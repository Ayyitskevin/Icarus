import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  assertReadableBytes,
  assertReadableManifest,
  MAX_GRANT_CALLS,
  MAX_READABLE_FILES,
  parseCapabilityGrants,
  parsePlanProposal,
  planApprovalDigest,
  readableManifestDigest,
} from "../../packages/core/src/policy.js";
import type { CheckProfile, ReadableManifest } from "../../packages/core/src/types.js";
import {
  UNIT_BASE_COMMIT,
  UNIT_CEILING,
  UNIT_PLAN,
  UNIT_PROVIDER,
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

const SELECTION = ["src/greeting.txt", "README.md"] as const;
const CHECKS: readonly CheckProfile[] = [
  { id: "unit", name: "Unit check", argv: ["node", "-e", ""] },
];

function manifest(overrides: Partial<ReadableManifest> = {}): ReadableManifest {
  return {
    baseCommit: UNIT_BASE_COMMIT,
    entries: [
      { path: "src/greeting.txt", sha256: sha256("hello") },
      { path: "README.md", sha256: sha256("readme") },
    ],
    ...overrides,
  };
}

describe("capability grant validation", () => {
  it("accepts an itemized grant and returns it sorted by kind", () => {
    const grants = parseCapabilityGrants(
      [
        { kind: "exec.check", scope: ["unit"], maxCalls: 4 },
        { kind: "read.manifest", scope: ["src/"], maxCalls: 20 },
      ],
      SELECTION,
      CHECKS,
    );
    expect(grants.map((grant) => grant.kind)).toEqual(["exec.check", "read.manifest"]);
    expect(grants[0]?.maxCalls).toBe(4);
  });

  it("refuses a capability the host does not define", () => {
    expectIcarusCode(
      () =>
        parseCapabilityGrants([{ kind: "exec.shell", scope: [], maxCalls: 1 }], SELECTION, CHECKS),
      "UNKNOWN_CAPABILITY",
    );
  });

  it("refuses a duplicate capability rather than merging scopes", () => {
    expectIcarusCode(
      () =>
        parseCapabilityGrants(
          [
            { kind: "exec.check", scope: ["unit"], maxCalls: 1 },
            { kind: "exec.check", scope: ["unit"], maxCalls: 8 },
          ],
          SELECTION,
          CHECKS,
        ),
      "INVALID_PROVIDER_OUTPUT",
    );
  });

  it("bounds the calls one grant may authorize", () => {
    expectIcarusCode(
      () =>
        parseCapabilityGrants(
          [{ kind: "exec.check", scope: ["unit"], maxCalls: MAX_GRANT_CALLS + 1 }],
          SELECTION,
          CHECKS,
        ),
      "INVALID_PROVIDER_OUTPUT",
    );
    expectIcarusCode(
      () =>
        parseCapabilityGrants(
          [{ kind: "exec.check", scope: ["unit"], maxCalls: 0 }],
          SELECTION,
          CHECKS,
        ),
      "INVALID_PROVIDER_OUTPUT",
    );
  });

  it("refuses a mutation grant naming a path outside the operator selection", () => {
    expectIcarusCode(
      () =>
        parseCapabilityGrants(
          [{ kind: "mutation.patchset", scope: ["src/elsewhere.txt"], maxCalls: 2 }],
          SELECTION,
          CHECKS,
        ),
      "TARGET_MISMATCH",
    );
  });

  it("refuses a check grant naming an unregistered check", () => {
    expectIcarusCode(
      () =>
        parseCapabilityGrants(
          [{ kind: "exec.check", scope: ["not-registered"], maxCalls: 1 }],
          SELECTION,
          CHECKS,
        ),
      "CHECK_MISMATCH",
    );
  });

  it("refuses a read grant escaping the repository", () => {
    expectIcarusCode(
      () =>
        parseCapabilityGrants(
          [{ kind: "read.manifest", scope: ["../outside"], maxCalls: 1 }],
          SELECTION,
          CHECKS,
        ),
      "INVALID_PATH",
    );
  });

  it("treats an absent grant list as requesting no capability", () => {
    const plan = parsePlanProposal(
      {
        summary: "Replace the greeting.",
        steps: ["Replace one exact string."],
        risks: [],
        target: "src/greeting.txt",
        targets: ["src/greeting.txt"],
        repairIterations: 0,
        checkIds: ["unit"],
      },
      SELECTION,
      CHECKS,
    );
    expect(plan.grants).toEqual([]);
  });

  it("carries requested grants through plan parsing", () => {
    const plan = parsePlanProposal(
      {
        summary: "Replace the greeting.",
        steps: ["Replace one exact string."],
        risks: [],
        target: "src/greeting.txt",
        targets: ["src/greeting.txt"],
        repairIterations: 0,
        checkIds: ["unit"],
        grants: [{ kind: "exec.check", scope: ["unit"], maxCalls: 2 }],
      },
      SELECTION,
      CHECKS,
    );
    expect(plan.grants).toHaveLength(1);
    expect(plan.grants[0]?.kind).toBe("exec.check");
  });
});

describe("readable manifest", () => {
  it("refuses a scope resolving past the host ceiling instead of truncating", () => {
    const entries = Array.from({ length: MAX_READABLE_FILES + 1 }, (_unused, index) => ({
      path: `src/file-${index}.txt`,
      sha256: sha256(`file-${index}`),
    }));
    expectIcarusCode(() => assertReadableManifest(manifest({ entries })), "READ_SCOPE_TOO_LARGE");
  });

  it("refuses duplicates, malformed digests, and protected paths", () => {
    expectIcarusCode(
      () =>
        assertReadableManifest(
          manifest({
            entries: [
              { path: "src/greeting.txt", sha256: sha256("a") },
              { path: "src/greeting.txt", sha256: sha256("b") },
            ],
          }),
        ),
      "INVALID_READ_MANIFEST",
    );
    expectIcarusCode(
      () =>
        assertReadableManifest(
          manifest({ entries: [{ path: "src/greeting.txt", sha256: "not-a-digest" }] }),
        ),
      "INVALID_READ_MANIFEST",
    );
    expectIcarusCode(
      () => assertReadableManifest(manifest({ entries: [{ path: ".env", sha256: sha256("a") }] })),
      "INVALID_READ_MANIFEST",
    );
  });

  it("refuses git internals a worktree resolver would otherwise see", () => {
    for (const gitPath of [".git", ".git/config", ".git/HEAD"]) {
      expectIcarusCode(
        () =>
          assertReadableManifest(manifest({ entries: [{ path: gitPath, sha256: sha256("a") }] })),
        "INVALID_READ_MANIFEST",
      );
    }
  });

  it("refuses an intrinsically secret path even when it is not edit-protected", () => {
    expectIcarusCode(
      () =>
        assertReadableManifest(
          manifest({ entries: [{ path: "deploy/.netrc", sha256: sha256("a") }] }),
        ),
      "INVALID_READ_MANIFEST",
    );
  });

  it("digests an equal set equally regardless of resolution order", () => {
    const forward = manifest();
    const reversed = manifest({ entries: [...forward.entries].reverse() });
    expect(readableManifestDigest(reversed)).toBe(readableManifestDigest(forward));
  });

  it("digests a different admitted set differently", () => {
    const baseline = readableManifestDigest(manifest());
    expect(
      readableManifestDigest(
        manifest({ entries: [{ path: "src/greeting.txt", sha256: sha256("hello") }] }),
      ),
    ).not.toBe(baseline);
    expect(
      readableManifestDigest(
        manifest({
          entries: [
            { path: "src/greeting.txt", sha256: sha256("changed") },
            { path: "README.md", sha256: sha256("readme") },
          ],
        }),
      ),
    ).not.toBe(baseline);
    expect(readableManifestDigest(manifest({ baseCommit: "f".repeat(40) }))).not.toBe(baseline);
  });
});

describe("read binding", () => {
  const approved = manifest();
  const noWrites = new Map<string, string>();

  it("admits bytes whose digest matches the approved entry", () => {
    expect(() =>
      assertReadableBytes({
        path: "src/greeting.txt",
        sha256: sha256("hello"),
        manifest: approved,
        sessionWritten: noWrites,
      }),
    ).not.toThrow();
  });

  it("refuses a path the manifest never admitted", () => {
    expectIcarusCode(
      () =>
        assertReadableBytes({
          path: "src/secret.txt",
          sha256: sha256("hello"),
          manifest: approved,
          sessionWritten: noWrites,
        }),
      "READ_NOT_GRANTED",
    );
  });

  it("treats changed bytes as drift rather than falling back", () => {
    expectIcarusCode(
      () =>
        assertReadableBytes({
          path: "src/greeting.txt",
          sha256: sha256("something else"),
          manifest: approved,
          sessionWritten: noWrites,
        }),
      "READ_MANIFEST_DRIFT",
    );
  });

  it("admits bytes this session recorded writing", () => {
    expect(() =>
      assertReadableBytes({
        path: "src/greeting.txt",
        sha256: sha256("patched"),
        manifest: approved,
        sessionWritten: new Map([["src/greeting.txt", sha256("patched")]]),
      }),
    ).not.toThrow();
  });

  it("refuses bytes attributed to a session write that does not match", () => {
    expectIcarusCode(
      () =>
        assertReadableBytes({
          path: "src/greeting.txt",
          sha256: sha256("tampered"),
          manifest: approved,
          sessionWritten: new Map([["src/greeting.txt", sha256("patched")]]),
        }),
      "READ_MANIFEST_DRIFT",
    );
  });
});

describe("plan approval digest binds granted authority", () => {
  const planInput = {
    task: "Update the greeting",
    baseCommit: UNIT_BASE_COMMIT,
    contextSha256: "e".repeat(64),
    targets: UNIT_PLAN.targets,
    provider: UNIT_PROVIDER,
    checks: [...CHECKS],
    sandbox: UNIT_SANDBOX,
    ceiling: UNIT_CEILING,
    plan: UNIT_PLAN,
    readableManifest: null,
  };

  it("changes when a requested grant changes", () => {
    const baseline = planApprovalDigest(planInput);
    const withGrant = planApprovalDigest({
      ...planInput,
      plan: {
        ...UNIT_PLAN,
        grants: [{ kind: "exec.check", scope: ["unit"], maxCalls: 1 }],
      },
    });
    const widerGrant = planApprovalDigest({
      ...planInput,
      plan: {
        ...UNIT_PLAN,
        grants: [{ kind: "exec.check", scope: ["unit"], maxCalls: 8 }],
      },
    });
    expect(withGrant).not.toBe(baseline);
    expect(widerGrant).not.toBe(withGrant);
  });

  it("distinguishes granting nothing from granting an empty scope", () => {
    const noManifest = planApprovalDigest(planInput);
    const emptyManifest = planApprovalDigest({
      ...planInput,
      readableManifest: { baseCommit: UNIT_BASE_COMMIT, entries: [] },
    });
    expect(emptyManifest).not.toBe(noManifest);
  });

  it("changes when the admitted readable set changes", () => {
    const narrow = planApprovalDigest({
      ...planInput,
      readableManifest: {
        baseCommit: UNIT_BASE_COMMIT,
        entries: [{ path: "src/greeting.txt", sha256: sha256("hello") }],
      },
    });
    const wide = planApprovalDigest({ ...planInput, readableManifest: manifest() });
    expect(wide).not.toBe(narrow);
  });
});
