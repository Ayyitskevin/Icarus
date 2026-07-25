import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  MAX_REPLACEMENTS_PER_FILE,
  type PatchSetPreimage,
  parsePatchSet,
  resolveFileEdit,
  treeCheckpointDigest,
} from "../../packages/core/src/policy.js";
import type { CheckpointFile, FileEdit } from "../../packages/core/src/types.js";

const APP = "src/app.ts";
const HELPER = "src/helper.ts";
const CREATED = "src/created.ts";
const APP_TEXT = "export const value = 1;\nexport const other = 2;\n";
const HELPER_TEXT = "export function helper(): number {\n  return 1;\n}\n";

function preimages(
  overrides: Record<string, PatchSetPreimage> = {},
): Map<string, PatchSetPreimage> {
  return new Map<string, PatchSetPreimage>([
    [APP, { exists: true, sha256: sha256(APP_TEXT) }],
    [HELPER, { exists: true, sha256: sha256(HELPER_TEXT) }],
    [CREATED, { exists: false, sha256: null }],
    ...Object.entries(overrides),
  ]);
}

function modifyEdit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    op: "modify",
    path: APP,
    expectedPreimageSha256: sha256(APP_TEXT),
    replacements: [{ findText: "value = 1", replaceText: "value = 2" }],
    content: null,
    rationale: "Change the value.",
    ...overrides,
  };
}

function createEdit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    op: "create",
    path: CREATED,
    expectedPreimageSha256: null,
    replacements: null,
    content: "export const created = true;\n",
    rationale: "Add the module.",
    ...overrides,
  };
}

function deleteEdit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    op: "delete",
    path: HELPER,
    expectedPreimageSha256: sha256(HELPER_TEXT),
    replacements: null,
    content: null,
    rationale: "Remove the helper.",
    ...overrides,
  };
}

function parse(
  edits: readonly Record<string, unknown>[],
  options: {
    readonly approved?: readonly string[];
    readonly maxFilesChanged?: number;
    readonly preimages?: Map<string, PatchSetPreimage>;
  } = {},
): ReturnType<typeof parsePatchSet> {
  return parsePatchSet(
    { summary: "Bounded change.", edits },
    options.approved ?? [APP, HELPER, CREATED],
    options.preimages ?? preimages(),
    options.maxFilesChanged ?? 8,
  );
}

function expectCode(action: () => unknown, code: string): IcarusError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
    return error as IcarusError;
  }
  throw new Error(`Expected ${code}`);
}

