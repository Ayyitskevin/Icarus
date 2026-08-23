import { parseStrictJson } from "./canonical-json.js";
import { digestJson, sha256 } from "./digest.js";
import { IcarusError } from "./errors.js";
import { decodeGitHubLandingProfileV1, type GitHubLandingProfileV1 } from "./landing-records.js";
import { assertOperatorActor } from "./policy.js";
import { parseProviderBaseUrl } from "./provider.js";
import type { JsonValue, ProviderKind, ProviderLocality } from "./types.js";

// The Gate 1 credential-gated live-evidence profile (S3).
//
// The offline Gate 1 benchmark proves Icarus reproduces byte-pinned candidate
// objects against fixtures. It cannot prove the remote landing chain works,
// because it never contacts GitHub. This record is the separate, human-approved
// authority that permits exactly one bounded live attempt per pinned case, and
// nothing else.
//
// Three properties carry the safety of this record:
//
//  1. It binds the offline manifest digest, the exact case set, AND each case's
//     authoritative repository identity (owner, repository, base branch) as
//     pinned by that manifest case. A matching case-id set alone is not a pin:
//     without the identity comparison a profile could carry the exact digest
//     and case ids, hold a self-consistent approval, and still aim a case at a
//     repository nobody reviewed. Those identities must also be DISTINCT, so a
//     single repository cannot receive the effects of two cases. Changing the
//     manifest invalidates the profile — and that is true because the manifest
//     is supplied as BYTES whose digest is computed here, not as a parsed object
//     beside a digest string the caller merely asserts corresponds to it.
//  2. Its effect list is a CLOSED set, compared by equality rather than by
//     subset. Authority cannot be widened by appending an effect, and the
//     prohibitions (force update, ref deletion, merge, deployment,
//     source-checkout mutation) remain inexpressible because no effect naming
//     them exists.
//  3. Approval is digest-bound. `approval.profileDigestSha256` is the digest of
//     this record with `approval` removed, so editing any pinned field after
//     approval invalidates it. Approval attaches to exact content, never to a
//     profile name.
//
// The per-repository branch/PR-triggered automation assessment is NOT modelled
// here. It already exists as `derivativeEffects` on GitHubLandingProfileV1
// (disposition plus operator evidence digest), and duplicating it would create
// a second source of truth for the same fact. This record requires each case to
// carry a decoded landing profile, so the assessment is mandatory by
// construction. That matters because creating a head reference or opening a
// same-repo draft pull request runs the head branch's own automation with
// repository secrets: it is a code-execution boundary, not a formality.

export const LIVE_EVIDENCE_PROFILE_SCHEMA_VERSION = 1;

/** The complete authority a live-evidence run may express. Compared by exact
 * equality: neither a missing nor an additional effect is accepted. */
export const LIVE_EVIDENCE_AUTHORIZED_EFFECTS = [
  "github.objects.upload",
  "github.ref.create.absent_only",
  "github.pull_request.create.draft",
  "github.landing.receipt",
] as const;

export type LiveEvidenceEffect = (typeof LIVE_EVIDENCE_AUTHORIZED_EFFECTS)[number];

/** Ceilings the run must refuse to exceed. A live run spends real money and
 * real wall clock against real repositories; both need a stated bound. */
export interface LiveEvidenceBudgetV1 {
  readonly maxSpendUsd: number;
  readonly maxRuntimeSeconds: number;
}

/** The real provider and model, pinned. `adapterVersion` records which adapter
 * produced the evidence, so a later adapter change cannot silently inherit an
 * old run's approval. */
export interface LiveEvidenceProviderPinV1 {
  readonly kind: ProviderKind;
  readonly model: string;
  readonly baseUrl: string;
  readonly adapterVersion: string;
  readonly inputUsdPerMillionTokens: number | null;
  readonly outputUsdPerMillionTokens: number | null;
}

export interface LiveEvidenceCasePinV1 {
  readonly caseId: string;
  readonly landingProfile: GitHubLandingProfileV1;
}

export interface LiveEvidenceApprovalV1 {
  readonly actor: string;
  readonly approvedAt: string;
  readonly profileDigestSha256: string;
}

