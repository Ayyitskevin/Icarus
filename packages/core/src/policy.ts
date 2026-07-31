import path from "node:path";

import {
  containsSecretShapedContent,
  isIntrinsicallySecretPath,
  isProtectedEditPath,
} from "./context.js";
import { digestJson, sha256 } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import type {
  CapabilityGrant,
  CapabilityKind,
  CheckProfile,
  CheckpointFile,
  EditProposal,
  FileEdit,
  FileReplacement,
  JsonValue,
  PatchSet,
  PlanProposal,
  ProviderConfig,
  ReadableManifest,
  SandboxProfile,
  SunCeiling,
} from "./types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DIGEST_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const ENCODED_PATH_PATTERN = /%(?:2e|2f|5c)/i;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Advanced by ADR 0026 slice 2b-ii(b2): explicit grants now drive the wired
 * production session tools, so newly planned approvals bind the production
 * authority contract rather than the earlier callable-only surface.
 */
export const POLICY_VERSION = "session-loop-wiring-v5";

/** Hard host ceiling on operator-selected candidate paths and patch-set size. */
export const MAX_CHANGED_FILES = 64;
/** Ordered exact replacements permitted inside one `modify` edit. */
export const MAX_REPLACEMENTS_PER_FILE = 32;
/**
 * Host ceiling on session iterations a plan may request (ADR 0026, superseding
 * the ADR 0024 repair grant).
 *
 * Two is the measured production maximum, not a preference. A local run costs
 * 12 tool calls before its first session turn and a remote run costs 13 because
 * exact egress validation is itself metered. Each full turn then admits one
 * provider operation plus at most eight tool operations. Two turns therefore
 * land at 30 locally or 31 remotely under the default ceiling of 40. That
 * leaves room for restart reconciliation and an operator's atomic review or
 * rollback; the former three-turn bound did not, so its claimed recovery slot
 * disappeared on the remote and resumed paths.
 *
 * Raising the global ceiling to fit a preferred iteration count would make the
 * budget decorative. The integration suite pins local, remote, and resumed
 * arithmetic so later admission changes cannot silently spend recovery room.
 *
 * This arithmetic is the wired interleaved-session worst case. Re-measure it
 * whenever provider/tool admission changes; do not raise the global ceiling on
 * argument.
 */
export const MAX_SESSION_ITERATIONS = 2;
/**
 * What a plan should request absent a reason to differ. Advisory: nothing
 * enforces it yet, because no host code chooses a plan's ceiling — the provider
 * proposes and the operator approves.
 */
export const DEFAULT_SESSION_ITERATIONS = 2;
/**
 * Host ceiling on entries a `read.manifest` grant may admit (ADR 0026). A
 * scope resolving past this is refused at plan validation rather than
 * truncated: a shortened manifest would leave the model reading from a set the
 * operator never saw.
 */
export const MAX_READABLE_FILES = 512;
/** Itemized grants one plan may request. */
export const MAX_GRANTS = 8;
/** Scope entries one grant may name. */
export const MAX_GRANT_SCOPE_ENTRIES = 64;
/** Host ceiling on calls a single grant may authorize. */
export const MAX_GRANT_CALLS = 64;

const CAPABILITY_KINDS: readonly CapabilityKind[] = [
  "read.manifest",
  "read.checks",
  "mutation.patchset",
  "exec.check",
];
const MAX_REPLACEMENT_TEXT_LENGTH = 262_144;