describe("patch-set policy", () => {
  it("accepts a mixed modify, create, and delete patch set across approved paths", () => {
    const patchSet = parse([modifyEdit(), createEdit(), deleteEdit()]);

    expect(patchSet.edits.map((edit) => `${edit.op}:${edit.path}`)).toEqual([
      `modify:${APP}`,
      `create:${CREATED}`,
      `delete:${HELPER}`,
    ]);
    expect(resolveFileEdit(patchSet.edits[0] as FileEdit, APP_TEXT, 4_096)).toBe(
      "export const value = 2;\nexport const other = 2;\n",
    );
    expect(resolveFileEdit(patchSet.edits[1] as FileEdit, null, 4_096)).toBe(
      "export const created = true;\n",
    );
    expect(resolveFileEdit(patchSet.edits[2] as FileEdit, HELPER_TEXT, 4_096)).toBeNull();
  });

  it("applies ordered replacements against the evolving content", () => {
    const patchSet = parse([
      modifyEdit({
        replacements: [
          { findText: "value = 1", replaceText: "value = 10" },
          { findText: "other = 2", replaceText: "other = 20" },
        ],
      }),
    ]);

    expect(resolveFileEdit(patchSet.edits[0] as FileEdit, APP_TEXT, 4_096)).toBe(
      "export const value = 10;\nexport const other = 20;\n",
    );
  });

  it("refuses a path outside the approved targets", () => {
    expectCode(() => parse([modifyEdit({ path: "src/unapproved.ts" })]), "TARGET_MISMATCH");
  });

  it("refuses a protected path even when it was approved", () => {
    const protectedPath = ".github/workflows/ci.yml";
    expectCode(
      () =>
        parse([modifyEdit({ path: protectedPath })], {
          approved: [protectedPath],
          preimages: new Map([[protectedPath, { exists: true, sha256: sha256("x") }]]),
        }),
      "PROTECTED_PATH",
    );
  });

  it("refuses a traversal or absolute path", () => {
    for (const path of ["../escape.ts", "/etc/passwd", "src/../../escape.ts"]) {
      expectCode(
        () =>
          parse([modifyEdit({ path })], {
            approved: [path],
            preimages: new Map([[path, { exists: true, sha256: sha256("x") }]]),
          }),
        "INVALID_PATH",
      );
    }
  });

  it("refuses a stale preimage binding", () => {
    expectCode(
      () => parse([modifyEdit({ expectedPreimageSha256: sha256("different") })]),
      "STALE_PREIMAGE",
    );
  });

  it("refuses creating a path that already exists and modifying one that does not", () => {
    expectCode(() => parse([createEdit({ path: APP })]), "TARGET_MISMATCH");
    expectCode(() => parse([modifyEdit({ path: CREATED })]), "TARGET_MISMATCH");
    expectCode(() => parse([deleteEdit({ path: CREATED })]), "TARGET_MISMATCH");
  });

  it("refuses cross-contaminated operation fields", () => {
    expectCode(
      () => parse([createEdit({ expectedPreimageSha256: sha256("x") })]),
      "INVALID_PROVIDER_OUTPUT",
    );
    expectCode(() => parse([createEdit({ content: null })]), "INVALID_PROVIDER_OUTPUT");
    expectCode(() => parse([modifyEdit({ content: "whole file" })]), "INVALID_PROVIDER_OUTPUT");
    expectCode(() => parse([modifyEdit({ replacements: [] })]), "INVALID_PROVIDER_OUTPUT");
    expectCode(() => parse([deleteEdit({ content: "text" })]), "INVALID_PROVIDER_OUTPUT");
    expectCode(
      () => parse([deleteEdit({ replacements: [{ findText: "a", replaceText: "b" }] })]),
      "INVALID_PROVIDER_OUTPUT",
    );
  });

  it("refuses unknown fields and unsupported operations", () => {
    expectCode(() => parse([modifyEdit({ command: "rm -rf /" })]), "INVALID_PROVIDER_OUTPUT");
    expectCode(() => parse([modifyEdit({ op: "rename" })]), "INVALID_PROVIDER_OUTPUT");
  });

  it("refuses the same path twice in one patch set", () => {
    expectCode(() => parse([modifyEdit(), modifyEdit()]), "INVALID_PROVIDER_OUTPUT");
  });

  it("refuses more files than the project ceiling permits", () => {
    expectCode(
      () => parse([modifyEdit(), createEdit(), deleteEdit()], { maxFilesChanged: 2 }),
      "FILE_BUDGET_EXCEEDED",
    );
    expect(parse([modifyEdit(), createEdit()], { maxFilesChanged: 2 }).edits).toHaveLength(2);
  });

  it("refuses more replacements than the per-file ceiling permits", () => {
    const replacements = Array.from({ length: MAX_REPLACEMENTS_PER_FILE + 1 }, (_, index) => ({
      findText: `token-${index}`,
      replaceText: `value-${index}`,
    }));
    expectCode(() => parse([modifyEdit({ replacements })]), "INVALID_PROVIDER_OUTPUT");
  });

  it("refuses an empty patch set", () => {
    expectCode(() => parse([]), "INVALID_PROVIDER_OUTPUT");
  });

  it("refuses a replacement that does not match exactly once", () => {
    const patchSet = parse([
      modifyEdit({ replacements: [{ findText: "export const", replaceText: "export let" }] }),
    ]);
    expectCode(
      () => resolveFileEdit(patchSet.edits[0] as FileEdit, APP_TEXT, 4_096),
      "EDIT_AMBIGUOUS",
    );

    const missing = parse([
      modifyEdit({ replacements: [{ findText: "absent text", replaceText: "x" }] }),
    ]);
    expectCode(
      () => resolveFileEdit(missing.edits[0] as FileEdit, APP_TEXT, 4_096),
      "EDIT_NO_MATCH",
    );
  });

  it("refuses a no-op modify and an over-ceiling result", () => {
    const noop = parse([
      modifyEdit({ replacements: [{ findText: "value = 1", replaceText: "value = 1" }] }),
    ]);
    expectCode(() => resolveFileEdit(noop.edits[0] as FileEdit, APP_TEXT, 4_096), "EMPTY_DIFF");

    const patchSet = parse([modifyEdit()]);
    expectCode(
      () => resolveFileEdit(patchSet.edits[0] as FileEdit, APP_TEXT, 8),
      "FILE_BUDGET_EXCEEDED",
    );
  });

  it("refuses bytes that changed after the patch set was proposed", () => {
    const patchSet = parse([modifyEdit()]);
    expectCode(
      () => resolveFileEdit(patchSet.edits[0] as FileEdit, `${APP_TEXT}drift\n`, 4_096),
      "STALE_PREIMAGE",
    );
  });
});

describe("tree checkpoint digest", () => {
  const files: readonly CheckpointFile[] = [
    {
      path: APP,
      op: "modify",
      baselineBase64: Buffer.from(APP_TEXT, "utf8").toString("base64"),
      approvedBase64: Buffer.from("changed\n", "utf8").toString("base64"),
    },
    {
      path: CREATED,
      op: "create",
      baselineBase64: null,
      approvedBase64: Buffer.from("created\n", "utf8").toString("base64"),
    },
    {
      path: HELPER,
      op: "delete",
      baselineBase64: Buffer.from(HELPER_TEXT, "utf8").toString("base64"),
      approvedBase64: null,
    },
  ];
  const input = {
    runId: "00000000-0000-4000-8000-000000000001",
    baseCommit: "a".repeat(40),
    files,
  };

  it("is stable across file ordering", () => {
    expect(treeCheckpointDigest({ ...input, files: [...files].reverse() })).toBe(
      treeCheckpointDigest(input),
    );
  });

  it("changes when any path, operation, or byte side changes", () => {
    const baseline = treeCheckpointDigest(input);
    const mutations: readonly CheckpointFile[][] = [
      [{ ...(files[0] as CheckpointFile), path: "src/renamed.ts" }, ...files.slice(1)],
      [{ ...(files[0] as CheckpointFile), op: "delete" }, ...files.slice(1)],
      [
        {
          ...(files[0] as CheckpointFile),
          approvedBase64: Buffer.from("other\n", "utf8").toString("base64"),
        },
        ...files.slice(1),
      ],
      [{ ...(files[1] as CheckpointFile), baselineBase64: "" }, ...files.slice(2)],
      files.slice(1),
    ];
    for (const mutated of mutations) {
      expect(treeCheckpointDigest({ ...input, files: mutated })).not.toBe(baseline);
    }
  });

  it("distinguishes an absent side from empty content", () => {
    const empty = Buffer.from("", "utf8").toString("base64");
    expect(
      treeCheckpointDigest({
        ...input,
        files: [{ path: CREATED, op: "create", baselineBase64: empty, approvedBase64: empty }],
      }),
    ).not.toBe(
      treeCheckpointDigest({
        ...input,
        files: [{ path: CREATED, op: "create", baselineBase64: null, approvedBase64: empty }],
      }),
    );
  });
});
