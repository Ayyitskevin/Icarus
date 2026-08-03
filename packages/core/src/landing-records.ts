import { createHash } from "node:crypto";

import { containsSecretShapedContent } from "./context.js";
import { digestJson, sha256, stableJson } from "./digest.js";
import { IcarusError } from "./errors.js";
import {
  canAttachLandingHttpKind,
  canStartLandingOperation,
  canTransitionLanding,
  isLandingHttpKindV1,
  isLandingOperationKindV1,
  isLandingResumeStateV1,
  isLandingStateV1,
  type LandingHttpKindV1,
  type LandingOperationKindV1,
  type LandingResumeStateV1,
  type LandingStateV1,
} from "./landing-state.js";
import { assertAllowedTarget } from "./policy.js";
import type { CheckProfile, JsonValue, VerificationEvidence } from "./types.js";

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA1_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GIT_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const LANDING_CREDENTIAL_ENV_PATTERN =
  /^ICARUS_GITHUB_TOKEN_[A-Z0-9](?:[A-Z0-9_]{0,106}[A-Z0-9])?$/;
const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9._-]{1,100}$/;
const ASCII_PRINTABLE_PATTERN = /^[\x20-\x7e]+$/;
const UNICODE_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const PROFILE_BASE_BRANCH_URL_SYNTAX_PATTERN = /(?:^[A-Za-z][A-Za-z0-9+.-]*:\/\/|^\/\/|[?#])/;

export const LANDING_POLICY_VERSION = 1 as const;
export const GITHUB_API_VERSION = "2026-03-10" as const;
export const GITHUB_API_ORIGIN = "https://api.github.com" as const;
export const GITHUB_RECEIPT_ORIGIN = "https://github.com" as const;
export const LANDING_BRANCH_NAMESPACE = "icarus/" as const;
export const LANDING_CREDENTIAL_ENV_PREFIX = "ICARUS_GITHUB_TOKEN_" as const;
export const LANDING_OUTGOING_AUDIT_POLICY_VERSION = "landing-outgoing-v1" as const;
export const MAX_COMMIT_MESSAGE_BYTES = 4 * 1024;
export const MAX_PULL_REQUEST_TITLE_BYTES = 256;
export const MAX_PULL_REQUEST_BODY_PREFIX_BYTES = 32 * 1024;
export const MAX_PULL_REQUEST_BODY_BYTES = 40 * 1024;
export const MAX_COMMIT_EPOCH_SECONDS = 253_402_300_799;

export const DIRECT_ICARUS_EFFECTS = [
  "local_ref.create",
  "github.objects.upload",
  "github.ref.create",
  "github.draft_pull_request.create",
] as const;

export const DERIVATIVE_GITHUB_EVENTS = ["create", "pull_request.opened"] as const;

export const DERIVATIVE_EFFECTS = [
  "actions",
  "webhooks",
  "bots",
  "notifications",
  "deployments",
] as const;

export interface GitHubLandingProfileV1 {
  readonly version: 1;
  readonly provider: "github";
  readonly owner: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly branchNamespace: "icarus/";
  readonly credentialRef: {
    readonly kind: "environment";
    readonly name: string;
  };
  readonly expectedActor: string;
  readonly commitIdentity: {
    readonly name: string;
    readonly email: string;
  };
  readonly derivativeEffects: {
    readonly version: 1;
    readonly disposition: "inert-repository" | "operator-approved";
    readonly evidenceSha256: string;
  };
}

export interface ChangedPathsDigestV1 {
  readonly schemaVersion: 1;
  readonly paths: readonly string[];
}

export interface ReviewDecisionDigestV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly runId: string;
  readonly kind: "review";
  readonly digest: string;
  readonly actor: string;
  readonly decision: "approve";
  readonly createdAt: string;
}

export interface VerificationCheckDigestV1 {
  readonly checkId: string;
  readonly argv: readonly string[];
  readonly exitCode: 0;
  readonly signal: null;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stdoutSha256: string;
  readonly stderrBytes: number;
  readonly stderrSha256: string;
  readonly truncated: boolean;
  readonly outcome: "passed";
}

export interface VerificationDigestV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly outcome: "passed";
  readonly changedPaths: readonly string[];
  readonly diffSha256: string;
  readonly checkpointSha256: string;
  readonly checks: readonly VerificationCheckDigestV1[];
}

export type CandidateCredentialAuditSubjectV1 =
  | {
      readonly kind: "changed_blob";
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
    }
  | {
      readonly kind: "commit_message" | "pull_request_title" | "pull_request_body_prefix";
      readonly path: null;
      readonly bytes: number;
      readonly sha256: string;
    };

export interface CandidateCredentialAuditV1 {
  readonly schemaVersion: 1;
  readonly policyVersion: "landing-outgoing-v1";
  readonly outcome: "passed";
  readonly subjects: readonly CandidateCredentialAuditSubjectV1[];
}

export interface CandidateObjectManifestEntryV1 {
  readonly path: string;
  readonly op: "modify" | "create" | "delete";
  readonly mode: "100644";
  readonly blobSha1: string | null;
  readonly contentBytes: number | null;
  readonly contentSha256: string | null;
}

export interface CandidateObjectManifestV1 {
  readonly schemaVersion: 1;
  readonly baseCommitSha1: string;
  readonly baseTreeSha1: string;
  readonly candidateTreeSha1: string;
  readonly candidateCommitSha1: string;
  readonly candidateCommitPayloadSha256: string;
  readonly entries: readonly CandidateObjectManifestEntryV1[];
}

export interface LandingDigestV1 {
  readonly schemaVersion: 1;
  readonly policyVersion: 1;
  readonly githubApiVersion: "2026-03-10";
  readonly landingId: string;
  readonly runId: string;
  readonly projectId: string;
  readonly baseCommitSha1: string;
  readonly baseTreeSha1: string;
  readonly planSha256: string;
  readonly diffSha256: string;
  readonly checkpointSha256: string;
  readonly verificationSha256: string;
  readonly reviewDecisionId: string;
  readonly reviewDecisionSha256: string;
  readonly changedPaths: readonly string[];
  readonly changedPathsSha256: string;
  readonly candidateCredentialAuditSha256: string;
  readonly profileVersion: 1;
  readonly profileSha256: string;
  readonly profile: GitHubLandingProfileV1;
  readonly objectFormat: "sha1";
  readonly candidateParentSha1: string;
  readonly candidateTreeSha1: string;
  readonly candidateCommitSha1: string;
  readonly candidateCommitPayloadSha256: string;
  readonly candidateObjectManifestSha256: string;
  readonly commitMessageSha256: string;
  readonly commitAuthor: {
    readonly name: string;
    readonly email: string;
  };
  readonly commitCommitter: {
    readonly name: string;
    readonly email: string;
  };
  readonly commitEpochSeconds: number;
  readonly commitIso8601: string;
  readonly baseRef: string;
  readonly expectedRemoteBaseSha1: string;
  readonly headRef: string;
  readonly pullRequestTitleSha256: string;
  readonly pullRequestBodyPrefixSha256: string;
  readonly pullRequestMarkerVersion: 1;
  readonly draft: true;
  readonly maintainerCanModify: false;
  readonly directIcarusEffects: typeof DIRECT_ICARUS_EFFECTS;
  readonly derivativeEffectDisclosure: {
    readonly version: 1;
    readonly githubEvents: typeof DERIVATIVE_GITHUB_EVENTS;
    readonly mayTrigger: typeof DERIVATIVE_EFFECTS;
    readonly disposition: "inert-repository" | "operator-approved";
    readonly evidenceSha256: string;
  };
}

export interface LandingTextBindingsV1 {
  readonly commitMessage: string;
  readonly pullRequestTitle: string;
  readonly pullRequestBodyPrefix: string;
}

type JsonRecord = Record<string, unknown>;

function invalid(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new IcarusError("LANDING_RECORD_INVALID", message, details);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
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

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byteCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertJsonValue(value: unknown, field = "record"): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "string" && isWellFormedUnicode(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertJsonValue(entry, `${field}[${index}]`);
    }
    return;
  }
  if (typeof value !== "object") {
    invalid(`${field} is not a canonical JSON value`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${field} has a non-JSON prototype`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !isWellFormedUnicode(key)) {
      invalid(`${field} has an invalid key`);
    }
    assertJsonValue((value as JsonRecord)[key], `${field}.${key}`);
  }
}

function asciiStableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => asciiStableJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => asciiCompare(left, right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${asciiStableJson(entry)}`)
    .join(",")}}`;
}

/**
 * Serializes through the repository helper, while independently enforcing the
 * ADR's ascending-ASCII key rule. The consistency check prevents locale rules
 * from silently becoming landing authority.
 */
export function canonicalLandingJson(value: unknown): string {
  assertJsonValue(value);
  const repositoryCanonical = stableJson(value);
  if (repositoryCanonical !== asciiStableJson(value)) {
    invalid("Repository canonical JSON ordering is not ascending ASCII");
  }
  return repositoryCanonical;
}

export function digestLandingRecord(value: unknown): string {
  const canonical = canonicalLandingJson(value);
  assertJsonValue(value);
  const repositoryDigest = digestJson(value);
  if (repositoryDigest !== sha256(canonical)) {
    invalid("Repository canonical digest does not match canonical landing bytes");
  }
  return repositoryDigest;
}

export function decodeCanonicalLandingJson<T>(encoded: string, decode: (value: unknown) => T): T {
  if (!isWellFormedUnicode(encoded) || encoded.startsWith("\uFEFF") || encoded.endsWith("\n")) {
    invalid("Persisted landing JSON has invalid framing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    invalid("Persisted landing JSON is malformed");
  }
  const decoded = decode(parsed);
  if (encoded !== canonicalLandingJson(decoded)) {
    invalid("Persisted landing JSON is not canonical");
  }
  return decoded;
}

export function assertLandingDigest(value: unknown, expectedSha256: string): string {
  const digest = digestLandingRecord(value);
  if (!SHA256_PATTERN.test(expectedSha256) || digest !== expectedSha256) {
    invalid("Landing record digest does not match its canonical bytes");
  }
  return digest;
}

function record(value: unknown, keys: readonly string[], field: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${field} has a non-record prototype`);
  }
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.some((key) => typeof key !== "string") ||
    actualKeys.length !== keys.length ||
    ![...(actualKeys as string[])]
      .sort(asciiCompare)
      .every((key, index) => key === [...keys].sort(asciiCompare)[index])
  ) {
    invalid(`${field} has missing or unknown keys`);
  }
  return value as JsonRecord;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !isWellFormedUnicode(value)) {
    invalid(`${field} must be well-formed Unicode`);
  }
  return value;
}

function literal<T extends string | number | boolean | null>(
  value: unknown,
  expected: T,
  field: string,
): T {
  if (value !== expected) invalid(`${field} must equal ${String(expected)}`);
  return expected;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    invalid(`${field} has an unsupported value`);
  }
  return value as T[number];
}

