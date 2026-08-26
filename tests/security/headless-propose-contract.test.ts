import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const worker = readFileSync(
  new URL("../../packages/core/src/headless-worker.ts", import.meta.url),
  "utf8",
);
const store = readFileSync(new URL("../../packages/core/src/store.ts", import.meta.url), "utf8");
const service = readFileSync(
  new URL("../../packages/core/src/service.ts", import.meta.url),
  "utf8",
);
const cli = readFileSync(new URL("../../packages/cli/src/main.ts", import.meta.url), "utf8");
const types = readFileSync(new URL("../../packages/core/src/types.ts", import.meta.url), "utf8");

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("headless propose-only security contract", () => {
  test("the propose stop precedes materialization and materializes nothing", () => {
    const execute = body(service, "async #execute(", "async #assertWorktreeMatchesCheckpoint(");
    const intent = execute.indexOf("recordPatchSetIntent(runId, patchSet, files)");
    const stop = execute.indexOf('mutation === "propose"');
    const materialize = execute.indexOf('"edit.materialize"');
    expect(intent).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(intent);
    expect(materialize).toBeGreaterThan(stop);
  });

  test("proposal and application use distinct closed schemas with defined exits", () => {
    expect(worker).toContain('"icarus.headless.worker-proposal.v1"');
    expect(worker).toContain('"icarus.headless.worker-application.v1"');
    expect(worker).toContain('"icarus.headless.worker-apply.v1"');
    expect(worker).toContain("proposed: 10");
    const proposal = body(
      worker,
      "export function createProposedHeadlessWorkerSettlementV1(",
      "export function createAppliedHeadlessWorkerSettlementV1(",
    );
    expect(proposal).toContain('run.state === "running" && input.run.patchSet !== null');
    expect(proposal).toContain("assertQuiescent(input.events)");
    expect(proposal).not.toContain("applyFileWrites");
  });

  test("the lifecycle grammar admits at most one epoch intent and two settlements", () => {
    const inspector = body(
      worker,
      "export function inspectHeadlessWorkerLifecycleV1(",
      "export function createInterruptedHeadlessWorkerSettlementV1(",
    );
    expect(inspector).toContain("more than one epoch intent");
    expect(inspector).toContain("more than one apply request");
    expect(inspector).toContain("more than two settlements");
    expect(inspector).toContain("apply request must follow a proposed settlement");
  });

  test("the apply act requires the durable digest before any effect", () => {
    const apply = body(service, "async applyHeadlessProposal(", "async reconcileHeadlessWorker(");
    expect(apply).toContain("this.#leases.withLease(runId");
    const lifecycle = apply.indexOf("inspectHeadlessWorkerLifecycleV1(");
    const reconstruction = apply.indexOf("reconstructHeadlessContinuationV1(");
    const digest = apply.indexOf("recomputed === patchSetSha256");
    const intent = apply.indexOf("recordHeadlessWorkerApplyRequested(");
    const execute = apply.indexOf("this.#execute(runId, signal,");
    const settlement = apply.indexOf("createAppliedHeadlessWorkerSettlementV1(");
    const record = apply.indexOf("recordHeadlessWorkerApplicationSettled(");
    expect(lifecycle).toBeGreaterThanOrEqual(0);
    expect(reconstruction).toBeGreaterThan(lifecycle);
    expect(digest).toBeGreaterThan(reconstruction);
    expect(intent).toBeGreaterThan(digest);
    expect(execute).toBeGreaterThan(intent);
    expect(settlement).toBeGreaterThan(execute);
    expect(record).toBeGreaterThan(settlement);
    expect(apply).toContain("HEADLESS_APPLY_DENIED");
    expect(apply).toContain("HEADLESS_APPLY_EXHAUSTED");
    // resume-headless cannot bypass the digest-bound apply act in propose mode.
    const resume = body(service, "async resumeHeadlessWorker(", "async review(");
    expect(resume).toContain("Proposed workers apply through run apply-headless");
  });

  test("the apply approval and intent are atomic, single-shot, and pipeline-native", () => {
    expect(types).toContain('"egress" | "plan" | "review" | "rollback" | "restore" | "apply"');
    const intent = body(
      store,
      "recordHeadlessWorkerApplyRequested(",
      "recordHeadlessWorkerApplicationSettled(",
    );
    expect(intent).toContain("HEADLESS_APPLY_EXHAUSTED");
    expect(intent).toContain("INSERT INTO approvals");
    expect(intent).toContain("headless.worker.apply_requested");
    const settled = body(
      store,
      "recordHeadlessWorkerApplicationSettled(",
      "recordHeadlessChildLinked(",
    );
    expect(settled).toContain("HEADLESS_WORKER_PROPOSAL_SCHEMA");
    expect(settled).toContain("HEADLESS_WORKER_APPLY_SCHEMA");
    expect(settled).toContain("HEADLESS_APPLY_DENIED");
  });

  test("envelopes only narrow, and the doom guard is shared deterministic code", () => {
    expect(service).toContain("envelope?.maxTurns ??");
    expect(service).toContain("envelope?.maxBudgetUsd ??");
    expect(service.match(/Math\.min\([\s\S]{0,120}maxCostUsd/g)?.length).toBeGreaterThanOrEqual(2);
    const loop = body(
      service,
      "const admittedCallDigests",
      "let current = this.#store.getRun(runId);",
    );
    expect(loop).toContain("HEADLESS_DOOM_LOOP");
    expect(loop).toContain("admitted >= 3");
    expect(loop).toContain('"read.manifest"');
    expect(loop).toContain('"read.checks"');
    expect(loop).toContain("recordSessionDoomLoop(");
    const landing = body(store, "recordSessionDoomLoop(", "recordSessionAdmissionExhausted(");
    expect(landing).toContain('reason: "doom_loop"');
    expect(landing).toContain("callDigestSha256");
  });

  test("the CLI binds the flag to a digest shape and propagates settlement exits", () => {
    const command = body(
      cli,
      'if (action === "apply-headless")',
      'if (action === "reconcile-headless")',
    );
    expect(command).toContain("/^[a-f0-9]{64}$/");
    expect(command).toContain("applyHeadlessProposal(");
    expect(command).toContain("canonicalJsonLine(line)");
    expect(command).toContain("process.exitCode = result.settlement.exitCode");
    expect(cli).toContain('"icarus run apply-headless RUN --patchset-sha SHA --actor ACTOR');
    expect(cli).toContain("--max-turns N] [--max-budget-usd USD]");
  });
});