export const DEFAULT_CEILING: SunCeiling = {
  maxToolCalls: 40,
  maxActiveRuntimeMs: 20 * 60_000,
  maxContextBytes: 192 * 1024,
  maxOutputTokensPerCall: 8_192,
  maxTotalTokens: 100_000,
  maxCostUsd: 2,
  maxFilesChanged: 8,
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
  readonly targets: readonly string[];
  readonly provider: ProviderConfig;
  readonly checks: readonly CheckProfile[];
  readonly sandbox: SandboxProfile;
  readonly ceiling: SunCeiling;
  readonly plan: PlanProposal;
  /**
   * The resolved manifest for this run's `read.manifest` grant, or null when
   * the plan requests no read capability. Null and an empty manifest digest to
   * different values, so an approval that granted nothing cannot be replayed
   * as one that granted an empty scope.
   */
  readonly readableManifest: ReadableManifest | null;
}): string {
  return digestJson(
    toJsonValue({
      schemaVersion: 4,
      policyVersion: POLICY_VERSION,
      task: input.task,
      baseCommit: input.baseCommit,
      contextSha256: input.contextSha256,
      targets: [...input.targets],
      provider: input.provider,
      checks: input.checks,
      sandbox: input.sandbox,
      ceiling: input.ceiling,
      plan: input.plan,
      readableManifestSha256: input.readableManifest
        ? readableManifestDigest(input.readableManifest)
        : null,
    }),
  );
}

/**
 * Binds an enumerated readable set: the base commit it was resolved against
 * and every admitted path with the sha256 of its contents there. Entries are
 * sorted so an equal set always digests equally regardless of resolution order.
 */
export function readableManifestDigest(manifest: ReadableManifest): string {
  return digestJson(
    toJsonValue({
      // Deliberately not policy-versioned. A manifest digest identifies the
      // manifest; the plan approval digest is where POLICY_VERSION binds. Mixing
      // them would invalidate every persisted manifest on an unrelated policy
      // bump and surface as spurious drift rather than as a stale approval.
      schemaVersion: 1,
      baseCommit: manifest.baseCommit,
      entries: [...manifest.entries]
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
        .map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    }),
  );
}

/**
 * Rejects a manifest the host would not be able to hold the operator to:
 * unsorted or duplicated paths, malformed digests, a scope past the host
 * ceiling, or a protected path. Called before the manifest reaches an approval
 * digest, so an unapprovable manifest never becomes an approved one.
 */
export function assertReadableManifest(manifest: ReadableManifest): void {
  invariant(
    SHA256_PATTERN.test(manifest.baseCommit) || /^[a-f0-9]{40}$/.test(manifest.baseCommit),
    "INVALID_READ_MANIFEST",
    "Readable manifest base commit is invalid",
  );
  invariant(
    manifest.entries.length <= MAX_READABLE_FILES,
    "READ_SCOPE_TOO_LARGE",
    `Readable manifest admits more than ${MAX_READABLE_FILES} files`,
  );
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    const entryPath = assertRepositoryRelativePath(entry.path);
    invariant(
      !isProtectedEditPath(entryPath),
      "INVALID_READ_MANIFEST",
      "Readable manifest admits a protected path",
    );
    // A read manifest sends bytes to a provider, so it refuses more than the
    // edit guard does. Git internals are excluded by path rather than by
    // trusting the resolver: `.git/config` carries remote URLs with embedded
    // credentials, and a resolver walking a worktree sees `.git/` even though
    // one reading `git ls-tree` never does.
    invariant(
      entryPath !== ".git" && !entryPath.startsWith(".git/"),
      "INVALID_READ_MANIFEST",
      "Readable manifest admits a git internal path",
    );
    invariant(
      !isIntrinsicallySecretPath(entryPath),
      "INVALID_READ_MANIFEST",
      "Readable manifest admits an intrinsically secret path",
    );
    invariant(
      SHA256_PATTERN.test(entry.sha256),
      "INVALID_READ_MANIFEST",
      "Readable manifest entry digest is invalid",
    );
    invariant(
      !seen.has(entryPath),
      "INVALID_READ_MANIFEST",
      "Readable manifest lists a duplicate path",
    );
    seen.add(entryPath);
  }
}

/**
 * The read binding. Bytes may be returned only when their digest still matches
 * this path's approved manifest entry, or when this session itself recorded
 * writing them — those bytes originated from the model and are already covered
 * by the patch set and tree checkpoint.
 *
 * Anything else is drift, not a fallback: it means the file changed under an
 * approval that named its contents, so the operator approved a read of bytes
 * that no longer exist.
 */
