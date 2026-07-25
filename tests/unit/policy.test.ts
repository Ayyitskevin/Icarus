import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import type { PatchSetPreimage } from "../../packages/core/src/policy.js";
import {
  applyExactReplacement,
  checkpointDigest,
  parseEditProposal,
  parsePatchSet,
  parsePlanProposal,
  planApprovalDigest,
  resolveFileEdit,
  treeCheckpointDigest,
} from "../../packages/core/src/policy.js";
import type {
  CheckpointFile,
  EditProposal,
  FileEdit,
  FileReplacement,
} from "../../packages/core/src/types.js";
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

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
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
    targets: UNIT_PLAN.targets,
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
      { ...planInput, targets: ["src/other.txt"] },
      { ...planInput, targets: [...planInput.targets, "src/other.txt"] },
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
        ceiling: {
          ...planInput.ceiling,
          maxFilesChanged: planInput.ceiling.maxFilesChanged + 1,
        },
      },
      {
        ...planInput,
        plan: { ...planInput.plan, summary: "A different approved plan" },
      },
      {
        ...planInput,
        plan: { ...planInput.plan, targets: [...planInput.plan.targets, "src/other.txt"] },
      },
    ];

    for (const mutation of mutations) {
      expect(planApprovalDigest(mutation)).not.toBe(baseline);
    }
  });

  it("binds a legacy checkpoint to run, base, target, baseline, and approved bytes", () => {
    const input = {
      runId: UNIT_RUN_ID,
      baseCommit: UNIT_BASE_COMMIT,
      target: "src/greeting.txt",
      baselineBase64: base64("hello\n"),
      approvedBase64: base64("goodbye\n"),
    };
    const baseline = checkpointDigest(input);
    const mutations = [
      { ...input, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { ...input, baseCommit: "a".repeat(40) },
      { ...input, target: "src/other.txt" },
      { ...input, baselineBase64: base64("HELLO\n") },
      { ...input, approvedBase64: base64("GOODBYE\n") },
    ];

    for (const mutation of mutations) {
      expect(checkpointDigest(mutation)).not.toBe(baseline);
    }
  });

  it("binds a tree checkpoint to run, base, and every path's operation and bytes", () => {
    const files: readonly CheckpointFile[] = [
      {
        path: "src/greeting.txt",
        op: "modify",
        baselineBase64: base64("hello\n"),
        approvedBase64: base64("goodbye\n"),
      },
      {
        path: "src/created.txt",
        op: "create",
        baselineBase64: null,
        approvedBase64: base64("created\n"),
      },
      {
        path: "src/removed.txt",
        op: "delete",
        baselineBase64: base64("removed\n"),
        approvedBase64: null,
      },
    ];
    const input = { runId: UNIT_RUN_ID, baseCommit: UNIT_BASE_COMMIT, files };
    const baseline = treeCheckpointDigest(input);

    const patch = (path: string, overrides: Partial<CheckpointFile>): readonly CheckpointFile[] =>
      files.map((file) => (file.path === path ? { ...file, ...overrides } : file));

    const mutations = [
      { ...input, runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { ...input, baseCommit: "a".repeat(40) },
      { ...input, files: patch("src/greeting.txt", { path: "src/other.txt" }) },
      { ...input, files: patch("src/greeting.txt", { baselineBase64: base64("HELLO\n") }) },
      { ...input, files: patch("src/greeting.txt", { approvedBase64: base64("GOODBYE\n") }) },
      { ...input, files: patch("src/created.txt", { op: "modify" }) },
      // A missing side must never collapse into an empty file.
      { ...input, files: patch("src/created.txt", { baselineBase64: "" }) },
      { ...input, files: patch("src/removed.txt", { approvedBase64: "" }) },
      { ...input, files: files.filter((file) => file.op !== "delete") },
    ];

    for (const mutation of mutations) {
      expect(treeCheckpointDigest(mutation)).not.toBe(baseline);
    }

    // The digest binds the set of affected paths, not the order they arrived in.
    expect(treeCheckpointDigest({ ...input, files: [...files].reverse() })).toBe(baseline);
  });
});

