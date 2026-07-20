import path from "node:path";

import { containsSecretShapedContent, isProtectedEditPath } from "./context.js";
import { digestJson, sha256 } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import type {
  CheckProfile,
  EditProposal,
  JsonValue,
  PlanProposal,
  ProviderConfig,
  SandboxProfile,
  SunCeiling,
} from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DIGEST_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const ENCODED_PATH_PATTERN = /%(?:2e|2f|5c)/i;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const POLICY_VERSION = "m1-v1";

export const DEFAULT_CEILING: SunCeiling = {
  maxToolCalls: 40,
  maxActiveRuntimeMs: 20 * 60_000,
  maxContextBytes: 192 * 1024,
  maxOutputTokensPerCall: 8_192,
  maxTotalTokens: 100_000,
  maxCostUsd: 2,
  maxFilesChanged: 1,
  maxFileBytes: 256 * 1024,
  maxDiffBytes: 256 * 1024,
  maxCommandOutputBytes: 256 * 1024,
  maxRawCommandOutputBytes: 8 * 1024 * 1024,
  providerTimeoutMs: 5 * 60_000,
  commandTimeoutMs: 5 * 60_000,
};

export const DEFAULT_SANDBOX_LIMITS: Omit<SandboxProfile, "image"> = {
  cpus: 2,
  memoryMb: 4_096,
  pids: 256,
  tmpfsMb: 1_024,
};

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function planApprovalDigest(input: {
  readonly task: string;
  readonly baseCommit: string;
  readonly contextSha256: string;
  readonly target: string;
  readonly provider: ProviderConfig;
  readonly checks: readonly CheckProfile[];
  readonly sandbox: SandboxProfile;
  readonly ceiling: SunCeiling;
  readonly plan: PlanProposal;
}): string {
  return digestJson(
    toJsonValue({
      schemaVersion: 1,
      policyVersion: POLICY_VERSION,
      task: input.task,
      baseCommit: input.baseCommit,
      contextSha256: input.contextSha256,
      target: input.target,
      provider: input.provider,
      checks: input.checks,
      sandbox: input.sandbox,
      ceiling: input.ceiling,
      plan: input.plan,
    }),
  );
}

export function checkpointDigest(input: {
  readonly runId: string;
  readonly baseCommit: string;
  readonly target: string;
  readonly baselineBase64: string;
  readonly approvedBase64: string;
}): string {
  return digestJson(
    toJsonValue({
      schemaVersion: 1,
      runId: input.runId,
      baseCommit: input.baseCommit,
      target: input.target,
      baselineSha256: sha256(Buffer.from(input.baselineBase64, "base64")),
      approvedSha256: sha256(Buffer.from(input.approvedBase64, "base64")),
    }),
  );
}

export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "steps", "risks", "target", "checkIds"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 1_000 },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    risks: {
      type: "array",
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    target: { type: "string", minLength: 1, maxLength: 1_024 },
    checkIds: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 128 },
      uniqueItems: true,
    },
  },
} satisfies JsonValue;

export const EDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "expectedPreimageSha256", "findText", "replaceText", "rationale"],
  properties: {
    path: { type: "string", minLength: 1, maxLength: 1_024 },
    expectedPreimageSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    findText: { type: "string", minLength: 1, maxLength: 262_144 },
    replaceText: { type: "string", maxLength: 262_144 },
    rationale: { type: "string", minLength: 1, maxLength: 1_000 },
  },
} satisfies JsonValue;

export function assertRepositoryRelativePath(value: string): string {
  invariant(value.length > 0, "INVALID_PATH", "Target path must not be empty");
  invariant(!value.includes("\0"), "INVALID_PATH", "Target path contains a NUL byte");
  invariant(
    !ENCODED_PATH_PATTERN.test(value),
    "INVALID_PATH",
    "Encoded path separators are denied",
  );
  invariant(!value.includes("\\"), "INVALID_PATH", "Backslash paths are not supported");
  invariant(!path.posix.isAbsolute(value), "INVALID_PATH", "Absolute target paths are denied");
  invariant(!/^[a-zA-Z]:/.test(value), "INVALID_PATH", "Drive-qualified target paths are denied");

  const components = value.split("/");
  invariant(
    components.every((component) => component !== "" && component !== "." && component !== ".."),
    "INVALID_PATH",
    "Target path contains an unsafe component",
  );
  invariant(path.posix.normalize(value) === value, "INVALID_PATH", "Target path is not canonical");
  invariant(
    components.every((component) =>
      [...component].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      }),
    ),
    "INVALID_PATH",
    "Target path contains control characters",
  );
  return value;
}

