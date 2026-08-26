import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const reconstruction = readFileSync(
  new URL("../../packages/core/src/headless-reconstruction.ts", import.meta.url),
  "utf8",
);
const binding = readFileSync(
  new URL("../../packages/core/src/headless-binding.ts", import.meta.url),
  "utf8",
);
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

describe("headless reconstruction security contract", () => {
  test("the projection module performs no I/O and creates no authority", () => {
    expect(reconstruction).not.toMatch(
      /node:fs|node:child_process|node:net|fetch\(|createGateway|RunLeaseManager/,
    );
    expect(reconstruction).not.toMatch(
      /approvePlan|approveEgress|beginOperation|appendEvent|recordResume|markStarted|recordHeadlessWorker|#execute/,
    );
  });

  test("reconstruction and binding stay on the same digest path", () => {
    expect(binding).toContain("function bindHeadlessExecutionCurrentV1(");
    // The pristine-snapshot assertion lives inside the shared path, gated by an
    // explicit flag, AFTER host-shape validation — never before it (PR #57
    // review: a malformed host record must fail closed, not throw TypeError).
    const shared = body(
      binding,
      "function bindHeadlessExecutionCurrentV1(",
      "export function bindHeadlessExecutionV1(",
    );
    expect(shared).toContain("requirePristineSnapshot: boolean");
    const hostCheck = shared.indexOf('invalidHost("Host run record is invalid")');
    const pristineCheck = shared.indexOf("assertPristineRunningRun(run)");
    expect(hostCheck).toBeGreaterThanOrEqual(0);
    expect(pristineCheck).toBeGreaterThan(hostCheck);
    const admission = body(binding, "export function bindHeadlessExecutionV1(", "/**\n * H3b");
    expect(admission).toContain("bindHeadlessExecutionCurrentV1(profile, authority, true)");
    const reconstructionEntry = binding.slice(
      binding.indexOf("export function reconstructHeadlessExecutionBindingV1("),
    );
    expect(reconstructionEntry).toContain(
      "bindHeadlessExecutionCurrentV1(profile, authority, false)",
    );
    expect(reconstructionEntry).not.toContain("assertPristineRunningRun");
  });

  test("the recomputed binding must equal the durable lifecycle digest before any result", () => {
    const projection = body(
      reconstruction,
      "export function reconstructHeadlessEvidenceV1(",
      "reconstructionDigestSha256: digestJson",
    );
    const bindingCall = projection.indexOf("reconstructHeadlessExecutionBindingV1(");
    const comparison = projection.indexOf(
      "binding.bindingDigestSha256 === lifecycle.bindingDigestSha256",
    );
    const result = projection.indexOf("const payload = {");
    expect(bindingCall).toBeGreaterThanOrEqual(0);
    expect(comparison).toBeGreaterThan(bindingCall);
    expect(result).toBeGreaterThan(comparison);
    expect(projection).toContain("HEADLESS_RECONSTRUCTION_AUTHORITY_DENIED");
  });

  test("classification labels are closed and fail-closed", () => {
    expect(reconstruction).toContain('"no_effect" | "durably_settled" | "ambiguous"');
    expect(reconstruction).toContain('let disposition: HeadlessEffectDispositionV1 = "ambiguous"');
    expect(reconstruction).toContain("NO_EFFECT_OPERATION_KINDS");
    expect(reconstruction).toContain("KNOWN_OPERATION_KINDS");
    expect(reconstruction).toContain("HEADLESS_RECONSTRUCTION_EFFECT_LIMIT");
    // Resume intent inside the lifecycle is malformed evidence, never input.
    expect(reconstruction).toContain('"resume.requested"');
  });

  test("the service read path holds no lease and mutates nothing", () => {
    const method = body(service, "reconstructHeadlessEvidence(runId: string)", "async review(");
    expect(method).not.toContain("withLease");
    expect(method).not.toMatch(
      /recordResumeRequested|markStartedOperationsInterrupted|beginOperation|recordHeadlessWorker|appendEvent|approvePlan|approveEgress|#execute\(/,
    );
    expect(method).toContain("reconstructHeadlessEvidenceV1({");
    expect(method).toContain("getRunHistory(runId)");
  });

  test("the CLI command emits one canonical record and keeps exit 0", () => {
    const command = body(cli, 'if (action === "reconstruct-headless")', 'if (action === "status")');
    expect(command).toContain("reconstructHeadlessEvidence(oneRunId(options))");
    expect(command).toContain("canonicalJsonLine(result as unknown as JsonValue)");
    expect(command).not.toContain("process.exitCode");
    expect(command).not.toContain("runtime.service.history");
    expect(cli).toContain('"icarus run reconstruct-headless RUN"');
  });
});
