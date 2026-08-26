import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const worker = readFileSync(
  new URL("../../packages/core/src/headless-worker.ts", import.meta.url),
  "utf8",
);
const continuation = readFileSync(
  new URL("../../packages/core/src/headless-continuation.ts", import.meta.url),
  "utf8",
);
const store = readFileSync(new URL("../../packages/core/src/store.ts", import.meta.url), "utf8");
const service = readFileSync(
  new URL("../../packages/core/src/service.ts", import.meta.url),
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

describe("headless continuation security contract", () => {
  test("the continuation gate performs no I/O and creates no authority", () => {
    expect(continuation).not.toMatch(
      /node:fs|node:child_process|node:net|fetch\(|createGateway|RunLeaseManager/,
    );
    expect(continuation).not.toMatch(
      /approvePlan|approveEgress|beginOperation|appendEvent|recordHeadlessWorker|recordResume|markStarted/,
    );
    expect(continuation).toContain("HEADLESS_CONTINUATION_DENIED");
    expect(continuation).toContain("CONTINUABLE_OPERATION_KINDS");
  });

  test("continuation uses its own closed schemas, never the closed worker v1 grammar", () => {
    expect(worker).toContain('"icarus.headless.worker-continuation.v1"');
    expect(worker).toContain('"icarus.headless.worker-resume.v1"');
    const created = worker.slice(
      worker.indexOf("export function createContinuedHeadlessWorkerSettlementV1("),
    );
    expect(created).toContain("schema: HEADLESS_WORKER_CONTINUATION_SCHEMA");
    expect(created).not.toContain("schema: HEADLESS_WORKER_SCHEMA,");
    // A forged continuation must fail against its durable resume intent.
    expect(created).toContain("resumePayload.schema === HEADLESS_WORKER_RESUME_SCHEMA");
    expect(created).toContain("HEADLESS_WORKER_IDENTITY_CHANGED");
  });

  test("the lifecycle grammar admits at most one resume and two ordered settlements", () => {
    const inspector = body(
      worker,
      "export function inspectHeadlessWorkerLifecycleV1(",
      "export function createInterruptedHeadlessWorkerSettlementV1(",
    );
    expect(inspector).toContain("Headless worker history contains more than one resume request");
    expect(inspector).toContain("Headless worker history contains more than two settlements");
    expect(inspector).toContain(
      "Headless worker resume request must follow an interrupted settlement",
    );
    expect(inspector).toContain(
      "Headless worker continuation settlement exists without resume intent",
    );
  });

  test("the store records resume intent only over a reconciled crash tail, exactly once", () => {
    const intent = body(
      store,
      "recordHeadlessWorkerResumeRequested(",
      "recordHeadlessWorkerContinuationSettled(",
    );
    expect(intent).toContain("HEADLESS_CONTINUATION_DENIED");
    expect(intent).toContain("HEADLESS_WORKER_CONTINUATION_EXHAUSTED");
    expect(intent).toContain("HEADLESS_WORKER_NOT_QUIESCENT");
    expect(intent).toContain("headless.worker.resume_requested");
  });

  test("the store accepts a second settlement only as a crash closure, never a third", () => {
    const settled = body(
      store,
      "recordHeadlessWorkerSettled(",
      "recordHeadlessWorkerResumeRequested(",
    );
    expect(settled).toContain("priorSettlements.length === 1");
    expect(settled).toContain("settlement.schema === HEADLESS_WORKER_INTERRUPTION_SCHEMA");
    const continuation = body(store, "recordHeadlessWorkerContinuationSettled(", "beginOperation(");
    expect(continuation).toContain("settlements.length === 1");
    expect(continuation).toContain("resumes.length === 1");
    expect(continuation).toContain("HEADLESS_WORKER_NOT_QUIESCENT");
  });

  test("the service resumes under the lease only after reconstruction and the gate", () => {
    const resume = body(service, "async resumeHeadlessWorker(", "async review(");
    expect(resume).toContain("this.#leases.withLease(runId");
    const reconstruction = resume.indexOf("reconstructHeadlessContinuationV1(");
    const gate = resume.indexOf("assertHeadlessContinuationReplaySafeV1(");
    const intent = resume.indexOf("recordHeadlessWorkerResumeRequested(");
    const execute = resume.indexOf("this.#execute(");
    const settlement = resume.indexOf("createContinuedHeadlessWorkerSettlementV1(");
    const record = resume.indexOf("recordHeadlessWorkerContinuationSettled(");
    expect(reconstruction).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(reconstruction);
    expect(intent).toBeGreaterThan(gate);
    expect(execute).toBeGreaterThan(intent);
    expect(settlement).toBeGreaterThan(execute);
    expect(record).toBeGreaterThan(settlement);
    // The ordinary resume refusal of headless lifecycles is unchanged.
    const ordinary = body(service, "async #resumeUnleased(", "async #cancelUnleased(");
    expect(ordinary).toContain("HEADLESS_BINDING_RECONSTRUCTION_REQUIRED");
    expect(ordinary).not.toContain("resumeHeadlessWorker");
  });

  test("the CLI command emits checksum-terminated history and the settlement exit code", () => {
    const command = body(cli, 'if (action === "resume-headless")', 'if (action === "status")');
    expect(command).toContain("resumeHeadlessWorker(oneRunId(options)");
    expect(command).toContain("emitRunTrajectory(runtime, result.run.id");
    expect(command).toContain("process.exitCode = result.settlement.exitCode");
    // The shared emitter keeps the H0 history as the default output format.
    const emitter = body(cli, "function emitRunTrajectory(", "function handoffInputPair(");
    expect(emitter).toContain("createHeadlessHistoryLines(");
    expect(emitter).toContain("canonicalJsonLine(line)");
    expect(command.indexOf("headlessOutputFormat(options)")).toBeLessThan(
      command.indexOf("resumeHeadlessWorker("),
    );
    expect(cli).toContain('"icarus run resume-headless RUN [--output-format history|stream-json]"');
  });
});