function safeInteger(
  value: unknown,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(`${field} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function nullable<T>(value: unknown, decode: (entry: unknown) => T): T | null {
  return value === null ? null : decode(value);
}

export function assertUuid(value: unknown, field = "uuid"): string {
  const decoded = string(value, field);
  if (!UUID_PATTERN.test(decoded)) invalid(`${field} is not a canonical UUID`);
  return decoded;
}

export function assertSha1(value: unknown, field = "sha1"): string {
  const decoded = string(value, field);
  if (!SHA1_PATTERN.test(decoded)) invalid(`${field} is not a lowercase SHA-1`);
  return decoded;
}

export function assertSha256(value: unknown, field = "sha256"): string {
  const decoded = string(value, field);
  if (!SHA256_PATTERN.test(decoded)) invalid(`${field} is not a lowercase SHA-256`);
  return decoded;
}

export function assertSafeCode(value: unknown, field = "errorCode"): string {
  const decoded = string(value, field);
  if (!SAFE_CODE_PATTERN.test(decoded) || utf8Bytes(decoded) < 2 || utf8Bytes(decoded) > 128) {
    invalid(`${field} is not a safe error code`);
  }
  return decoded;
}

export function assertInstant(value: unknown, field = "instant"): string {
  const decoded = string(value, field);
  const date = new Date(decoded);
  if (
    !INSTANT_PATTERN.test(decoded) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== decoded
  ) {
    invalid(`${field} is not a canonical millisecond UTC instant`);
  }
  return decoded;
}

export function commitEpochToGitInstant(epochSeconds: number): string {
  safeInteger(epochSeconds, "commitEpochSeconds", 0, MAX_COMMIT_EPOCH_SECONDS);
  const precise = new Date(epochSeconds * 1_000).toISOString();
  if (!precise.endsWith(".000Z") || precise.length !== 24) {
    invalid("Commit epoch cannot be represented as a four-digit UTC instant");
  }
  return precise.replace(".000Z", "Z");
}

export function assertGitInstant(value: unknown, field = "gitInstant"): string {
  const decoded = string(value, field);
  if (!GIT_INSTANT_PATTERN.test(decoded)) {
    invalid(`${field} is not an exact Git UTC instant`);
  }
  const milliseconds = Date.parse(decoded);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    Math.floor(milliseconds / 1_000) > MAX_COMMIT_EPOCH_SECONDS ||
    commitEpochToGitInstant(Math.floor(milliseconds / 1_000)) !== decoded
  ) {
    invalid(`${field} is outside the v1 Git instant range`);
  }
  return decoded;
}

function assertSortedUniqueStrings(values: readonly string[], field: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const prior = values[index - 1];
    const current = values[index];
    if (prior === undefined || current === undefined || byteCompare(prior, current) >= 0) {
      invalid(`${field} must be strictly byte-sorted and duplicate-free`);
    }
  }
}

function assertLandingPath(value: unknown, field: string): string {
  const decoded = string(value, field);
  try {
    return assertAllowedTarget(decoded);
  } catch {
    invalid(`${field} is not an allowed canonical repository path`);
  }
}

function assertActor(value: unknown, field: string): string {
  const decoded = string(value, field);
  if (
    decoded.trim().length === 0 ||
    utf8Bytes(decoded) > 200 ||
    UNICODE_CONTROL_PATTERN.test(decoded) ||
    containsSecretShapedContent(Buffer.from(decoded, "utf8"))
  ) {
    invalid(`${field} is not a bounded safe actor`);
  }
  return decoded;
}

function assertCommitIdentity(
  value: unknown,
  field: string,
): {
  readonly name: string;
  readonly email: string;
} {
  const decoded = record(value, ["name", "email"], field);
  const name = string(decoded.name, `${field}.name`);
  const email = string(decoded.email, `${field}.email`);
  if (
    !ASCII_PRINTABLE_PATTERN.test(name) ||
    !ASCII_PRINTABLE_PATTERN.test(email) ||
    name.trim() !== name ||
    email.trim() !== email ||
    name.includes("<") ||
    name.includes(">") ||
    email.includes("<") ||
    email.includes(">") ||
    /\s/.test(email) ||
    email.indexOf("@") <= 0 ||
    email.indexOf("@") !== email.lastIndexOf("@") ||
    email.endsWith("@") ||
    utf8Bytes(name) > 200 ||
    utf8Bytes(email) > 254
  ) {
    invalid(`${field} is not an unambiguous printable-ASCII Git identity`);
  }
  if (containsSecretShapedContent(Buffer.from(`${name}\n${email}`, "utf8"))) {
    invalid(`${field} contains credential-shaped content`);
  }
  return { name, email };
}

export function assertGitBranchName(value: unknown, field = "baseBranch"): string {
  const decoded = string(value, field);
  const components = decoded.split("/");
  const hasForbiddenCharacter = [...decoded].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      "~^:?*[\\".includes(character)
    );
  });
  if (
    decoded.length === 0 ||
    decoded.normalize("NFC") !== decoded ||
    utf8Bytes(decoded) > 255 ||
    decoded.startsWith("/") ||
    decoded.endsWith("/") ||
    decoded.endsWith(".") ||
    decoded.includes("//") ||
    decoded.includes("..") ||
    decoded.includes("@{") ||
    hasForbiddenCharacter ||
    components.some(
      (component) =>
        component.length === 0 ||
        component === "." ||
        component === ".." ||
        component.startsWith(".") ||
        component.toLowerCase().endsWith(".lock"),
    )
  ) {
    invalid(`${field} is not one canonical Git branch name`);
  }
  return decoded;
}

function assertProfileBaseBranch(value: unknown): string {
  const decoded = string(value, "profile.baseBranch");
  if (PROFILE_BASE_BRANCH_URL_SYNTAX_PATTERN.test(decoded)) {
    invalid("profile.baseBranch contains URL, query, or fragment syntax");
  }
  const branch = assertGitBranchName(decoded, "profile.baseBranch");
  if (containsSecretShapedContent(Buffer.from(branch, "utf8"))) {
    invalid("profile.baseBranch contains credential-shaped content");
  }
  return branch;
}

function assertFullHeadRef(value: unknown, field: string): string {
  const decoded = string(value, field);
  if (!decoded.startsWith("refs/heads/")) {
    invalid(`${field} is not a fully qualified branch ref`);
  }
  assertGitBranchName(decoded.slice("refs/heads/".length), field);
  return decoded;
}

export function assertLandingCredentialEnvironmentName(
  value: unknown,
  field = "credentialEnvironmentName",
): string {
  const decoded = string(value, field);
  if (!LANDING_CREDENTIAL_ENV_PATTERN.test(decoded)) {
    invalid(`${field} violates the dedicated Icarus GitHub-token environment-name policy`);
  }
  return decoded;
}

export function decodeGitHubLandingProfileV1(value: unknown): GitHubLandingProfileV1 {
  const decoded = record(
    value,
    [
      "version",
      "provider",
      "owner",
      "repository",
      "baseBranch",
      "branchNamespace",
      "credentialRef",
      "expectedActor",
      "commitIdentity",
      "derivativeEffects",
    ],
    "profile",
  );
  literal(decoded.version, 1, "profile.version");
  literal(decoded.provider, "github", "profile.provider");
  const owner = string(decoded.owner, "profile.owner");
  const repository = string(decoded.repository, "profile.repository");
  const expectedActor = string(decoded.expectedActor, "profile.expectedActor");
  if (
    !GITHUB_OWNER_PATTERN.test(owner) ||
    owner.includes("--") ||
    !GITHUB_OWNER_PATTERN.test(expectedActor) ||
    expectedActor.includes("--") ||
    !GITHUB_REPOSITORY_PATTERN.test(repository) ||
    repository === "." ||
    repository === ".." ||
    owner !== owner.toLowerCase() ||
    repository !== repository.toLowerCase() ||
    expectedActor !== expectedActor.toLowerCase()
  ) {
    invalid("Profile GitHub identity is not canonical lowercase ASCII");
  }
  if (
    containsSecretShapedContent(Buffer.from(`${owner}\n${repository}\n${expectedActor}`, "utf8"))
  ) {
    invalid("Profile GitHub identity contains credential-shaped content");
  }
  const credentialRef = record(decoded.credentialRef, ["kind", "name"], "profile.credentialRef");
  literal(credentialRef.kind, "environment", "profile.credentialRef.kind");
  const credentialName = assertLandingCredentialEnvironmentName(
    credentialRef.name,
    "profile.credentialRef.name",
  );
  const derivativeEffects = record(
    decoded.derivativeEffects,
    ["version", "disposition", "evidenceSha256"],
    "profile.derivativeEffects",
  );
  literal(derivativeEffects.version, 1, "profile.derivativeEffects.version");
  const disposition = oneOf(
    derivativeEffects.disposition,
    ["inert-repository", "operator-approved"] as const,
    "profile.derivativeEffects.disposition",
  );
  return {
    version: 1,
    provider: "github",
    owner,
    repository,
    baseBranch: assertProfileBaseBranch(decoded.baseBranch),
    branchNamespace: literal(
      decoded.branchNamespace,
      LANDING_BRANCH_NAMESPACE,
      "profile.branchNamespace",
    ),
    credentialRef: {
      kind: "environment",
      name: credentialName,
    },
    expectedActor,
    commitIdentity: assertCommitIdentity(decoded.commitIdentity, "profile.commitIdentity"),
    derivativeEffects: {
      version: 1,
      disposition,
      evidenceSha256: assertSha256(
        derivativeEffects.evidenceSha256,
        "profile.derivativeEffects.evidenceSha256",
      ),
    },
  };
}

export function assertLandingCredentialEnvironmentAllowed(
  profile: GitHubLandingProfileV1,
  allowedNames: ReadonlySet<string>,
): void {
  const decoded = decodeGitHubLandingProfileV1(profile);
  if (!allowedNames.has(decoded.credentialRef.name)) {
    throw new IcarusError(
      "LANDING_CREDENTIAL_NOT_ALLOWED",
      "Landing credential environment reference is not startup-allowlisted",
    );
  }
}

function canonicalizeMultilineText(value: string, field: string): string {
  if (!isWellFormedUnicode(value)) invalid(`${field} must be well-formed Unicode`);
  const normalized = value.normalize("NFC").replace(/\r\n?/g, "\n");
  if (
    [...normalized].some(
      (character) => character !== "\n" && UNICODE_CONTROL_PATTERN.test(character),
    )
  ) {
    invalid(`${field} contains a forbidden control character`);
  }
  return normalized;
}

export function canonicalizeCommitMessage(value: string): string {
  let normalized = canonicalizeMultilineText(value, "commitMessage");
  if (normalized.trim().length === 0) invalid("Commit message must not be blank");
  if (!normalized.endsWith("\n")) normalized += "\n";
  if (utf8Bytes(normalized) > MAX_COMMIT_MESSAGE_BYTES) {
    invalid("Commit message exceeds the v1 byte ceiling");
  }
  return normalized;
}

export function canonicalizePullRequestTitle(value: string): string {
  if (!isWellFormedUnicode(value)) invalid("Pull-request title must be well-formed Unicode");
  const normalized = value.normalize("NFC");
  if (
    normalized.trim().length === 0 ||
    [...normalized].some((character) => UNICODE_CONTROL_PATTERN.test(character)) ||
    utf8Bytes(normalized) < 1 ||
    utf8Bytes(normalized) > MAX_PULL_REQUEST_TITLE_BYTES
  ) {
    invalid("Pull-request title is blank, unsafe, or outside the v1 byte ceiling");
  }
  return normalized;
}

export function canonicalizePullRequestBodyPrefix(value: string): string {
  const normalized = canonicalizeMultilineText(value, "pullRequestBodyPrefix");
  if (
    utf8Bytes(normalized) > MAX_PULL_REQUEST_BODY_PREFIX_BYTES ||
    normalized.includes("<!-- icarus-landing:")
  ) {
    invalid("Pull-request body prefix is too large or contains the reserved marker");
  }
  return normalized;
}

export function buildUnsignedCommitPayloadV1(input: {
  readonly candidateTreeSha1: string;
  readonly baseCommitSha1: string;
  readonly commitIdentity: { readonly name: string; readonly email: string };
  readonly commitEpochSeconds: number;
  readonly commitMessage: string;
}): Uint8Array {
  const tree = assertSha1(input.candidateTreeSha1, "candidateTreeSha1");
  const parent = assertSha1(input.baseCommitSha1, "baseCommitSha1");
  const identity = assertCommitIdentity(input.commitIdentity, "commitIdentity");
  const epoch = safeInteger(
    input.commitEpochSeconds,
    "commitEpochSeconds",
    0,
    MAX_COMMIT_EPOCH_SECONDS,
  );
  const message = canonicalizeCommitMessage(input.commitMessage);
  return Buffer.from(
    `tree ${tree}\nparent ${parent}\nauthor ${identity.name} <${identity.email}> ${epoch} +0000\ncommitter ${identity.name} <${identity.email}> ${epoch} +0000\n\n${message}`,
    "utf8",
  );
}

export function gitObjectSha1(type: "blob" | "tree" | "commit", payload: Uint8Array): string {
  const header = Buffer.from(`${type} ${payload.byteLength}\0`, "ascii");
  return createHash("sha1").update(header).update(payload).digest("hex");
}

function decodeLandingPaths(value: unknown, field: string): readonly string[] {
  const paths = array(value, field).map((entry, index) =>
    assertLandingPath(entry, `${field}[${index}]`),
  );
  if (paths.length === 0) invalid(`${field} must not be empty`);
  assertSortedUniqueStrings(paths, field);
  return paths;
}

export function decodeChangedPathsDigestV1(value: unknown): ChangedPathsDigestV1 {
  const decoded = record(value, ["schemaVersion", "paths"], "changedPaths");
  literal(decoded.schemaVersion, 1, "changedPaths.schemaVersion");
  return {
    schemaVersion: 1,
    paths: decodeLandingPaths(decoded.paths, "changedPaths.paths"),
  };
}

export function decodeReviewDecisionDigestV1(value: unknown): ReviewDecisionDigestV1 {
  const decoded = record(
    value,
    ["schemaVersion", "id", "runId", "kind", "digest", "actor", "decision", "createdAt"],
    "reviewDecision",
  );
  return {
    schemaVersion: literal(decoded.schemaVersion, 1, "reviewDecision.schemaVersion"),
    id: assertUuid(decoded.id, "reviewDecision.id"),
    runId: assertUuid(decoded.runId, "reviewDecision.runId"),
    kind: literal(decoded.kind, "review", "reviewDecision.kind"),
    digest: assertSha256(decoded.digest, "reviewDecision.digest"),
    actor: assertActor(decoded.actor, "reviewDecision.actor"),
    decision: literal(decoded.decision, "approve", "reviewDecision.decision"),
    createdAt: assertInstant(decoded.createdAt, "reviewDecision.createdAt"),
  };
}

function decodeVerificationCheckV1(value: unknown, field: string): VerificationCheckDigestV1 {
  const decoded = record(
    value,
    [
      "checkId",
      "argv",
      "exitCode",
      "signal",
      "durationMs",
      "stdoutBytes",
      "stdoutSha256",
      "stderrBytes",
      "stderrSha256",
      "truncated",
      "outcome",
    ],
    field,
  );
  const checkId = string(decoded.checkId, `${field}.checkId`);
  const argv = array(decoded.argv, `${field}.argv`).map((entry, index) =>
    string(entry, `${field}.argv[${index}]`),
  );
  if (
    checkId.length === 0 ||
    utf8Bytes(checkId) > 128 ||
    argv.length === 0 ||
    argv.some((entry) => entry.length === 0 || entry.includes("\0"))
  ) {
    invalid(`${field} has an invalid check identity or argv`);
  }
  if (typeof decoded.truncated !== "boolean") invalid(`${field}.truncated must be boolean`);
  return {
    checkId,
    argv,
    exitCode: literal(decoded.exitCode, 0, `${field}.exitCode`),
    signal: literal(decoded.signal, null, `${field}.signal`),
    durationMs: safeInteger(decoded.durationMs, `${field}.durationMs`),
    stdoutBytes: safeInteger(decoded.stdoutBytes, `${field}.stdoutBytes`),
    stdoutSha256: assertSha256(decoded.stdoutSha256, `${field}.stdoutSha256`),
    stderrBytes: safeInteger(decoded.stderrBytes, `${field}.stderrBytes`),
    stderrSha256: assertSha256(decoded.stderrSha256, `${field}.stderrSha256`),
    truncated: decoded.truncated,
    outcome: literal(decoded.outcome, "passed", `${field}.outcome`),
  };
}

export function decodeVerificationDigestV1(value: unknown): VerificationDigestV1 {
  const decoded = record(
    value,
    [
      "schemaVersion",
      "runId",
      "outcome",
      "changedPaths",
      "diffSha256",
      "checkpointSha256",
      "checks",
    ],
    "verification",
  );
  const checks = array(decoded.checks, "verification.checks").map((entry, index) =>
    decodeVerificationCheckV1(entry, `verification.checks[${index}]`),
  );
  if (new Set(checks.map((check) => check.checkId)).size !== checks.length) {
    invalid("Verification check IDs must be unique");
  }
  return {
    schemaVersion: literal(decoded.schemaVersion, 1, "verification.schemaVersion"),
    runId: assertUuid(decoded.runId, "verification.runId"),
    outcome: literal(decoded.outcome, "passed", "verification.outcome"),
    changedPaths: decodeLandingPaths(decoded.changedPaths, "verification.changedPaths"),
    diffSha256: assertSha256(decoded.diffSha256, "verification.diffSha256"),
    checkpointSha256: assertSha256(decoded.checkpointSha256, "verification.checkpointSha256"),
    checks,
  };
}

export function buildVerificationDigestV1(input: {
  readonly runId: string;
  readonly verification: VerificationEvidence;
  readonly registeredChecks: readonly CheckProfile[];
}): VerificationDigestV1 {
  if (
    input.verification.outcome !== "passed" ||
    input.verification.checks.length !== input.registeredChecks.length
  ) {
    invalid("Landing verification must be passing and cover every registered check");
  }
  const checks = input.verification.checks.map((evidence, index): VerificationCheckDigestV1 => {
    const registered = input.registeredChecks[index];
    if (
      registered === undefined ||
      evidence.checkId !== registered.id ||
      evidence.argv.length !== registered.argv.length ||
      !evidence.argv.every((entry, argvIndex) => entry === registered.argv[argvIndex]) ||
      evidence.exitCode !== 0 ||
      evidence.signal !== null ||
      evidence.outcome !== "passed"
    ) {
      invalid("Landing verification check order or registered argv does not match");
    }
    return {
      checkId: evidence.checkId,
      argv: [...evidence.argv],
      exitCode: 0,
      signal: null,
      durationMs: safeInteger(evidence.durationMs, "verification.check.durationMs"),
      stdoutBytes: utf8Bytes(evidence.stdout),
      stdoutSha256: sha256(evidence.stdout),
      stderrBytes: utf8Bytes(evidence.stderr),
      stderrSha256: sha256(evidence.stderr),
      truncated: evidence.truncated,
      outcome: "passed",
    };
  });
  return decodeVerificationDigestV1({
    schemaVersion: 1,
    runId: input.runId,
    outcome: "passed",
    changedPaths: [...input.verification.changedPaths],
    diffSha256: input.verification.diffSha256,
    checkpointSha256: input.verification.checkpointSha256,
    checks,
  });
}

function decodeCredentialAuditSubjectV1(
  value: unknown,
  field: string,
): CandidateCredentialAuditSubjectV1 {
  const decoded = record(value, ["kind", "path", "bytes", "sha256"], field);
  const kind = oneOf(
    decoded.kind,
    ["changed_blob", "commit_message", "pull_request_title", "pull_request_body_prefix"] as const,
    `${field}.kind`,
  );
  const bytes = safeInteger(decoded.bytes, `${field}.bytes`);
  const digest = assertSha256(decoded.sha256, `${field}.sha256`);
  if (kind === "changed_blob") {
    return {
      kind,
      path: assertLandingPath(decoded.path, `${field}.path`),
      bytes,
      sha256: digest,
    };
  }
  literal(decoded.path, null, `${field}.path`);
  return { kind, path: null, bytes, sha256: digest };
}

export function decodeCandidateCredentialAuditV1(value: unknown): CandidateCredentialAuditV1 {
  const decoded = record(
    value,
    ["schemaVersion", "policyVersion", "outcome", "subjects"],
    "credentialAudit",
  );
  const subjects = array(decoded.subjects, "credentialAudit.subjects").map((entry, index) =>
    decodeCredentialAuditSubjectV1(entry, `credentialAudit.subjects[${index}]`),
  );
  if (subjects.length < 3) invalid("Credential audit must contain the three text subjects");
  const textSubjects = subjects.slice(-3).map((subject) => subject.kind);
  if (
    textSubjects[0] !== "commit_message" ||
    textSubjects[1] !== "pull_request_title" ||
    textSubjects[2] !== "pull_request_body_prefix"
  ) {
    invalid("Credential audit text subjects have the wrong order");
  }
  const blobSubjects = subjects.slice(0, -3);
  if (blobSubjects.some((subject) => subject.kind !== "changed_blob")) {
    invalid("Changed-blob credential subjects must precede text subjects");
  }
  assertSortedUniqueStrings(
    blobSubjects.map((subject) => subject.path as string),
    "credentialAudit.changedBlobPaths",
  );
  return {
    schemaVersion: literal(decoded.schemaVersion, 1, "credentialAudit.schemaVersion"),
    policyVersion: literal(
      decoded.policyVersion,
      LANDING_OUTGOING_AUDIT_POLICY_VERSION,
      "credentialAudit.policyVersion",
    ),
    outcome: literal(decoded.outcome, "passed", "credentialAudit.outcome"),
    subjects,
  };
}

function decodeObjectManifestEntryV1(
  value: unknown,
  field: string,
): CandidateObjectManifestEntryV1 {
  const decoded = record(
    value,
    ["path", "op", "mode", "blobSha1", "contentBytes", "contentSha256"],
    field,
  );
  const op = oneOf(decoded.op, ["modify", "create", "delete"] as const, `${field}.op`);
  const path = assertLandingPath(decoded.path, `${field}.path`);
  literal(decoded.mode, "100644", `${field}.mode`);
  if (op === "delete") {
    literal(decoded.blobSha1, null, `${field}.blobSha1`);
    literal(decoded.contentBytes, null, `${field}.contentBytes`);
    literal(decoded.contentSha256, null, `${field}.contentSha256`);
    return {
      path,
      op,
      mode: "100644",
      blobSha1: null,
      contentBytes: null,
      contentSha256: null,
    };
  }
  return {
    path,
    op,
    mode: "100644",
    blobSha1: assertSha1(decoded.blobSha1, `${field}.blobSha1`),
    contentBytes: safeInteger(decoded.contentBytes, `${field}.contentBytes`),
    contentSha256: assertSha256(decoded.contentSha256, `${field}.contentSha256`),
  };
}

export function decodeCandidateObjectManifestV1(value: unknown): CandidateObjectManifestV1 {
  const decoded = record(
    value,
    [
      "schemaVersion",
      "baseCommitSha1",
      "baseTreeSha1",
      "candidateTreeSha1",
      "candidateCommitSha1",
      "candidateCommitPayloadSha256",
      "entries",
    ],
    "objectManifest",
  );
  const entries = array(decoded.entries, "objectManifest.entries").map((entry, index) =>
    decodeObjectManifestEntryV1(entry, `objectManifest.entries[${index}]`),
  );
  if (entries.length === 0) invalid("Object manifest must contain a changed path");
  assertSortedUniqueStrings(
    entries.map((entry) => entry.path),
    "objectManifest.entries",
  );
  return {
    schemaVersion: literal(decoded.schemaVersion, 1, "objectManifest.schemaVersion"),
    baseCommitSha1: assertSha1(decoded.baseCommitSha1, "objectManifest.baseCommitSha1"),
    baseTreeSha1: assertSha1(decoded.baseTreeSha1, "objectManifest.baseTreeSha1"),
    candidateTreeSha1: assertSha1(decoded.candidateTreeSha1, "objectManifest.candidateTreeSha1"),
    candidateCommitSha1: assertSha1(
      decoded.candidateCommitSha1,
      "objectManifest.candidateCommitSha1",
    ),
    candidateCommitPayloadSha256: assertSha256(
      decoded.candidateCommitPayloadSha256,
      "objectManifest.candidateCommitPayloadSha256",
    ),
    entries,
  };
}

function exactLiteralArray<const T extends readonly string[]>(
  value: unknown,
  expected: T,
  field: string,
): T {
  const decoded = array(value, field);
  if (
    decoded.length !== expected.length ||
    !decoded.every((entry, index) => entry === expected[index])
  ) {
    invalid(`${field} does not have the required literal order`);
  }
  return expected;
}

function sameCommitIdentity(
  left: { readonly name: string; readonly email: string },
  right: { readonly name: string; readonly email: string },
): boolean {
  return left.name === right.name && left.email === right.email;
}

export function decodeLandingDigestV1(value: unknown): LandingDigestV1 {
  const decoded = record(
    value,
    [
      "schemaVersion",
      "policyVersion",
      "githubApiVersion",
      "landingId",
      "runId",
      "projectId",
      "baseCommitSha1",
      "baseTreeSha1",
      "planSha256",
      "diffSha256",
      "checkpointSha256",
      "verificationSha256",
      "reviewDecisionId",
      "reviewDecisionSha256",
      "changedPaths",
      "changedPathsSha256",
      "candidateCredentialAuditSha256",
      "profileVersion",
      "profileSha256",
      "profile",
      "objectFormat",
      "candidateParentSha1",
      "candidateTreeSha1",
      "candidateCommitSha1",
      "candidateCommitPayloadSha256",
      "candidateObjectManifestSha256",
      "commitMessageSha256",
      "commitAuthor",
      "commitCommitter",
      "commitEpochSeconds",
      "commitIso8601",
      "baseRef",
      "expectedRemoteBaseSha1",
      "headRef",
      "pullRequestTitleSha256",
      "pullRequestBodyPrefixSha256",
      "pullRequestMarkerVersion",
      "draft",
      "maintainerCanModify",
      "directIcarusEffects",
      "derivativeEffectDisclosure",
    ],
    "landingDigest",
  );
  literal(decoded.schemaVersion, 1, "landingDigest.schemaVersion");
  literal(decoded.policyVersion, LANDING_POLICY_VERSION, "landingDigest.policyVersion");
  literal(decoded.githubApiVersion, GITHUB_API_VERSION, "landingDigest.githubApiVersion");
  const landingId = assertUuid(decoded.landingId, "landingDigest.landingId");
  const runId = assertUuid(decoded.runId, "landingDigest.runId");
  const projectId = assertUuid(decoded.projectId, "landingDigest.projectId");
  const baseCommitSha1 = assertSha1(decoded.baseCommitSha1, "landingDigest.baseCommitSha1");
  const baseTreeSha1 = assertSha1(decoded.baseTreeSha1, "landingDigest.baseTreeSha1");
  const planSha256 = assertSha256(decoded.planSha256, "landingDigest.planSha256");
  const diffSha256 = assertSha256(decoded.diffSha256, "landingDigest.diffSha256");
  const checkpointSha256 = assertSha256(decoded.checkpointSha256, "landingDigest.checkpointSha256");
  const verificationSha256 = assertSha256(
    decoded.verificationSha256,
    "landingDigest.verificationSha256",
  );
  const reviewDecisionId = assertUuid(decoded.reviewDecisionId, "landingDigest.reviewDecisionId");
  const reviewDecisionSha256 = assertSha256(
    decoded.reviewDecisionSha256,
    "landingDigest.reviewDecisionSha256",
  );
  const changedPaths = decodeLandingPaths(decoded.changedPaths, "landingDigest.changedPaths");
  const changedPathsSha256 = assertSha256(
    decoded.changedPathsSha256,
    "landingDigest.changedPathsSha256",
  );
  const candidateCredentialAuditSha256 = assertSha256(
    decoded.candidateCredentialAuditSha256,
    "landingDigest.candidateCredentialAuditSha256",
  );
  literal(decoded.profileVersion, 1, "landingDigest.profileVersion");
  const profile = decodeGitHubLandingProfileV1(decoded.profile);
  const profileSha256 = assertSha256(decoded.profileSha256, "landingDigest.profileSha256");
  if (profileSha256 !== digestLandingRecord(profile)) {
    invalid("Landing profile digest does not match the canonical profile snapshot");
  }
  if (
    changedPathsSha256 !==
    digestLandingRecord({ schemaVersion: 1, paths: changedPaths } satisfies ChangedPathsDigestV1)
  ) {
    invalid("Changed-path digest does not match the canonical landing paths");
  }
  literal(decoded.objectFormat, "sha1", "landingDigest.objectFormat");
  const candidateParentSha1 = assertSha1(
    decoded.candidateParentSha1,
    "landingDigest.candidateParentSha1",
  );
  const candidateTreeSha1 = assertSha1(
    decoded.candidateTreeSha1,
    "landingDigest.candidateTreeSha1",
  );
  const candidateCommitSha1 = assertSha1(
    decoded.candidateCommitSha1,
    "landingDigest.candidateCommitSha1",
  );
  const candidateCommitPayloadSha256 = assertSha256(
    decoded.candidateCommitPayloadSha256,
    "landingDigest.candidateCommitPayloadSha256",
  );
  const candidateObjectManifestSha256 = assertSha256(
    decoded.candidateObjectManifestSha256,
    "landingDigest.candidateObjectManifestSha256",
  );
  const commitMessageSha256 = assertSha256(
    decoded.commitMessageSha256,
    "landingDigest.commitMessageSha256",
  );
  const commitAuthor = assertCommitIdentity(decoded.commitAuthor, "landingDigest.commitAuthor");
  const commitCommitter = assertCommitIdentity(
    decoded.commitCommitter,
    "landingDigest.commitCommitter",
  );
  const commitEpochSeconds = safeInteger(
    decoded.commitEpochSeconds,
    "landingDigest.commitEpochSeconds",
    0,
    MAX_COMMIT_EPOCH_SECONDS,
  );
  const commitIso8601 = assertGitInstant(decoded.commitIso8601, "landingDigest.commitIso8601");
  const baseRef = assertFullHeadRef(decoded.baseRef, "landingDigest.baseRef");
  const expectedRemoteBaseSha1 = assertSha1(
    decoded.expectedRemoteBaseSha1,
    "landingDigest.expectedRemoteBaseSha1",
  );
  const headRef = assertFullHeadRef(decoded.headRef, "landingDigest.headRef");
  const pullRequestTitleSha256 = assertSha256(
    decoded.pullRequestTitleSha256,
    "landingDigest.pullRequestTitleSha256",
  );
  const pullRequestBodyPrefixSha256 = assertSha256(
    decoded.pullRequestBodyPrefixSha256,
    "landingDigest.pullRequestBodyPrefixSha256",
  );
  literal(decoded.pullRequestMarkerVersion, 1, "landingDigest.pullRequestMarkerVersion");
  literal(decoded.draft, true, "landingDigest.draft");
  literal(decoded.maintainerCanModify, false, "landingDigest.maintainerCanModify");
  exactLiteralArray(
    decoded.directIcarusEffects,
    DIRECT_ICARUS_EFFECTS,
    "landingDigest.directIcarusEffects",
  );
  const disclosure = record(
    decoded.derivativeEffectDisclosure,
    ["version", "githubEvents", "mayTrigger", "disposition", "evidenceSha256"],
    "landingDigest.derivativeEffectDisclosure",
  );
  literal(disclosure.version, 1, "landingDigest.derivativeEffectDisclosure.version");
  exactLiteralArray(
    disclosure.githubEvents,
    DERIVATIVE_GITHUB_EVENTS,
    "landingDigest.derivativeEffectDisclosure.githubEvents",
  );
  exactLiteralArray(
    disclosure.mayTrigger,
    DERIVATIVE_EFFECTS,
    "landingDigest.derivativeEffectDisclosure.mayTrigger",
  );
  const disposition = oneOf(
    disclosure.disposition,
    ["inert-repository", "operator-approved"] as const,
    "landingDigest.derivativeEffectDisclosure.disposition",
  );
  const disclosureEvidenceSha256 = assertSha256(
    disclosure.evidenceSha256,
    "landingDigest.derivativeEffectDisclosure.evidenceSha256",
  );
  const expectedBaseRef = `refs/heads/${profile.baseBranch}`;
  const expectedHeadRef = `refs/heads/${LANDING_BRANCH_NAMESPACE}${runId}`;
  if (
    candidateParentSha1 !== baseCommitSha1 ||
    expectedRemoteBaseSha1 !== baseCommitSha1 ||
    baseRef !== expectedBaseRef ||
    headRef !== expectedHeadRef ||
    commitIso8601 !== commitEpochToGitInstant(commitEpochSeconds) ||
    !sameCommitIdentity(commitAuthor, commitCommitter) ||
    !sameCommitIdentity(commitAuthor, profile.commitIdentity) ||
    disposition !== profile.derivativeEffects.disposition ||
    disclosureEvidenceSha256 !== profile.derivativeEffects.evidenceSha256
  ) {
    invalid("Landing digest fields are not internally correlated");
  }
  return {
    schemaVersion: 1,
    policyVersion: 1,
    githubApiVersion: GITHUB_API_VERSION,
    landingId,
    runId,
    projectId,
    baseCommitSha1,
    baseTreeSha1,
    planSha256,
    diffSha256,
    checkpointSha256,
    verificationSha256,
    reviewDecisionId,
    reviewDecisionSha256,
    changedPaths,
    changedPathsSha256,
    candidateCredentialAuditSha256,
    profileVersion: 1,
    profileSha256,
    profile,
    objectFormat: "sha1",
    candidateParentSha1,
    candidateTreeSha1,
    candidateCommitSha1,
    candidateCommitPayloadSha256,
    candidateObjectManifestSha256,
    commitMessageSha256,
    commitAuthor,
    commitCommitter,
    commitEpochSeconds,
    commitIso8601,
    baseRef,
    expectedRemoteBaseSha1,
    headRef,
    pullRequestTitleSha256,
    pullRequestBodyPrefixSha256,
    pullRequestMarkerVersion: 1,
    draft: true,
    maintainerCanModify: false,
    directIcarusEffects: DIRECT_ICARUS_EFFECTS,
    derivativeEffectDisclosure: {
      version: 1,
      githubEvents: DERIVATIVE_GITHUB_EVENTS,
      mayTrigger: DERIVATIVE_EFFECTS,
      disposition,
      evidenceSha256: disclosureEvidenceSha256,
    },
  };
}

export function assertLandingDigestTextBindingsV1(
  landing: LandingDigestV1,
  text: LandingTextBindingsV1,
): LandingTextBindingsV1 {
  const commitMessage = canonicalizeCommitMessage(text.commitMessage);
  const pullRequestTitle = canonicalizePullRequestTitle(text.pullRequestTitle);
  const pullRequestBodyPrefix = canonicalizePullRequestBodyPrefix(text.pullRequestBodyPrefix);
  if (
    commitMessage !== text.commitMessage ||
    pullRequestTitle !== text.pullRequestTitle ||
    pullRequestBodyPrefix !== text.pullRequestBodyPrefix ||
    sha256(commitMessage) !== landing.commitMessageSha256 ||
    sha256(pullRequestTitle) !== landing.pullRequestTitleSha256 ||
    sha256(pullRequestBodyPrefix) !== landing.pullRequestBodyPrefixSha256
  ) {
    invalid("Landing text bytes do not match the approved digest");
  }
  return { commitMessage, pullRequestTitle, pullRequestBodyPrefix };
}

export function landingPullRequestMarkerV1(landingId: string, landingSha256: string): string {
  return `<!-- icarus-landing:v1:${assertUuid(landingId, "landingId")}:${assertSha256(
    landingSha256,
    "landingSha256",
  )} -->\n`;
}

export function renderPullRequestBodyV1(input: {
  readonly landing: LandingDigestV1;
  readonly landingSha256: string;
  readonly bodyPrefix: string;
}): string {
  const landing = decodeLandingDigestV1(input.landing);
  const landingSha256 = assertSha256(input.landingSha256, "landingSha256");
  if (digestLandingRecord(landing) !== landingSha256) {
    invalid("Landing SHA-256 does not match the canonical authority record");
  }
  const bodyPrefix = canonicalizePullRequestBodyPrefix(input.bodyPrefix);
  if (
    bodyPrefix !== input.bodyPrefix ||
    sha256(bodyPrefix) !== landing.pullRequestBodyPrefixSha256
  ) {
    invalid("Pull-request body prefix does not match the landing authority");
  }
  const body =
    `${bodyPrefix}\n\n` +
    "Icarus landing evidence v1\n" +
    `run-id: ${landing.runId}\n` +
    `candidate-commit-sha1: ${landing.candidateCommitSha1}\n` +
    `plan-sha256: ${landing.planSha256}\n` +
    `diff-sha256: ${landing.diffSha256}\n` +
    `checkpoint-sha256: ${landing.checkpointSha256}\n` +
    "object-format: sha1\n" +
    "\n" +
    landingPullRequestMarkerV1(landing.landingId, landingSha256);
  if (utf8Bytes(body) > MAX_PULL_REQUEST_BODY_BYTES) {
    invalid("Rendered pull-request body exceeds the v1 byte ceiling");
  }
  return body;
}

export function reconstructPullRequestUrlV1(
  profile: GitHubLandingProfileV1,
  pullRequestNumber: number,
): string {
  const decodedProfile = decodeGitHubLandingProfileV1(profile);
  const number = safeInteger(pullRequestNumber, "pullRequestNumber", 1, Number.MAX_SAFE_INTEGER);
  return `${GITHUB_RECEIPT_ORIGIN}/${decodedProfile.owner}/${decodedProfile.repository}/pull/${number}`;
}

export interface CandidatePrepareInputV1 {
  readonly profileSha256: string;
  readonly baseCommitSha1: string;
  readonly baseTreeSha1: string;
  readonly planSha256: string;
  readonly diffSha256: string;
  readonly checkpointSha256: string;
  readonly verificationSha256: string;
  readonly reviewDecisionSha256: string;
  readonly changedPathsSha256: string;
  readonly headRef: string;
  readonly commitMessageSha256: string;
  readonly commitEpochSeconds: number;
  readonly commitIso8601: string;
  readonly pullRequestTitleSha256: string;
  readonly pullRequestBodyPrefixSha256: string;
}

export interface LocalRefCreateInputV1 {
  readonly landingSha256: string;
  readonly headRef: string;
  readonly candidateCommitSha1: string;
}

export interface GitHubPreflightInputV1 {
  readonly landingSha256: string;
  readonly profileSha256: string;
  readonly baseRef: string;
  readonly expectedRemoteBaseSha1: string;
  readonly headRef: string;
  readonly candidateCommitSha1: string;
  readonly includePullRequestAbsence: boolean;
}

export interface GitHubObjectsUploadInputV1 {
  readonly landingSha256: string;
  readonly candidateObjectManifestSha256: string;
  readonly changedPathsSha256: string;
  readonly preflightOperationId: string;
  readonly preflightResultSha256: string;
  readonly retrySubjectOperationId: string | null;
  readonly retrySubjectRequestSha256: string | null;
}

export interface GitHubRefCreateInputV1 {
  readonly landingSha256: string;
  readonly baseRef: string;
  readonly expectedRemoteBaseSha1: string;
  readonly headRef: string;
  readonly candidateCommitSha1: string;
  readonly preflightOperationId: string;
  readonly preflightResultSha256: string;
}

export interface GitHubPullRequestCreateInputV1 {
  readonly landingSha256: string;
  readonly baseRef: string;
  readonly expectedRemoteBaseSha1: string;
  readonly headRef: string;
  readonly candidateCommitSha1: string;
  readonly pullRequestTitleSha256: string;
  readonly pullRequestBodySha256: string;
  readonly draft: true;
  readonly maintainerCanModify: false;
  readonly preflightOperationId: string;
  readonly preflightResultSha256: string;
}

export interface LandingReconcileInputV1 {
  readonly landingSha256: string;
  readonly resumeState: Exclude<LandingResumeStateV1, "preparing_candidate">;
  readonly subjectOperationId: string;
  readonly subjectRequestSha256: string;
  readonly subjectResultSha256: string;
}

export type LandingOperationInputV1 =
  | CandidatePrepareInputV1
  | LocalRefCreateInputV1
  | GitHubPreflightInputV1
  | GitHubObjectsUploadInputV1
  | GitHubRefCreateInputV1
  | GitHubPullRequestCreateInputV1
  | LandingReconcileInputV1;

export interface LandingOperationRequestV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly landingId: string;
  readonly coordinatorAttempt: number;
  readonly kindAttempt: number;
  readonly kind: LandingOperationKindV1;
  readonly expectedState:
    | "preparing_candidate"
    | "approved"
    | "local_ready"
    | "objects_ready"
    | "remote_ready"
    | "reconciliation_required";
  readonly expectedVersion: number;
  readonly input: LandingOperationInputV1;
}

function decodeCandidatePrepareInputV1(value: unknown): CandidatePrepareInputV1 {
  const decoded = record(
    value,
    [
      "profileSha256",
      "baseCommitSha1",
      "baseTreeSha1",
      "planSha256",
      "diffSha256",
      "checkpointSha256",
      "verificationSha256",
      "reviewDecisionSha256",
      "changedPathsSha256",
      "headRef",
      "commitMessageSha256",
      "commitEpochSeconds",
      "commitIso8601",
      "pullRequestTitleSha256",
      "pullRequestBodyPrefixSha256",
    ],
    "operation.input",
  );
  const epoch = safeInteger(
    decoded.commitEpochSeconds,
    "operation.input.commitEpochSeconds",
    0,
    MAX_COMMIT_EPOCH_SECONDS,
  );
  const instant = assertGitInstant(decoded.commitIso8601, "operation.input.commitIso8601");
  if (instant !== commitEpochToGitInstant(epoch)) {
    invalid("Candidate operation commit epoch and instant differ");
  }
  return {
    profileSha256: assertSha256(decoded.profileSha256, "operation.input.profileSha256"),
    baseCommitSha1: assertSha1(decoded.baseCommitSha1, "operation.input.baseCommitSha1"),
    baseTreeSha1: assertSha1(decoded.baseTreeSha1, "operation.input.baseTreeSha1"),
    planSha256: assertSha256(decoded.planSha256, "operation.input.planSha256"),
    diffSha256: assertSha256(decoded.diffSha256, "operation.input.diffSha256"),
    checkpointSha256: assertSha256(decoded.checkpointSha256, "operation.input.checkpointSha256"),
    verificationSha256: assertSha256(
      decoded.verificationSha256,
      "operation.input.verificationSha256",
    ),
    reviewDecisionSha256: assertSha256(
      decoded.reviewDecisionSha256,
      "operation.input.reviewDecisionSha256",
    ),
    changedPathsSha256: assertSha256(
      decoded.changedPathsSha256,
      "operation.input.changedPathsSha256",
    ),
    headRef: assertFullHeadRef(decoded.headRef, "operation.input.headRef"),
    commitMessageSha256: assertSha256(
      decoded.commitMessageSha256,
      "operation.input.commitMessageSha256",
    ),
    commitEpochSeconds: epoch,
    commitIso8601: instant,
    pullRequestTitleSha256: assertSha256(
      decoded.pullRequestTitleSha256,
      "operation.input.pullRequestTitleSha256",
    ),
    pullRequestBodyPrefixSha256: assertSha256(
      decoded.pullRequestBodyPrefixSha256,
      "operation.input.pullRequestBodyPrefixSha256",
    ),
  };
}

function decodeLocalRefCreateInputV1(value: unknown): LocalRefCreateInputV1 {
  const decoded = record(
    value,
    ["landingSha256", "headRef", "candidateCommitSha1"],
    "operation.input",
  );
  return {
    landingSha256: assertSha256(decoded.landingSha256, "operation.input.landingSha256"),
    headRef: assertFullHeadRef(decoded.headRef, "operation.input.headRef"),
    candidateCommitSha1: assertSha1(
      decoded.candidateCommitSha1,
      "operation.input.candidateCommitSha1",
    ),
  };
}

function decodeGitHubPreflightInputV1(value: unknown): GitHubPreflightInputV1 {
  const decoded = record(
    value,
    [
      "landingSha256",
      "profileSha256",
      "baseRef",
      "expectedRemoteBaseSha1",
      "headRef",
      "candidateCommitSha1",
      "includePullRequestAbsence",
    ],
    "operation.input",
  );
  if (typeof decoded.includePullRequestAbsence !== "boolean") {
    invalid("operation.input.includePullRequestAbsence must be boolean");
  }
  return {
    landingSha256: assertSha256(decoded.landingSha256, "operation.input.landingSha256"),
    profileSha256: assertSha256(decoded.profileSha256, "operation.input.profileSha256"),
    baseRef: assertFullHeadRef(decoded.baseRef, "operation.input.baseRef"),
    expectedRemoteBaseSha1: assertSha1(
      decoded.expectedRemoteBaseSha1,
      "operation.input.expectedRemoteBaseSha1",
    ),
    headRef: assertFullHeadRef(decoded.headRef, "operation.input.headRef"),
    candidateCommitSha1: assertSha1(
      decoded.candidateCommitSha1,
      "operation.input.candidateCommitSha1",
    ),
    includePullRequestAbsence: decoded.includePullRequestAbsence,
  };
}

function decodeGitHubObjectsUploadInputV1(value: unknown): GitHubObjectsUploadInputV1 {
  const decoded = record(
    value,
    [
      "landingSha256",
      "candidateObjectManifestSha256",
      "changedPathsSha256",
      "preflightOperationId",
      "preflightResultSha256",
      "retrySubjectOperationId",
      "retrySubjectRequestSha256",
    ],
    "operation.input",
  );
  const retrySubjectOperationId = nullable(decoded.retrySubjectOperationId, (entry) =>
    assertUuid(entry, "operation.input.retrySubjectOperationId"),
  );
  const retrySubjectRequestSha256 = nullable(decoded.retrySubjectRequestSha256, (entry) =>
    assertSha256(entry, "operation.input.retrySubjectRequestSha256"),
  );
  if ((retrySubjectOperationId === null) !== (retrySubjectRequestSha256 === null)) {
    invalid("Object retry subject fields must both be null or both be present");
  }
  return {
    landingSha256: assertSha256(decoded.landingSha256, "operation.input.landingSha256"),
    candidateObjectManifestSha256: assertSha256(
      decoded.candidateObjectManifestSha256,
      "operation.input.candidateObjectManifestSha256",
    ),
    changedPathsSha256: assertSha256(
      decoded.changedPathsSha256,
      "operation.input.changedPathsSha256",
    ),
    preflightOperationId: assertUuid(
      decoded.preflightOperationId,
      "operation.input.preflightOperationId",
    ),
    preflightResultSha256: assertSha256(
      decoded.preflightResultSha256,
      "operation.input.preflightResultSha256",
    ),
    retrySubjectOperationId,
    retrySubjectRequestSha256,
  };
}

function decodeGitHubRefCreateInputV1(value: unknown): GitHubRefCreateInputV1 {
  const decoded = record(
    value,
    [
      "landingSha256",
      "baseRef",
      "expectedRemoteBaseSha1",
      "headRef",
      "candidateCommitSha1",
      "preflightOperationId",
      "preflightResultSha256",
    ],
    "operation.input",
  );
  return {
    landingSha256: assertSha256(decoded.landingSha256, "operation.input.landingSha256"),
    baseRef: assertFullHeadRef(decoded.baseRef, "operation.input.baseRef"),
    expectedRemoteBaseSha1: assertSha1(
      decoded.expectedRemoteBaseSha1,
      "operation.input.expectedRemoteBaseSha1",
    ),
    headRef: assertFullHeadRef(decoded.headRef, "operation.input.headRef"),
    candidateCommitSha1: assertSha1(
      decoded.candidateCommitSha1,
      "operation.input.candidateCommitSha1",
    ),
    preflightOperationId: assertUuid(
      decoded.preflightOperationId,
      "operation.input.preflightOperationId",
    ),
    preflightResultSha256: assertSha256(
      decoded.preflightResultSha256,
      "operation.input.preflightResultSha256",
    ),
  };
}

function decodeGitHubPullRequestCreateInputV1(value: unknown): GitHubPullRequestCreateInputV1 {
  const decoded = record(
    value,
    [
      "landingSha256",
      "baseRef",
      "expectedRemoteBaseSha1",
      "headRef",
      "candidateCommitSha1",
      "pullRequestTitleSha256",
      "pullRequestBodySha256",
      "draft",
      "maintainerCanModify",
      "preflightOperationId",
      "preflightResultSha256",
    ],
    "operation.input",
  );
  return {
    landingSha256: assertSha256(decoded.landingSha256, "operation.input.landingSha256"),
    baseRef: assertFullHeadRef(decoded.baseRef, "operation.input.baseRef"),
    expectedRemoteBaseSha1: assertSha1(
      decoded.expectedRemoteBaseSha1,
      "operation.input.expectedRemoteBaseSha1",
    ),
    headRef: assertFullHeadRef(decoded.headRef, "operation.input.headRef"),
    candidateCommitSha1: assertSha1(
      decoded.candidateCommitSha1,
      "operation.input.candidateCommitSha1",
    ),
    pullRequestTitleSha256: assertSha256(
      decoded.pullRequestTitleSha256,
      "operation.input.pullRequestTitleSha256",
    ),
    pullRequestBodySha256: assertSha256(
      decoded.pullRequestBodySha256,
      "operation.input.pullRequestBodySha256",
    ),
    draft: literal(decoded.draft, true, "operation.input.draft"),
    maintainerCanModify: literal(
      decoded.maintainerCanModify,
      false,
      "operation.input.maintainerCanModify",
    ),
    preflightOperationId: assertUuid(
      decoded.preflightOperationId,
      "operation.input.preflightOperationId",
    ),
    preflightResultSha256: assertSha256(
      decoded.preflightResultSha256,
      "operation.input.preflightResultSha256",
    ),
  };
}

function decodeLandingReconcileInputV1(value: unknown): LandingReconcileInputV1 {
  const decoded = record(
    value,
    [
      "landingSha256",
      "resumeState",
      "subjectOperationId",
      "subjectRequestSha256",
      "subjectResultSha256",
    ],
    "operation.input",
  );
  if (
    !isLandingResumeStateV1(decoded.resumeState) ||
    decoded.resumeState === "preparing_candidate"
  ) {
    invalid("Reconciliation input has an invalid resume state");
  }
  return {
    landingSha256: assertSha256(decoded.landingSha256, "operation.input.landingSha256"),
    resumeState: decoded.resumeState,
    subjectOperationId: assertUuid(
      decoded.subjectOperationId,
      "operation.input.subjectOperationId",
    ),
    subjectRequestSha256: assertSha256(
      decoded.subjectRequestSha256,
      "operation.input.subjectRequestSha256",
    ),
    subjectResultSha256: assertSha256(
      decoded.subjectResultSha256,
      "operation.input.subjectResultSha256",
    ),
  };
}

function decodeOperationInputV1(
  kind: LandingOperationKindV1,
  value: unknown,
): LandingOperationInputV1 {
  switch (kind) {
    case "candidate.prepare":
      return decodeCandidatePrepareInputV1(value);
    case "local_ref.create":
      return decodeLocalRefCreateInputV1(value);
    case "github.preflight":
      return decodeGitHubPreflightInputV1(value);
    case "github.objects.upload":
      return decodeGitHubObjectsUploadInputV1(value);
    case "github.ref.create":
      return decodeGitHubRefCreateInputV1(value);
    case "github.pull_request.create":
      return decodeGitHubPullRequestCreateInputV1(value);
    case "landing.reconcile":
      return decodeLandingReconcileInputV1(value);
  }
}

export function decodeLandingOperationRequestV1(value: unknown): LandingOperationRequestV1 {
  const decoded = record(
    value,
    [
      "schemaVersion",
      "operationId",
      "landingId",
      "coordinatorAttempt",
      "kindAttempt",
      "kind",
      "expectedState",
      "expectedVersion",
      "input",
    ],
    "operation",
  );
  if (!isLandingOperationKindV1(decoded.kind)) {
    invalid("Operation kind is not supported by landing policy v1");
  }
  const expectedState = oneOf(
    decoded.expectedState,
    [
      "preparing_candidate",
      "approved",
      "local_ready",
      "objects_ready",
      "remote_ready",
      "reconciliation_required",
    ] as const,
    "operation.expectedState",
  );
  if (!canStartLandingOperation(decoded.kind, expectedState)) {
    invalid("Operation kind cannot start from its expected state");
  }
  return {
    schemaVersion: literal(decoded.schemaVersion, 1, "operation.schemaVersion"),
    operationId: assertUuid(decoded.operationId, "operation.operationId"),
    landingId: assertUuid(decoded.landingId, "operation.landingId"),
    coordinatorAttempt: safeInteger(
      decoded.coordinatorAttempt,
      "operation.coordinatorAttempt",
      1,
      8,
    ),
    kindAttempt: safeInteger(decoded.kindAttempt, "operation.kindAttempt", 1, 9),
    kind: decoded.kind,
    expectedState,
    expectedVersion: safeInteger(decoded.expectedVersion, "operation.expectedVersion"),
    input: decodeOperationInputV1(decoded.kind, decoded.input),
  };
}

export interface LandingHttpRequestV1 {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly landingId: string;
  readonly operationId: string;
  readonly coordinatorAttempt: number;
  readonly operationKind: LandingOperationKindV1;
  readonly requestOrdinal: number;
  readonly kind: LandingHttpKindV1;
  readonly method: "GET" | "POST";
  readonly profileSha256: string;
  readonly bodySha256: string | null;
  readonly subject: JsonRecord;
}

const HTTP_GET_KINDS = [
  "github.actor.get",
  "github.base_ref.get",
  "github.head_ref.get",
  "github.pull_requests.get",
] as const satisfies readonly LandingHttpKindV1[];

function assertGitHubIdentityPart(value: unknown, field: string, owner: boolean): string {
  const decoded = string(value, field);
  const valid = owner
    ? GITHUB_OWNER_PATTERN.test(decoded) && !decoded.includes("--")
    : GITHUB_REPOSITORY_PATTERN.test(decoded) && decoded !== "." && decoded !== "..";
  if (!valid || decoded !== decoded.toLowerCase()) {
    invalid(`${field} is not a canonical GitHub identity`);
  }
  return decoded;
}

function decodeHttpSubjectV1(kind: LandingHttpKindV1, value: unknown): JsonRecord {
  switch (kind) {
    case "github.actor.get": {
      const decoded = record(value, ["expectedActor"], "http.subject");
      return {
        expectedActor: assertGitHubIdentityPart(
          decoded.expectedActor,
          "http.subject.expectedActor",
          true,
        ),
      };
    }
    case "github.base_ref.get": {
      const decoded = record(
        value,
        ["owner", "repository", "baseRef", "expectedSha1"],
        "http.subject",
      );
      return {
        owner: assertGitHubIdentityPart(decoded.owner, "http.subject.owner", true),
        repository: assertGitHubIdentityPart(decoded.repository, "http.subject.repository", false),
        baseRef: assertFullHeadRef(decoded.baseRef, "http.subject.baseRef"),
        expectedSha1: assertSha1(decoded.expectedSha1, "http.subject.expectedSha1"),
      };
    }
    case "github.head_ref.get": {
      const decoded = record(
        value,
        ["owner", "repository", "headRef", "expectedSha1"],
        "http.subject",
      );
      return {
        owner: assertGitHubIdentityPart(decoded.owner, "http.subject.owner", true),
        repository: assertGitHubIdentityPart(decoded.repository, "http.subject.repository", false),
        headRef: assertFullHeadRef(decoded.headRef, "http.subject.headRef"),
        expectedSha1: assertSha1(decoded.expectedSha1, "http.subject.expectedSha1"),
      };
    }
    case "github.pull_requests.get": {
      const decoded = record(
        value,
        ["owner", "repository", "headOwner", "headRef", "baseBranch", "state", "page", "perPage"],
        "http.subject",
      );
      return {
        owner: assertGitHubIdentityPart(decoded.owner, "http.subject.owner", true),
        repository: assertGitHubIdentityPart(decoded.repository, "http.subject.repository", false),
        headOwner: assertGitHubIdentityPart(decoded.headOwner, "http.subject.headOwner", true),
        headRef: assertGitBranchName(decoded.headRef, "http.subject.headRef"),
        baseBranch: assertGitBranchName(decoded.baseBranch, "http.subject.baseBranch"),
        state: literal(decoded.state, "all", "http.subject.state"),
        page: literal(decoded.page, 1, "http.subject.page"),
        perPage: literal(decoded.perPage, 100, "http.subject.perPage"),
      };
    }
    case "github.blob.post": {
      const decoded = record(
        value,
        ["pathSha256", "contentBytes", "contentSha256", "expectedBlobSha1"],
        "http.subject",
      );
      return {
        pathSha256: assertSha256(decoded.pathSha256, "http.subject.pathSha256"),
        contentBytes: safeInteger(decoded.contentBytes, "http.subject.contentBytes"),
        contentSha256: assertSha256(decoded.contentSha256, "http.subject.contentSha256"),
        expectedBlobSha1: assertSha1(decoded.expectedBlobSha1, "http.subject.expectedBlobSha1"),
      };
    }
    case "github.tree.post": {
      const decoded = record(
        value,
        ["baseTreeSha1", "entriesSha256", "expectedTreeSha1"],
        "http.subject",
      );
      return {
        baseTreeSha1: assertSha1(decoded.baseTreeSha1, "http.subject.baseTreeSha1"),
        entriesSha256: assertSha256(decoded.entriesSha256, "http.subject.entriesSha256"),
        expectedTreeSha1: assertSha1(decoded.expectedTreeSha1, "http.subject.expectedTreeSha1"),
      };
    }
    case "github.commit.post": {
      const decoded = record(
        value,
        [
          "candidateTreeSha1",
          "baseCommitSha1",
          "candidateCommitPayloadSha256",
          "expectedCommitSha1",
          "commitIso8601",
        ],
        "http.subject",
      );
      return {
        candidateTreeSha1: assertSha1(decoded.candidateTreeSha1, "http.subject.candidateTreeSha1"),
        baseCommitSha1: assertSha1(decoded.baseCommitSha1, "http.subject.baseCommitSha1"),
        candidateCommitPayloadSha256: assertSha256(
          decoded.candidateCommitPayloadSha256,
          "http.subject.candidateCommitPayloadSha256",
        ),
        expectedCommitSha1: assertSha1(
          decoded.expectedCommitSha1,
          "http.subject.expectedCommitSha1",
        ),
        commitIso8601: assertGitInstant(decoded.commitIso8601, "http.subject.commitIso8601"),
      };
    }
    case "github.ref.post": {
      const decoded = record(
        value,
        ["baseRef", "expectedRemoteBaseSha1", "headRef", "candidateCommitSha1"],
        "http.subject",
      );
      return {
        baseRef: assertFullHeadRef(decoded.baseRef, "http.subject.baseRef"),
        expectedRemoteBaseSha1: assertSha1(
          decoded.expectedRemoteBaseSha1,
          "http.subject.expectedRemoteBaseSha1",
        ),
        headRef: assertFullHeadRef(decoded.headRef, "http.subject.headRef"),
        candidateCommitSha1: assertSha1(
          decoded.candidateCommitSha1,
          "http.subject.candidateCommitSha1",
        ),
      };
    }
    case "github.pull_request.post": {
      const decoded = record(
        value,
        [
          "baseRef",
          "expectedRemoteBaseSha1",
          "headRef",
          "candidateCommitSha1",
          "pullRequestTitleSha256",
          "pullRequestBodySha256",
          "draft",
          "maintainerCanModify",
        ],
        "http.subject",
      );
      return {
        baseRef: assertFullHeadRef(decoded.baseRef, "http.subject.baseRef"),
        expectedRemoteBaseSha1: assertSha1(
          decoded.expectedRemoteBaseSha1,
          "http.subject.expectedRemoteBaseSha1",
        ),
        headRef: assertFullHeadRef(decoded.headRef, "http.subject.headRef"),
        candidateCommitSha1: assertSha1(
          decoded.candidateCommitSha1,
          "http.subject.candidateCommitSha1",
        ),
        pullRequestTitleSha256: assertSha256(
          decoded.pullRequestTitleSha256,
          "http.subject.pullRequestTitleSha256",
        ),
        pullRequestBodySha256: assertSha256(
          decoded.pullRequestBodySha256,
          "http.subject.pullRequestBodySha256",
        ),
        draft: literal(decoded.draft, true, "http.subject.draft"),
        maintainerCanModify: literal(
          decoded.maintainerCanModify,
          false,
          "http.subject.maintainerCanModify",
        ),
      };
    }
  }
}

export function decodeLandingHttpRequestV1(value: unknown): LandingHttpRequestV1 {
  const decoded = record(
    value,
    [
      "schemaVersion",
      "requestId",
      "landingId",
      "operationId",
      "coordinatorAttempt",
      "operationKind",
      "requestOrdinal",
      "kind",
      "method",
      "profileSha256",
      "bodySha256",
      "subject",
    ],
    "http",
  );
  if (!isLandingOperationKindV1(decoded.operationKind)) {
    invalid("HTTP request operation kind is unsupported");
  }
  if (!isLandingHttpKindV1(decoded.kind)) {
    invalid("HTTP request kind is unsupported");
  }
  if (!canAttachLandingHttpKind(decoded.operationKind, decoded.kind)) {
    invalid("HTTP request kind cannot attach to this landing operation");
  }
  const method = oneOf(decoded.method, ["GET", "POST"] as const, "http.method");
  const expectedMethod = (HTTP_GET_KINDS as readonly LandingHttpKindV1[]).includes(decoded.kind)
    ? "GET"
    : "POST";
  if (method !== expectedMethod) invalid("HTTP request method does not match its kind");
  const bodySha256 =
    method === "GET"
      ? literal(decoded.bodySha256, null, "http.bodySha256")
      : assertSha256(decoded.bodySha256, "http.bodySha256");
  return {
    schemaVersion: literal(decoded.schemaVersion, 1, "http.schemaVersion"),
    requestId: assertUuid(decoded.requestId, "http.requestId"),
    landingId: assertUuid(decoded.landingId, "http.landingId"),
    operationId: assertUuid(decoded.operationId, "http.operationId"),
    coordinatorAttempt: safeInteger(decoded.coordinatorAttempt, "http.coordinatorAttempt", 1, 8),
    operationKind: decoded.operationKind,
    requestOrdinal: safeInteger(
      decoded.requestOrdinal,
      "http.requestOrdinal",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    kind: decoded.kind,
    method,
    profileSha256: assertSha256(decoded.profileSha256, "http.profileSha256"),
    bodySha256,
    subject: decodeHttpSubjectV1(decoded.kind, decoded.subject),
  };
}

export interface GitHubTreeEntryV1 {
  readonly path: string;
  readonly mode: "100644";
  readonly type: "blob";
  readonly sha: string | null;
}

export interface GitHubBlobBodyV1 {
  readonly content: string;
  readonly encoding: "base64";
}

export interface GitHubTreeBodyV1 {
  readonly base_tree: string;
  readonly tree: readonly GitHubTreeEntryV1[];
}

export interface GitHubCommitBodyV1 {
  readonly message: string;
  readonly tree: string;
  readonly parents: readonly [string];
  readonly author: { readonly name: string; readonly email: string; readonly date: string };
  readonly committer: { readonly name: string; readonly email: string; readonly date: string };
}

export interface GitHubRefBodyV1 {
  readonly ref: string;
  readonly sha: string;
}

export interface GitHubPullRequestBodyV1 {
  readonly title: string;
  readonly head: string;
  readonly base: string;
  readonly body: string;
  readonly draft: true;
  readonly maintainer_can_modify: false;
}

export type GitHubPostBodyV1 =
  | GitHubBlobBodyV1
  | GitHubTreeBodyV1
  | GitHubCommitBodyV1
  | GitHubRefBodyV1
  | GitHubPullRequestBodyV1;

function decodeGitHubTreeEntryV1(value: unknown, field: string): GitHubTreeEntryV1 {
  const decoded = record(value, ["path", "mode", "type", "sha"], field);
  return {
    path: assertLandingPath(decoded.path, `${field}.path`),
    mode: literal(decoded.mode, "100644", `${field}.mode`),
    type: literal(decoded.type, "blob", `${field}.type`),
    sha: nullable(decoded.sha, (entry) => assertSha1(entry, `${field}.sha`)),
  };
}

function decodeGitHubCommitPartyV1(
  value: unknown,
  field: string,
): { readonly name: string; readonly email: string; readonly date: string } {
  const decoded = record(value, ["name", "email", "date"], field);
  const identity = assertCommitIdentity({ name: decoded.name, email: decoded.email }, field);
  return {
    ...identity,
    date: assertGitInstant(decoded.date, `${field}.date`),
  };
}

export function decodeGitHubPostBodyV1(
  kind:
    | "github.blob.post"
    | "github.tree.post"
    | "github.commit.post"
    | "github.ref.post"
    | "github.pull_request.post",
  value: unknown,
): GitHubPostBodyV1 {
  switch (kind) {
    case "github.blob.post": {
      const decoded = record(value, ["content", "encoding"], "body");
      const content = string(decoded.content, "body.content");
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content) ||
        Buffer.from(content, "base64").toString("base64") !== content
      ) {
        invalid("Blob content is not canonical padded RFC 4648 base64");
      }
      return {
        content,
        encoding: literal(decoded.encoding, "base64", "body.encoding"),
      };
    }
    case "github.tree.post": {
      const decoded = record(value, ["base_tree", "tree"], "body");
      const tree = array(decoded.tree, "body.tree").map((entry, index) =>
        decodeGitHubTreeEntryV1(entry, `body.tree[${index}]`),
      );
      if (tree.length === 0) invalid("Tree body must contain changed paths");
      assertSortedUniqueStrings(
        tree.map((entry) => entry.path),
        "body.tree",
      );
      return {
        base_tree: assertSha1(decoded.base_tree, "body.base_tree"),
        tree,
      };
    }
    case "github.commit.post": {
      const decoded = record(value, ["message", "tree", "parents", "author", "committer"], "body");
      const message = string(decoded.message, "body.message");
      if (canonicalizeCommitMessage(message) !== message) {
        invalid("Commit body message is not canonical");
      }
      const parents = array(decoded.parents, "body.parents");
      if (parents.length !== 1) invalid("Commit body must have exactly one parent");
      const author = decodeGitHubCommitPartyV1(decoded.author, "body.author");
      const committer = decodeGitHubCommitPartyV1(decoded.committer, "body.committer");
      if (!sameCommitIdentity(author, committer) || author.date !== committer.date) {
        invalid("Commit body author and committer must be identical");
      }
      return {
        message,
        tree: assertSha1(decoded.tree, "body.tree"),
        parents: [assertSha1(parents[0], "body.parents[0]")],
        author,
        committer,
      };
    }
    case "github.ref.post": {
      const decoded = record(value, ["ref", "sha"], "body");
      return {
        ref: assertFullHeadRef(decoded.ref, "body.ref"),
        sha: assertSha1(decoded.sha, "body.sha"),
      };
    }
    case "github.pull_request.post": {
      const decoded = record(
        value,
        ["title", "head", "base", "body", "draft", "maintainer_can_modify"],
        "body",
      );
      const title = string(decoded.title, "body.title");
      if (canonicalizePullRequestTitle(title) !== title) {
        invalid("Pull-request body title is not canonical");
      }
      const head = string(decoded.head, "body.head");
      const headSeparator = head.indexOf(":");
      if (
        headSeparator <= 0 ||
        headSeparator !== head.lastIndexOf(":") ||
        !GITHUB_OWNER_PATTERN.test(head.slice(0, headSeparator))
      ) {
        invalid("Pull-request head is not owner-qualified");
      }
      assertGitBranchName(head.slice(headSeparator + 1), "body.head");
      const body = string(decoded.body, "body.body");
      if (utf8Bytes(body) > MAX_PULL_REQUEST_BODY_BYTES) {
        invalid("Pull-request body exceeds the v1 byte ceiling");
      }
      return {
        title,
        head,
        base: assertGitBranchName(decoded.base, "body.base"),
        body,
        draft: literal(decoded.draft, true, "body.draft"),
        maintainer_can_modify: literal(
          decoded.maintainer_can_modify,
          false,
          "body.maintainer_can_modify",
        ),
      };
    }
  }
}

export function canonicalGitHubPostBodyV1(
  kind:
    | "github.blob.post"
    | "github.tree.post"
    | "github.commit.post"
    | "github.ref.post"
    | "github.pull_request.post",
  value: unknown,
): { readonly value: GitHubPostBodyV1; readonly body: string; readonly sha256: string } {
  const decoded = decodeGitHubPostBodyV1(kind, value);
  const body = canonicalLandingJson(decoded);
  return { value: decoded, body, sha256: sha256(body) };
}

export interface LandingDecisionV1 {
  readonly id: string;
  readonly landingId: string;
  readonly landingSha256: string;
  readonly actor: string;
  readonly decision: "approve" | "reject";
  readonly createdAt: string;
}

export function decodeLandingDecisionV1(value: unknown): LandingDecisionV1 {
  const decoded = record(
    value,
    ["id", "landingId", "landingSha256", "actor", "decision", "createdAt"],
    "landingDecision",
  );
  return {
    id: assertUuid(decoded.id, "landingDecision.id"),
    landingId: assertUuid(decoded.landingId, "landingDecision.landingId"),
    landingSha256: assertSha256(decoded.landingSha256, "landingDecision.landingSha256"),
    actor: assertActor(decoded.actor, "landingDecision.actor"),
    decision: oneOf(decoded.decision, ["approve", "reject"] as const, "landingDecision.decision"),
    createdAt: assertInstant(decoded.createdAt, "landingDecision.createdAt"),
  };
}

export type LocalRefFactV1 =
  | {
      readonly schemaVersion: 1;
      readonly state: "absent";
      readonly objectSha1: null;
      readonly symbolicTargetSha256: null;
    }
  | {
      readonly schemaVersion: 1;
      readonly state: "direct";
      readonly objectSha1: string;
      readonly symbolicTargetSha256: null;
    }
  | {
      readonly schemaVersion: 1;
      readonly state: "symbolic";
      readonly objectSha1: null;
      readonly symbolicTargetSha256: string;
    };

/**
 * The accepted contract defines no legal nullability shape for its explanatory
 * "invalid" local-ref state. Persisted v1 records therefore reject it rather
 * than inventing an encoding.
 */
export function decodeLocalRefFactV1(value: unknown): LocalRefFactV1 {
  const decoded = record(
    value,
    ["schemaVersion", "state", "objectSha1", "symbolicTargetSha256"],
    "localRefFact",
  );
  const schemaVersion = literal(decoded.schemaVersion, 1, "localRefFact.schemaVersion");
  const state = oneOf(
    decoded.state,
    ["absent", "direct", "symbolic"] as const,
    "localRefFact.state",
  );
  switch (state) {
    case "absent":
      return {
        schemaVersion,
        state,
        objectSha1: literal(decoded.objectSha1, null, "localRefFact.objectSha1"),
        symbolicTargetSha256: literal(
          decoded.symbolicTargetSha256,
          null,
          "localRefFact.symbolicTargetSha256",
        ),
      };
    case "direct":
      return {
        schemaVersion,
        state,
        objectSha1: assertSha1(decoded.objectSha1, "localRefFact.objectSha1"),
        symbolicTargetSha256: literal(
          decoded.symbolicTargetSha256,
          null,
          "localRefFact.symbolicTargetSha256",
        ),
      };
    case "symbolic":
      return {
        schemaVersion,
        state,
        objectSha1: literal(decoded.objectSha1, null, "localRefFact.objectSha1"),
        symbolicTargetSha256: assertSha256(
          decoded.symbolicTargetSha256,
          "localRefFact.symbolicTargetSha256",
        ),
      };
  }
}

export function decodeCanonicalLocalRefFactJsonV1(encoded: string): LocalRefFactV1 {
  return decodeCanonicalLandingJson(encoded, decodeLocalRefFactV1);
}

export type LandingObservationFactNameV1 =
  | "subject_operation"
  | "local_ref"
  | "actor"
  | "base_ref"
  | "head_ref"
  | "pull_requests";

export interface LandingOperationObservationFactV1 {
  readonly fact: LandingObservationFactNameV1;
  readonly requestId: string | null;
  readonly resultSha256: string;
}

export interface LandingOperationObservationV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly kind: LandingOperationKindV1;
  readonly phase: "pre_effect" | "reconciliation";
  readonly facts: readonly LandingOperationObservationFactV1[];
}

const OBSERVATION_FACT_NAMES = [
  "subject_operation",
  "local_ref",
  "actor",
  "base_ref",
  "head_ref",
  "pull_requests",
] as const satisfies readonly LandingObservationFactNameV1[];

function sameStringSequence(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((entry, index) => entry === expected[index])
  );
}

function permittedObservationSequences(
  kind: LandingOperationKindV1,
): readonly (readonly LandingObservationFactNameV1[])[] {
  switch (kind) {
    case "candidate.prepare":
      return [];
    case "local_ref.create":
      return [["local_ref"]];
    case "github.preflight":
      return [
        ["actor", "base_ref", "head_ref"],
        ["actor", "base_ref", "head_ref", "pull_requests"],
      ];
    case "github.objects.upload":
      return [["actor"]];
    case "github.ref.create":
      return [["actor", "base_ref", "head_ref"]];
    case "github.pull_request.create":
      return [["actor", "base_ref", "head_ref", "pull_requests"]];
    case "landing.reconcile":
      return [
        ["subject_operation"],
        ["subject_operation", "local_ref"],
        ["subject_operation", "actor", "base_ref", "head_ref"],
        ["subject_operation", "actor", "base_ref", "head_ref", "pull_requests"],
      ];
  }
}

export function decodeLandingOperationObservationV1(value: unknown): LandingOperationObservationV1 {
  const decoded = record(
    value,
    ["schemaVersion", "operationId", "kind", "phase", "facts"],
    "operationObservation",
  );
  if (!isLandingOperationKindV1(decoded.kind)) {
    invalid("Operation observation kind is unsupported");
  }
  const expectedPhase = decoded.kind === "landing.reconcile" ? "reconciliation" : "pre_effect";
  const phase = literal(decoded.phase, expectedPhase, "operationObservation.phase");
  const facts = array(decoded.facts, "operationObservation.facts").map((entry, index) => {
    const field = `operationObservation.facts[${index}]`;
    const factRecord = record(entry, ["fact", "requestId", "resultSha256"], field);
    const fact = oneOf(factRecord.fact, OBSERVATION_FACT_NAMES, `${field}.fact`);
    const localFact = fact === "subject_operation" || fact === "local_ref";
    const requestId = localFact
      ? literal(factRecord.requestId, null, `${field}.requestId`)
      : assertUuid(factRecord.requestId, `${field}.requestId`);
    return {
      fact,
      requestId,
      resultSha256: assertSha256(factRecord.resultSha256, `${field}.resultSha256`),
    };
  });
  const factNames = facts.map((entry) => entry.fact);
  if (
    !permittedObservationSequences(decoded.kind).some((expected) =>
      sameStringSequence(factNames, expected),
    )
  ) {
    invalid("Operation observation facts do not match the kind-specific grammar");
  }
  const requestIds = facts
    .map((entry) => entry.requestId)
    .filter((entry): entry is string => entry !== null);
  if (new Set(requestIds).size !== requestIds.length) {
    invalid("Operation observation contains a duplicate provider request");
  }
  return {
    schemaVersion: literal(decoded.schemaVersion, 1, "operationObservation.schemaVersion"),
    operationId: assertUuid(decoded.operationId, "operationObservation.operationId"),
    kind: decoded.kind,
    phase,
    facts,
  };
}

export function decodeCanonicalLandingOperationObservationJsonV1(
  encoded: string,
): LandingOperationObservationV1 {
  return decodeCanonicalLandingJson(encoded, decodeLandingOperationObservationV1);
}

export interface CandidateReadyValueV1 {
  readonly candidateTreeSha1: string;
  readonly candidateCommitSha1: string;
  readonly candidateCommitPayloadSha256: string;
  readonly candidateObjectManifestSha256: string;
  readonly candidateCredentialAuditSha256: string;
  readonly diffByteEqual: true;
}

export interface LocalRefReadyValueV1 {
  readonly headRef: string;
  readonly candidateCommitSha1: string;
  readonly localRefOutcome: "created" | "reconciled";
  readonly updateRefExitCode: 0 | null;
}

export interface PreflightExactValueV1 {
  readonly actor: string;
  readonly baseSha1: string;
  readonly headState: "absent" | "exact";
  readonly pullRequestCount: 0 | null;
}

export interface ObjectsExactValueV1 {
  readonly candidateObjectManifestSha256: string;
  readonly remoteObjectOutcome: "created_or_exact";
}

export interface RemoteRefReadyValueV1 {
  readonly baseSha1: string;
  readonly headSha1: string;
  readonly remoteRefOutcome: "created" | "reconciled";
}

export interface PullRequestProjectionV1 {
  readonly type: "pull_request";
  readonly number: number;
  readonly state: "open";
  readonly draft: true;
  readonly owner: string;
  readonly repository: string;
  readonly headOwner: string;
  readonly headRef: string;
  readonly headSha1: string;
  readonly baseRef: string;
  readonly baseSha1: string;
  readonly titleSha256: string;
  readonly bodySha256: string;
  readonly markerCount: 1;
  readonly maintainerCanModify: false;
}

export interface DraftPrExactValueV1 extends PullRequestProjectionV1 {
  readonly pullRequestOutcome: "created" | "reconciled";
}

export interface ReconcileValueV1 {
  readonly subjectOperationId: string;
  readonly nextState: LandingStateV1;
  readonly remoteResidue: "none" | "branch" | "pull_request";
  readonly stageValue:
    | LocalRefReadyValueV1
    | ObjectsExactValueV1
    | RemoteRefReadyValueV1
    | DraftPrExactValueV1
    | null;
}

export interface ReconciliationRequiredValueV1 {
  readonly subjectOperationId: string;
  readonly remoteResidue: "none" | "branch" | "pull_request" | "ambiguous";
}

export interface LandingOperationEvidenceV1 {
  readonly requestId: string | null;
  readonly resultSha256: string;
}

export interface LandingOperationResultV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly kind: LandingOperationKindV1;
  readonly outcome: "completed" | "failed" | "interrupted" | "reconciliation_required";
  readonly boundary:
    | "candidate_ready"
    | "local_ref_ready"
    | "preflight_exact"
    | "objects_exact"
    | "remote_ref_ready"
    | "draft_pr_exact"
    | "subject_settled"
    | "retry_stage_proven"
    | "operation_failed"
    | "operation_interrupted"
    | "reconciliation_required";
  readonly evidence: readonly LandingOperationEvidenceV1[];
  readonly value:
    | CandidateReadyValueV1
    | LocalRefReadyValueV1
    | PreflightExactValueV1
    | ObjectsExactValueV1
    | RemoteRefReadyValueV1
    | DraftPrExactValueV1
    | ReconcileValueV1
    | ReconciliationRequiredValueV1
    | null;
  readonly errorCode: string | null;
}

const PULL_REQUEST_PROJECTION_KEYS = [
  "type",
  "number",
  "state",
  "draft",
  "owner",
  "repository",
  "headOwner",
  "headRef",
  "headSha1",
  "baseRef",
  "baseSha1",
  "titleSha256",
  "bodySha256",
  "markerCount",
  "maintainerCanModify",
] as const;

function decodePullRequestProjectionFieldsV1(
  decoded: JsonRecord,
  field: string,
): PullRequestProjectionV1 {
  return {
    type: literal(decoded.type, "pull_request", `${field}.type`),
    number: safeInteger(decoded.number, `${field}.number`, 1, Number.MAX_SAFE_INTEGER),
    state: literal(decoded.state, "open", `${field}.state`),
    draft: literal(decoded.draft, true, `${field}.draft`),
    owner: assertGitHubIdentityPart(decoded.owner, `${field}.owner`, true),
    repository: assertGitHubIdentityPart(decoded.repository, `${field}.repository`, false),
    headOwner: assertGitHubIdentityPart(decoded.headOwner, `${field}.headOwner`, true),
    headRef: assertGitBranchName(decoded.headRef, `${field}.headRef`),
    headSha1: assertSha1(decoded.headSha1, `${field}.headSha1`),
    baseRef: assertGitBranchName(decoded.baseRef, `${field}.baseRef`),
    baseSha1: assertSha1(decoded.baseSha1, `${field}.baseSha1`),
    titleSha256: assertSha256(decoded.titleSha256, `${field}.titleSha256`),
    bodySha256: assertSha256(decoded.bodySha256, `${field}.bodySha256`),
    markerCount: literal(decoded.markerCount, 1, `${field}.markerCount`),
    maintainerCanModify: literal(
      decoded.maintainerCanModify,
      false,
      `${field}.maintainerCanModify`,
    ),
  };
}

export function decodePullRequestProjectionV1(value: unknown): PullRequestProjectionV1 {
  const decoded = record(value, PULL_REQUEST_PROJECTION_KEYS, "pullRequestProjection");
  return decodePullRequestProjectionFieldsV1(decoded, "pullRequestProjection");
}

function decodeCandidateReadyValueV1(value: unknown, field: string): CandidateReadyValueV1 {
  const decoded = record(
    value,
    [
      "candidateTreeSha1",
      "candidateCommitSha1",
      "candidateCommitPayloadSha256",
      "candidateObjectManifestSha256",
      "candidateCredentialAuditSha256",
      "diffByteEqual",
    ],
    field,
  );
  return {
    candidateTreeSha1: assertSha1(decoded.candidateTreeSha1, `${field}.candidateTreeSha1`),
    candidateCommitSha1: assertSha1(decoded.candidateCommitSha1, `${field}.candidateCommitSha1`),
    candidateCommitPayloadSha256: assertSha256(
      decoded.candidateCommitPayloadSha256,
      `${field}.candidateCommitPayloadSha256`,
    ),
    candidateObjectManifestSha256: assertSha256(
      decoded.candidateObjectManifestSha256,
      `${field}.candidateObjectManifestSha256`,
    ),
    candidateCredentialAuditSha256: assertSha256(
      decoded.candidateCredentialAuditSha256,
      `${field}.candidateCredentialAuditSha256`,
    ),
    diffByteEqual: literal(decoded.diffByteEqual, true, `${field}.diffByteEqual`),
  };
}

function decodeLocalRefReadyValueV1(value: unknown, field: string): LocalRefReadyValueV1 {
  const decoded = record(
    value,
    ["headRef", "candidateCommitSha1", "localRefOutcome", "updateRefExitCode"],
    field,
  );
  const localRefOutcome = oneOf(
    decoded.localRefOutcome,
    ["created", "reconciled"] as const,
    `${field}.localRefOutcome`,
  );
  const updateRefExitCode =
    localRefOutcome === "created"
      ? literal(decoded.updateRefExitCode, 0, `${field}.updateRefExitCode`)
      : literal(decoded.updateRefExitCode, null, `${field}.updateRefExitCode`);
  return {
    headRef: assertFullHeadRef(decoded.headRef, `${field}.headRef`),
    candidateCommitSha1: assertSha1(decoded.candidateCommitSha1, `${field}.candidateCommitSha1`),
    localRefOutcome,
    updateRefExitCode,
  };
}

function decodePreflightExactValueV1(value: unknown, field: string): PreflightExactValueV1 {
  const decoded = record(value, ["actor", "baseSha1", "headState", "pullRequestCount"], field);
  return {
    actor: assertGitHubIdentityPart(decoded.actor, `${field}.actor`, true),
    baseSha1: assertSha1(decoded.baseSha1, `${field}.baseSha1`),
    headState: oneOf(decoded.headState, ["absent", "exact"] as const, `${field}.headState`),
    pullRequestCount:
      decoded.pullRequestCount === null
        ? null
        : literal(decoded.pullRequestCount, 0, `${field}.pullRequestCount`),
  };
}

function decodeObjectsExactValueV1(value: unknown, field: string): ObjectsExactValueV1 {
  const decoded = record(value, ["candidateObjectManifestSha256", "remoteObjectOutcome"], field);
  return {
    candidateObjectManifestSha256: assertSha256(
      decoded.candidateObjectManifestSha256,
      `${field}.candidateObjectManifestSha256`,
    ),
    remoteObjectOutcome: literal(
      decoded.remoteObjectOutcome,
      "created_or_exact",
      `${field}.remoteObjectOutcome`,
    ),
  };
}

function decodeRemoteRefReadyValueV1(value: unknown, field: string): RemoteRefReadyValueV1 {
  const decoded = record(value, ["baseSha1", "headSha1", "remoteRefOutcome"], field);
  return {
    baseSha1: assertSha1(decoded.baseSha1, `${field}.baseSha1`),
    headSha1: assertSha1(decoded.headSha1, `${field}.headSha1`),
    remoteRefOutcome: oneOf(
      decoded.remoteRefOutcome,
      ["created", "reconciled"] as const,
      `${field}.remoteRefOutcome`,
    ),
  };
}

function decodeDraftPrExactValueV1(value: unknown, field: string): DraftPrExactValueV1 {
  const decoded = record(value, [...PULL_REQUEST_PROJECTION_KEYS, "pullRequestOutcome"], field);
  return {
    ...decodePullRequestProjectionFieldsV1(decoded, field),
    pullRequestOutcome: oneOf(
      decoded.pullRequestOutcome,
      ["created", "reconciled"] as const,
      `${field}.pullRequestOutcome`,
    ),
  };
}

function decodeLandingStateName(value: unknown, field: string): LandingStateV1 {
  if (!isLandingStateV1(value)) invalid(`${field} is not a landing state`);
  return value;
}

function decodeReconcileValueV1(
  value: unknown,
  field: string,
  boundary: "subject_settled" | "retry_stage_proven",
): ReconcileValueV1 {
  const decoded = record(
    value,
    ["subjectOperationId", "nextState", "remoteResidue", "stageValue"],
    field,
  );
  const subjectOperationId = assertUuid(decoded.subjectOperationId, `${field}.subjectOperationId`);
  const nextState = decodeLandingStateName(decoded.nextState, `${field}.nextState`);
  const remoteResidue = oneOf(
    decoded.remoteResidue,
    ["none", "branch", "pull_request"] as const,
    `${field}.remoteResidue`,
  );

  if (boundary === "retry_stage_proven") {
    literal(decoded.stageValue, null, `${field}.stageValue`);
    if (
      !(
        nextState === "approved" ||
        nextState === "local_ready" ||
        nextState === "objects_ready" ||
        nextState === "remote_ready"
      )
    ) {
      invalid("Retry-stage reconciliation has an impossible next state");
    }
    const expectedResidue = nextState === "remote_ready" ? "branch" : "none";
    if (remoteResidue !== expectedResidue) {
      invalid("Retry-stage reconciliation has an inconsistent remote residue");
    }
    return { subjectOperationId, nextState, remoteResidue, stageValue: null };
  }

  if (decoded.stageValue === null) {
    invalid("Settled-subject reconciliation requires a stage value");
  }
  switch (nextState) {
    case "local_ready": {
      const stageValue = decodeLocalRefReadyValueV1(decoded.stageValue, `${field}.stageValue`);
      if (
        stageValue.localRefOutcome !== "reconciled" ||
        stageValue.updateRefExitCode !== null ||
        remoteResidue !== "none"
      ) {
        invalid("Local-ref reconciliation stage evidence is inconsistent");
      }
      return { subjectOperationId, nextState, remoteResidue, stageValue };
    }
    case "objects_ready": {
      const stageValue = decodeObjectsExactValueV1(decoded.stageValue, `${field}.stageValue`);
      if (remoteResidue !== "none") {
        invalid("Object reconciliation cannot claim mutable remote residue");
      }
      return { subjectOperationId, nextState, remoteResidue, stageValue };
    }
    case "remote_ready": {
      const stageValue = decodeRemoteRefReadyValueV1(decoded.stageValue, `${field}.stageValue`);
      if (stageValue.remoteRefOutcome !== "reconciled" || remoteResidue !== "branch") {
        invalid("Remote-ref reconciliation stage evidence is inconsistent");
      }
      return { subjectOperationId, nextState, remoteResidue, stageValue };
    }
    case "landed": {
      const stageValue = decodeDraftPrExactValueV1(decoded.stageValue, `${field}.stageValue`);
      if (stageValue.pullRequestOutcome !== "reconciled" || remoteResidue !== "pull_request") {
        invalid("Pull-request reconciliation stage evidence is inconsistent");
      }
      return { subjectOperationId, nextState, remoteResidue, stageValue };
    }
    default:
      invalid("Settled-subject reconciliation has an impossible next state");
  }
}

function decodeReconciliationRequiredValueV1(
  value: unknown,
  field: string,
): ReconciliationRequiredValueV1 {
  const decoded = record(value, ["subjectOperationId", "remoteResidue"], field);
  return {
    subjectOperationId: assertUuid(decoded.subjectOperationId, `${field}.subjectOperationId`),
    remoteResidue: oneOf(
      decoded.remoteResidue,
      ["none", "branch", "pull_request", "ambiguous"] as const,
      `${field}.remoteResidue`,
    ),
  };
}

function assertCompletedEvidenceShape(
  kind: LandingOperationKindV1,
  evidence: readonly LandingOperationEvidenceV1[],
): void {
  const requestIds = evidence.map((entry) => entry.requestId);
  switch (kind) {
    case "candidate.prepare":
      if (evidence.length !== 0) invalid("Candidate result cannot carry effect evidence");
      return;
    case "local_ref.create":
      if (evidence.length !== 1 || requestIds[0] !== null) {
        invalid("Local-ref result must carry exactly one local fact");
      }
      return;
    case "github.preflight":
      if (
        !(evidence.length === 3 || evidence.length === 4) ||
        requestIds.some((entry) => entry === null)
      ) {
        invalid("Preflight result evidence does not match its request grammar");
      }
      return;
    case "github.objects.upload":
      if (evidence.length < 3 || requestIds.some((entry) => entry === null)) {
        invalid("Object-upload result evidence is incomplete");
      }
      return;
    case "github.ref.create":
      if (evidence.length !== 6 || requestIds.some((entry) => entry === null)) {
        invalid("Remote-ref result evidence does not match its request grammar");
      }
      return;
    case "github.pull_request.create":
      if (evidence.length !== 8 || requestIds.some((entry) => entry === null)) {
        invalid("Pull-request result evidence does not match its request grammar");
      }
      return;
    case "landing.reconcile":
      if (
        ![1, 2, 4, 5].includes(evidence.length) ||
        requestIds[0] !== null ||
        (evidence.length === 2 && requestIds[1] !== null) ||
        (evidence.length > 2 && requestIds.slice(1).some((entry) => entry === null))
      ) {
        invalid("Reconciliation result evidence does not match a subject grammar");
      }
      return;
  }
}

export function decodeLandingOperationResultV1(value: unknown): LandingOperationResultV1 {
  const decoded = record(
    value,
    [
      "schemaVersion",
      "operationId",
      "kind",
      "outcome",
      "boundary",
      "evidence",
      "value",
      "errorCode",
    ],
    "operationResult",
  );
  if (!isLandingOperationKindV1(decoded.kind)) {
    invalid("Operation result kind is unsupported");
  }
  const outcome = oneOf(
    decoded.outcome,
    ["completed", "failed", "interrupted", "reconciliation_required"] as const,
    "operationResult.outcome",
  );
  const boundary = oneOf(
    decoded.boundary,
    [
      "candidate_ready",
      "local_ref_ready",
      "preflight_exact",
      "objects_exact",
      "remote_ref_ready",
      "draft_pr_exact",
      "subject_settled",
      "retry_stage_proven",
      "operation_failed",
      "operation_interrupted",
      "reconciliation_required",
    ] as const,
    "operationResult.boundary",
  );
  const evidence = array(decoded.evidence, "operationResult.evidence").map((entry, index) => {
    const field = `operationResult.evidence[${index}]`;
    const evidenceRecord = record(entry, ["requestId", "resultSha256"], field);
    return {
      requestId: nullable(evidenceRecord.requestId, (requestId) =>
        assertUuid(requestId, `${field}.requestId`),
      ),
      resultSha256: assertSha256(evidenceRecord.resultSha256, `${field}.resultSha256`),
    };
  });
  const evidenceIdentities = evidence.map(
    (entry) => `${entry.requestId ?? "local"}:${entry.resultSha256}`,
  );
  if (new Set(evidenceIdentities).size !== evidenceIdentities.length) {
    invalid("Operation result contains duplicate evidence");
  }
  const errorCode =
    outcome === "completed"
      ? literal(decoded.errorCode, null, "operationResult.errorCode")
      : assertSafeCode(decoded.errorCode, "operationResult.errorCode");

  let resultValue: LandingOperationResultV1["value"];
  if (outcome === "failed") {
    literal(boundary, "operation_failed", "operationResult.boundary");
    resultValue = literal(decoded.value, null, "operationResult.value");
  } else if (outcome === "interrupted") {
    literal(boundary, "operation_interrupted", "operationResult.boundary");
    resultValue = literal(decoded.value, null, "operationResult.value");
  } else if (outcome === "reconciliation_required") {
    literal(boundary, "reconciliation_required", "operationResult.boundary");
    if (decoded.kind === "candidate.prepare" || decoded.kind === "github.preflight") {
      invalid("Retry-safe operation kinds cannot create a reconciliation subject");
    }
    resultValue = decodeReconciliationRequiredValueV1(decoded.value, "operationResult.value");
  } else {
    assertCompletedEvidenceShape(decoded.kind, evidence);
    switch (decoded.kind) {
      case "candidate.prepare":
        literal(boundary, "candidate_ready", "operationResult.boundary");
        resultValue = decodeCandidateReadyValueV1(decoded.value, "operationResult.value");
        break;
      case "local_ref.create":
        literal(boundary, "local_ref_ready", "operationResult.boundary");
        resultValue = decodeLocalRefReadyValueV1(decoded.value, "operationResult.value");
        break;
      case "github.preflight":
        literal(boundary, "preflight_exact", "operationResult.boundary");
        resultValue = decodePreflightExactValueV1(decoded.value, "operationResult.value");
        break;
      case "github.objects.upload":
        literal(boundary, "objects_exact", "operationResult.boundary");
        resultValue = decodeObjectsExactValueV1(decoded.value, "operationResult.value");
        break;
      case "github.ref.create":
        literal(boundary, "remote_ref_ready", "operationResult.boundary");
        resultValue = decodeRemoteRefReadyValueV1(decoded.value, "operationResult.value");
        break;
      case "github.pull_request.create":
        literal(boundary, "draft_pr_exact", "operationResult.boundary");
        resultValue = decodeDraftPrExactValueV1(decoded.value, "operationResult.value");
        break;
      case "landing.reconcile":
        if (!(boundary === "subject_settled" || boundary === "retry_stage_proven")) {
          invalid("Completed reconciliation has an unsupported boundary");
        }
        resultValue = decodeReconcileValueV1(decoded.value, "operationResult.value", boundary);
        break;
    }
  }
  return {
    schemaVersion: literal(decoded.schemaVersion, 1, "operationResult.schemaVersion"),
    operationId: assertUuid(decoded.operationId, "operationResult.operationId"),
    kind: decoded.kind,
    outcome,
    boundary,
    evidence,
    value: resultValue,
    errorCode,
  };
}

export function decodeCanonicalLandingOperationResultJsonV1(
  encoded: string,
): LandingOperationResultV1 {
  return decodeCanonicalLandingJson(encoded, decodeLandingOperationResultV1);
}

export const LANDING_EVENT_TYPES = [
  "landing.attempt.started",
  "landing.attempt.settled",
  "landing.operation.started",
  "landing.operation.settled",
  "landing.github.request.admitted",
  "landing.github.request.settled",
  "landing.state.changed",
  "landing.decision.recorded",
] as const;

export type LandingEventTypeV1 = (typeof LANDING_EVENT_TYPES)[number];

export interface LandingAttemptStartedEventV1 {
  readonly schemaVersion: 1;
  readonly landingId: string;
  readonly coordinatorAttempt: number;
}

export interface LandingAttemptSettledEventV1 {
  readonly schemaVersion: 1;
  readonly landingId: string;
  readonly coordinatorAttempt: number;
  readonly outcome: "completed" | "failed" | "interrupted";
  readonly errorCode: string | null;
}

export interface LandingOperationStartedEventV1 {
  readonly schemaVersion: 1;
  readonly landingId: string;
  readonly operationId: string;
  readonly coordinatorAttempt: number;
  readonly kind: LandingOperationKindV1;
  readonly kindAttempt: number;
  readonly requestSha256: string;
}

export interface LandingOperationSettledEventV1 {
  readonly schemaVersion: 1;
  readonly landingId: string;
  readonly operationId: string;
  readonly coordinatorAttempt: number;
  readonly kind: LandingOperationKindV1;
  readonly outcome: "completed" | "failed" | "interrupted" | "reconciliation_required";
  readonly resultSha256: string;
  readonly errorCode: string | null;
}

export interface LandingGitHubRequestAdmittedEventV1 {
  readonly schemaVersion: 1;
  readonly landingId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly coordinatorAttempt: number;
  readonly operationKind: LandingOperationKindV1;
  readonly requestOrdinal: number;
  readonly kind: LandingHttpKindV1;
  readonly requestSha256: string;
}

export interface LandingGitHubRequestSettledEventV1 {
  readonly schemaVersion: 1;
  readonly landingId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly coordinatorAttempt: number;
  readonly operationKind: LandingOperationKindV1;
  readonly requestOrdinal: number;
  readonly kind: LandingHttpKindV1;
  readonly outcome: "succeeded" | "failed" | "ambiguous";
  readonly resultSha256: string;
  readonly errorCode: string | null;
}

export interface LandingStateChangedEventV1 {
  readonly schemaVersion: 1;
  readonly landingId: string;
  readonly from: LandingStateV1;
  readonly to: LandingStateV1;
  readonly version: number;
  readonly operationId: string | null;
}

export interface LandingDecisionRecordedEventV1 {
  readonly schemaVersion: 1;
  readonly landingId: string;
  readonly decisionId: string;
  readonly landingSha256: string;
  readonly decision: "approve" | "reject";
  readonly actor: string;
}

export type LandingEventPayloadV1 =
  | LandingAttemptStartedEventV1
  | LandingAttemptSettledEventV1
  | LandingOperationStartedEventV1
  | LandingOperationSettledEventV1
  | LandingGitHubRequestAdmittedEventV1
  | LandingGitHubRequestSettledEventV1
  | LandingStateChangedEventV1
  | LandingDecisionRecordedEventV1;

function decodeEventOperationKind(value: unknown, field: string): LandingOperationKindV1 {
  if (!isLandingOperationKindV1(value)) invalid(`${field} is unsupported`);
  return value;
}

function decodeEventHttpKind(value: unknown, field: string): LandingHttpKindV1 {
  if (!isLandingHttpKindV1(value)) invalid(`${field} is unsupported`);
  return value;
}

function decodeSettledErrorCode(
  outcome: string,
  completedOutcome: string,
  value: unknown,
  field: string,
): string | null {
  return outcome === completedOutcome ? literal(value, null, field) : assertSafeCode(value, field);
}

export function decodeLandingEventPayloadV1(type: unknown, value: unknown): LandingEventPayloadV1 {
  if (typeof type !== "string" || !(LANDING_EVENT_TYPES as readonly string[]).includes(type)) {
    invalid("Landing event type is unsupported");
  }
  const eventType = type as LandingEventTypeV1;
  switch (eventType) {
    case "landing.attempt.started": {
      const decoded = record(
        value,
        ["schemaVersion", "landingId", "coordinatorAttempt"],
        "landingEvent",
      );
      return {
        schemaVersion: literal(decoded.schemaVersion, 1, "landingEvent.schemaVersion"),
        landingId: assertUuid(decoded.landingId, "landingEvent.landingId"),
        coordinatorAttempt: safeInteger(
          decoded.coordinatorAttempt,
          "landingEvent.coordinatorAttempt",
          1,
          8,
        ),
      };
    }
    case "landing.attempt.settled": {
      const decoded = record(
        value,
        ["schemaVersion", "landingId", "coordinatorAttempt", "outcome", "errorCode"],
        "landingEvent",
      );
      const outcome = oneOf(
        decoded.outcome,
        ["completed", "failed", "interrupted"] as const,
        "landingEvent.outcome",
      );
      return {
        schemaVersion: literal(decoded.schemaVersion, 1, "landingEvent.schemaVersion"),
        landingId: assertUuid(decoded.landingId, "landingEvent.landingId"),
        coordinatorAttempt: safeInteger(
          decoded.coordinatorAttempt,
          "landingEvent.coordinatorAttempt",
          1,
          8,
        ),
        outcome,
        errorCode: decodeSettledErrorCode(
          outcome,
          "completed",
          decoded.errorCode,
          "landingEvent.errorCode",
        ),
      };
    }
    case "landing.operation.started": {
      const decoded = record(
        value,
        [
          "schemaVersion",
          "landingId",
          "operationId",
          "coordinatorAttempt",
          "kind",
          "kindAttempt",
          "requestSha256",
        ],
        "landingEvent",
      );
      return {
        schemaVersion: literal(decoded.schemaVersion, 1, "landingEvent.schemaVersion"),
        landingId: assertUuid(decoded.landingId, "landingEvent.landingId"),
        operationId: assertUuid(decoded.operationId, "landingEvent.operationId"),
        coordinatorAttempt: safeInteger(
          decoded.coordinatorAttempt,
          "landingEvent.coordinatorAttempt",
          1,
          8,
        ),
        kind: decodeEventOperationKind(decoded.kind, "landingEvent.kind"),
        kindAttempt: safeInteger(decoded.kindAttempt, "landingEvent.kindAttempt", 1, 9),
        requestSha256: assertSha256(decoded.requestSha256, "landingEvent.requestSha256"),
      };
    }
    case "landing.operation.settled": {
      const decoded = record(
        value,
        [
          "schemaVersion",
          "landingId",
          "operationId",
          "coordinatorAttempt",
          "kind",
          "outcome",
          "resultSha256",
          "errorCode",
        ],
        "landingEvent",
      );
      const outcome = oneOf(
        decoded.outcome,
        ["completed", "failed", "interrupted", "reconciliation_required"] as const,
        "landingEvent.outcome",
      );
      return {
        schemaVersion: literal(decoded.schemaVersion, 1, "landingEvent.schemaVersion"),
        landingId: assertUuid(decoded.landingId, "landingEvent.landingId"),
        operationId: assertUuid(decoded.operationId, "landingEvent.operationId"),
        coordinatorAttempt: safeInteger(
          decoded.coordinatorAttempt,
          "landingEvent.coordinatorAttempt",
          1,
          8,
        ),
        kind: decodeEventOperationKind(decoded.kind, "landingEvent.kind"),
        outcome,
        resultSha256: assertSha256(decoded.resultSha256, "landingEvent.resultSha256"),
        errorCode: decodeSettledErrorCode(
          outcome,
          "completed",
          decoded.errorCode,
          "landingEvent.errorCode",
        ),
      };
    }
    case "landing.github.request.admitted": {
      const decoded = record(
        value,
        [
          "schemaVersion",
          "landingId",
          "operationId",
          "requestId",
          "coordinatorAttempt",
          "operationKind",
          "requestOrdinal",
          "kind",
          "requestSha256",
        ],
        "landingEvent",
      );
      const operationKind = decodeEventOperationKind(
        decoded.operationKind,
        "landingEvent.operationKind",
      );
      const kind = decodeEventHttpKind(decoded.kind, "landingEvent.kind");
      if (!canAttachLandingHttpKind(operationKind, kind)) {
        invalid("Landing request event kind cannot attach to its operation");
      }
      return {
        schemaVersion: literal(decoded.schemaVersion, 1, "landingEvent.schemaVersion"),
        landingId: assertUuid(decoded.landingId, "landingEvent.landingId"),
        operationId: assertUuid(decoded.operationId, "landingEvent.operationId"),
        requestId: assertUuid(decoded.requestId, "landingEvent.requestId"),
        coordinatorAttempt: safeInteger(
          decoded.coordinatorAttempt,
          "landingEvent.coordinatorAttempt",
          1,
          8,
        ),
        operationKind,
        requestOrdinal: safeInteger(
          decoded.requestOrdinal,
          "landingEvent.requestOrdinal",
          1,
          Number.MAX_SAFE_INTEGER,
        ),
        kind,
        requestSha256: assertSha256(decoded.requestSha256, "landingEvent.requestSha256"),
      };
    }
    case "landing.github.request.settled": {
      const decoded = record(
        value,
        [
          "schemaVersion",
          "landingId",
          "operationId",
          "requestId",
          "coordinatorAttempt",
          "operationKind",
          "requestOrdinal",
          "kind",
          "outcome",
          "resultSha256",
          "errorCode",
        ],
        "landingEvent",
      );
      const operationKind = decodeEventOperationKind(
        decoded.operationKind,
        "landingEvent.operationKind",
      );
      const kind = decodeEventHttpKind(decoded.kind, "landingEvent.kind");
      if (!canAttachLandingHttpKind(operationKind, kind)) {
        invalid("Landing request event kind cannot attach to its operation");
      }
      const outcome = oneOf(
        decoded.outcome,
        ["succeeded", "failed", "ambiguous"] as const,
        "landingEvent.outcome",
      );
      return {
        schemaVersion: literal(decoded.schemaVersion, 1, "landingEvent.schemaVersion"),
        landingId: assertUuid(decoded.landingId, "landingEvent.landingId"),
        operationId: assertUuid(decoded.operationId, "landingEvent.operationId"),
        requestId: assertUuid(decoded.requestId, "landingEvent.requestId"),
        coordinatorAttempt: safeInteger(
          decoded.coordinatorAttempt,
          "landingEvent.coordinatorAttempt",
          1,
          8,
        ),
        operationKind,
        requestOrdinal: safeInteger(
          decoded.requestOrdinal,
          "landingEvent.requestOrdinal",
          1,
          Number.MAX_SAFE_INTEGER,
        ),
        kind,
        outcome,
        resultSha256: assertSha256(decoded.resultSha256, "landingEvent.resultSha256"),
        errorCode: decodeSettledErrorCode(
          outcome,
          "succeeded",
          decoded.errorCode,
          "landingEvent.errorCode",
        ),
      };
    }
    case "landing.state.changed": {
      const decoded = record(
        value,
        ["schemaVersion", "landingId", "from", "to", "version", "operationId"],
        "landingEvent",
      );
      const from = decodeLandingStateName(decoded.from, "landingEvent.from");
      const to = decodeLandingStateName(decoded.to, "landingEvent.to");
      if (from === to || !canTransitionLanding(from, to)) {
        invalid("Landing state event does not encode one legal non-self transition");
      }
      return {
        schemaVersion: literal(decoded.schemaVersion, 1, "landingEvent.schemaVersion"),
        landingId: assertUuid(decoded.landingId, "landingEvent.landingId"),
        from,
        to,
        version: safeInteger(decoded.version, "landingEvent.version", 1, Number.MAX_SAFE_INTEGER),
        operationId: nullable(decoded.operationId, (operationId) =>
          assertUuid(operationId, "landingEvent.operationId"),
        ),
      };
    }
    case "landing.decision.recorded": {
      const decoded = record(
        value,
        ["schemaVersion", "landingId", "decisionId", "landingSha256", "decision", "actor"],
        "landingEvent",
      );
      return {
        schemaVersion: literal(decoded.schemaVersion, 1, "landingEvent.schemaVersion"),
        landingId: assertUuid(decoded.landingId, "landingEvent.landingId"),
        decisionId: assertUuid(decoded.decisionId, "landingEvent.decisionId"),
        landingSha256: assertSha256(decoded.landingSha256, "landingEvent.landingSha256"),
        decision: oneOf(decoded.decision, ["approve", "reject"] as const, "landingEvent.decision"),
        actor: assertActor(decoded.actor, "landingEvent.actor"),
      };
    }
  }
}

export function decodeCanonicalLandingEventPayloadJsonV1(
  type: unknown,
  encoded: string,
): LandingEventPayloadV1 {
  return decodeCanonicalLandingJson(encoded, (value) => decodeLandingEventPayloadV1(type, value));
}