export function assertReadableBytes(input: {
  readonly path: string;
  readonly sha256: string;
  readonly manifest: ReadableManifest;
  readonly sessionWritten: ReadonlyMap<string, string>;
}): void {
  const requested = assertRepositoryRelativePath(input.path);
  invariant(SHA256_PATTERN.test(input.sha256), "INVALID_READ_MANIFEST", "Read digest is malformed");

  const sessionDigest = input.sessionWritten.get(requested);
  if (sessionDigest !== undefined) {
    invariant(
      sessionDigest === input.sha256,
      "READ_MANIFEST_DRIFT",
      "Read returned bytes this session did not write",
    );
    return;
  }

  const entry = input.manifest.entries.find((candidate) => candidate.path === requested);
  invariant(
    entry !== undefined,
    "READ_NOT_GRANTED",
    "Read targeted a path outside the approved readable manifest",
  );
  invariant(
    entry.sha256 === input.sha256,
    "READ_MANIFEST_DRIFT",
    "Read returned bytes whose digest does not match the approved manifest entry",
  );
}

/**
 * Validates itemized grants from provider output. Unknown kinds, duplicate
 * kinds, unbounded call counts, and paths outside the run's authority are
 * refused here rather than at call time, so an unapprovable grant never
 * reaches an operator as if it were reviewable.
 */
export function parseCapabilityGrants(
  value: unknown,
  selection: readonly string[],
  checks: readonly CheckProfile[],
): CapabilityGrant[] {
  invariant(Array.isArray(value), "INVALID_PROVIDER_OUTPUT", "grants must be an array");
  invariant(
    value.length <= MAX_GRANTS,
    "INVALID_PROVIDER_OUTPUT",
    `grants must not exceed ${MAX_GRANTS} entries`,
  );

  const selected = new Set(selection);
  const registeredChecks = new Set(checks.map((check) => check.id));
  const kinds = new Set<string>();
  const grants: CapabilityGrant[] = [];

  for (const raw of value) {
    const object = asObject(raw, "grant");
    const allowedKeys = new Set(["kind", "scope", "maxCalls"]);
    invariant(
      Object.keys(object).every((key) => allowedKeys.has(key)),
      "INVALID_PROVIDER_OUTPUT",
      "grant has unknown fields",
    );

    const kind = asBoundedString(object.kind, "grant.kind", 64);
    invariant(
      (CAPABILITY_KINDS as readonly string[]).includes(kind),
      "UNKNOWN_CAPABILITY",
      "grant names a capability the host does not define",
    );
    invariant(!kinds.has(kind), "INVALID_PROVIDER_OUTPUT", "grants list a duplicate capability");
    kinds.add(kind);

    const maxCalls = object.maxCalls;
    invariant(
      typeof maxCalls === "number" &&
        Number.isSafeInteger(maxCalls) &&
        maxCalls >= 1 &&
        maxCalls <= MAX_GRANT_CALLS,
      "INVALID_PROVIDER_OUTPUT",
      `grant.maxCalls must be an integer between 1 and ${MAX_GRANT_CALLS}`,
    );

    const scope = asStringArray(object.scope, "grant.scope", 1, MAX_GRANT_SCOPE_ENTRIES, 1_024);
    invariant(
      new Set(scope).size === scope.length,
      "INVALID_PROVIDER_OUTPUT",
      "grant.scope lists a duplicate entry",
    );

    if (kind === "mutation.patchset") {
      for (const entry of scope) {
        invariant(
          selected.has(assertRepositoryRelativePath(entry)),
          "TARGET_MISMATCH",
          "mutation.patchset grant names a path outside the approved plan targets",
        );
      }
    }
    if (kind === "read.checks" || kind === "exec.check") {
      for (const entry of scope) {
        invariant(
          registeredChecks.has(entry),
          "CHECK_MISMATCH",
          "check grant names an unregistered check",
        );
      }
    }
    if (kind === "read.manifest") {
      for (const entry of scope) {
        assertRepositoryRelativePath(entry.endsWith("/") ? entry.slice(0, -1) : entry);
      }
    }

    grants.push({ kind: kind as CapabilityKind, scope: [...scope].sort(), maxCalls });
  }

  return grants.sort((left, right) =>
    left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0,
  );
}

