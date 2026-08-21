import { digestJson } from "./digest.js";
import { errorMessage, IcarusError } from "./errors.js";
import { assertSunCeiling, MAX_SESSION_ITERATIONS } from "./policy.js";
import { createProviderConfig } from "./provider.js";
import { TOOL_REGISTRY, type ToolDefinition, type ToolName } from "./tools.js";
import type {
  CapabilityKind,
  JsonValue,
  PlanProposal,
  ProviderConfig,
  ProviderKind,
  SunCeiling,
} from "./types.js";

// H1 is a selection contract, not an execution path. A decoded profile names
// only host-owned IDs and tighter ceilings. The resolver below proves that the
// selections fit the authority already present in an approved plan; it never
// creates a grant, gateway, lease, workspace, or worker.

export const HEADLESS_PROFILE_SCHEMA_VERSION = 1;
export const HEADLESS_PROFILE_RESOLUTION_SCHEMA = "icarus.headless.profile-resolution.v1";

export interface HeadlessProfileBudgetsV1 extends SunCeiling {
  readonly iterationCeiling: number;
}

export interface HeadlessProfileOutputV1 {
  readonly format: "jsonl";
}

export interface HeadlessProfileWorkerPolicyV1 {
  readonly mode: "one_task";
  readonly maxConcurrency: 1;
  readonly childRuns: "deny";
  readonly scheduledRuns: "deny";
}

export interface HeadlessProfileV1 {
  readonly schemaVersion: typeof HEADLESS_PROFILE_SCHEMA_VERSION;
  readonly profileId: string;
  /** Host catalog ID. Provider URL, model, and pricing do not come from this record. */
  readonly providerProfileId: string;
  /** Exact enabled set. Empty means no model-callable tools. */
  readonly toolIds: readonly ToolName[];
  readonly budgets: HeadlessProfileBudgetsV1;
  readonly output: HeadlessProfileOutputV1;
  readonly worker: HeadlessProfileWorkerPolicyV1;
}

/** Provider material supplied by the host, never by the profile. */
export interface HeadlessHostProviderProfileV1 {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly model: string;
  readonly baseUrl: string;
  readonly inputUsdPerMillionTokens: number | null;
  readonly outputUsdPerMillionTokens: number | null;
}

export interface HeadlessProfileAuthorityV1 {
  readonly providerProfiles: readonly HeadlessHostProviderProfileV1[];
  readonly projectCeiling: SunCeiling;
  /** The host must supply the already-approved, persisted plan for the run. */
  readonly approvedPlan: PlanProposal;
}

export interface ResolvedHeadlessProfileV1 {
  readonly schema: typeof HEADLESS_PROFILE_RESOLUTION_SCHEMA;
  readonly profile: HeadlessProfileV1;
  readonly profileDigestSha256: string;
  /** Binds the profile to the provider mapping and tool definitions resolved now. */
  readonly resolutionDigestSha256: string;
  readonly provider: ProviderConfig;
  readonly tools: readonly ToolDefinition[];
}

const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SUN_CEILING_KEYS = [
  "maxToolCalls",
  "maxActiveRuntimeMs",
  "maxContextBytes",
  "maxOutputTokensPerCall",
  "maxTotalTokens",
  "maxCostUsd",
  "maxFilesChanged",
  "maxFileBytes",
  "maxDiffBytes",
  "maxCommandOutputBytes",
  "maxRawCommandOutputBytes",
  "providerTimeoutMs",
  "commandTimeoutMs",
] as const satisfies readonly (keyof SunCeiling)[];
const BUDGET_KEYS = [...SUN_CEILING_KEYS, "iterationCeiling"] as const;
const CAPABILITY_KINDS = new Set<CapabilityKind>([
  "read.manifest",
  "read.checks",
  "mutation.patchset",
  "exec.check",
]);

function invalid(message: string): never {
  throw new IcarusError("INVALID_HEADLESS_PROFILE", message);
}

function denied(message: string): never {
  throw new IcarusError("HEADLESS_PROFILE_AUTHORITY_DENIED", message);
}

