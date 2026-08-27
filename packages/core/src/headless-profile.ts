import { digestJson } from "./digest.js";
import { errorMessage, IcarusError } from "./errors.js";
import { assertSunCeiling, MAX_SESSION_ITERATIONS } from "./policy.js";
import { createProviderConfig } from "./provider.js";
import { VULCAN_PROVIDER_SEAT } from "./providers.js";
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
export const HEADLESS_VULCAN_ADMISSION_SCHEMA = "icarus.headless.vulcan-admission.v1";

export interface HeadlessProfileBudgetsV1 extends SunCeiling {
  readonly iterationCeiling: number;
}

export interface HeadlessProfileOutputV1 {
  readonly format: "jsonl";
}

/** H4: the governed alternative to the closed `childRuns: "deny"` default. */
export interface HeadlessChildRunsAllowV1 {
  /** v1 admits direct children of the root worker only. */
  readonly maxDepth: 1;
  readonly maxChildren: number;
}

export interface HeadlessProfileWorkerPolicyV1 {
  readonly mode: "one_task";
  readonly maxConcurrency: 1;
  readonly childRuns: "deny" | HeadlessChildRunsAllowV1;
  readonly scheduledRuns: "deny";
  /**
   * ADR 0060: `"propose"` stops after patch-set intent and requires the
   * digest-bound apply act; `"apply"` is the explicit approve-and-run
   * opt-in. Absent means `"propose"` — the default — and decodes to the
   * identical pre-ADR-0060 object so existing profile digests are stable.
   */
  readonly mutation?: "propose" | "apply";
}

/**
 * H4: one operator-declared child run. Every field can only narrow the
 * parent worker's authority: targets stay within the parent's approved plan
 * targets, tools within the parent's resolved set, and budgets within the
 * parent's profile budgets (checked at resolution) and remaining envelope
 * (checked at spawn).
 */
export interface HeadlessChildSpecV1 {
  readonly childId: string;
  readonly task: string;
  readonly targets: readonly string[];
  readonly toolIds: readonly ToolName[];
  readonly budgets: HeadlessProfileBudgetsV1;
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
  /** H4: operator-declared child runs. Absent means none are admitted. */
  readonly children?: readonly HeadlessChildSpecV1[];
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

export interface HeadlessVulcanAdmissionV1 {
  readonly schema: typeof HEADLESS_VULCAN_ADMISSION_SCHEMA;
  readonly seat: typeof VULCAN_PROVIDER_SEAT;
  readonly mutation: "propose";
  readonly childRuns: "deny";
}

export interface ResolvedHeadlessProfileV1 {
  readonly schema: typeof HEADLESS_PROFILE_RESOLUTION_SCHEMA;
  readonly profile: HeadlessProfileV1;
  readonly profileDigestSha256: string;
  /** Binds the profile to the provider mapping and tool definitions resolved now. */
  readonly resolutionDigestSha256: string;
  readonly provider: ProviderConfig;
  readonly tools: readonly ToolDefinition[];
  /** Present only when the resolution deliberately admits the Vulcan adapter. */
  readonly vulcanAdmission?: HeadlessVulcanAdmissionV1;
}

const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const HEADLESS_CHILD_LIMIT = 8;
export const HEADLESS_CHILD_TARGET_LIMIT = 64;
export const HEADLESS_CHILD_TASK_MAX_BYTES = 8 * 1024;
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

function decodeChildRuns(value: unknown): "deny" | HeadlessChildRunsAllowV1 {
  if (value === "deny") return "deny";
  const decoded = record(value, ["maxChildren", "maxDepth"], "profile.worker.childRuns");
  if (decoded.maxDepth !== 1) {
    invalid("profile.worker.childRuns.maxDepth must equal 1");
  }
  if (
    typeof decoded.maxChildren !== "number" ||
    !Number.isSafeInteger(decoded.maxChildren) ||
    decoded.maxChildren < 1 ||
    decoded.maxChildren > HEADLESS_CHILD_LIMIT
  ) {
    invalid(
      `profile.worker.childRuns.maxChildren must be an integer between 1 and ${HEADLESS_CHILD_LIMIT}`,
    );
  }
  return { maxDepth: 1, maxChildren: decoded.maxChildren };
}

function decodeWorker(value: unknown): HeadlessProfileWorkerPolicyV1 {
  const hasMutation =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "mutation");
  const decoded = record(
    value,
    hasMutation
      ? ["mode", "maxConcurrency", "childRuns", "scheduledRuns", "mutation"]
      : ["mode", "maxConcurrency", "childRuns", "scheduledRuns"],
    "profile.worker",
  );
  if (decoded.mode !== "one_task") invalid("profile.worker.mode must equal one_task");
  if (decoded.maxConcurrency !== 1) {
    invalid("profile.worker.maxConcurrency must equal 1");
  }
  if (decoded.scheduledRuns !== "deny") {
    invalid("profile.worker.scheduledRuns must equal deny");
  }
  if (
    decoded.mutation !== undefined &&
    decoded.mutation !== "propose" &&
    decoded.mutation !== "apply"
  ) {
    invalid("profile.worker.mutation must equal propose or apply");
  }
  return {
    mode: "one_task",
    maxConcurrency: 1,
    childRuns: decodeChildRuns(decoded.childRuns),
    scheduledRuns: "deny",
    ...(hasMutation ? { mutation: decoded.mutation as "propose" | "apply" } : {}),
  };
}