/** Retained to verify checkpoints persisted before ADR 0023 (schema v1). */
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

/**
 * Binds a run's complete restorable state: every affected path, its operation,
 * and the digests of its baseline and approved bytes. A missing side is
 * recorded as null so a created or deleted path can never be confused with an
 * empty file.
 */
export function treeCheckpointDigest(input: {
  readonly runId: string;
  readonly baseCommit: string;
  readonly files: readonly CheckpointFile[];
}): string {
  return digestJson(
    toJsonValue({
      schemaVersion: 2,
      runId: input.runId,
      baseCommit: input.baseCommit,
      files: [...input.files]
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
        .map((file) => ({
          path: file.path,
          op: file.op,
          baselineSha256:
            file.baselineBase64 === null
              ? null
              : sha256(Buffer.from(file.baselineBase64, "base64")),
          approvedSha256:
            file.approvedBase64 === null
              ? null
              : sha256(Buffer.from(file.approvedBase64, "base64")),
        })),
    }),
  );
}

export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "steps",
    "risks",
    "target",
    "targets",
    "iterationCeiling",
    "checkIds",
    "grants",
  ],
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
    targets: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CHANGED_FILES,
      items: { type: "string", minLength: 1, maxLength: 1_024 },
      uniqueItems: true,
    },
    iterationCeiling: { type: "integer", minimum: 0, maximum: MAX_SESSION_ITERATIONS },
    checkIds: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 128 },
      uniqueItems: true,
    },
    grants: {
      type: "array",
      maxItems: MAX_GRANTS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "scope", "maxCalls"],
        properties: {
          kind: { type: "string", enum: [...CAPABILITY_KINDS] },
          scope: {
            type: "array",
            minItems: 1,
            maxItems: MAX_GRANT_SCOPE_ENTRIES,
            items: { type: "string", minLength: 1, maxLength: 1_024 },
            uniqueItems: true,
          },
          maxCalls: { type: "integer", minimum: 1, maximum: MAX_GRANT_CALLS },
        },
      },
    },
  },
} satisfies JsonValue;

/** Retained to describe runs planned before ADR 0023. */
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

/**
 * Every property is required and optional values are nullable, because strict
 * structured-output modes reject optional properties. Discriminant rules are
 * enforced by `parsePatchSet` rather than by schema composition.
 */
export const PATCH_SET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "edits"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 1_000 },
    edits: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CHANGED_FILES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "path", "expectedPreimageSha256", "replacements", "content", "rationale"],
        properties: {
          op: { type: "string", enum: ["modify", "create", "delete"] },
          path: { type: "string", minLength: 1, maxLength: 1_024 },
          expectedPreimageSha256: { type: ["string", "null"] },
          replacements: {
            type: ["array", "null"],
            maxItems: MAX_REPLACEMENTS_PER_FILE,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["findText", "replaceText"],
              properties: {
                findText: { type: "string", minLength: 1, maxLength: MAX_REPLACEMENT_TEXT_LENGTH },
                replaceText: { type: "string", maxLength: MAX_REPLACEMENT_TEXT_LENGTH },
              },
            },
          },
          content: { type: ["string", "null"], maxLength: MAX_REPLACEMENT_TEXT_LENGTH },
          rationale: { type: "string", minLength: 1, maxLength: 1_000 },
        },
      },
    },
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
    Number.isSafeInteger(ceiling.maxFilesChanged) &&
      ceiling.maxFilesChanged >= 1 &&
      ceiling.maxFilesChanged <= MAX_CHANGED_FILES,
    "INVALID_CEILING",
    `Sun ceiling maxFilesChanged must be between 1 and ${MAX_CHANGED_FILES}`,
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

