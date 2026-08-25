import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const service = readFileSync(
  new URL("../../packages/core/src/service.ts", import.meta.url),
  "utf8",
);
const store = readFileSync(new URL("../../packages/core/src/store.ts", import.meta.url), "utf8");
const worker = readFileSync(
  new URL("../../packages/core/src/headless-worker.ts", import.meta.url),
  "utf8",
);
const session = readFileSync(
  new URL("../../packages/core/src/session-loop.ts", import.meta.url),
  "utf8",
);
const cli = readFileSync(new URL("../../packages/cli/src/main.ts", import.meta.url), "utf8");

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("headless worker security contract", () => {
  test("the public entrypoint holds the existing run lease", () => {
    const entrypoint = body(service, "async approveHeadlessPlan(", "async review(");
    expect(entrypoint).toContain("this.#leases.withLease(runId");
    expect(entrypoint).not.toContain("new RunLeaseManager");
  });

  test("approval and H2a binding precede the first worker effect", () => {
    const execution = body(
      service,
      "async #approveHeadlessPlanUnleased(",
      "async #reviewUnleased(",
    );
    const approval = execution.indexOf("this.#store.approvePlan(");
    const binding = execution.indexOf("bindHeadlessExecutionV1(");
    const started = execution.indexOf("recordHeadlessWorkerStarted(");
    const effect = execution.indexOf("this.#execute(");
    expect(approval).toBeGreaterThanOrEqual(0);
    expect(binding).toBeGreaterThan(approval);
    expect(started).toBeGreaterThan(binding);
    expect(effect).toBeGreaterThan(started);
  });

  test("profile ceilings reach durable ordinary-operation admission", () => {
    expect(store).toContain("authorityCeiling?: SunCeiling");
    expect(store).toContain("ceiling[key] <= project.ceiling[key]");
    expect(store).toContain("run.usage.toolCalls + 1 <= ceiling.maxToolCalls");
    expect(store).toContain(
      "run.usage.activeRuntimeMs + reservedRuntimeMs <= ceiling.maxActiveRuntimeMs",
    );
    expect(
      service.match(/this\.#browserActionIdForOperation\(runId, [^)]+\),\n\s+project\.ceiling,/g)
        ?.length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("the headless tool filter is additional to plan-grant enforcement", () => {
    const action = body(
      session,
      "assertToolCallGranted({",
      "const toolResult = await executeToolCall",
    );
    expect(action).toContain("deps.enabledTools === undefined || deps.enabledTools.has(call.name)");
    expect(action.indexOf("assertToolCallGranted")).toBeLessThan(
      action.indexOf("deps.enabledTools"),
    );
    expect(session).toContain('"TOOL_NOT_ENABLED"');
  });

  test("the worker contract cannot perform I/O or create authority", () => {
    expect(worker).not.toMatch(/node:fs|node:child_process|fetch\(|createGateway|RunLeaseManager/);
    expect(worker).not.toMatch(/approvePlan|approveEgress|beginOperation/);
  });

  test("durable settlement refuses active operations and duplicate lifecycle rows", () => {
    expect(store).toContain("Headless worker cannot settle across an active operation");
    expect(store).toContain("HEADLESS_WORKER_ALREADY_STARTED");
    expect(store).toContain("HEADLESS_WORKER_ALREADY_SETTLED");
    expect(worker).toContain("HEADLESS_WORKER_NOT_QUIESCENT");
  });

  test("crash-tail reconciliation closes operations before settlement and never resumes work", () => {
    const reconciliation = body(service, "async reconcileHeadlessWorker(", "async review(");
    expect(reconciliation).toContain("this.#leases.withLease(runId");
    const interrupt = reconciliation.indexOf("markStartedOperationsInterrupted(");
    const settlement = reconciliation.indexOf("createInterruptedHeadlessWorkerSettlementV1(");
    const record = reconciliation.indexOf("recordHeadlessWorkerSettled(");
    expect(interrupt).toBeGreaterThanOrEqual(0);
    expect(settlement).toBeGreaterThan(interrupt);
    expect(record).toBeGreaterThan(settlement);
    expect(reconciliation).not.toContain("this.#execute(");
    expect(reconciliation).not.toContain("createGateway(");
  });

  test("ordinary resume cannot bypass headless binding reconstruction", () => {
    const resume = body(service, "async #resumeUnleased(", "async #cancelUnleased(");
    const guard = resume.indexOf("inspectHeadlessWorkerLifecycleV1(");
    const resumeEvent = resume.indexOf("recordResumeRequested(");
    const execute = resume.indexOf("this.#execute(");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(resumeEvent).toBeGreaterThan(guard);
    expect(execute).toBeGreaterThan(guard);
    expect(resume).toContain("HEADLESS_BINDING_RECONSTRUCTION_REQUIRED");
  });

  test("the CLI emits checksum-terminated history and propagates worker exit status", () => {
    const command = body(cli, 'if (action === "approve-headless")', 'if (action === "status")');
    expect(command).toContain("createHeadlessHistoryLines(");
    expect(command).toContain("canonicalJsonLine(line)");
    expect(command).toContain("process.exitCode = result.settlement.exitCode");
    expect(command).not.toContain("process.exit(0)");
    expect(command).toContain('if (action === "reconcile-headless")');
  });
});
