import { afterEach, describe, expect, test } from "vitest";
import { sha256 } from "../../packages/core/src/digest.js";
import {
  HEADLESS_HISTORY_SCHEMA,
  HEADLESS_STREAM_SCHEMA,
  type HeadlessStreamContentLineV1,
  headlessStreamContentSha256,
} from "../../packages/core/src/index.js";
import { DEFAULT_CEILING } from "../../packages/core/src/policy.js";
import type { RunRecord } from "../../packages/core/src/types.js";
import {
  createFixtureRepository,
  editResponse,
  jsonOutput,
  PYTHON_IMAGE,
  planResponse,
  runCli,
  startOllamaQueue,
} from "../support/integration-cli.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function streamLines(stdout: string): readonly Record<string, unknown>[] {
  return stdout
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function planGoldenRun(
  fixture: Awaited<ReturnType<typeof createFixtureRepository>>,
  providerBaseUrl: string,
): Promise<RunRecord> {
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
  return jsonOutput<RunRecord>(
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
      providerBaseUrl,
    ]),
  );
}

function approveHeadlessArgs(
  planned: RunRecord,
  providerBaseUrl: string,
  extra: readonly string[] = [],
): readonly string[] {
  const profile = {
    schemaVersion: 1,
    profileId: "local-headless",
    providerProfileId: "local-provider",
    toolIds: [],
    budgets: { ...DEFAULT_CEILING, iterationCeiling: 0 },
    output: { format: "jsonl" },
    worker: { mode: "one_task", maxConcurrency: 1, childRuns: "deny", scheduledRuns: "deny" },
  };
  const catalog = [
    {
      id: "local-provider",
      kind: "ollama",
      model: "contract-model",
      baseUrl: providerBaseUrl,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
    },
  ];
  return [
    "run",
    "approve-headless",
    planned.id,
    "--plan-sha",
    planned.planSha256 ?? "",
    "--actor",
    "integration-test",
    "--profile-json",
    JSON.stringify(profile),
    "--provider-catalog-json",
    JSON.stringify(catalog),
    ...extra,
  ];
}