function decodeChildSpec(value: unknown, index: number): HeadlessChildSpecV1 {
  const field = `profile.children[${index}]`;
  const decoded = record(value, ["budgets", "childId", "targets", "task", "toolIds"], field);
  const task = decoded.task;
  if (
    typeof task !== "string" ||
    !isWellFormedUnicode(task) ||
    task.length === 0 ||
    Buffer.byteLength(task, "utf8") > HEADLESS_CHILD_TASK_MAX_BYTES
  ) {
    invalid(`${field}.task must be a non-empty string within its byte ceiling`);
  }
  const targets = decoded.targets;
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    targets.length > HEADLESS_CHILD_TARGET_LIMIT ||
    !targets.every(
      (target) =>
        typeof target === "string" &&
        target.length > 0 &&
        Buffer.byteLength(target, "utf8") <= 1024 &&
        !/[\r\n\0]/.test(target),
    ) ||
    new Set(targets).size !== targets.length
  ) {
    invalid(`${field}.targets must be a non-empty unique bounded path list`);
  }
  return {
    childId: canonicalId(decoded.childId, `${field}.childId`),
    task,
    targets: targets as readonly string[],
    toolIds: decodeToolIds(decoded.toolIds),
    budgets: decodeBudgets(decoded.budgets),
  };
}

function decodeChildren(value: unknown): readonly HeadlessChildSpecV1[] {
  if (!Array.isArray(value)) invalid("profile.children must be an array");
  if (value.length > HEADLESS_CHILD_LIMIT) {
    invalid(`profile.children must not exceed ${HEADLESS_CHILD_LIMIT} entries`);
  }
  const specs = value.map((entry, index) => decodeChildSpec(entry, index));
  if (new Set(specs.map((spec) => spec.childId)).size !== specs.length) {
    invalid("profile.children must not contain duplicate child IDs");
  }
  return specs;
}

const PROFILE_REQUIRED_KEYS = [
  "schemaVersion",
  "profileId",
  "providerProfileId",
  "toolIds",
  "budgets",
  "output",
  "worker",
] as const;