function invalidHost(message: string): never {
  throw new IcarusError("INVALID_HEADLESS_PROFILE_HOST", message);
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function record(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${field} has a non-record prototype`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) {
    invalid(`${field} has non-string keys`);
  }
  const sortedActual = [...(actual as string[])].sort(asciiCompare);
  const sortedExpected = [...keys].sort(asciiCompare);
  if (
    sortedActual.length !== sortedExpected.length ||
    !sortedActual.every((key, index) => key === sortedExpected[index])
  ) {
    invalid(`${field} has missing or unknown keys`);
  }
  return value as Record<string, unknown>;
}

function canonicalId(value: unknown, field: string): string {
  if (typeof value !== "string" || !isWellFormedUnicode(value) || !PROFILE_ID_PATTERN.test(value)) {
    invalid(`${field} must be canonical lowercase ASCII`);
  }
  return value;
}

function decodeToolIds(value: unknown): readonly ToolName[] {
  if (!Array.isArray(value)) invalid("profile.toolIds must be an array");
  if (value.length > TOOL_REGISTRY.length) {
    invalid(`profile.toolIds must not exceed ${TOOL_REGISTRY.length} entries`);
  }
  const known = new Set<string>(TOOL_REGISTRY.map((entry) => entry.name));
  const decoded = value.map((entry, index) => {
    if (typeof entry !== "string" || !known.has(entry)) {
      invalid(`profile.toolIds[${index}] is not a registered tool ID`);
    }
    return entry as ToolName;
  });
  const sorted = [...decoded].sort(asciiCompare);
  if (!decoded.every((entry, index) => entry === sorted[index])) {
    invalid("profile.toolIds must be sorted by ASCII tool ID");
  }
  if (new Set(decoded).size !== decoded.length) {
    invalid("profile.toolIds must not contain duplicates");
  }
  return decoded;
}

function decodeBudgets(value: unknown): HeadlessProfileBudgetsV1 {
  const decoded = record(value, BUDGET_KEYS, "profile.budgets");
  const ceiling = Object.fromEntries(
    SUN_CEILING_KEYS.map((key) => [key, decoded[key]]),
  ) as unknown as SunCeiling;
  try {
    assertSunCeiling(ceiling);
  } catch (error) {
    invalid(`profile.budgets is not a valid SunCeiling: ${errorMessage(error)}`);
  }
  const iterationCeiling = decoded.iterationCeiling;
  if (
    typeof iterationCeiling !== "number" ||
    !Number.isSafeInteger(iterationCeiling) ||
    iterationCeiling < 0 ||
    iterationCeiling > MAX_SESSION_ITERATIONS
  ) {
    invalid(
      `profile.budgets.iterationCeiling must be an integer between 0 and ${MAX_SESSION_ITERATIONS}`,
    );
  }
  return { ...ceiling, iterationCeiling };
}

function decodeOutput(value: unknown): HeadlessProfileOutputV1 {
  const decoded = record(value, ["format"], "profile.output");
  if (decoded.format !== "jsonl") invalid("profile.output.format must equal jsonl");
  return { format: "jsonl" };
}

function decodeWorker(value: unknown): HeadlessProfileWorkerPolicyV1 {
  const decoded = record(
    value,
    ["mode", "maxConcurrency", "childRuns", "scheduledRuns"],
    "profile.worker",
  );
  if (decoded.mode !== "one_task") invalid("profile.worker.mode must equal one_task");
  if (decoded.maxConcurrency !== 1) {
    invalid("profile.worker.maxConcurrency must equal 1");
  }
  if (decoded.childRuns !== "deny") invalid("profile.worker.childRuns must equal deny");
  if (decoded.scheduledRuns !== "deny") {
    invalid("profile.worker.scheduledRuns must equal deny");
  }
  return { mode: "one_task", maxConcurrency: 1, childRuns: "deny", scheduledRuns: "deny" };
}

export function decodeHeadlessProfileV1(value: unknown): HeadlessProfileV1 {
  const decoded = record(
    value,
    ["schemaVersion", "profileId", "providerProfileId", "toolIds", "budgets", "output", "worker"],
    "profile",
  );
  if (decoded.schemaVersion !== HEADLESS_PROFILE_SCHEMA_VERSION) {
    invalid(`profile.schemaVersion must equal ${HEADLESS_PROFILE_SCHEMA_VERSION}`);
  }
  return {
    schemaVersion: HEADLESS_PROFILE_SCHEMA_VERSION,
    profileId: canonicalId(decoded.profileId, "profile.profileId"),
    providerProfileId: canonicalId(decoded.providerProfileId, "profile.providerProfileId"),
    toolIds: decodeToolIds(decoded.toolIds),
    budgets: decodeBudgets(decoded.budgets),
    output: decodeOutput(decoded.output),
    worker: decodeWorker(decoded.worker),
  };
}

function profileJson(profile: HeadlessProfileV1): JsonValue {
  return profile as unknown as JsonValue;
}

export function headlessProfileDigest(value: unknown): string {
  return digestJson(profileJson(decodeHeadlessProfileV1(value)));
}

function assertApprovedPlanAuthority(approvedPlan: PlanProposal): void {
  if (
    !Number.isSafeInteger(approvedPlan.iterationCeiling) ||
    approvedPlan.iterationCeiling < 0 ||
    approvedPlan.iterationCeiling > MAX_SESSION_ITERATIONS
  ) {
    invalidHost("Host approved plan has an invalid iterationCeiling");
  }
  if (!Array.isArray(approvedPlan.grants)) {
    invalidHost("Host approved plan grants must be an array");
  }
  for (const grant of approvedPlan.grants) {
    if (
      typeof grant !== "object" ||
      grant === null ||
      Array.isArray(grant) ||
      !CAPABILITY_KINDS.has(grant.kind) ||
      !Array.isArray(grant.scope) ||
      !grant.scope.every((entry: unknown) => typeof entry === "string") ||
      !Number.isSafeInteger(grant.maxCalls) ||
      grant.maxCalls <= 0
    ) {
      invalidHost("Host approved plan contains an invalid capability grant");
    }
  }
}

function assertBudgetWithinAuthority(
  budgets: HeadlessProfileBudgetsV1,
  projectCeiling: SunCeiling,
  approvedPlan: PlanProposal,
): void {
  try {
    assertSunCeiling(projectCeiling);
  } catch (error) {
    throw new IcarusError(
      "INVALID_HEADLESS_PROFILE_HOST",
      `Host project ceiling is invalid: ${errorMessage(error)}`,
    );
  }
  for (const key of SUN_CEILING_KEYS) {
    if (budgets[key] > projectCeiling[key]) {
      denied(`profile.budgets.${key} exceeds the project ceiling`);
    }
  }
  if (budgets.iterationCeiling > approvedPlan.iterationCeiling) {
    denied("profile.budgets.iterationCeiling exceeds the approved plan");
  }
}

function resolveProvider(
  providerProfileId: string,
  profiles: readonly HeadlessHostProviderProfileV1[],
): ProviderConfig {
  if (!Array.isArray(profiles)) invalidHost("Host provider catalog must be an array");
  const seen = new Set<string>();
  for (const entry of profiles) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      invalidHost("Host provider catalog contains a non-record entry");
    }
    let id: string;
    try {
      id = canonicalId(entry.id, "host.providerProfiles[].id");
    } catch (error) {
      throw new IcarusError(
        "INVALID_HEADLESS_PROFILE_HOST",
        `Host provider catalog ID is invalid: ${errorMessage(error)}`,
      );
    }
    if (seen.has(id)) {
      throw new IcarusError(
        "INVALID_HEADLESS_PROFILE_HOST",
        `Host provider catalog contains duplicate ID ${id}`,
      );
    }
    seen.add(id);
  }
  const selected = profiles.find((entry) => entry.id === providerProfileId);
  if (selected === undefined) {
    denied(`provider profile ${providerProfileId} is not present in the host catalog`);
  }
  if (selected.kind !== "ollama" && selected.kind !== "openai" && selected.kind !== "anthropic") {
    invalidHost(`Host provider profile ${providerProfileId} has an invalid kind`);
  }
  try {
    return createProviderConfig({
      kind: selected.kind,
      model: selected.model,
      baseUrl: selected.baseUrl,
      inputUsdPerMillionTokens: selected.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: selected.outputUsdPerMillionTokens,
    });
  } catch (error) {
    throw new IcarusError(
      "INVALID_HEADLESS_PROFILE_HOST",
      `Host provider profile ${providerProfileId} is invalid: ${errorMessage(error)}`,
    );
  }
}

function resolveTools(
  toolIds: readonly ToolName[],
  approvedPlan: PlanProposal,
): readonly ToolDefinition[] {
  return toolIds.map((toolId) => {
    const definition = TOOL_REGISTRY.find((entry) => entry.name === toolId);
    if (definition === undefined) {
      throw new IcarusError("INVALID_HEADLESS_PROFILE_HOST", `Tool ${toolId} is not registered`);
    }
    if (
      definition.capability !== null &&
      !approvedPlan.grants.some(
        (grant) => grant.kind === definition.capability && grant.maxCalls > 0,
      )
    ) {
      denied(`tool ${toolId} has no matching capability in the approved plan`);
    }
    return { ...definition };
  });
}

export function resolveHeadlessProfileV1(
  value: unknown,
  authority: HeadlessProfileAuthorityV1,
): ResolvedHeadlessProfileV1 {
  const profile = decodeHeadlessProfileV1(value);
  assertApprovedPlanAuthority(authority.approvedPlan);
  assertBudgetWithinAuthority(profile.budgets, authority.projectCeiling, authority.approvedPlan);
  const provider = resolveProvider(profile.providerProfileId, authority.providerProfiles);
  const tools = resolveTools(profile.toolIds, authority.approvedPlan);
  const profileDigestSha256 = digestJson(profileJson(profile));
  const resolution = {
    schema: HEADLESS_PROFILE_RESOLUTION_SCHEMA,
    profileDigestSha256,
    providerProfileId: profile.providerProfileId,
    provider,
    tools,
  } as unknown as JsonValue;
  return {
    schema: HEADLESS_PROFILE_RESOLUTION_SCHEMA,
    profile,
    profileDigestSha256,
    resolutionDigestSha256: digestJson(resolution),
    provider,
    tools,
  };
}