describe("headless stream CLI", () => {
  test("run history --format stream-json exports a deterministic, checksum-terminated stream", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const provider = await startOllamaQueue([planResponse()]);
    cleanups.push(provider.close);
    const planned = await planGoldenRun(fixture, provider.baseUrl);

    const args = ["run", "history", planned.id, "--format", "stream-json"];
    const streamed = await runCli(fixture.stateRoot, args);
    expect(streamed.exitCode).toBe(0);
    const repeated = await runCli(fixture.stateRoot, args);
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout).toBe(streamed.stdout);

    const lines = streamLines(streamed.stdout);
    expect(lines.every((line) => line.schema === HEADLESS_STREAM_SCHEMA)).toBe(true);
    // A planned-but-unapproved run: identity, the plan, and the terminal
    // result — no grants, patch sets, checks, or receipts exist yet.
    expect(lines.map((line) => line.kind)).toEqual(["init", "plan", "result"]);
    expect(lines[0]).toMatchObject({
      kind: "init",
      phase: "run_created",
      runId: planned.id,
      source: { type: "event", sequence: 1, eventType: "run.created" },
    });
    expect(lines[1]).toMatchObject({
      kind: "plan",
      planSha256: planned.planSha256,
      targets: ["src/greeting.txt"],
      checkIds: ["verify"],
    });
    const result = lines.at(-1);
    expect(result).toMatchObject({ kind: "result", finalState: "awaiting_approval" });
    expect(result?.contentSha256).toBe(
      headlessStreamContentSha256(
        lines.slice(0, -1) as unknown as readonly HeadlessStreamContentLineV1[],
      ),
    );

    const invalid = await runCli(fixture.stateRoot, [
      "run",
      "history",
      planned.id,
      "--format",
      "ndjson",
    ]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("INVALID_ARGUMENT");
  });

  test("approve-headless --output-format stream-json emits the receipt-bound stream", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const preimageSha = sha256("Hello, world!\n");
    const provider = await startOllamaQueue([planResponse(), editResponse(preimageSha)]);
    cleanups.push(provider.close);
    const planned = await planGoldenRun(fixture, provider.baseUrl);

    const approved = await runCli(
      fixture.stateRoot,
      approveHeadlessArgs(planned, provider.baseUrl, ["--output-format", "stream-json"]),
    );
    expect(approved.stderr).toBe("");
    expect(approved.exitCode).toBe(0);

    const lines = streamLines(approved.stdout);
    expect(lines.every((line) => line.schema === HEADLESS_STREAM_SCHEMA)).toBe(true);
    expect(lines.map((line) => line.kind)).toEqual([
      "init",
      "grant",
      "plan",
      "init",
      "patchset",
      "patchset",
      "check",
      "receipt",
      "result",
    ]);

    const workerInit = lines.find(
      (line) => line.kind === "init" && line.phase === "worker_started",
    );
    expect(workerInit).toMatchObject({
      profileId: "local-headless",
      providerProfileId: "local-provider",
    });
    const bindingDigest = workerInit?.bindingDigestSha256 as string;
    expect(bindingDigest).toMatch(/^[a-f0-9]{64}$/);

    const grant = lines.find((line) => line.kind === "grant");
    expect(grant).toMatchObject({
      approvalKind: "plan",
      digest: planned.planSha256,
      actor: "integration-test",
      decision: "approve",
    });

    const patchsets = lines.filter((line) => line.kind === "patchset");
    expect(patchsets[0]).toMatchObject({
      action: "intent_recorded",
      paths: ["src/greeting.txt"],
      operations: ["modify"],
    });
    expect(patchsets[0]?.patchSetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(patchsets[1]).toMatchObject({ action: "materialized" });
    expect(patchsets[1]?.approvedSha256).toMatch(/^[a-f0-9]{64}$/);

    expect(lines.find((line) => line.kind === "check")).toMatchObject({
      outcome: "passed",
      checks: [expect.objectContaining({ checkId: "verify", outcome: "passed", exitCode: 0 })],
    });

    const receipt = lines.find((line) => line.kind === "receipt");
    expect(receipt).toMatchObject({
      receiptKind: "worker",
      settlementSchema: "icarus.headless.worker.v1",
      outcome: "review_ready",
      exitCode: 0,
      bindingDigestSha256: bindingDigest,
    });

    const result = lines.at(-1);
    expect(result).toMatchObject({
      kind: "result",
      finalState: "awaiting_review",
      verificationOutcome: "passed",
      settlement: {
        schema: "icarus.headless.worker.v1",
        outcome: "review_ready",
        exitCode: 0,
        bindingDigestSha256: bindingDigest,
      },
    });
    expect(result?.contentSha256).toBe(
      headlessStreamContentSha256(
        lines.slice(0, -1) as unknown as readonly HeadlessStreamContentLineV1[],
      ),
    );

    // Every projected line cites the durable record it was derived from.
    for (const line of lines.slice(0, -1)) {
      const source = line.source as { readonly type?: unknown };
      expect(source.type === "event" || source.type === "approval").toBe(true);
    }
  });

  test("default headless output remains the H0 history trajectory", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const preimageSha = sha256("Hello, world!\n");
    const provider = await startOllamaQueue([planResponse(), editResponse(preimageSha)]);
    cleanups.push(provider.close);
    const planned = await planGoldenRun(fixture, provider.baseUrl);

    const approved = await runCli(
      fixture.stateRoot,
      approveHeadlessArgs(planned, provider.baseUrl),
    );
    expect(approved.stderr).toBe("");
    expect(approved.exitCode).toBe(0);
    const lines = streamLines(approved.stdout);
    expect(lines.every((line) => line.schema === HEADLESS_HISTORY_SCHEMA)).toBe(true);
    expect(lines[0]?.kind).toBe("run");
    expect(lines.at(-1)?.kind).toBe("end");

    const invalid = await runCli(
      fixture.stateRoot,
      approveHeadlessArgs(planned, provider.baseUrl, ["--output-format", "yaml"]),
    );
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).toContain("INVALID_ARGUMENT");
  });
});