describe("provider proposal policy", () => {
  const target = "src/greeting.txt";
  const secondTarget = "src/farewell.txt";
  const selection = [target, secondTarget];
  const checks = [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }];
  const plan = {
    summary: "Update one tracked file.",
    steps: ["Apply one exact replacement."],
    risks: [],
    target,
    targets: [target],
    repairIterations: 0,
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

  it("accepts a plan whose targets are a sorted subset of the selection", () => {
    const parsed = parsePlanProposal(
      { ...plan, targets: [secondTarget, target] },
      selection,
      checks,
    );
    expect(parsed.target).toBe(target);
    expect(parsed.targets).toEqual([...selection].sort());
  });

  it.each([
    ["command", "forbidden-command"],
    ["tool", "shell"],
    ["argv", ["sh", "-c", "forbidden-command"]],
  ])("rejects a model-proposed plan %s field", (key, value) => {
    expectIcarusCode(
      () => parsePlanProposal({ ...plan, [key]: value }, selection, checks),
      "INVALID_PROVIDER_OUTPUT",
    );
  });

  it.each([
    ["unregistered", ["unregistered"]],
    ["duplicate", ["unit", "unit"]],
  ])("rejects %s model-selected checks", (_case, checkIds) => {
    expectIcarusCode(
      () => parsePlanProposal({ ...plan, checkIds }, selection, checks),
      "CHECK_MISMATCH",
    );
  });

  it("rejects a plan that leaves the operator-selected anchor or selection", () => {
    expectIcarusCode(
      () => parsePlanProposal({ ...plan, target: secondTarget }, selection, checks),
      "TARGET_MISMATCH",
    );
    expectIcarusCode(
      () => parsePlanProposal({ ...plan, targets: ["src/other.txt"] }, selection, checks),
      "TARGET_MISMATCH",
    );
    expectIcarusCode(
      () => parsePlanProposal({ ...plan, targets: [target, target] }, selection, checks),
      "TARGET_MISMATCH",
    );
  });

  it("rejects a plan when the operator selected nothing", () => {
    expectIcarusCode(() => parsePlanProposal(plan, [], checks), "INVALID_TARGET_SELECTION");
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

describe("patch set policy", () => {
  const target = "src/greeting.txt";
  const createdTarget = "src/created.txt";
  const removedTarget = "src/removed.txt";
  const preimage = "hello\n";
  const removedPreimage = "farewell\n";
  const approvedTargets = [createdTarget, removedTarget, target];
  const preimages = new Map<string, PatchSetPreimage>([
    [target, { exists: true, sha256: sha256(preimage) }],
    [createdTarget, { exists: false, sha256: null }],
    [removedTarget, { exists: true, sha256: sha256(removedPreimage) }],
  ]);
  const modifyEdit = {
    op: "modify",
    path: target,
    expectedPreimageSha256: sha256(preimage),
    replacements: [{ findText: "hello", replaceText: "goodbye" }],
    content: null,
    rationale: "Update the fixture greeting.",
  };
  const createEdit = {
    op: "create",
    path: createdTarget,
    expectedPreimageSha256: null,
    replacements: null,
    content: "created\n",
    rationale: "Add the new fixture.",
  };
  const deleteEdit = {
    op: "delete",
    path: removedTarget,
    expectedPreimageSha256: sha256(removedPreimage),
    replacements: null,
    content: null,
    rationale: "Remove the stale fixture.",
  };
  const patchSet = {
    summary: "Change exactly the approved paths.",
    edits: [modifyEdit, createEdit, deleteEdit],
  };

  it("accepts a patch set confined to the approved paths", () => {
    const parsed = parsePatchSet(patchSet, approvedTargets, preimages, 8);
    expect(parsed.edits.map((fileEdit) => [fileEdit.path, fileEdit.op])).toEqual([
      [target, "modify"],
      [createdTarget, "create"],
      [removedTarget, "delete"],
    ]);
  });

  it.each([
    ["command", "forbidden-command"],
    ["tool", "shell"],
    ["argv", ["sh", "-c", "forbidden-command"]],
  ])("rejects a model-proposed patch-set edit %s field", (key, value) => {
    expectIcarusCode(
      () =>
        parsePatchSet(
          { ...patchSet, edits: [{ ...modifyEdit, [key]: value }] },
          approvedTargets,
          preimages,
          8,
        ),
      "INVALID_PROVIDER_OUTPUT",
    );
  });

  it("rejects a patch set that reaches outside the approved paths", () => {
    expectIcarusCode(
      () =>
        parsePatchSet(
          { ...patchSet, edits: [{ ...modifyEdit, path: "src/other.txt" }] },
          approvedTargets,
          preimages,
          8,
        ),
      "TARGET_MISMATCH",
    );
  });

  it("rejects a patch set that reaches a protected path", () => {
    expectIcarusCode(
      () =>
        parsePatchSet(
          { ...patchSet, edits: [{ ...modifyEdit, path: ".git/config" }] },
          [...approvedTargets, ".git/config"],
          new Map([...preimages, [".git/config", { exists: true, sha256: sha256(preimage) }]]),
          8,
        ),
      "PROTECTED_PATH",
    );
  });

  it("rejects more changed files than the ceiling permits", () => {
    expectIcarusCode(
      () => parsePatchSet(patchSet, approvedTargets, preimages, 2),
      "FILE_BUDGET_EXCEEDED",
    );
  });

  it("rejects a patch set that changes the same path twice", () => {
    expectIcarusCode(
      () =>
        parsePatchSet(
          { ...patchSet, edits: [modifyEdit, modifyEdit] },
          approvedTargets,
          preimages,
          8,
        ),
      "INVALID_PROVIDER_OUTPUT",
    );
  });

  it("rejects a patch set bound to the wrong preimage", () => {
    expectIcarusCode(
      () =>
        parsePatchSet(
          { ...patchSet, edits: [{ ...modifyEdit, expectedPreimageSha256: sha256("stale\n") }] },
          approvedTargets,
          preimages,
          8,
        ),
      "STALE_PREIMAGE",
    );
  });

  it("rejects operations that contradict the worktree state", () => {
    expectIcarusCode(
      () =>
        parsePatchSet(
          { ...patchSet, edits: [{ ...createEdit, path: target }] },
          approvedTargets,
          preimages,
          8,
        ),
      "TARGET_MISMATCH",
    );
    expectIcarusCode(
      () =>
        parsePatchSet(
          {
            ...patchSet,
            edits: [{ ...modifyEdit, path: createdTarget, expectedPreimageSha256: null }],
          },
          approvedTargets,
          preimages,
          8,
        ),
      "TARGET_MISMATCH",
    );
  });

  it("rejects edits that mix operation payloads", () => {
    const mixtures = [
      { ...createEdit, expectedPreimageSha256: sha256(preimage) },
      { ...createEdit, replacements: [{ findText: "a", replaceText: "b" }] },
      { ...createEdit, content: null },
      { ...deleteEdit, content: "still here\n" },
      { ...deleteEdit, replacements: [{ findText: "a", replaceText: "b" }] },
      { ...modifyEdit, content: "whole file\n" },
      { ...modifyEdit, replacements: null },
      { ...modifyEdit, replacements: [] },
    ];
    for (const mixture of mixtures) {
      expectIcarusCode(
        () => parsePatchSet({ ...patchSet, edits: [mixture] }, approvedTargets, preimages, 8),
        "INVALID_PROVIDER_OUTPUT",
      );
    }
  });
});

describe("patch set resolution", () => {
  const target = "src/greeting.txt";
  const rationale = "Update the fixture greeting.";

  function modifyFor(preimage: string, replacements: readonly FileReplacement[]): FileEdit {
    return {
      op: "modify",
      path: target,
      expectedPreimageSha256: sha256(preimage),
      replacements,
      rationale,
    };
  }

  it("applies ordered replacements", () => {
    const preimage = "before hello after\n";
    expect(
      resolveFileEdit(
        modifyFor(preimage, [{ findText: "hello", replaceText: "goodbye" }]),
        preimage,
        1_024,
      ),
    ).toBe("before goodbye after\n");
  });

  it("applies each replacement against the previous result", () => {
    const preimage = "one two\n";
    expect(
      resolveFileEdit(
        modifyFor(preimage, [
          { findText: "one", replaceText: "three" },
          { findText: "three two", replaceText: "four" },
        ]),
        preimage,
        1_024,
      ),
    ).toBe("four\n");
  });

  it("resolves a create to its content and a delete to no bytes", () => {
    const preimage = "hello\n";
    expect(
      resolveFileEdit({ op: "create", path: target, content: "created\n", rationale }, null, 1_024),
    ).toBe("created\n");
    expect(
      resolveFileEdit(
        {
          op: "delete",
          path: target,
          expectedPreimageSha256: sha256(preimage),
          rationale,
        },
        preimage,
        1_024,
      ),
    ).toBeNull();
  });

  it("rejects a stale preimage digest", () => {
    const preimage = "hello\n";
    expectIcarusCode(
      () =>
        resolveFileEdit(
          modifyFor(preimage, [{ findText: "hello", replaceText: "goodbye" }]),
          "changed hello\n",
          1_024,
        ),
      "STALE_PREIMAGE",
    );
    expectIcarusCode(
      () =>
        resolveFileEdit(
          {
            op: "delete",
            path: target,
            expectedPreimageSha256: sha256(preimage),
            rationale,
          },
          "changed hello\n",
          1_024,
        ),
      "STALE_PREIMAGE",
    );
  });

  it("rejects missing and ambiguous matches, including overlaps", () => {
    const missing = "good morning\n";
    expectIcarusCode(
      () =>
        resolveFileEdit(
          modifyFor(missing, [{ findText: "hello", replaceText: "goodbye" }]),
          missing,
          1_024,
        ),
      "EDIT_NO_MATCH",
    );

    const repeated = "hello and hello\n";
    expectIcarusCode(
      () =>
        resolveFileEdit(
          modifyFor(repeated, [{ findText: "hello", replaceText: "goodbye" }]),
          repeated,
          1_024,
        ),
      "EDIT_AMBIGUOUS",
    );

    const overlapping = "aaa";
    expectIcarusCode(
      () =>
        resolveFileEdit(
          modifyFor(overlapping, [{ findText: "aa", replaceText: "b" }]),
          overlapping,
          1_024,
        ),
      "EDIT_AMBIGUOUS",
    );
  });

  it("rejects no-op and oversized replacements", () => {
    const preimage = "hello\n";
    expectIcarusCode(
      () =>
        resolveFileEdit(
          modifyFor(preimage, [{ findText: "hello", replaceText: "hello" }]),
          preimage,
          1_024,
        ),
      "EMPTY_DIFF",
    );
    expectIcarusCode(
      () =>
        resolveFileEdit(
          modifyFor(preimage, [{ findText: "hello", replaceText: "longer" }]),
          preimage,
          6,
        ),
      "FILE_BUDGET_EXCEEDED",
    );
    expectIcarusCode(
      () => resolveFileEdit({ op: "create", path: target, content: "", rationale }, null, 1_024),
      "EMPTY_DIFF",
    );
    expectIcarusCode(
      () =>
        resolveFileEdit({ op: "create", path: target, content: "longer\n", rationale }, null, 6),
      "FILE_BUDGET_EXCEEDED",
    );
  });
});

describe("legacy exact replacement", () => {
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