export function decodeHeadlessProfileV1(value: unknown): HeadlessProfileV1 {
  const hasChildren =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "children");
  const base = record(
    value,
    hasChildren ? [...PROFILE_REQUIRED_KEYS, "children"] : PROFILE_REQUIRED_KEYS,
    "profile",
  );
  const children = base.children === undefined ? [] : decodeChildren(base.children);
  if (base.schemaVersion !== HEADLESS_PROFILE_SCHEMA_VERSION) {
    invalid(`profile.schemaVersion must equal ${HEADLESS_PROFILE_SCHEMA_VERSION}`);
  }
  return {
    schemaVersion: HEADLESS_PROFILE_SCHEMA_VERSION,
    profileId: canonicalId(base.profileId, "profile.profileId"),
    providerProfileId: canonicalId(base.providerProfileId, "profile.providerProfileId"),
    toolIds: decodeToolIds(base.toolIds),
    budgets: decodeBudgets(base.budgets),
    output: decodeOutput(base.output),
    worker: decodeWorker(base.worker),
    ...(children.length === 0 ? {} : { children }),
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

function assertChildrenWithinAuthority(
  profile: HeadlessProfileV1,
  provider: ProviderConfig,
  approvedPlan: PlanProposal,
): void {
  const children = profile.children ?? [];
  if (children.length === 0) return;
  if (profile.worker.childRuns === "deny") {
    denied("profile.children requires worker.childRuns to allow child runs");
  }
  if (children.length > profile.worker.childRuns.maxChildren) {
    denied("profile.children exceeds the worker child-run ceiling");
  }
  if (provider.capabilities.locality !== "loopback") {
    // A child's context-egress approval can never be operator-reviewed; v1
    // admits children under loopback providers only.
    denied("profile.children requires a loopback provider");
  }
  for (const [index, spec] of children.entries()) {
    const field = `profile.children[${index}]`;
    for (const toolId of spec.toolIds) {
      if (!profile.toolIds.includes(toolId)) {
        denied(`${field}.toolIds must not exceed the parent tool set`);
      }
    }
    for (const key of SUN_CEILING_KEYS) {
      if (spec.budgets[key] > profile.budgets[key]) {
        denied(`${field}.budgets.${key} exceeds the parent profile budget`);
      }
    }
    if (spec.budgets.iterationCeiling > profile.budgets.iterationCeiling) {
      denied(`${field}.budgets.iterationCeiling exceeds the parent profile budget`);
    }
    for (const target of spec.targets) {
      if (!approvedPlan.targets.includes(target)) {
        denied(`${field}.targets must stay within the approved plan targets`);
      }
    }
    // The derived child profile ID must remain a canonical identifier.
    canonicalId(`${profile.profileId}-c-${spec.childId}`, `${field}.childId`);
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
  if (
    selected.kind !== "ollama" &&
    selected.kind !== "openai" &&
    selected.kind !== "anthropic" &&
    selected.kind !== "vulcan"
  ) {
    invalidHost(`Host provider profile ${providerProfileId} has an invalid kind`);
  }
  try {
    const provider = createProviderConfig({
      kind: selected.kind,
      model: selected.model,
      baseUrl: selected.baseUrl,
      inputUsdPerMillionTokens: selected.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: selected.outputUsdPerMillionTokens,
    });
    if (provider.kind === "vulcan") {
      if (provider.capabilities.locality !== "loopback") {
        invalidHost(`Host provider profile ${providerProfileId} must use loopback Vulcan`);
      }
      if (
        provider.inputUsdPerMillionTokens === null ||
        provider.inputUsdPerMillionTokens <= 0 ||
        provider.outputUsdPerMillionTokens === null ||
        provider.outputUsdPerMillionTokens <= 0
      ) {
        invalidHost(
          `Host provider profile ${providerProfileId} must declare positive input and output token rates for Vulcan`,
        );
      }
    }
    return provider;
  } catch (error) {
    if (error instanceof IcarusError && error.code === "INVALID_HEADLESS_PROFILE_HOST") {
      throw error;
    }
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
  const vulcanAdmission =
    provider.kind === "vulcan"
      ? (() => {
          if ((profile.worker.mutation ?? "propose") !== "propose") {
            denied("vulcan headless admission is proposal-only");
          }
          if (profile.worker.childRuns !== "deny" || (profile.children?.length ?? 0) !== 0) {
            denied("vulcan headless admission does not permit child runs");
          }
          return {
            schema: HEADLESS_VULCAN_ADMISSION_SCHEMA,
            seat: VULCAN_PROVIDER_SEAT,
            mutation: "propose",
            childRuns: "deny",
          } as const;
        })()
      : undefined;
  const tools = resolveTools(profile.toolIds, authority.approvedPlan);
  assertChildrenWithinAuthority(profile, provider, authority.approvedPlan);
  const profileDigestSha256 = digestJson(profileJson(profile));
  const resolution = {
    schema: HEADLESS_PROFILE_RESOLUTION_SCHEMA,
    profileDigestSha256,
    providerProfileId: profile.providerProfileId,
    provider,
    tools,
    ...(vulcanAdmission === undefined ? {} : { vulcanAdmission }),
  } as unknown as JsonValue;
  return {
    schema: HEADLESS_PROFILE_RESOLUTION_SCHEMA,
    profile,
    profileDigestSha256,
    resolutionDigestSha256: digestJson(resolution),
    provider,
    tools,
    ...(vulcanAdmission === undefined ? {} : { vulcanAdmission }),
  };
}