export function assertAllowedTarget(value: string): string {
  const target = assertRepositoryRelativePath(value);
  const lower = target.toLowerCase();
  const components = lower.split("/");
  const basename = components.at(-1) ?? "";

  const denied =
    components.includes(".git") ||
    components.includes(".icarus") ||
    components.includes("migrations") ||
    isProtectedEditPath(target) ||
    lower.startsWith(".github/workflows/") ||
    basename === "agents.md" ||
    basename === "dockerfile" ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename === "package.json" ||
    basename.endsWith("lock.json") ||
    basename.endsWith("lock.yaml") ||
    basename.endsWith(".lock");

  invariant(!denied, "PROTECTED_PATH", `Milestone 1 cannot change protected path: ${target}`);
  return target;
}

export function assertSandboxProfile(profile: SandboxProfile): void {
  invariant(
    DIGEST_IMAGE_PATTERN.test(profile.image),
    "UNPINNED_SANDBOX_IMAGE",
    "Sandbox image must include an immutable sha256 manifest digest",
  );
  invariant(
    profile.cpus > 0 && profile.cpus <= 4,
    "INVALID_SANDBOX",
    "Sandbox CPU limit is invalid",
  );
  invariant(
    profile.memoryMb >= 128 && profile.memoryMb <= 8_192,
    "INVALID_SANDBOX",
    "Sandbox memory limit is invalid",
  );
  invariant(
    profile.pids >= 16 && profile.pids <= 512,
    "INVALID_SANDBOX",
    "Sandbox PID limit is invalid",
  );
  invariant(
    profile.tmpfsMb >= 16 && profile.tmpfsMb <= 2_048,
    "INVALID_SANDBOX",
    "Sandbox tmpfs limit is invalid",
  );
}

export function assertSunCeiling(ceiling: SunCeiling): void {
  const positiveIntegers: readonly (keyof SunCeiling)[] = [
    "maxToolCalls",
    "maxActiveRuntimeMs",
    "maxContextBytes",
    "maxOutputTokensPerCall",
    "maxTotalTokens",
    "maxFileBytes",
    "maxDiffBytes",
    "maxCommandOutputBytes",
    "maxRawCommandOutputBytes",
    "providerTimeoutMs",
    "commandTimeoutMs",
  ];
  for (const key of positiveIntegers) {
    invariant(
      Number.isSafeInteger(ceiling[key]) && ceiling[key] > 0,
      "INVALID_CEILING",
      `Sun ceiling ${key} must be a positive integer`,
    );
  }
  const timerFields = [
    "maxActiveRuntimeMs",
    "providerTimeoutMs",
    "commandTimeoutMs",
  ] as const satisfies readonly (keyof SunCeiling)[];
  for (const key of timerFields) {
    invariant(
      ceiling[key] <= MAX_TIMER_DELAY_MS,
      "INVALID_CEILING",
      `Sun ceiling ${key} exceeds the timer-safe integer range`,
    );
  }
  invariant(
    ceiling.maxFilesChanged === 1,
    "INVALID_CEILING",
    "Milestone 1 permits exactly one changed file",
  );
  invariant(
    Number.isFinite(ceiling.maxCostUsd) && ceiling.maxCostUsd >= 0,
    "INVALID_CEILING",
    "Sun cost ceiling must be finite and nonnegative",
  );
  invariant(
    ceiling.maxOutputTokensPerCall <= ceiling.maxTotalTokens,
    "INVALID_CEILING",
    "Per-call token ceiling exceeds the total token ceiling",
  );
  invariant(
    ceiling.maxCommandOutputBytes <= ceiling.maxRawCommandOutputBytes,
    "INVALID_CEILING",
    "Persisted command output ceiling exceeds the raw kill threshold",
  );
}

export function assertCheckProfiles(checks: readonly CheckProfile[]): void {
  invariant(checks.length > 0, "CHECKS_REQUIRED", "At least one sandbox check is required");
  const ids = new Set<string>();
  for (const check of checks) {
    invariant(
      !containsSecretShapedContent(
        Buffer.from([check.id, check.name, ...check.argv].join("\n"), "utf8"),
      ),
      "CHECK_SECRET_DETECTED",
      "Check profile contains recognizable credential material",
    );
    invariant(
      check.id.length > 0 && !ids.has(check.id),
      "INVALID_CHECK",
      "Check IDs must be unique",
    );
    invariant(check.argv.length > 0, "INVALID_CHECK", `Check ${check.id} has no executable`);
    invariant(
      check.argv.every((part) => part.length > 0 && !part.includes("\0") && !/[\r\n]/.test(part)),
      "INVALID_CHECK",
      `Check ${check.id} contains an invalid argument`,
    );
    ids.add(check.id);
  }
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_PROVIDER_OUTPUT",
    `${name} must be a JSON object`,
  );
  return value as Record<string, unknown>;
}

function asBoundedString(
  value: unknown,
  name: string,
  maxLength: number,
  allowEmpty = false,
): string {
  invariant(typeof value === "string", "INVALID_PROVIDER_OUTPUT", `${name} must be a string`);
  invariant(allowEmpty || value.length > 0, "INVALID_PROVIDER_OUTPUT", `${name} must not be empty`);
  invariant(value.length <= maxLength, "INVALID_PROVIDER_OUTPUT", `${name} is too long`);
  invariant(!value.includes("\0"), "INVALID_PROVIDER_OUTPUT", `${name} contains a NUL byte`);
  return value;
}

