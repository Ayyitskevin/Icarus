import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { RunRecord } from "../../packages/core/src/types.js";
import {
  createFixtureRepository,
  editResponse,
  jsonOutput,
  planResponse,
  PYTHON_IMAGE,
  runCli,
  startOllamaQueue,
} from "../support/integration-cli.js";

interface PublicRun extends Omit<RunRecord, "context"> {
  readonly context: { readonly sha256: string };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("failed-run recovery", () => {
  test("resumes the persisted running state after a provider failure", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const preimageSha = createHash("sha256").update("Hello, world!\n").digest("hex");
    const provider = await startOllamaQueue([
      planResponse(),
      { status: 503, rawBody: '{"error":"temporary"}' },
    ]);
    cleanups.push(provider.close);

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
    const planned = jsonOutput<PublicRun>(
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
    const failedApproval = await runCli(fixture.stateRoot, [
      "run",
      "approve",
      planned.id,
      "--plan-sha",
      planned.planSha256 ?? "",
      "--actor",
      "integration-test",
    ]);
    expect(failedApproval.exitCode).toBe(1);
    expect(failedApproval.stderr).toContain("PROVIDER_HTTP_ERROR");
    const failed = jsonOutput<PublicRun>(
      await runCli(fixture.stateRoot, ["run", "status", planned.id]),
    );
    expect(failed.state).toBe("failed");
    expect(failed.resumeState).toBe("running");
    const listed = jsonOutput<PublicRun[]>(
      await runCli(fixture.stateRoot, ["run", "list", "--project", "golden"]),
    );
    expect(listed.map((run) => run.id)).toEqual([planned.id]);

    provider.enqueue(editResponse(preimageSha));
    const resumed = jsonOutput<PublicRun>(
      await runCli(fixture.stateRoot, ["run", "resume", planned.id]),
    );
    expect(resumed.state).toBe("awaiting_review");
    expect(resumed.verification?.outcome).toBe("passed");
    expect(
      await readFile(
        path.join(fixture.stateRoot, "runs", planned.id, "worktree", "src/greeting.txt"),
        "utf8",
      ),
    ).toBe("Hello, Icarus!\n");
  }, 180_000);
});
