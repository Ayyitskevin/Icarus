import { describe, expect, it } from "vitest";

import {
  decodeHeadlessProfileV1,
  headlessProfileDigest,
  resolveHeadlessProfileV1,
} from "../../packages/core/src/headless-profile.js";
import { DEFAULT_CEILING } from "../../packages/core/src/policy.js";
import type { PlanProposal } from "../../packages/core/src/types.js";

const PLAN: PlanProposal = {
  summary: "Exercise one bounded headless task",
  steps: ["inspect", "verify"],
  risks: [],
  target: "src/example.ts",
  targets: ["src/example.ts"],
  iterationCeiling: 1,
  checkIds: ["unit"],
  grants: [
    { kind: "exec.check", scope: ["unit"], maxCalls: 1 },
    { kind: "read.checks", scope: [], maxCalls: 1 },
    { kind: "read.manifest", scope: ["src"], maxCalls: 4 },
  ],
};

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    profileId: "mickey-one-task",
    providerProfileId: "local-code",
    toolIds: ["get_check_catalog", "read_file", "report_done", "run_checks"],
    budgets: { ...DEFAULT_CEILING, maxCostUsd: 0, iterationCeiling: 1 },
    output: { format: "jsonl" },
    worker: {
      mode: "one_task",
      maxConcurrency: 1,
      childRuns: "deny",
      scheduledRuns: "deny",
    },
    ...overrides,
  };
}

function authority(plan: PlanProposal = PLAN) {
  return {
    providerProfiles: [
      {
        id: "local-code",
        kind: "ollama" as const,
        model: "qwen3.8:27b",
        baseUrl: "http://127.0.0.1:11434",
        inputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: null,
      },
    ],
    projectCeiling: DEFAULT_CEILING,
    approvedPlan: plan,
  };
}

describe("headless profile decode", () => {
  it("accepts the complete H1 record and preserves an explicit empty default-deny tool set", () => {
    const decoded = decodeHeadlessProfileV1(profile({ toolIds: [] }));
    expect(decoded.profileId).toBe("mickey-one-task");
    expect(decoded.toolIds).toEqual([]);
    expect(decoded.worker).toEqual({
      mode: "one_task",
      maxConcurrency: 1,
      childRuns: "deny",
      scheduledRuns: "deny",
    });
  });

  it("produces the same digest for semantically identical records with different object-key order", () => {
    const original = profile();
    const reordered = {
      worker: original.worker,
      output: original.output,
      budgets: original.budgets,
      toolIds: original.toolIds,
      providerProfileId: original.providerProfileId,
      profileId: original.profileId,
      schemaVersion: original.schemaVersion,
    };
    expect(headlessProfileDigest(reordered)).toBe(headlessProfileDigest(original));
    expect(headlessProfileDigest(original)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses unknown fields so a profile cannot smuggle provider or authority material", () => {
    expect(() => decodeHeadlessProfileV1(profile({ grants: [] }))).toThrowError(
      /missing or unknown keys/,
    );
  });

  it("refuses prototype-inherited fields", () => {
    const hostile = Object.create({ grants: [] }) as Record<string, unknown>;
    Object.assign(hostile, profile());
    expect(() => decodeHeadlessProfileV1(hostile)).toThrowError(/non-record prototype/);
  });

  it("requires registered, sorted, unique tool IDs", () => {
    expect(() => decodeHeadlessProfileV1(profile({ toolIds: ["shell"] }))).toThrowError(
      /not a registered tool ID/,
    );
    expect(() =>
      decodeHeadlessProfileV1(profile({ toolIds: ["run_checks", "read_file"] })),
    ).toThrowError(/sorted/);
    expect(() =>
      decodeHeadlessProfileV1(profile({ toolIds: ["read_file", "read_file"] })),
    ).toThrowError(/duplicates/);
  });

  it("keeps output and worker behavior closed in v1", () => {
    expect(() => decodeHeadlessProfileV1(profile({ output: { format: "text" } }))).toThrowError(
      /must equal jsonl/,
    );
    expect(() =>
      decodeHeadlessProfileV1(
        profile({
          worker: {
            mode: "daemon",
            maxConcurrency: 2,
            childRuns: "allow",
            scheduledRuns: "allow",
          },
        }),
      ),
    ).toThrowError(/mode must equal one_task/);
  });
});

describe("headless profile host resolution", () => {
  it("resolves provider and tools from host-owned catalogs without creating new authority", () => {
    const resolved = resolveHeadlessProfileV1(profile(), authority());
    expect(resolved.provider).toMatchObject({
      kind: "ollama",
      model: "qwen3.8:27b",
      baseUrl: "http://127.0.0.1:11434/",
    });
    expect(resolved.tools.map((entry) => entry.name)).toEqual([
      "get_check_catalog",
      "read_file",
      "report_done",
      "run_checks",
    ]);
    expect(resolved.profileDigestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved.resolutionDigestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes only the resolution digest when the host changes an ID's provider mapping", () => {
    const first = resolveHeadlessProfileV1(profile(), authority());
    const changedAuthority = authority();
    const changedProvider = changedAuthority.providerProfiles[0];
    if (changedProvider === undefined) throw new Error("Fixture provider is missing");
    const second = resolveHeadlessProfileV1(profile(), {
      ...changedAuthority,
      providerProfiles: [{ ...changedProvider, model: "ornith:35b" }],
    });
    expect(second.profileDigestSha256).toBe(first.profileDigestSha256);
    expect(second.resolutionDigestSha256).not.toBe(first.resolutionDigestSha256);
  });

  it("refuses absent and ambiguous host provider IDs", () => {
    expect(() =>
      resolveHeadlessProfileV1(profile({ providerProfileId: "missing" }), authority()),
    ).toThrowError(/not present in the host catalog/);
    const duplicateAuthority = authority();
    const duplicateProvider = duplicateAuthority.providerProfiles[0];
    if (duplicateProvider === undefined) throw new Error("Fixture provider is missing");
    expect(() =>
      resolveHeadlessProfileV1(profile(), {
        ...duplicateAuthority,
        providerProfiles: [...duplicateAuthority.providerProfiles, { ...duplicateProvider }],
      }),
    ).toThrowError(/duplicate ID/);
  });
});