function asStringArray(
  value: unknown,
  name: string,
  min: number,
  max: number,
  maxLength = 500,
): string[] {
  invariant(Array.isArray(value), "INVALID_PROVIDER_OUTPUT", `${name} must be an array`);
  invariant(
    value.length >= min && value.length <= max,
    "INVALID_PROVIDER_OUTPUT",
    `${name} has invalid length`,
  );
  return value.map((entry, index) => asBoundedString(entry, `${name}[${index}]`, maxLength));
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
  selection: readonly string[],
  checks: readonly CheckProfile[],
): PlanProposal {
  const object = asObject(value, "plan");
  const allowedKeys = new Set([
    "summary",
    "steps",
    "risks",
    "target",
    "targets",
    "iterationCeiling",
    "checkIds",
    "grants",
  ]);
  invariant(
    Object.keys(object).every((key) => allowedKeys.has(key)),
    "INVALID_PROVIDER_OUTPUT",
    "Plan has unknown fields",
  );

  const anchor = selection[0];
  invariant(anchor !== undefined, "INVALID_TARGET_SELECTION", "Run has no selected target");
  const proposalTarget = asBoundedString(object.target, "target", 1_024);
  invariant(
    proposalTarget === anchor,
    "TARGET_MISMATCH",
    "Provider plan changed the operator-selected target",
  );

  const selected = new Set(selection);
  const proposalTargets = asStringArray(object.targets, "targets", 1, MAX_CHANGED_FILES, 1_024);
  invariant(
    proposalTargets.every((candidate) => selected.has(candidate)),
    "TARGET_MISMATCH",
    "Provider plan proposed a path outside the operator-selected targets",
  );
  invariant(
    new Set(proposalTargets).size === proposalTargets.length,
    "TARGET_MISMATCH",
    "Provider plan proposed a duplicate target",
  );
  const targets = [...proposalTargets].sort();

  const iterationCeiling = object.iterationCeiling;
  invariant(
    typeof iterationCeiling === "number" &&
      Number.isSafeInteger(iterationCeiling) &&
      iterationCeiling >= 0 &&
      iterationCeiling <= MAX_SESSION_ITERATIONS,
    "INVALID_PROVIDER_OUTPUT",
    `iterationCeiling must be an integer between 0 and ${MAX_SESSION_ITERATIONS}`,
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

  // Absent grants are an empty list, not a defaulted capability: a plan that
  // does not ask for a capability must not receive one, and a plan authored
  // before ADR 0026 asks for nothing.
  // Mutation authority is bounded by the paths this plan actually proposes,
  // not by the broader operator selection from which the provider narrowed
  // its plan. Read/check grants keep their own independently closed scopes.
  const grants = parseCapabilityGrants(object.grants ?? [], targets, checks);

  return {
    summary: asBoundedString(object.summary, "summary", 1_000),
    steps: asStringArray(object.steps, "steps", 1, 8),
    risks: asStringArray(object.risks, "risks", 0, 6),
    target: proposalTarget,
    targets,
    iterationCeiling,
    checkIds,
    grants,
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

/** The worktree state a patch set is validated against, per approved path. */
export interface PatchSetPreimage {
  readonly exists: boolean;
  readonly sha256: string | null;
}

function asNullableBoundedString(value: unknown, name: string, maxLength: number): string | null {
  if (value === null) return null;
  return asBoundedString(value, name, maxLength, true);
}

function parseFileEdit(
  value: unknown,
  index: number,
  approvedTargets: ReadonlySet<string>,
  preimages: ReadonlyMap<string, PatchSetPreimage>,
): FileEdit {
  const name = `edits[${index}]`;
  const object = asObject(value, name);
  const allowedKeys = new Set([
    "op",
    "path",
    "expectedPreimageSha256",
    "replacements",
    "content",
    "rationale",
  ]);
  invariant(
    Object.keys(object).every((key) => allowedKeys.has(key)),
    "INVALID_PROVIDER_OUTPUT",
    `${name} has unknown fields`,
  );

  const op = asBoundedString(object.op, `${name}.op`, 16);
  invariant(
    op === "modify" || op === "create" || op === "delete",
    "INVALID_PROVIDER_OUTPUT",
    `${name}.op is not a supported operation`,
  );

  const editPath = assertAllowedTarget(asBoundedString(object.path, `${name}.path`, 1_024));
  invariant(
    approvedTargets.has(editPath),
    "TARGET_MISMATCH",
    "Patch set changed a path outside the approved targets",
  );
  const preimage = preimages.get(editPath);
  invariant(preimage !== undefined, "TARGET_MISMATCH", "Patch set path has no approved preimage");

  const rationale = asBoundedString(object.rationale, `${name}.rationale`, 1_000);
  const expectedPreimageSha256 = asNullableBoundedString(
    object.expectedPreimageSha256,
    `${name}.expectedPreimageSha256`,
    64,
  );
  const content = asNullableBoundedString(
    object.content,
    `${name}.content`,
    MAX_REPLACEMENT_TEXT_LENGTH,
  );

  if (op === "create") {
    invariant(!preimage.exists, "TARGET_MISMATCH", `${name} creates a path that already exists`);
    invariant(content !== null, "INVALID_PROVIDER_OUTPUT", `${name} create has no content`);
    invariant(
      expectedPreimageSha256 === null,
      "INVALID_PROVIDER_OUTPUT",
      `${name} create must not bind a preimage`,
    );
    invariant(
      object.replacements === null ||
        (Array.isArray(object.replacements) && object.replacements.length === 0),
      "INVALID_PROVIDER_OUTPUT",
      `${name} create must not carry replacements`,
    );
    return { op: "create", path: editPath, content, rationale };
  }

  invariant(
    preimage.exists && preimage.sha256 !== null,
    "TARGET_MISMATCH",
    `${name} changes a path that does not exist`,
  );
  invariant(
    expectedPreimageSha256 !== null && SHA256_PATTERN.test(expectedPreimageSha256),
    "INVALID_PROVIDER_OUTPUT",
    `${name} preimage digest is invalid`,
  );
  invariant(
    expectedPreimageSha256 === preimage.sha256,
    "STALE_PREIMAGE",
    `${name} is bound to the wrong preimage`,
  );

  if (op === "delete") {
    invariant(content === null, "INVALID_PROVIDER_OUTPUT", `${name} delete must not carry content`);
    invariant(
      object.replacements === null ||
        (Array.isArray(object.replacements) && object.replacements.length === 0),
      "INVALID_PROVIDER_OUTPUT",
      `${name} delete must not carry replacements`,
    );
    return { op: "delete", path: editPath, expectedPreimageSha256, rationale };
  }

  invariant(content === null, "INVALID_PROVIDER_OUTPUT", `${name} modify must not carry content`);
  invariant(
    Array.isArray(object.replacements),
    "INVALID_PROVIDER_OUTPUT",
    `${name} modify has no replacements`,
  );
  const rawReplacements = object.replacements;
  invariant(
    rawReplacements.length >= 1 && rawReplacements.length <= MAX_REPLACEMENTS_PER_FILE,
    "INVALID_PROVIDER_OUTPUT",
    `${name}.replacements has invalid length`,
  );
  const replacements: FileReplacement[] = rawReplacements.map((entry, replacementIndex) => {
    const replacementName = `${name}.replacements[${replacementIndex}]`;
    const replacement = asObject(entry, replacementName);
    const replacementKeys = new Set(["findText", "replaceText"]);
    invariant(
      Object.keys(replacement).every((key) => replacementKeys.has(key)),
      "INVALID_PROVIDER_OUTPUT",
      `${replacementName} has unknown fields`,
    );
    return {
      findText: asBoundedString(
        replacement.findText,
        `${replacementName}.findText`,
        MAX_REPLACEMENT_TEXT_LENGTH,
      ),
      replaceText: asBoundedString(
        replacement.replaceText,
        `${replacementName}.replaceText`,
        MAX_REPLACEMENT_TEXT_LENGTH,
        true,
      ),
    };
  });
  return { op: "modify", path: editPath, expectedPreimageSha256, replacements, rationale };
}

export function parsePatchSet(
  value: unknown,
  approvedTargets: readonly string[],
  preimages: ReadonlyMap<string, PatchSetPreimage>,
  maxFilesChanged: number,
): PatchSet {
  const object = asObject(value, "patchSet");
  const allowedKeys = new Set(["summary", "edits"]);
  invariant(
    Object.keys(object).every((key) => allowedKeys.has(key)),
    "INVALID_PROVIDER_OUTPUT",
    "Patch set has unknown fields",
  );
  invariant(Array.isArray(object.edits), "INVALID_PROVIDER_OUTPUT", "edits must be an array");
  invariant(object.edits.length >= 1, "INVALID_PROVIDER_OUTPUT", "Patch set has no edits");
  invariant(
    object.edits.length <= Math.min(maxFilesChanged, MAX_CHANGED_FILES),
    "FILE_BUDGET_EXCEEDED",
    "Patch set changes more files than the ceiling permits",
  );

  const approved = new Set(approvedTargets);
  const edits = object.edits.map((entry, index) =>
    parseFileEdit(entry, index, approved, preimages),
  );
  const seen = new Set<string>();
  for (const edit of edits) {
    invariant(
      !seen.has(edit.path),
      "INVALID_PROVIDER_OUTPUT",
      "Patch set changes the same path twice",
    );
    seen.add(edit.path);
  }

  return { summary: asBoundedString(object.summary, "patchSet.summary", 1_000), edits };
}

/**
 * Resolves the bytes a single edit produces. Returns null for a delete, so a
 * removed path is never represented as empty content.
 */
export function resolveFileEdit(
  edit: FileEdit,
  preimage: string | null,
  maxFileBytes: number,
): string | null {
  if (edit.op === "delete") {
    invariant(preimage !== null, "STALE_PREIMAGE", "Deleted path has no preimage");
    invariant(
      sha256(preimage) === edit.expectedPreimageSha256,
      "STALE_PREIMAGE",
      `Bytes changed after the patch set was proposed: ${edit.path}`,
    );
    return null;
  }
  if (edit.op === "create") {
    invariant(edit.content.length > 0, "EMPTY_DIFF", `Created file has no content: ${edit.path}`);
    invariant(
      Buffer.byteLength(edit.content, "utf8") <= maxFileBytes,
      "FILE_BUDGET_EXCEEDED",
      `Created file exceeds the byte ceiling: ${edit.path}`,
    );
    return edit.content;
  }

  invariant(preimage !== null, "STALE_PREIMAGE", "Modified path has no preimage");
  invariant(
    sha256(preimage) === edit.expectedPreimageSha256,
    "STALE_PREIMAGE",
    `Bytes changed after the patch set was proposed: ${edit.path}`,
  );
  let result = preimage;
  for (const [index, replacement] of edit.replacements.entries()) {
    const first = result.indexOf(replacement.findText);
    invariant(first >= 0, "EDIT_NO_MATCH", `Replacement ${index} does not occur in ${edit.path}`);
    invariant(
      result.indexOf(replacement.findText, first + 1) === -1,
      "EDIT_AMBIGUOUS",
      `Replacement ${index} occurs more than once in ${edit.path}`,
    );
    result = `${result.slice(0, first)}${replacement.replaceText}${result.slice(first + replacement.findText.length)}`;
  }
  invariant(result !== preimage, "EMPTY_DIFF", `Edit would not change ${edit.path}`);
  invariant(
    Buffer.byteLength(result, "utf8") <= maxFileBytes,
    "FILE_BUDGET_EXCEEDED",
    `Edited file exceeds the byte ceiling: ${edit.path}`,
  );
  return result;
}

/** Retained to replay runs recorded before ADR 0023. */
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