function asStringArray(value: unknown, name: string, min: number, max: number): string[] {
  invariant(Array.isArray(value), "INVALID_PROVIDER_OUTPUT", `${name} must be an array`);
  invariant(
    value.length >= min && value.length <= max,
    "INVALID_PROVIDER_OUTPUT",
    `${name} has invalid length`,
  );
  return value.map((entry, index) => asBoundedString(entry, `${name}[${index}]`, 500));
}

export function parseProviderJson(text: string, maxBytes: number): unknown {
  invariant(
    Buffer.byteLength(text, "utf8") <= maxBytes,
    "INVALID_PROVIDER_OUTPUT",
    "Provider output is too large",
  );
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new IcarusError("INVALID_PROVIDER_OUTPUT", "Provider did not return valid JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parsePlanProposal(
  value: unknown,
  target: string,
  checks: readonly CheckProfile[],
): PlanProposal {
  const object = asObject(value, "plan");
  const allowedKeys = new Set(["summary", "steps", "risks", "target", "checkIds"]);
  invariant(
    Object.keys(object).every((key) => allowedKeys.has(key)),
    "INVALID_PROVIDER_OUTPUT",
    "Plan has unknown fields",
  );

  const proposalTarget = asBoundedString(object.target, "target", 1_024);
  invariant(
    proposalTarget === target,
    "TARGET_MISMATCH",
    "Provider plan changed the operator-selected target",
  );
  const checkIds = asStringArray(object.checkIds, "checkIds", 1, 8);
  const allowedChecks = new Set(checks.map((check) => check.id));
  invariant(
    checkIds.every((id) => allowedChecks.has(id)),
    "CHECK_MISMATCH",
    "Provider selected an unregistered check",
  );
  invariant(
    new Set(checkIds).size === checkIds.length,
    "CHECK_MISMATCH",
    "Provider selected duplicate checks",
  );

  return {
    summary: asBoundedString(object.summary, "summary", 1_000),
    steps: asStringArray(object.steps, "steps", 1, 8),
    risks: asStringArray(object.risks, "risks", 0, 6),
    target: proposalTarget,
    checkIds,
  };
}

export function parseEditProposal(
  value: unknown,
  target: string,
  preimageSha256: string,
): EditProposal {
  const object = asObject(value, "edit");
  const allowedKeys = new Set([
    "path",
    "expectedPreimageSha256",
    "findText",
    "replaceText",
    "rationale",
  ]);
  invariant(
    Object.keys(object).every((key) => allowedKeys.has(key)),
    "INVALID_PROVIDER_OUTPUT",
    "Edit has unknown fields",
  );

  const proposalPath = asBoundedString(object.path, "path", 1_024);
  invariant(
    proposalPath === target,
    "TARGET_MISMATCH",
    "Provider edit changed the approved target",
  );
  const expectedSha = asBoundedString(object.expectedPreimageSha256, "expectedPreimageSha256", 64);
  invariant(
    SHA256_PATTERN.test(expectedSha),
    "INVALID_PROVIDER_OUTPUT",
    "Edit preimage digest is invalid",
  );
  invariant(
    expectedSha === preimageSha256,
    "STALE_PREIMAGE",
    "Provider edit is bound to the wrong preimage",
  );

  return {
    path: proposalPath,
    expectedPreimageSha256: expectedSha,
    findText: asBoundedString(object.findText, "findText", 256 * 1024),
    replaceText: asBoundedString(object.replaceText, "replaceText", 256 * 1024, true),
    rationale: asBoundedString(object.rationale, "rationale", 1_000),
  };
}

export function applyExactReplacement(
  preimage: string,
  edit: EditProposal,
  maxFileBytes: number,
): string {
  invariant(
    sha256(preimage) === edit.expectedPreimageSha256,
    "STALE_PREIMAGE",
    "Target bytes changed after edit proposal",
  );
  const first = preimage.indexOf(edit.findText);
  invariant(first >= 0, "EDIT_NO_MATCH", "Approved edit text does not occur in the target");
  invariant(
    preimage.indexOf(edit.findText, first + 1) === -1,
    "EDIT_AMBIGUOUS",
    "Approved edit text occurs more than once",
  );
  const result = `${preimage.slice(0, first)}${edit.replaceText}${preimage.slice(first + edit.findText.length)}`;
  invariant(result !== preimage, "EMPTY_DIFF", "Edit would not change the target");
  invariant(
    Buffer.byteLength(result, "utf8") <= maxFileBytes,
    "FILE_BUDGET_EXCEEDED",
    "Edited file exceeds the byte ceiling",
  );
  return result;
}
