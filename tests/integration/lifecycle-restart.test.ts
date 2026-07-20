import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { RunRecord } from "../../packages/core/src/types.js";
import { IcarusStore } from "../../packages/core/src/store.js";
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

interface PublicRun extends Omit<RunRecord, "context"> {
  readonly context: { readonly sha256: string };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function configureProject(repository: string, stateRoot: string): Promise<void> {
  expect(
    (await runCli(stateRoot, ["repo", "add", "--name", "fixture", "--path", repository])).exitCode,
  ).toBe(0);
  const check = JSON.stringify({
    id: "verify",
    name: "Verify greeting",
    argv: ["python", "checks/verify.py"],
  });
  expect(
    (
      await runCli(stateRoot, [
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
        check,
      ])
    ).exitCode,
  ).toBe(0);
}

describe("CLI lifecycle across process restarts", () => {
  test("persists approvals, verifies in Docker, rolls back, restores, and preserves the source checkout", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const preimage = "Hello, world!\n";
    const preimageSha = createHash("sha256").update(preimage).digest("hex");
    const provider = await startOllamaQueue([planResponse(), editResponse(preimageSha)]);
    cleanups.push(provider.close);
    const sourceBefore = await repositoryFingerprint(fixture.repository);
    await configureProject(fixture.repository, fixture.stateRoot);

    const planned = jsonOutput<PublicRun>(
      await runCli(fixture.stateRoot, [
        "run",
        "plan",
        "--project",
        "golden",
        "--task",
        "Replace the greeting and run the registered check.",
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
    expect(planned.state).toBe("awaiting_approval");
    expect(planned.planSha256).toMatch(/^[a-f0-9]{64}$/);

    const wrongApproval = await runCli(fixture.stateRoot, [
      "run",
      "approve",
      planned.id,
      "--plan-sha",
      "0".repeat(64),
      "--actor",
      "integration-test",
    ]);
    expect(wrongApproval.exitCode).toBe(1);
    expect(wrongApproval.stderr).toContain("STALE_APPROVAL");
    await expect(
      readFile(path.join(fixture.stateRoot, "runs", planned.id, "worktree")),
    ).rejects.toThrow();
    expect(provider.requests).toHaveLength(1);

    const reviewed = jsonOutput<PublicRun>(
      await runCli(fixture.stateRoot, [
        "run",
        "approve",
        planned.id,
        "--plan-sha",
        planned.planSha256 ?? "",
        "--actor",
        "integration-test",
      ]),
    );
    expect(reviewed.state).toBe("awaiting_review");
    expect(reviewed.verification?.outcome).toBe("passed");
    expect(reviewed.verification?.changedPaths).toEqual(["src/greeting.txt"]);
    expect(reviewed.diff).toContain("+Hello, Icarus!");
    expect(provider.requests).toHaveLength(2);

    const worktreeTarget = path.join(
      fixture.stateRoot,
      "runs",
      planned.id,
      "worktree",
      "src/greeting.txt",
    );
    expect(await readFile(worktreeTarget, "utf8")).toBe("Hello, Icarus!\n");
    expect(await readFile(path.join(fixture.repository, "src/greeting.txt"), "utf8")).toBe(
      preimage,
    );

    const rolledBack = jsonOutput<PublicRun>(
      await runCli(fixture.stateRoot, [
        "run",
        "review",
        planned.id,
        "--decision",
        "reject",
        "--diff-sha",
        reviewed.verification?.diffSha256 ?? "",
        "--actor",
        "integration-test",
      ]),
    );
    expect(rolledBack.state).toBe("rolled_back");
    expect(await readFile(worktreeTarget, "utf8")).toBe(preimage);

    const restored = jsonOutput<PublicRun>(
      await runCli(fixture.stateRoot, [
        "run",
        "restore",
        planned.id,
        "--checkpoint-sha",
        reviewed.verification?.checkpointSha256 ?? "",
        "--actor",
        "integration-test",
      ]),
    );
    expect(restored.state).toBe("awaiting_review");
    expect(restored.verification?.outcome).toBe("passed");
    expect(await readFile(worktreeTarget, "utf8")).toBe("Hello, Icarus!\n");

    await writeFile(worktreeTarget, "tampered after verification\n", "utf8");
    const staleReview = await runCli(fixture.stateRoot, [
      "run",
      "review",
      planned.id,
      "--decision",
      "approve",
      "--diff-sha",
      restored.verification?.diffSha256 ?? "",
      "--actor",
      "integration-test",
    ]);
    expect(staleReview.exitCode).toBe(1);
    expect(staleReview.stderr).toContain("WORKTREE_DRIFT");
    expect(
      jsonOutput<PublicRun>(await runCli(fixture.stateRoot, ["run", "status", planned.id])).state,
    ).toBe("awaiting_review");
    await writeFile(worktreeTarget, "Hello, Icarus!\n", "utf8");

    const completed = jsonOutput<PublicRun>(
      await runCli(fixture.stateRoot, [
        "run",
        "review",
        planned.id,
        "--decision",
        "approve",
        "--diff-sha",
        restored.verification?.diffSha256 ?? "",
        "--actor",
        "integration-test",
      ]),
    );
    expect(completed.state).toBe("completed");

    const history = jsonOutput<{
      readonly approvals: readonly { readonly kind: string; readonly decision: string }[];
      readonly events: readonly {
        readonly type: string;
        readonly payload: Record<string, unknown>;
      }[];
    }>(await runCli(fixture.stateRoot, ["run", "history", planned.id]));
    expect(history.approvals.map(({ kind, decision }) => `${kind}:${decision}`)).toEqual([
      "plan:approve",
      "review:reject",
      "restore:approve",
      "review:approve",
    ]);
    const eventTypes = history.events.map(({ type }) => type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "run.created",
        "base.pinned",
        "context.assembled",
        "plan.created",
        "plan.approved",
        "checkpoint.saved",
        "verification.completed",
        "rollback.completed",
        "restore.completed",
        "review.accepted",
      ]),
    );
    const verificationAttempts = history.events.filter(
      (event) => event.type === "verification.completed",
    );
    expect(verificationAttempts).toHaveLength(2);
    for (const attempt of verificationAttempts) {
      expect(attempt.payload.diff).toContain("+Hello, Icarus!");
      expect(attempt.payload.verification).toEqual(
        expect.objectContaining({
          outcome: "passed",
          checks: [expect.objectContaining({ checkId: "verify", outcome: "passed" })],
        }),
      );
    }
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
  }, 180_000);

  test("persists cancellation intent before restoring baseline bytes", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const preimage = "Hello, world!\n";
    const preimageSha = createHash("sha256").update(preimage).digest("hex");
    const provider = await startOllamaQueue([planResponse(), editResponse(preimageSha)]);
    cleanups.push(provider.close);
    await configureProject(fixture.repository, fixture.stateRoot);

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
    const awaitingReview = jsonOutput<PublicRun>(
      await runCli(fixture.stateRoot, [
        "run",
        "approve",
        planned.id,
        "--plan-sha",
        planned.planSha256 ?? "",
        "--actor",
        "integration-test",
      ]),
    );
    expect(awaitingReview.state).toBe("awaiting_review");

    const crashedStore = new IcarusStore(path.join(fixture.stateRoot, "icarus.sqlite3"));
    crashedStore.beginOperation(planned.id, "synthetic.crashed-operation", 0.1, 25, 100);
    crashedStore.close();

    const cancelled = jsonOutput<PublicRun>(
      await runCli(fixture.stateRoot, ["run", "cancel", planned.id, "--actor", "integration-test"]),
    );
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.usage.estimatedCostUsd).toBeCloseTo(
      awaitingReview.usage.estimatedCostUsd + 0.1,
    );
    expect(cancelled.usage.inputTokens).toBe(awaitingReview.usage.inputTokens + 25);
    expect(cancelled.usage.activeRuntimeMs).toBe(awaitingReview.usage.activeRuntimeMs + 100);
    expect(
      await readFile(
        path.join(fixture.stateRoot, "runs", planned.id, "worktree", "src/greeting.txt"),
        "utf8",
      ),
    ).toBe(preimage);
    const history = jsonOutput<{ readonly events: readonly { readonly type: string }[] }>(
      await runCli(fixture.stateRoot, ["run", "history", planned.id]),
    );
    const eventTypes = history.events.map((event) => event.type);
    expect(eventTypes.indexOf("operation.interrupted")).toBeGreaterThanOrEqual(0);
    expect(eventTypes.indexOf("cancellation.requested")).toBeGreaterThanOrEqual(0);
    expect(eventTypes.indexOf("operation.interrupted")).toBeLessThan(
      eventTypes.indexOf("cancellation.requested"),
    );
    expect(eventTypes.indexOf("cancellation.completed")).toBeGreaterThan(
      eventTypes.indexOf("cancellation.requested"),
    );
  }, 180_000);
});