export interface LiveEvidenceProfileDraftV1 {
  readonly schemaVersion: typeof LIVE_EVIDENCE_PROFILE_SCHEMA_VERSION;
  readonly profileId: string;
  readonly benchmarkId: string;
  readonly benchmarkRevision: string;
  readonly offlineManifestDigest: string;
  readonly provider: LiveEvidenceProviderPinV1;
  readonly budgets: LiveEvidenceBudgetV1;
  readonly authorizedEffects: readonly LiveEvidenceEffect[];
  readonly cases: readonly LiveEvidenceCasePinV1[];
}

export interface LiveEvidenceProfileV1 extends LiveEvidenceProfileDraftV1 {
  readonly approval: LiveEvidenceApprovalV1;
}

// The manifest's model-adapter block, decoded strictly so a renamed or dropped
// field is refused rather than silently unbound. Only `provider`, `paid` and
// the two rates are COMPARED against the profile — see
// `assertLiveEvidenceProfileMatchesManifest` and ADR 0050 for why `model`,
// `adapterVersion`, `transport`, `expectedRequests` and `credentials` are
// deliberately not.
const MANIFEST_MODEL_ADAPTER_KEYS = [
  "provider",
  "model",
  "adapterVersion",
  "transport",
  "inputUsdPerMillionTokens",
  "outputUsdPerMillionTokens",
  "expectedRequests",
  "paid",
  "credentials",
] as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_CASES = 64;

function invalid(message: string): never {
  throw new IcarusError("INVALID_LIVE_EVIDENCE_PROFILE", message);
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Matches the surrogate-pair check used by the landing decoders; the compiler
// target predates String.prototype.isWellFormed.
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

// Strict record decode: unknown or missing keys are refused rather than
// ignored, and a non-plain prototype is refused outright.
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

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || !isWellFormedUnicode(value)) {
    invalid(`${field} must be a non-empty well-formed string`);
  }
  return value;
}

