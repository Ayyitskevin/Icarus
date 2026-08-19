import { digestJson } from "./digest.js";
import { IcarusError } from "./errors.js";
import { decodeGitHubLandingProfileV1, type GitHubLandingProfileV1 } from "./landing-records.js";
import type { JsonValue, ProviderKind } from "./types.js";

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
//     repository nobody reviewed. Changing the manifest invalidates the profile.
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

export interface LiveEvidenceProfileV1 {
  readonly schemaVersion: typeof LIVE_EVIDENCE_PROFILE_SCHEMA_VERSION;
  readonly profileId: string;
  readonly benchmarkId: string;
  readonly benchmarkRevision: string;
  readonly offlineManifestDigest: string;
  readonly provider: LiveEvidenceProviderPinV1;
  readonly budgets: LiveEvidenceBudgetV1;
  readonly authorizedEffects: readonly LiveEvidenceEffect[];
  readonly cases: readonly LiveEvidenceCasePinV1[];
  readonly approval: LiveEvidenceApprovalV1;
}

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
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    invalid("profile.provider.baseUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    invalid("profile.provider.baseUrl must use HTTP(S)");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    invalid("profile.provider.baseUrl must not embed credentials");
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
export function liveEvidenceProfileApprovalDigest(
  profile: Omit<LiveEvidenceProfileV1, "approval">,
): string {
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
export function decodeLiveEvidenceProfileV1(value: unknown): LiveEvidenceProfileV1 {
  const decoded = record(
    value,
    [
      "schemaVersion",
      "profileId",
      "benchmarkId",
      "benchmarkRevision",
      "offlineManifestDigest",
      "provider",
      "budgets",
      "authorizedEffects",
      "cases",
      "approval",
    ],
    "profile",
  );
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
    approval: decodeApproval(decoded.approval),
  };
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
 */
export function assertLiveEvidenceProfileMatchesManifest(
  profile: LiveEvidenceProfileV1,
  manifest: {
    readonly benchmarkId?: unknown;
    readonly benchmarkRevision?: unknown;
    readonly cases?: unknown;
  },
  manifestDigest: string,
): void {
  if (profile.offlineManifestDigest !== digest(manifestDigest, "manifestDigest")) {
    invalid("profile.offlineManifestDigest does not match the offline manifest");
  }
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
    const decoded = entry as { readonly id?: unknown; readonly repository?: unknown };
    const id = text(decoded.id, `manifest.cases[${index}].id`);
    const repository = decoded.repository;
    if (typeof repository !== "object" || repository === null || Array.isArray(repository)) {
      invalid(
        `manifest.cases[${index}].repository must carry the authoritative repository identity`,
      );
    }
    const pinned = repository as Record<string, unknown>;
    return {
      id,
      githubOwner: text(pinned.githubOwner, `manifest.cases[${index}].repository.githubOwner`),
      githubRepository: text(
        pinned.githubRepository,
        `manifest.cases[${index}].repository.githubRepository`,
      ),
      baseBranch: text(pinned.baseBranch, `manifest.cases[${index}].repository.baseBranch`),
    };
  });
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
}
