import { describe, expect, it } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import {
  decodeHeadlessProfileV1,
  type HeadlessProfileAuthorityV1,
  resolveHeadlessProfileV1,
} from "../../packages/core/src/headless-profile.js";
import { DEFAULT_CEILING } from "../../packages/core/src/policy.js";
import type { PlanProposal, SunCeiling } from "../../packages/core/src/types.js";

function plan(grants: PlanProposal["grants"] = [], iterationCeiling = 0): PlanProposal {
  return {
    summary: "Bounded task",
    steps: ["settle"],
    risks: [],
    target: "src/example.ts",
    targets: ["src/example.ts"],
    iterationCeiling,
    checkIds: ["unit"],
    grants,
  };
}

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    profileId: "secure-one-task",
    providerProfileId: "local-code",
    toolIds: [],
    budgets: { ...DEFAULT_CEILING, maxCostUsd: 0, iterationCeiling: 0 },
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

function authority(approvedPlan = plan(), projectCeiling: SunCeiling = DEFAULT_CEILING) {
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
    projectCeiling,
    approvedPlan,
  };
}

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof IcarusError ? error.code : "UNKNOWN";
  }
}

describe("headless profile authority boundary", () => {
  it("allows no tools by default and allows grant-free settlement tools explicitly", () => {
    expect(resolveHeadlessProfileV1(profile(), authority()).tools).toEqual([]);
    const resolved = resolveHeadlessProfileV1(
      profile({ toolIds: ["report_done", "request_human_input"] }),
      authority(),
    );
    expect(resolved.tools.map((entry) => entry.name)).toEqual([
      "report_done",
      "request_human_input",
    ]);
  });

  it("refuses every capability-bearing tool whose capability is absent from the approved plan", () => {
    for (const toolId of [
      "apply_patchset",
      "get_check_catalog",
      "list_tree",
      "propose_patch",
      "read_file",
      "run_checks",
      "search",
    ]) {
      expect(
        code(() => resolveHeadlessProfileV1(profile({ toolIds: [toolId] }), authority())),
      ).toBe("HEADLESS_PROFILE_AUTHORITY_DENIED");
    }
  });

  it("admits a capability-bearing tool only when the approved plan already carries its grant", () => {
    const approved = plan([{ kind: "mutation.patchset", scope: ["src/example.ts"], maxCalls: 1 }]);
    const resolved = resolveHeadlessProfileV1(
      profile({ toolIds: ["apply_patchset", "propose_patch"] }),
      authority(approved),
    );
    expect(resolved.tools.map((entry) => entry.name)).toEqual(["apply_patchset", "propose_patch"]);
  });

  it("refuses a malformed zero-call grant before it can be treated as authority", () => {
    const malformed = plan([{ kind: "read.manifest", scope: ["src"], maxCalls: 0 }]);
    expect(
      code(() =>
        resolveHeadlessProfileV1(profile({ toolIds: ["read_file"] }), authority(malformed)),
      ),
    ).toBe("INVALID_HEADLESS_PROFILE_HOST");
  });

  it("refuses a malformed plan iteration ceiling instead of letting NaN bypass comparison", () => {
    expect(code(() => resolveHeadlessProfileV1(profile(), authority(plan([], Number.NaN))))).toBe(
      "INVALID_HEADLESS_PROFILE_HOST",
    );
  });

  it("refuses every profile budget that exceeds the project ceiling", () => {
    const cases: readonly [keyof SunCeiling, number][] = [
      ["maxToolCalls", DEFAULT_CEILING.maxToolCalls + 1],
      ["maxActiveRuntimeMs", DEFAULT_CEILING.maxActiveRuntimeMs + 1],
      ["maxContextBytes", DEFAULT_CEILING.maxContextBytes + 1],
      ["maxOutputTokensPerCall", DEFAULT_CEILING.maxOutputTokensPerCall + 1],
      ["maxTotalTokens", DEFAULT_CEILING.maxTotalTokens + 1],
      ["maxCostUsd", DEFAULT_CEILING.maxCostUsd + 1],
      ["maxFilesChanged", DEFAULT_CEILING.maxFilesChanged + 1],
      ["maxFileBytes", DEFAULT_CEILING.maxFileBytes + 1],
      ["maxDiffBytes", DEFAULT_CEILING.maxDiffBytes + 1],
      ["maxCommandOutputBytes", DEFAULT_CEILING.maxCommandOutputBytes + 1],
      ["maxRawCommandOutputBytes", DEFAULT_CEILING.maxRawCommandOutputBytes + 1],
      ["providerTimeoutMs", DEFAULT_CEILING.providerTimeoutMs + 1],
      ["commandTimeoutMs", DEFAULT_CEILING.commandTimeoutMs + 1],
    ];
    for (const [field, value] of cases) {
      const budgets = {
        ...DEFAULT_CEILING,
        maxCostUsd: 0,
        iterationCeiling: 0,
        [field]: value,
      };
      expect(
        code(() => resolveHeadlessProfileV1(profile({ budgets }), authority())),
        field,
      ).toBe("HEADLESS_PROFILE_AUTHORITY_DENIED");
    }
  });

  it("refuses an iteration budget above the approved plan", () => {
    expect(
      code(() =>
        resolveHeadlessProfileV1(
          profile({ budgets: { ...DEFAULT_CEILING, maxCostUsd: 0, iterationCeiling: 1 } }),
          authority(plan([], 0)),
        ),
      ),
    ).toBe("HEADLESS_PROFILE_AUTHORITY_DENIED");
  });

  it("does not make grants, targets, provider URLs, models, credentials, or commands expressible", () => {
    for (const [field, value] of [
      ["grants", []],
      ["targets", ["src/escape.ts"]],
      ["baseUrl", "https://example.invalid"],
      ["model", "unreviewed"],
      ["credential", "secret"],
      ["command", ["sh", "-c", "true"]],
    ] as const) {
      expect(
        code(() => decodeHeadlessProfileV1(profile({ [field]: value }))),
        field,
      ).toBe("INVALID_HEADLESS_PROFILE");
    }
  });

  it("refuses invalid host provider material instead of inheriting it from a trusted ID", () => {
    const current = authority();
    const currentProvider = current.providerProfiles[0];
    if (currentProvider === undefined) throw new Error("Fixture provider is missing");
    expect(
      code(() =>
        resolveHeadlessProfileV1(profile(), {
          ...current,
          providerProfiles: [
            {
              ...currentProvider,
              baseUrl: "http://remote.example.invalid",
              inputUsdPerMillionTokens: 1,
              outputUsdPerMillionTokens: 1,
            },
          ],
        }),
      ),
    ).toBe("INVALID_HEADLESS_PROFILE_HOST");

    const invalidKind = {
      ...current,
      providerProfiles: [{ ...currentProvider, kind: "shell" }],
    } as unknown as HeadlessProfileAuthorityV1;
    expect(code(() => resolveHeadlessProfileV1(profile(), invalidKind))).toBe(
      "INVALID_HEADLESS_PROFILE_HOST",
    );
  });
});