function digest(value: unknown, field: string): string {
  const decoded = text(value, field);
  if (!SHA256_PATTERN.test(decoded)) {
    invalid(`${field} must be a lowercase hexadecimal SHA-256 digest`);
  }
  return decoded;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${field} must be a finite number`);
  }
  return value;
}

function nullableRate(value: unknown, field: string): number | null {
  if (value === null) return null;
  const decoded = finiteNumber(value, field);
  if (decoded < 0) invalid(`${field} must not be negative`);
  return decoded;
}

/**
 * Decode the manifest from the exact bytes whose digest was just verified.
 *
 * Fatal UTF-8: a byte sequence that is not valid UTF-8 is refused rather than
 * silently replaced, because a replacement character would change what is
 * validated away from what was hashed.
 */
function decodeManifestBytes(manifestBytes: Uint8Array): {
  readonly benchmarkId?: unknown;
  readonly benchmarkRevision?: unknown;
  readonly cases?: unknown;
} {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  } catch {
    invalid("offline manifest bytes are not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text);
  } catch {
    invalid("offline manifest bytes are not strict JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    invalid("offline manifest must decode to an object");
  }
  return parsed as {
    readonly benchmarkId?: unknown;
    readonly benchmarkRevision?: unknown;
    readonly cases?: unknown;
  };
}

function decodeProvider(value: unknown): LiveEvidenceProviderPinV1 {
  const decoded = record(
    value,
    [
      "kind",
      "model",
      "baseUrl",
      "adapterVersion",
      "inputUsdPerMillionTokens",
      "outputUsdPerMillionTokens",
    ],
    "profile.provider",
  );
  const kind = text(decoded.kind, "profile.provider.kind");
  if (kind !== "ollama" && kind !== "openai" && kind !== "anthropic") {
    invalid("profile.provider.kind must be ollama, openai, or anthropic");
  }
  const baseUrl = text(decoded.baseUrl, "profile.provider.baseUrl");
  // Resolved through `parseProviderBaseUrl`, the same function every consumer
  // uses, rather than re-derived here.
  //
  // This pin binds the provider NAME. Until this call it did not bind the
  // provider HOST: it re-implemented a weaker subset of the URL rule — valid
  // URL, HTTP(S), no embedded credentials — and knew nothing of locality. So a
  // profile could carry the exact reviewed manifest digest, the correct
  // repository identities and a self-consistent approval while aiming the run's
  // model traffic at any host on the internet. That is the same shape as the
  // credential preflight before it applied its consumers' predicate: a gate
  // asserting less than the code behind it.
  //
  // Re-deriving was also strictly weaker in two ways nobody intended:
  // `parseProviderBaseUrl` refuses query and fragment data outright, and
  // `createProviderConfig` refuses plaintext HTTP to a remote host. Both were
  // admitted here.
  let parsed: URL;
  let locality: ProviderLocality;
  try {
    ({ url: parsed, locality } = parseProviderBaseUrl(baseUrl));
  } catch (error) {
    // Re-thrown in this module's own error class so a caller that classifies
    // refusals by code sees one contract, not two.
    invalid(
      `profile.provider.baseUrl is not a usable provider URL: ${
        error instanceof IcarusError ? error.message : "invalid"
      }`,
    );
  }
  if (locality === "remote" && parsed.protocol !== "https:") {
    invalid("profile.provider.baseUrl must use HTTPS for a remote host");
  }
  // An `ollama` pin must be loopback. This is the one rule here that is STRICTER
  // than its consumer rather than equal to it, and it is deliberate.
  // `OllamaGateway` has no origin invariant at all — unlike the OpenAI and
  // Anthropic gateways, which each pin their remote origin — so there is no
  // consumer predicate to mirror, and the bound has to come from the authority
  // record. Every other part of this record already assumes local: the provider
  // credential table maps `ollama` to `null`, so no key is preflighted and none
  // is sent, and an unpaid manifest case with zero rates is only honest if
  // nothing is billed. A remote `ollama` endpoint would collect the repository
  // context and drive the tool calls that write to three real repositories,
  // with no credential, no egress approval, and a spend ceiling that can never
  // fire. A remote Ollama deployment is a different product decision and needs
  // its own ADR and credential story.
  if (kind === "ollama" && locality !== "loopback") {
    invalid("profile.provider.baseUrl must be loopback for an ollama pin");
  }
  // For the hosted kinds, mirror the gateway that will actually receive the
  // credential. Loopback stays admissible because both gateways admit it.
  if (locality === "remote") {
    const host = parsed.hostname.toLowerCase();
    const portAllowed = parsed.port === "" || parsed.port === "443";
    if (kind === "openai" && !(host === "api.openai.com" && portAllowed)) {
      invalid("profile.provider.baseUrl must be api.openai.com for an openai pin");
    }
    if (kind === "anthropic" && !(host === "api.anthropic.com" && portAllowed)) {
      invalid("profile.provider.baseUrl must be api.anthropic.com for an anthropic pin");
    }
  }
  return {
    kind: kind as ProviderKind,
    model: text(decoded.model, "profile.provider.model"),
    baseUrl,
    adapterVersion: text(decoded.adapterVersion, "profile.provider.adapterVersion"),
    inputUsdPerMillionTokens: nullableRate(
      decoded.inputUsdPerMillionTokens,
      "profile.provider.inputUsdPerMillionTokens",
    ),
    outputUsdPerMillionTokens: nullableRate(
      decoded.outputUsdPerMillionTokens,
      "profile.provider.outputUsdPerMillionTokens",
    ),
  };
}

function decodeBudgets(value: unknown): LiveEvidenceBudgetV1 {
  const decoded = record(value, ["maxSpendUsd", "maxRuntimeSeconds"], "profile.budgets");
  const maxSpendUsd = finiteNumber(decoded.maxSpendUsd, "profile.budgets.maxSpendUsd");
  if (maxSpendUsd < 0) invalid("profile.budgets.maxSpendUsd must not be negative");
  const maxRuntimeSeconds = finiteNumber(
    decoded.maxRuntimeSeconds,
    "profile.budgets.maxRuntimeSeconds",
  );
  if (!Number.isInteger(maxRuntimeSeconds) || maxRuntimeSeconds <= 0) {
    invalid("profile.budgets.maxRuntimeSeconds must be a positive integer");
  }
  return { maxSpendUsd, maxRuntimeSeconds };
}

function decodeEffects(value: unknown): readonly LiveEvidenceEffect[] {
  if (!Array.isArray(value)) invalid("profile.authorizedEffects must be an array");
  const decoded = value.map((entry, index) => text(entry, `profile.authorizedEffects[${index}]`));
  // Equality, not subset: an authority list that can grow by appending is not a
  // bound. Order is fixed too, so the reviewed bytes are the accepted bytes.
  if (
    decoded.length !== LIVE_EVIDENCE_AUTHORIZED_EFFECTS.length ||
    !decoded.every((entry, index) => entry === LIVE_EVIDENCE_AUTHORIZED_EFFECTS[index])
  ) {
    invalid(
      `profile.authorizedEffects must be exactly ${JSON.stringify(LIVE_EVIDENCE_AUTHORIZED_EFFECTS)}`,
    );
  }
  return [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS];
}

function decodeCases(value: unknown): readonly LiveEvidenceCasePinV1[] {
  if (!Array.isArray(value)) invalid("profile.cases must be an array");
  if (value.length === 0) invalid("profile.cases must not be empty");
  if (value.length > MAX_CASES) invalid(`profile.cases must not exceed ${MAX_CASES} entries`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const decoded = record(entry, ["caseId", "landingProfile"], `profile.cases[${index}]`);
    const caseId = text(decoded.caseId, `profile.cases[${index}].caseId`);
    if (seen.has(caseId)) {
      invalid(`profile.cases contains duplicate caseId ${caseId}`);
    }
    seen.add(caseId);
    // Reuses the landing profile decoder wholesale, which is what makes the
    // per-repository automation assessment (derivativeEffects: disposition plus
    // evidence digest) mandatory here rather than restated.
    const landingProfile = decodeGitHubLandingProfileV1(decoded.landingProfile);
    return { caseId, landingProfile };
  });
}

function decodeApproval(value: unknown): LiveEvidenceApprovalV1 {
  const decoded = record(value, ["actor", "approvedAt", "profileDigestSha256"], "profile.approval");
  const approvedAt = text(decoded.approvedAt, "profile.approval.approvedAt");
  const parsed = new Date(approvedAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== approvedAt) {
    invalid("profile.approval.approvedAt must be an exact ISO-8601 UTC instant");
  }
  return {
    actor: text(decoded.actor, "profile.approval.actor"),
    approvedAt,
    profileDigestSha256: digest(
      decoded.profileDigestSha256,
      "profile.approval.profileDigestSha256",
    ),
  };
}

/**
 * Digest of the profile with `approval` removed. This is the value an approver
 * signs off on, so any later edit to a pinned field invalidates the approval
 * rather than silently inheriting it.
 */
export function liveEvidenceProfileApprovalDigest(profile: LiveEvidenceProfileDraftV1): string {
  const approvable = {
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    benchmarkId: profile.benchmarkId,
    benchmarkRevision: profile.benchmarkRevision,
    offlineManifestDigest: profile.offlineManifestDigest,
    provider: {
      kind: profile.provider.kind,
      model: profile.provider.model,
      baseUrl: profile.provider.baseUrl,
      adapterVersion: profile.provider.adapterVersion,
      inputUsdPerMillionTokens: profile.provider.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: profile.provider.outputUsdPerMillionTokens,
    },
    budgets: {
      maxSpendUsd: profile.budgets.maxSpendUsd,
      maxRuntimeSeconds: profile.budgets.maxRuntimeSeconds,
    },
    authorizedEffects: [...profile.authorizedEffects],
    cases: profile.cases.map((entry) => ({
      caseId: entry.caseId,
      landingProfile: entry.landingProfile as unknown as JsonValue,
    })),
  } as unknown as JsonValue;
  return digestJson(approvable);
}

/** Decode an untrusted value into a profile. Structure only; see
 * `assertLiveEvidenceProfileApproved` and
 * `assertLiveEvidenceProfileMatchesManifest` for the binding checks. */
function decodeLiveEvidenceProfileDraftRecord(
  decoded: Record<string, unknown>,
): LiveEvidenceProfileDraftV1 {
  if (decoded.schemaVersion !== LIVE_EVIDENCE_PROFILE_SCHEMA_VERSION) {
    invalid(`profile.schemaVersion must equal ${LIVE_EVIDENCE_PROFILE_SCHEMA_VERSION}`);
  }
  const profileId = text(decoded.profileId, "profile.profileId");
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    invalid("profile.profileId must be canonical lowercase ASCII");
  }
  return {
    schemaVersion: LIVE_EVIDENCE_PROFILE_SCHEMA_VERSION,
    profileId,
    benchmarkId: text(decoded.benchmarkId, "profile.benchmarkId"),
    benchmarkRevision: text(decoded.benchmarkRevision, "profile.benchmarkRevision"),
    offlineManifestDigest: digest(decoded.offlineManifestDigest, "profile.offlineManifestDigest"),
    provider: decodeProvider(decoded.provider),
    budgets: decodeBudgets(decoded.budgets),
    authorizedEffects: decodeEffects(decoded.authorizedEffects),
    cases: decodeCases(decoded.cases),
  };
}

const LIVE_EVIDENCE_PROFILE_DRAFT_KEYS = [
  "schemaVersion",
  "profileId",
  "benchmarkId",
  "benchmarkRevision",
  "offlineManifestDigest",
  "provider",
  "budgets",
  "authorizedEffects",
  "cases",
] as const;

/** Decode an untrusted value into a profile. Structure only; see
 * `assertLiveEvidenceProfileApproved` and
 * `assertLiveEvidenceProfileMatchesManifest` for the binding checks. */
export function decodeLiveEvidenceProfileV1(value: unknown): LiveEvidenceProfileV1 {
  const decoded = record(value, [...LIVE_EVIDENCE_PROFILE_DRAFT_KEYS, "approval"], "profile");
  return {
    ...decodeLiveEvidenceProfileDraftRecord(decoded),
    approval: decodeApproval(decoded.approval),
  };
}

/** Decode the exact content an operator may approve; approval is never inferred. */
export function decodeLiveEvidenceProfileDraftV1(value: unknown): LiveEvidenceProfileDraftV1 {
  return decodeLiveEvidenceProfileDraftRecord(
    record(value, LIVE_EVIDENCE_PROFILE_DRAFT_KEYS, "profile"),
  );
}

/**
 * Produce the approval envelope only after the draft is proven to match the
 * exact reviewed manifest bytes. This records authority; it does not execute
 * any effect and does not mint reusable session authority.
 */
export function approveLiveEvidenceProfileV1(
  value: unknown,
  manifestBytes: Uint8Array,
  actorInput: string,
  approvedAtInput: string,
): LiveEvidenceProfileV1 {
  const draft = decodeLiveEvidenceProfileDraftV1(value);
  assertLiveEvidenceProfileMatchesManifest(draft, manifestBytes);
  const actor = text(actorInput, "profile.approval.actor");
  assertOperatorActor(actor, "INVALID_LIVE_EVIDENCE_PROFILE");
  const approval = decodeApproval({
    actor,
    approvedAt: approvedAtInput,
    profileDigestSha256: liveEvidenceProfileApprovalDigest(draft),
  });
  const profile = decodeLiveEvidenceProfileV1({ ...draft, approval });
  assertLiveEvidenceProfileApproved(profile);
  return profile;
}

/** Approval must bind to exact content. */
export function assertLiveEvidenceProfileApproved(profile: LiveEvidenceProfileV1): void {
  const expected = liveEvidenceProfileApprovalDigest(profile);
  if (expected !== profile.approval.profileDigestSha256) {
    invalid(
      "profile.approval.profileDigestSha256 does not match the profile content; the approval does not apply to this profile",
    );
  }
}

/**
 * The profile must target exactly the reviewed offline contract: same manifest
 * bytes, same benchmark identity, and a bijection with its case set. A profile
 * that covers only some cases cannot produce 3/3 evidence, and one that names
 * an unknown case is targeting work nobody reviewed.
 *
 * The manifest is untrusted input here, so its own well-formedness — distinct
 * case ids, distinct `owner/repository` identities, a pinned identity on every
 * case — is checked rather than assumed of whichever caller supplied it.
 */
export function assertLiveEvidenceProfileMatchesManifest(
  profile: LiveEvidenceProfileDraftV1,
  manifestBytes: Uint8Array,
): void {
  // The manifest arrives as BYTES, and the digest is computed here.
  //
  // This function once took the parsed manifest and its digest as two separate
  // parameters and compared the profile's pin against the digest STRING. That
  // compared the caller's claim to the caller's other claim: nothing linked the
  // digest to the object, so an edited manifest handed over with the reviewed
  // manifest's digest was admitted, and every binding below — repository
  // identity, provider kind, unpaid-means-unpaid, the spend ceiling — was then
  // evaluated against the edited one. A digest passed alongside the thing it is
  // supposed to authenticate authenticates nothing.
  //
  // Taking bytes removes the pair, so the mismatch is not merely detected, it is
  // unrepresentable. The parse below reads THESE bytes, so what is validated is
  // necessarily what was hashed. `scripts/gate1-benchmark.mjs:1024-1033` has
  // always done exactly this; the authority function is what had drifted.
  if (!(manifestBytes instanceof Uint8Array)) {
    invalid("offline manifest must be supplied as the exact reviewed bytes");
  }
  if (profile.offlineManifestDigest !== sha256(manifestBytes)) {
    invalid("profile.offlineManifestDigest does not match the offline manifest");
  }
  const manifest = decodeManifestBytes(manifestBytes);
  if (profile.benchmarkId !== manifest.benchmarkId) {
    invalid("profile.benchmarkId does not match the offline manifest");
  }
  if (profile.benchmarkRevision !== manifest.benchmarkRevision) {
    invalid("profile.benchmarkRevision does not match the offline manifest");
  }
  if (!Array.isArray(manifest.cases)) {
    invalid("offline manifest has no case list");
  }
  // Each manifest case carries the authoritative repository identity for that
  // case. Absence is refused rather than skipped: a missing pin must not read
  // as "no constraint", because the repository is the field that decides which
  // real repository receives real effects.
  const manifestCases = manifest.cases.map((entry, index) => {
    const decoded = entry as {
      readonly id?: unknown;
      readonly repository?: unknown;
      readonly modelAdapter?: unknown;
      readonly budgets?: unknown;
    };
    const id = text(decoded.id, `manifest.cases[${index}].id`);
    const repository = decoded.repository;
    if (typeof repository !== "object" || repository === null || Array.isArray(repository)) {
      invalid(
        `manifest.cases[${index}].repository must carry the authoritative repository identity`,
      );
    }
    const pinned = repository as Record<string, unknown>;
    // The manifest also pins which model produces the evidence and how much the
    // case may cost. Both are refused when absent, for the same reason the
    // repository identity is: a missing pin must not read as no constraint.
    const modelAdapter = record(
      decoded.modelAdapter,
      MANIFEST_MODEL_ADAPTER_KEYS,
      `manifest.cases[${index}].modelAdapter`,
    );
    const budgets = decoded.budgets;
    if (typeof budgets !== "object" || budgets === null || Array.isArray(budgets)) {
      invalid(`manifest.cases[${index}].budgets must carry the authoritative case ceilings`);
    }
    const maxCostUsd = finiteNumber(
      (budgets as Record<string, unknown>).maxCostUsd,
      `manifest.cases[${index}].budgets.maxCostUsd`,
    );
    if (maxCostUsd < 0) {
      invalid(`manifest.cases[${index}].budgets.maxCostUsd must not be negative`);
    }
    const paid = modelAdapter.paid;
    if (typeof paid !== "boolean") {
      invalid(`manifest.cases[${index}].modelAdapter.paid must be a boolean`);
    }
    return {
      id,
      githubOwner: text(pinned.githubOwner, `manifest.cases[${index}].repository.githubOwner`),
      githubRepository: text(
        pinned.githubRepository,
        `manifest.cases[${index}].repository.githubRepository`,
      ),
      baseBranch: text(pinned.baseBranch, `manifest.cases[${index}].repository.baseBranch`),
      providerKind: text(modelAdapter.provider, `manifest.cases[${index}].modelAdapter.provider`),
      paid,
      maxCostUsd,
    };
  });
  // Distinctness is an admission prerequisite this function establishes for
  // itself rather than assuming of its caller. `scripts/gate1-benchmark-
  // contract.mjs` refuses a manifest whose case ids or `owner/name` GitHub
  // identities repeat; that validator is separate, untyped from here, and may
  // simply not have run. Two case ids aimed at one repository would let a
  // single landing receive two draft-pull-request POSTs while each case's own
  // ledger count stayed at one, contradicting the durable
  // `one_create_pr_post_per_landing` index. The uniqueness key is
  // `owner/repository`, matching that validator exactly so the two contracts
  // cannot drift apart.
  const seenManifestCaseIds = new Set<string>();
  const seenGitHubIdentities = new Set<string>();
  for (const entry of manifestCases) {
    if (seenManifestCaseIds.has(entry.id)) {
      invalid(`offline manifest contains duplicate case id ${entry.id}`);
    }
    seenManifestCaseIds.add(entry.id);
    const identity = `${entry.githubOwner}/${entry.githubRepository}`;
    if (seenGitHubIdentities.has(identity)) {
      invalid(
        `offline manifest maps more than one case to repository ${identity}; each case must land in its own repository`,
      );
    }
    seenGitHubIdentities.add(identity);
  }

  const profileCaseIds = profile.cases.map((entry) => entry.caseId);
  const sortedManifest = [...manifestCases.map((entry) => entry.id)].sort(asciiCompare);
  const sortedProfile = [...profileCaseIds].sort(asciiCompare);
  if (
    sortedManifest.length !== sortedProfile.length ||
    !sortedManifest.every((id, index) => id === sortedProfile[index])
  ) {
    invalid(
      "profile.cases must cover exactly the offline manifest case set, with no missing or extra case",
    );
  }
  // A matching case-id set is not a pin. Without this, a profile carrying the
  // exact manifest digest, the exact case ids, and a self-consistent approval
  // could still aim a case at a repository nobody reviewed.
  for (const entry of profile.cases) {
    const pinned = manifestCases.find((candidate) => candidate.id === entry.caseId);
    if (pinned === undefined) {
      invalid(`profile.cases contains ${entry.caseId}, which the offline manifest does not pin`);
    }
    const landing = entry.landingProfile;
    if (
      landing.owner !== pinned.githubOwner ||
      landing.repository !== pinned.githubRepository ||
      landing.baseBranch !== pinned.baseBranch
    ) {
      invalid(
        `profile case ${entry.caseId} targets ${landing.owner}/${landing.repository}@${landing.baseBranch}, but the offline manifest pins ${pinned.githubOwner}/${pinned.githubRepository}@${pinned.baseBranch}`,
      );
    }
  }

  // Repository identity decides WHICH repositories receive effects. These two
  // decide WHICH MODEL produces the evidence and WHETHER REAL MONEY IS SPENT,
  // and until now neither was compared at all: a profile carrying the exact
  // reviewed manifest digest, the exact case ids, correct repository identities
  // and a self-consistent digest-bound approval could pin a paid remote model
  // at an arbitrary ceiling against a manifest declaring `paid: false`, zero
  // token rates and `maxCostUsd: 0`. An approval that binds everything except
  // the spend is not a spending authority.
  for (const pinned of manifestCases) {
    if (profile.provider.kind !== pinned.providerKind) {
      invalid(
        `profile pins provider ${profile.provider.kind}, but offline manifest case ${pinned.id} pins ${pinned.providerKind}`,
      );
    }
    // `paid: false` is the manifest declaring this case costs nothing to run.
    // A profile whose provider carries a non-zero rate contradicts that before
    // a single token is generated. Null rates are the loopback case and are
    // accepted: nothing is charged.
    if (!pinned.paid) {
      const rates = [
        profile.provider.inputUsdPerMillionTokens,
        profile.provider.outputUsdPerMillionTokens,
      ];
      if (rates.some((rate) => rate !== null && rate !== 0)) {
        invalid(
          `offline manifest case ${pinned.id} declares an unpaid model adapter, but the profile pins token rates ${JSON.stringify(rates)}`,
        );
      }
    }
    if (profile.budgets.maxSpendUsd > pinned.maxCostUsd) {
      invalid(
        `profile authorizes up to ${profile.budgets.maxSpendUsd} USD, above the ${pinned.maxCostUsd} USD ceiling offline manifest case ${pinned.id} pins`,
      );
    }
  }
}
