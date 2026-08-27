import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const children = readFileSync(
  new URL("../../packages/core/src/headless-children.ts", import.meta.url),
  "utf8",
);
const profile = readFileSync(
  new URL("../../packages/core/src/headless-profile.ts", import.meta.url),
  "utf8",
);
const worker = readFileSync(
  new URL("../../packages/core/src/headless-worker.ts", import.meta.url),
  "utf8",
);
const store = readFileSync(new URL("../../packages/core/src/store.ts", import.meta.url), "utf8");
const service = readFileSync(
  new URL("../../packages/core/src/service.ts", import.meta.url),
  "utf8",
);

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("headless child security contract", () => {
  test("the child contracts module performs no I/O and creates no authority", () => {
    expect(children).not.toMatch(
      /node:fs|node:child_process|node:net|fetch\(|createGateway|RunLeaseManager/,
    );
    expect(children).not.toMatch(
      /approvePlan|approveEgress|beginOperation|appendEvent|recordHeadless|createRunDraft/,
    );
  });

  test("the child grammar stays closed and default-deny", () => {
    expect(profile).toContain('"deny" | HeadlessChildRunsAllowV1');
    expect(profile).toContain("profile.worker.childRuns.maxDepth must equal 1");
    expect(profile).toContain("HEADLESS_CHILD_LIMIT");
    const spec = body(profile, "function decodeChildSpec(", "function decodeChildren(");
    expect(spec).toContain('["budgets", "childId", "targets", "task", "toolIds"]');
    // Narrowing is enforced at resolution, never assumed.
    const authority = body(
      profile,
      "function assertChildrenWithinAuthority(",
      "function resolveProvider(",
    );
    expect(authority).toContain("requires worker.childRuns to allow child runs");
    expect(authority).toContain("requires a loopback provider");
    expect(authority).toContain("must not exceed the parent tool set");
    expect(authority).toContain("exceeds the parent profile budget");
    expect(authority).toContain("within the approved plan targets");
  });

  test("children execute only from decoded profile specs, never model output", () => {
    const orchestration = body(
      service,
      "async #runHeadlessChildren(",
      "async #executeHeadlessChild(",
    );
    expect(orchestration).toContain("assertHeadlessChildEnvelopeV1(");
    expect(orchestration).not.toContain("executeToolCall");
    expect(orchestration).not.toContain("runRepairSession");
    const execution = body(service, "async #executeHeadlessChild(", "async #reviewUnleased(");
    const link = execution.indexOf("recordHeadlessChildLinked(");
    const plan = execution.indexOf("assertHeadlessChildPlanV1(");
    const approval = execution.indexOf("this.#store.approvePlan(");
    const binding = execution.indexOf("bindHeadlessExecutionV1(");
    const started = execution.indexOf("recordHeadlessWorkerStarted(");
    const execute = execution.indexOf("this.#execute(");
    // Lineage is recorded before planning so every child transition can
    // prove its single-active-run exemption; plan admission precedes approval.
    expect(link).toBeGreaterThanOrEqual(0);
    expect(plan).toBeGreaterThan(link);
    expect(approval).toBeGreaterThan(plan);
    expect(binding).toBeGreaterThan(approval);
    expect(started).toBeGreaterThan(binding);
    expect(execute).toBeGreaterThan(started);
    // The derived child profile closes the child-run policy again (depth 1).
    expect(children).toContain('childRuns: "deny"');
  });

  test("the parent settles only after every declared child, gated on child outcomes", () => {
    const approval = body(
      service,
      "async #approveHeadlessPlanUnleased(",
      "async #runHeadlessChildren(",
    );
    const execute = approval.indexOf("this.#execute(runId, signal, mutation)");
    const childrenCall = approval.indexOf("this.#runHeadlessChildren(");
    const settlement = approval.indexOf("createHeadlessWorkerSettlementV1(");
    expect(execute).toBeGreaterThanOrEqual(0);
    expect(childrenCall).toBeGreaterThan(execute);
    expect(settlement).toBeGreaterThan(childrenCall);
    const mapping = body(
      worker,
      "function outcomeForEvidence(",
      "headlessWorkerOutcomeForEvidenceV1",
    );
    expect(mapping).toContain('"headless.child.settled"');
    expect(mapping.indexOf('"headless.child.settled"')).toBeLessThan(
      mapping.indexOf('"review_ready", exitCode: 0'),
    );
  });

  test("child lineage is recorded exactly once with digest-bound identity", () => {
    const linked = body(store, "recordHeadlessChildLinked(", "recordHeadlessChildSettled(");
    expect(linked).toContain("HEADLESS_CHILD_ALREADY_LINKED");
    expect(linked).toContain("headless.child.linked");
    const settled = body(store, "recordHeadlessChildSettled(", "beginOperation(");
    expect(settled).toContain("headless.child.settled");
    expect(children).toContain("HEADLESS_CHILD_LINK_SCHEMA");
    expect(children).toContain("HEADLESS_CHILD_SETTLEMENT_SCHEMA");
    expect(children).toContain("DIGEST_PATTERN");
  });

  test("continuation refuses child-bearing workers", () => {
    const resume = body(service, "async resumeHeadlessWorker(", "async review(");
    expect(resume).toContain("continuation of child-bearing workers is a later slice");
    expect(resume).toContain("HEADLESS_CONTINUATION_DENIED");
  });
});
