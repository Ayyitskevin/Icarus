import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  applyExactReplacement,
  checkpointDigest,
  parseEditProposal,
  parsePlanProposal,
  planApprovalDigest,
} from "../../packages/core/src/policy.js";
import type { EditProposal } from "../../packages/core/src/types.js";
import {
  UNIT_BASE_COMMIT,
  UNIT_CEILING,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
  UNIT_SANDBOX,
} from "../support/unit-fixtures.js";

function expectIcarusCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected Icarus error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

function editFor(preimage: string, overrides: Partial<EditProposal> = {}): EditProposal {
  return {
    path: "src/greeting.txt",
    expectedPreimageSha256: sha256(preimage),
    findText: "hello",
    replaceText: "goodbye",
    rationale: "Update the fixture greeting.",
    ...overrides,
  };
}

describe("approval digests", () => {
  const planInput = {
    task: "Update the greeting",
    baseCommit: UNIT_BASE_COMMIT,
    contextSha256: "e".repeat(64),
    target: UNIT_PLAN.target,
    provider: UNIT_PROVIDER,
    checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }],
    sandbox: UNIT_SANDBOX,
    ceiling: UNIT_CEILING,
    plan: UNIT_PLAN,
  };

  it("binds plan approval to every security-relevant manifest section", () => {
    const baseline = planApprovalDigest(planInput);
    const mutations = [
      { ...planInput, task: "A different task" },
      { ...planInput, baseCommit: "f".repeat(40) },
      { ...planInput, contextSha256: "0".repeat(64) },
      { ...planInput, target: "src/other.txt" },
      {
        ...planInput,
        provider: { ...planInput.provider, model: "another-model" },
      },
      {
        ...planInput,
        checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test", "--watch"] }],
      },
      {
        ...planInput,
        sandbox: { ...planInput.sandbox, memoryMb: planInput.sandbox.memoryMb + 1 },
      },
      {
        ...planInput,
        ceiling: { ...planInput.ceiling, maxToolCalls: planInput.ceiling.maxToolCalls + 1 },
      },
      {
        ...planInput,
        plan: { ...planInput.plan, summary: "A different approved plan" },
      },
    ];

    for (const mutation of mutations) {
      expect(planApprovalDigest(mutation)).not.toBe(baseline);
    }
  });

  it("binds a checkpoint to run, base, target, baseline, and approved bytes", () => {
    const input = {
      runId: UNIT_RUN_ID,
      baseCommit: UNIT_BASE_COMMIT,
      target: "src/greeting.txt",
      baselineBase64: Buffer.from("hello\n").toString("base64"),
      approvedBase64: Buffer.from("goodbye\n").toString("base64"),
    };
    const baseline = checkpointDigest(input);
    const mutations = [
      { ...input, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { ...input, baseCommit: "a".repeat(40) },
      { ...input, target: "src/other.txt" },
      { ...input, baselineBase64: Buffer.from("HELLO\n").toString("base64") },
      { ...input, approvedBase64: Buffer.from("GOODBYE\n").toString("base64") },
    ];

    for (const mutation of mutations) {
      expect(checkpointDigest(mutation)).not.toBe(baseline);
    }
  });
});

describe("provider proposal policy", () => {
  const target = "src/greeting.txt";
  const checks = [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }];
  const plan = {
    summary: "Update one tracked file.",
    steps: ["Apply one exact replacement."],
    risks: [],
    target,
    checkIds: ["unit"],
  };
  const preimageSha256 = sha256("hello\n");
  const edit = {
    path: target,
    expectedPreimageSha256: preimageSha256,
    findText: "hello",
    replaceText: "goodbye",
    rationale: "Update the fixture greeting.",
  };

  it.each([
    ["command", "forbidden-command"],
    ["tool", "shell"],
    ["argv", ["sh", "-c", "forbidden-command"]],
  ])("rejects a model-proposed plan %s field", (key, value) => {
    expectIcarusCode(
      () => parsePlanProposal({ ...plan, [key]: value }, target, checks),
      "INVALID_PROVIDER_OUTPUT",
    );
  });

  it.each([
    ["unregistered", ["unregistered"]],
    ["duplicate", ["unit", "unit"]],
  ])("rejects %s model-selected checks", (_case, checkIds) => {
    expectIcarusCode(
      () => parsePlanProposal({ ...plan, checkIds }, target, checks),
      "CHECK_MISMATCH",
    );
  });

  it.each([
    ["command", "forbidden-command"],
    ["tool", "shell"],
    ["argv", ["sh", "-c", "forbidden-command"]],
  ])("rejects a model-proposed edit %s field", (key, value) => {
    expectIcarusCode(
      () => parseEditProposal({ ...edit, [key]: value }, target, preimageSha256),
      "INVALID_PROVIDER_OUTPUT",
    );
  });
});

describe("exact replacement", () => {
  it("applies one exact replacement", () => {
    const preimage = "before hello after\n";
    expect(applyExactReplacement(preimage, editFor(preimage), 1_024)).toBe(
      "before goodbye after\n",
    );
  });

  it("rejects a stale preimage digest", () => {
    const preimage = "hello\n";
    expectIcarusCode(
      () => applyExactReplacement("changed hello\n", editFor(preimage), 1_024),
      "STALE_PREIMAGE",
    );
  });

  it("rejects missing and ambiguous matches, including overlaps", () => {
    const missing = "good morning\n";
    expectIcarusCode(
      () => applyExactReplacement(missing, editFor(missing), 1_024),
      "EDIT_NO_MATCH",
    );

    const repeated = "hello and hello\n";
    expectIcarusCode(
      () => applyExactReplacement(repeated, editFor(repeated), 1_024),
      "EDIT_AMBIGUOUS",
    );

    const overlapping = "aaa";
    expectIcarusCode(
      () =>
        applyExactReplacement(
          overlapping,
          editFor(overlapping, { findText: "aa", replaceText: "b" }),
          1_024,
        ),
      "EDIT_AMBIGUOUS",
    );
  });

  it("rejects no-op and oversized replacements", () => {
    const preimage = "hello\n";
    expectIcarusCode(
      () => applyExactReplacement(preimage, editFor(preimage, { replaceText: "hello" }), 1_024),
      "EMPTY_DIFF",
    );
    expectIcarusCode(
      () => applyExactReplacement(preimage, editFor(preimage, { replaceText: "longer" }), 6),
      "FILE_BUDGET_EXCEEDED",
    );
  });
});
