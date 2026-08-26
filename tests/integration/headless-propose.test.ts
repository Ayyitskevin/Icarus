import path from "node:path";
import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { HEADLESS_HISTORY_SCHEMA } from "../../packages/core/src/index.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import type { RunRecord } from "../../packages/core/src/types.js";
import {
  createFixtureRepository,
  editResponse,
  jsonOutput,
  planResponse,
  PYTHON_IMAGE,
  repositoryFingerprint,
  runCli,
  startOllamaQueue,
} from "../support/integration-cli.js";

const cleanups: Array<() => Promise<void>> = [];
let forceColor: string | undefined;
let noColor: string | undefined;

beforeEach(() => {
  forceColor = process.env.FORCE_COLOR;
  noColor = process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
});

afterEach(async () => {
  try {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  } finally {
    if (forceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = forceColor;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  }
});

const PROFILE = {
  schemaVersion: 1,
  profileId: "local-headless",
  providerProfileId: "local-provider",
  toolIds: [],
  budgets: {
    maxToolCalls: 40,
    maxActiveRuntimeMs: 1_200_000,
    maxContextBytes: 196_608,
    maxOutputTokensPerCall: 8_192,
    maxTotalTokens: 100_000,
    maxCostUsd: 2,
    maxFilesChanged: 8,
    maxFileBytes: 262_144,
    maxDiffBytes: 262_144,
    maxCommandOutputBytes: 262_144,
    maxRawCommandOutputBytes: 8_388_608,
    providerTimeoutMs: 300_000,
    commandTimeoutMs: 300_000,
    iterationCeiling: 0,
  },
  output: { format: "jsonl" },
  worker: {
    mode: "one_task",
    maxConcurrency: 1,
    childRuns: "deny",
    scheduledRuns: "deny",
    // No mutation field: the ADR 0060 default is propose-only.
  },
};

function withStore<T>(stateRoot: string, read: (store: IcarusStore) => T): T {
  const store = new IcarusStore(path.join(stateRoot, "icarus.sqlite3"));
  try {
    return read(store);
  } finally {
    store.close();
  }
}

function historyLines(stdout: string): readonly Record<string, unknown>[] {
  return stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("headless propose-only default and digest-bound apply", () => {
  test("proposes by default, refuses a wrong digest, applies exactly once", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const preimageSha = sha256("Hello, world!\n");
    const provider = await startOllamaQueue([planResponse(), editResponse(preimageSha)]);
    cleanups.push(provider.close);
    const sourceBefore = await repositoryFingerprint(fixture.repository);

    expect(
      (
        await runCli(fixture.stateRoot, [
          "repo",
          "add",
          "--name",
          "fixture",
          "--path",
          fixture.repository,
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runCli(fixture.stateRoot, [
          "project",
          "add",
          "--name",
          "golden",
          "--repo",
          "fixture",
          "--base-ref",
          "main",
          "--sandbox-image",
          PYTHON_IMAGE,
          "--check",
          JSON.stringify({ id: "verify", name: "verify", argv: ["python", "checks/verify.py"] }),
        ])
      ).exitCode,
    ).toBe(0);
    const planned = jsonOutput<RunRecord>(
      await runCli(fixture.stateRoot, [
        "run",
        "plan",
        "--project",
        "golden",
        "--task",
        "Replace the greeting.",
        "--target",
        "src/greeting.txt",
        "--provider",
        "ollama",
        "--model",
        "contract-model",
        "--base-url",
        provider.baseUrl,
      ]),
    );
    const catalog = [
      {
        id: "local-provider",
        kind: "ollama",
        model: "contract-model",
        baseUrl: provider.baseUrl,
        inputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: null,
      },
    ];
    const approveArgs = [
      "run",
      "approve-headless",
      planned.id,
      "--plan-sha",
      planned.planSha256 ?? "",
      "--actor",
      "integration-test",
      "--profile-json",
      JSON.stringify(PROFILE),
      "--provider-catalog-json",
      JSON.stringify(catalog),
    ] as const;

    // The default is propose-only: clean stop, exit 10, nothing materialized.
    const proposed = await runCli(fixture.stateRoot, [...approveArgs]);
    expect(proposed.exitCode).toBe(10);
    expect(proposed.stderr).toBe("");
    const proposalLines = historyLines(proposed.stdout);
    expect(proposalLines.every((line) => line.schema === HEADLESS_HISTORY_SCHEMA)).toBe(true);
    const proposalSettlement = proposalLines.find(
      (line) => line.kind === "event" && line.type === "headless.worker.settled",
    );
    expect(proposalSettlement).toMatchObject({
      payload: {
        schema: "icarus.headless.worker-proposal.v1",
        outcome: "proposed",
        exitCode: 10,
        finalState: "running",
        error: null,
      },
    });
    expect(proposalSettlement).toBeDefined();
    const patchSetSha = (
      proposalSettlement as unknown as {
        readonly payload: { readonly proposal: { readonly patchSetSha256: string } };
      }
    ).payload.proposal.patchSetSha256;
    expect(patchSetSha).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await readFile(
        path.join(fixture.stateRoot, "runs", planned.id, "worktree", "src/greeting.txt"),
        "utf8",
      ),
    ).toBe("Hello, world!\n");
    expect(provider.requests).toHaveLength(2);

    // A wrong digest is refused before any effect or approval record.
    const eventCountBefore = withStore(
      fixture.stateRoot,
      (store) => store.listEvents(planned.id).length,
    );
    const wrong = await runCli(fixture.stateRoot, [
      "run",
      "apply-headless",
      planned.id,
      "--patchset-sha",
      "0".repeat(64),
      "--actor",
      "integration-test",
    ]);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toContain("HEADLESS_APPLY_DENIED");
    expect(withStore(fixture.stateRoot, (store) => store.listEvents(planned.id).length)).toBe(
      eventCountBefore,
    );
    expect(
      withStore(
        fixture.stateRoot,
        (store) =>
          store.listApprovals(planned.id).filter((approval) => approval.kind === "apply").length,
      ),
    ).toBe(0);

    // resume-headless cannot bypass the digest-bound apply act in propose mode.
    const resumed = await runCli(fixture.stateRoot, ["run", "resume-headless", planned.id]);
    expect(resumed.exitCode).toBe(1);
    expect(resumed.stderr).toContain("HEADLESS_CONTINUATION_DENIED");
    expect(
      withStore(
        fixture.stateRoot,
        (store) =>
          store
            .listEvents(planned.id)
            .filter((event) => event.type === "headless.worker.resume_requested").length,
      ),
    ).toBe(0);

    // The exact digest applies: materialize, verify, settle, exit 0.
    const applied = await runCli(fixture.stateRoot, [
      "run",
      "apply-headless",
      planned.id,
      "--patchset-sha",
      patchSetSha as string,
      "--actor",
      "integration-test",
    ]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stderr).toBe("");
    const appliedLines = historyLines(applied.stdout);
    const appliedEvents = appliedLines.filter((line) => line.kind === "event");
    expect(appliedEvents.filter((line) => line.type === "headless.worker.apply_requested")).toEqual(
      [
        expect.objectContaining({
          payload: expect.objectContaining({
            schema: "icarus.headless.worker-apply.v1",
            patchSetSha256: patchSetSha,
          }),
        }),
      ],
    );
    expect(appliedEvents.filter((line) => line.type === "headless.worker.settled")).toHaveLength(2);
    const applicationSettlement = appliedEvents.at(-1);
    expect(applicationSettlement).toMatchObject({
      type: "headless.worker.settled",
      payload: {
        schema: "icarus.headless.worker-application.v1",
        outcome: "review_ready",
        exitCode: 0,
        application: { patchSetSha256: patchSetSha },
      },
    });
    expect(
      withStore(fixture.stateRoot, (store) =>
        store
          .listApprovals(planned.id)
          .filter((approval) => approval.kind === "apply")
          .map((approval) => ({
            digest: approval.digest,
            actor: approval.actor,
            decision: approval.decision,
          })),
      ),
    ).toEqual([{ digest: patchSetSha, actor: "integration-test", decision: "approve" }]);
    expect(
      await readFile(
        path.join(fixture.stateRoot, "runs", planned.id, "worktree", "src/greeting.txt"),
        "utf8",
      ),
    ).toBe("Hello, Icarus!\n");
    const appliedRun = jsonOutput<RunRecord>(
      await runCli(fixture.stateRoot, ["run", "status", planned.id, "--json"]),
    );
    expect(appliedRun.state).toBe("awaiting_review");
    expect(appliedRun.verification?.outcome).toBe("passed");
    expect(provider.requests).toHaveLength(2);

    // A repeated apply returns byte-identical evidence and appends nothing.
    const eventCountAfter = withStore(
      fixture.stateRoot,
      (store) => store.listEvents(planned.id).length,
    );
    const repeated = await runCli(fixture.stateRoot, [
      "run",
      "apply-headless",
      planned.id,
      "--patchset-sha",
      patchSetSha as string,
      "--actor",
      "integration-test",
    ]);
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout).toBe(applied.stdout);
    expect(withStore(fixture.stateRoot, (store) => store.listEvents(planned.id).length)).toBe(
      eventCountAfter,
    );
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
  }, 180_000);
});
