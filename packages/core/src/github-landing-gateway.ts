import { parseStrictJson } from "./canonical-json.js";
import { sha256 } from "./digest.js";
import { IcarusError } from "./errors.js";
import {
  assertGitBranchName,
  assertLandingDigestTextBindingsV1,
  assertSha1,
  assertSha256,
  assertUuid,
  buildUnsignedCommitPayloadV1,
  canonicalGitHubPostBodyV1,
  decodeCandidateObjectManifestV1,
  decodeGitHubLandingProfileV1,
  decodeLandingDigestV1,
  decodeLandingHttpRequestV1,
  decodeLandingHttpResultV1,
  digestLandingRecord,
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  gitObjectSha1,
  renderPullRequestBodyV1,
  type CandidateObjectManifestV1,
  type GitHubLandingProfileV1,
  type GitHubPostBodyV1,
  type LandingDigestV1,
  type LandingHttpProjectionV1,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
} from "./landing-records.js";
import type { LandingOperationKindV1 } from "./landing-state.js";

export const GITHUB_LANDING_RESPONSE_MAX_BYTES = 1024 * 1024;
export const GITHUB_LANDING_REQUEST_TIMEOUT_MS = 30_000;
export const GITHUB_LANDING_USER_AGENT = "Icarus-GitHub-Landing/1";

const GITHUB_JSON_ACCEPT = "application/vnd.github+json";
const GITHUB_IDENTITY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const HEAD_REF_NOT_FOUND_DOCUMENTATION_URL =
  "https://docs.github.com/rest/git/refs#get-a-reference";
const POST_KINDS = new Set<LandingHttpRequestV1["kind"]>([
  "github.blob.post",
  "github.tree.post",
  "github.commit.post",
  "github.ref.post",
  "github.pull_request.post",
]);

type JsonRecord = Record<string, unknown>;

export interface GitHubLandingTransportRequest {
  readonly origin: typeof GITHUB_API_ORIGIN;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query: string;
  readonly headers: {
    readonly accept: typeof GITHUB_JSON_ACCEPT;
    readonly authorization: string;
    readonly contentType: "application/json" | null;
    readonly userAgent: typeof GITHUB_LANDING_USER_AGENT;
    readonly xGitHubApiVersion: typeof GITHUB_API_VERSION;
  };
  readonly body: Uint8Array | null;
  readonly timeoutMs: typeof GITHUB_LANDING_REQUEST_TIMEOUT_MS;
  readonly responseMaxBytes: typeof GITHUB_LANDING_RESPONSE_MAX_BYTES;
  readonly redirect: "error";
}

export interface GitHubLandingTransportResponse {
  readonly kind: "response";
  readonly status: number;
  readonly headers: readonly (readonly [name: string, value: string])[];
  readonly body: Uint8Array;
}

export interface GitHubLandingTransportFailure {
  readonly kind: "failure";
  readonly phase: "before_dispatch" | "after_dispatch";
  readonly reason: "cancelled" | "timeout" | "transport";
}

export type GitHubLandingTransportOutcome =
  | GitHubLandingTransportResponse
  | GitHubLandingTransportFailure;

export interface GitHubLandingTransport {
  dispatch(
    request: GitHubLandingTransportRequest,
    signal?: AbortSignal,
  ): Promise<GitHubLandingTransportOutcome>;
}

export interface GitHubLandingMaterialV1 {
  readonly landing: unknown;
  readonly profile: unknown;
  readonly objectManifest: unknown;
  readonly text: unknown;
  readonly changedBlobs: readonly unknown[];
}

export interface GitHubLandingMaterialReaderV1 {
  read(landingId: string): Promise<GitHubLandingMaterialV1>;
}

export interface GitHubLandingAdmittedRequestClaimerV1 {
  /** Atomically claims one durably admitted row under its owning operation lease. */
  claimAdmitted(requestId: string): Promise<unknown>;
}

export interface GitHubLandingCredentialResolverV1 {
  resolve(reference: GitHubLandingProfileV1["credentialRef"]): Promise<string>;
}

export interface GitHubGatewaySettledExchangeV1 {
  readonly kind: "settled";
  readonly request: LandingHttpRequestV1;
  readonly requestSha256: string;
  readonly wireRequestSha256: string;
  readonly responseBodySha256: string | null;
  readonly result: LandingHttpResultV1;
  readonly resultSha256: string;
}

export type GitHubGatewayExchangeV1 = GitHubGatewaySettledExchangeV1;

export interface ExecuteGitHubLandingRequestV1 {
  readonly requestId: unknown;
}

interface DecodedChangedBlob {
  readonly path: string;
  readonly content: Uint8Array;
}

interface DecodedGitHubLandingMaterial {
  readonly landing: LandingDigestV1;
  readonly profile: GitHubLandingProfileV1;
  readonly objectManifest: CandidateObjectManifestV1;
  readonly text: {
    readonly commitMessage: string;
    readonly pullRequestTitle: string;
    readonly pullRequestBodyPrefix: string;
  };
  readonly changedBlobs: readonly DecodedChangedBlob[];
}

interface PreparedWireRequest {
  readonly request: LandingHttpRequestV1;
  readonly profile: GitHubLandingProfileV1;
  readonly landing: LandingDigestV1;
  readonly material: DecodedGitHubLandingMaterial;
  readonly transport: GitHubLandingTransportRequest;
  readonly requestSha256: string;
  readonly wireRequestSha256: string;
}

interface GitHubLandingOperationSession {
  readonly landingId: string;
  readonly operationId: string;
  readonly operationKind: LandingOperationKindV1;
  readonly coordinatorAttempt: number;
  readonly credential: string;
  actorVerified: boolean;
  baseVerifiedSha1: string | null;
}

function invalid(code: string, message: string): never {
  throw new IcarusError(code, message);
}

function asRecord(value: unknown, field: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("GITHUB_PROTOCOL_ERROR", `${field} must be an object`);
  }
  return value as JsonRecord;
}

function asString(value: unknown, field: string): string {
  return typeof value === "string"
    ? value
    : invalid("GITHUB_PROTOCOL_ERROR", `${field} must be text`);
}

function asBoolean(value: unknown, field: string): boolean {
  return typeof value === "boolean"
    ? value
    : invalid("GITHUB_PROTOCOL_ERROR", `${field} must be boolean`);
}

function asSafePositiveInteger(value: unknown, field: string): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : invalid("GITHUB_PROTOCOL_ERROR", `${field} must be a positive safe integer`);
}

function hasForbiddenAsciiControl(value: string, allowHorizontalTab = false): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x7f || (code < 0x20 && !(allowHorizontalTab && code === 0x09))) {
      return true;
    }
  }
  return false;
}

function canonicalIdentity(value: unknown, field: string): string {
  const decoded = asString(value, field);
  if (!GITHUB_IDENTITY_PATTERN.test(decoded) || decoded.includes("--")) {
    return invalid("GITHUB_PROTOCOL_ERROR", `${field} is not a GitHub owner identity`);
  }
  return decoded.toLowerCase();
}

function canonicalRepository(value: unknown, field: string): string {
  const decoded = asString(value, field);
  if (
    !GITHUB_REPOSITORY_PATTERN.test(decoded) ||
    decoded === "." ||
    decoded === ".." ||
    hasForbiddenAsciiControl(decoded)
  ) {
    return invalid("GITHUB_PROTOCOL_ERROR", `${field} is not a GitHub repository identity`);
  }
  return decoded.toLowerCase();
}

function exactKeys(value: JsonRecord, expected: readonly string[], field: string): void {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    !keys.every((key, index) => key === sortedExpected[index])
  ) {
    invalid("GITHUB_PROTOCOL_ERROR", `${field} does not have the exact expected members`);
  }
}

function refBranch(ref: string, field: string): string {
  if (!ref.startsWith("refs/heads/")) {
    return invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", `${field} is not a branch ref`);
  }
  return assertGitBranchName(ref.slice("refs/heads/".length), field);
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function refPath(owner: string, repository: string, ref: string): string {
  const branch = refBranch(ref, "ref");
  const suffix = ["heads", ...branch.split("/")].map(encodePathSegment).join("/");
  return `/repos/${encodePathSegment(owner)}/${encodePathSegment(repository)}/git/ref/${suffix}`;
}

function repositoryPath(owner: string, repository: string, suffix: string): string {
  return `/repos/${encodePathSegment(owner)}/${encodePathSegment(repository)}${suffix}`;
}

function decodeGatewayMaterial(
  value: unknown,
  expectedLandingId: string,
): DecodedGitHubLandingMaterial {
  try {
    const decoded = asRecord(value, "GitHub landing material");
    exactKeys(
      decoded,
      ["landing", "profile", "objectManifest", "text", "changedBlobs"],
      "GitHub landing material",
    );
    const landing = decodeLandingDigestV1(decoded.landing);
    const profile = decodeGitHubLandingProfileV1(decoded.profile);
    const objectManifest = decodeCandidateObjectManifestV1(decoded.objectManifest);
    if (
      landing.landingId !== expectedLandingId ||
      digestLandingRecord(profile) !== landing.profileSha256 ||
      digestLandingRecord(landing.profile) !== landing.profileSha256 ||
      digestLandingRecord(profile) !== digestLandingRecord(landing.profile) ||
      digestLandingRecord(objectManifest) !== landing.candidateObjectManifestSha256 ||
      objectManifest.baseCommitSha1 !== landing.baseCommitSha1 ||
      objectManifest.baseTreeSha1 !== landing.baseTreeSha1 ||
      objectManifest.candidateTreeSha1 !== landing.candidateTreeSha1 ||
      objectManifest.candidateCommitSha1 !== landing.candidateCommitSha1 ||
      objectManifest.candidateCommitPayloadSha256 !== landing.candidateCommitPayloadSha256 ||
      objectManifest.entries.length !== landing.changedPaths.length ||
      !objectManifest.entries.every((entry, index) => entry.path === landing.changedPaths[index])
    ) {
      invalid("GITHUB_GATEWAY_MATERIAL_INVALID", "Immutable landing material is unbound");
    }

    const textRecord = asRecord(decoded.text, "GitHub landing material.text");
    exactKeys(
      textRecord,
      ["commitMessage", "pullRequestTitle", "pullRequestBodyPrefix"],
      "GitHub landing material.text",
    );
    const text = assertLandingDigestTextBindingsV1(landing, {
      commitMessage: asString(
        textRecord.commitMessage,
        "GitHub landing material.text.commitMessage",
      ),
      pullRequestTitle: asString(
        textRecord.pullRequestTitle,
        "GitHub landing material.text.pullRequestTitle",
      ),
      pullRequestBodyPrefix: asString(
        textRecord.pullRequestBodyPrefix,
        "GitHub landing material.text.pullRequestBodyPrefix",
      ),
    });

    if (!Array.isArray(decoded.changedBlobs)) {
      invalid("GITHUB_GATEWAY_MATERIAL_INVALID", "Immutable changed blobs must be an array");
    }
    const expectedBlobEntries = objectManifest.entries.filter((entry) => entry.op !== "delete");
    if (decoded.changedBlobs.length !== expectedBlobEntries.length) {
      invalid("GITHUB_GATEWAY_MATERIAL_INVALID", "Immutable changed blob count differs");
    }
    const changedBlobs = decoded.changedBlobs.map((value, index): DecodedChangedBlob => {
      const blob = asRecord(value, `GitHub landing material.changedBlobs[${index}]`);
      exactKeys(blob, ["path", "content"], `GitHub landing material.changedBlobs[${index}]`);
      const expected = expectedBlobEntries[index];
      const path = asString(blob.path, `GitHub landing material.changedBlobs[${index}].path`);
      if (
        expected === undefined ||
        path !== expected.path ||
        !(blob.content instanceof Uint8Array)
      ) {
        invalid("GITHUB_GATEWAY_MATERIAL_INVALID", "Immutable changed blob identity differs");
      }
      const content = new Uint8Array(blob.content);
      if (
        content.byteLength !== expected.contentBytes ||
        sha256(content) !== expected.contentSha256 ||
        gitObjectSha1("blob", content) !== expected.blobSha1
      ) {
        invalid("GITHUB_GATEWAY_MATERIAL_INVALID", "Immutable changed blob bytes differ");
      }
      return { path, content };
    });

    const commitPayload = buildUnsignedCommitPayloadV1({
      candidateTreeSha1: landing.candidateTreeSha1,
      baseCommitSha1: landing.baseCommitSha1,
      commitIdentity: landing.commitAuthor,
      commitEpochSeconds: landing.commitEpochSeconds,
      commitMessage: text.commitMessage,
    });
    if (
      sha256(commitPayload) !== landing.candidateCommitPayloadSha256 ||
      gitObjectSha1("commit", commitPayload) !== landing.candidateCommitSha1
    ) {
      invalid("GITHUB_GATEWAY_MATERIAL_INVALID", "Immutable commit material differs");
    }

    return { landing, profile, objectManifest, text, changedBlobs };
  } catch (error) {
    if (error instanceof IcarusError && error.code === "GITHUB_GATEWAY_MATERIAL_INVALID") {
      throw error;
    }
    return invalid(
      "GITHUB_GATEWAY_MATERIAL_INVALID",
      "Immutable GitHub landing material failed closed validation",
    );
  }
}

function assertProfileRequestBinding(
  request: LandingHttpRequestV1,
  profile: GitHubLandingProfileV1,
  landing: LandingDigestV1,
): void {
  if (digestLandingRecord(profile) !== request.profileSha256) {
    invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Admitted request does not bind the profile");
  }
  if (
    request.landingId !== landing.landingId ||
    landing.profileSha256 !== request.profileSha256 ||
    digestLandingRecord(landing.profile) !== request.profileSha256 ||
    digestLandingRecord(landing.profile) !== digestLandingRecord(profile)
  ) {
    invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Admitted request changed landing authority");
  }
  const subject = request.subject;
  for (const field of ["owner", "headOwner"] as const) {
    if (field in subject && subject[field] !== profile.owner) {
      invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", `Admitted request ${field} changed`);
    }
  }
  if ("repository" in subject && subject.repository !== profile.repository) {
    invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Admitted request repository changed");
  }
  if (request.kind === "github.actor.get" && subject.expectedActor !== profile.expectedActor) {
    invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Admitted actor request changed");
  }
  if (
    request.kind === "github.pull_requests.get" &&
    (subject.baseBranch !== profile.baseBranch ||
      subject.headRef !== refBranch(landing.headRef, "landing.headRef"))
  ) {
    invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Admitted pull-request filter changed");
  }
  if (
    request.kind === "github.base_ref.get" &&
    (subject.baseRef !== landing.baseRef || subject.expectedSha1 !== landing.baseCommitSha1)
  ) {
    invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Admitted base-ref request changed");
  }
  if (
    request.kind === "github.head_ref.get" &&
    (subject.headRef !== landing.headRef || subject.expectedSha1 !== landing.candidateCommitSha1)
  ) {
    invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Admitted head-ref request changed");
  }
}

function assertPostBodyBinding(
  request: LandingHttpRequestV1,
  material: DecodedGitHubLandingMaterial,
): { readonly body: GitHubPostBodyV1; readonly encoded: string } {
  if (request.method !== "POST" || request.bodySha256 === null) {
    invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "GET request cannot carry a body");
  }
  if (!POST_KINDS.has(request.kind)) {
    invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "POST request kind is invalid");
  }
  const { landing, objectManifest, profile, text } = material;
  const subject = request.subject;
  let bodyInput: GitHubPostBodyV1;
  switch (request.kind) {
    case "github.blob.post": {
      const matches = material.changedBlobs.filter(
        (entry) => sha256(entry.path) === subject.pathSha256,
      );
      const blob = matches[0];
      if (matches.length !== 1 || blob === undefined) {
        invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Blob request is not in the immutable manifest");
      }
      bodyInput = {
        content: Buffer.from(blob.content).toString("base64"),
        encoding: "base64",
      };
      break;
    }
    case "github.tree.post":
      bodyInput = {
        base_tree: landing.baseTreeSha1,
        tree: objectManifest.entries.map((entry) => ({
          path: entry.path,
          mode: entry.mode,
          type: "blob" as const,
          sha: entry.blobSha1,
        })),
      };
      break;
    case "github.commit.post":
      bodyInput = {
        message: text.commitMessage,
        tree: landing.candidateTreeSha1,
        parents: [landing.baseCommitSha1],
        author: { ...landing.commitAuthor, date: landing.commitIso8601 },
        committer: { ...landing.commitCommitter, date: landing.commitIso8601 },
      };
      break;
    case "github.ref.post":
      bodyInput = { ref: landing.headRef, sha: landing.candidateCommitSha1 };
      break;
    case "github.pull_request.post":
      bodyInput = {
        title: text.pullRequestTitle,
        head: `${profile.owner}:${refBranch(landing.headRef, "landing.headRef")}`,
        base: profile.baseBranch,
        body: renderPullRequestBodyV1({
          landing,
          landingSha256: digestLandingRecord(landing),
          bodyPrefix: text.pullRequestBodyPrefix,
        }),
        draft: true,
        maintainer_can_modify: false,
      };
      break;
    default:
      return invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "GET request cannot carry a body");
  }
  const canonical = canonicalGitHubPostBodyV1(
    request.kind as
      | "github.blob.post"
      | "github.tree.post"
      | "github.commit.post"
      | "github.ref.post"
      | "github.pull_request.post",
    bodyInput,
  );
  if (canonical.sha256 !== request.bodySha256) {
    invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "POST body digest changed after admission");
  }
  switch (request.kind) {
    case "github.blob.post": {
      const body = canonical.value as { readonly content: string; readonly encoding: "base64" };
      const bytes = Buffer.from(body.content, "base64");
      if (
        bytes.length !== subject.contentBytes ||
        sha256(bytes) !== subject.contentSha256 ||
        gitObjectSha1("blob", bytes) !== subject.expectedBlobSha1
      ) {
        invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Blob body changed after admission");
      }
      break;
    }
    case "github.tree.post": {
      const body = canonical.value as {
        readonly base_tree: string;
        readonly tree: readonly unknown[];
      };
      if (
        body.base_tree !== subject.baseTreeSha1 ||
        digestLandingRecord(body.tree) !== subject.entriesSha256 ||
        subject.expectedTreeSha1 !== landing.candidateTreeSha1
      ) {
        invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Tree body changed after admission");
      }
      break;
    }
    case "github.commit.post": {
      const body = canonical.value as {
        readonly tree: string;
        readonly parents: readonly [string];
        readonly author: { readonly date: string };
      };
      if (
        body.tree !== subject.candidateTreeSha1 ||
        body.parents[0] !== subject.baseCommitSha1 ||
        body.author.date !== subject.commitIso8601 ||
        subject.candidateCommitPayloadSha256 !== landing.candidateCommitPayloadSha256 ||
        subject.expectedCommitSha1 !== landing.candidateCommitSha1
      ) {
        invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Commit body changed after admission");
      }
      break;
    }
    case "github.ref.post": {
      const body = canonical.value as { readonly ref: string; readonly sha: string };
      if (
        body.ref !== subject.headRef ||
        body.sha !== subject.candidateCommitSha1 ||
        subject.baseRef !== landing.baseRef ||
        subject.expectedRemoteBaseSha1 !== landing.expectedRemoteBaseSha1
      ) {
        invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Reference body changed after admission");
      }
      break;
    }
    case "github.pull_request.post": {
      const body = canonical.value as {
        readonly title: string;
        readonly head: string;
        readonly base: string;
        readonly body: string;
        readonly draft: true;
        readonly maintainer_can_modify: false;
      };
      const expectedHead = `${profile.owner}:${refBranch(String(subject.headRef), "headRef")}`;
      if (
        sha256(body.title) !== subject.pullRequestTitleSha256 ||
        sha256(body.body) !== subject.pullRequestBodySha256 ||
        body.head !== expectedHead ||
        body.base !== profile.baseBranch ||
        body.draft !== subject.draft ||
        body.maintainer_can_modify !== subject.maintainerCanModify ||
        subject.baseRef !== landing.baseRef ||
        subject.expectedRemoteBaseSha1 !== landing.expectedRemoteBaseSha1 ||
        subject.candidateCommitSha1 !== landing.candidateCommitSha1
      ) {
        invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Pull-request body changed after admission");
      }
      break;
    }
  }
  return { body: canonical.value, encoded: canonical.body };
}

function wireRoute(
  request: LandingHttpRequestV1,
  profile: GitHubLandingProfileV1,
): { readonly path: string; readonly query: string } {
  const subject = request.subject;
  switch (request.kind) {
    case "github.actor.get":
      return { path: "/user", query: "" };
    case "github.base_ref.get":
      return {
        path: refPath(profile.owner, profile.repository, String(subject.baseRef)),
        query: "",
      };
    case "github.head_ref.get":
      return {
        path: refPath(profile.owner, profile.repository, String(subject.headRef)),
        query: "",
      };
    case "github.pull_requests.get": {
      const query = new URLSearchParams();
      query.set("state", "all");
      query.set("head", `${profile.owner}:${String(subject.headRef)}`);
      query.set("base", profile.baseBranch);
      query.set("page", "1");
      query.set("per_page", "100");
      return {
        path: repositoryPath(profile.owner, profile.repository, "/pulls"),
        query: query.toString(),
      };
    }
    case "github.blob.post":
      return {
        path: repositoryPath(profile.owner, profile.repository, "/git/blobs"),
        query: "",
      };
    case "github.tree.post":
      return {
        path: repositoryPath(profile.owner, profile.repository, "/git/trees"),
        query: "",
      };
    case "github.commit.post":
      return {
        path: repositoryPath(profile.owner, profile.repository, "/git/commits"),
        query: "",
      };
    case "github.ref.post":
      return {
        path: repositoryPath(profile.owner, profile.repository, "/git/refs"),
        query: "",
      };
    case "github.pull_request.post":
      return {
        path: repositoryPath(profile.owner, profile.repository, "/pulls"),
        query: "",
      };
  }
}

function assertCredential(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 512 ||
    /\s/u.test(value) ||
    hasForbiddenAsciiControl(value)
  ) {
    invalid("GITHUB_CREDENTIAL_INVALID", "GitHub credential has an invalid shape");
  }
  return value;
}

function decodeGatewayRequestId(input: ExecuteGitHubLandingRequestV1): string {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !("requestId" in input)
  ) {
    invalid(
      "GITHUB_GATEWAY_ARGUMENT_INVALID",
      "Gateway input must contain only an admitted request ID",
    );
  }
  try {
    return assertUuid(input.requestId, "requestId");
  } catch {
    return invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Gateway request ID is invalid");
  }
}

async function prepareWireRequest(
  requestId: string,
  requestClaimer: GitHubLandingAdmittedRequestClaimerV1,
  materialReader: GitHubLandingMaterialReaderV1,
  credentialFor: (
    request: LandingHttpRequestV1,
    profile: GitHubLandingProfileV1,
  ) => Promise<string>,
): Promise<PreparedWireRequest> {
  let rawRequest: unknown;
  try {
    rawRequest = await requestClaimer.claimAdmitted(requestId);
  } catch {
    return invalid("GITHUB_ADMITTED_REQUEST_UNAVAILABLE", "Admitted GitHub request is unavailable");
  }
  const admission = asRecord(rawRequest, "admitted GitHub request");
  exactKeys(admission, ["request", "landingSha256"], "admitted GitHub request");
  const request = decodeLandingHttpRequestV1(admission.request);
  const admittedLandingSha256 = assertSha256(
    admission.landingSha256,
    "admitted GitHub request.landingSha256",
  );
  if (request.requestId !== requestId) {
    invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "Admitted GitHub request identity changed");
  }
  let rawMaterial: GitHubLandingMaterialV1;
  try {
    rawMaterial = await materialReader.read(request.landingId);
  } catch {
    return invalid(
      "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE",
      "Immutable GitHub landing material is unavailable",
    );
  }
  const material = decodeGatewayMaterial(rawMaterial, request.landingId);
  const { landing, profile } = material;
  if (digestLandingRecord(landing) !== admittedLandingSha256) {
    invalid("GITHUB_GATEWAY_MATERIAL_INVALID", "Immutable landing authority digest changed");
  }
  assertProfileRequestBinding(request, profile, landing);
  let encodedBody: string | null = null;
  if (request.method === "POST") {
    encodedBody = assertPostBodyBinding(request, material).encoded;
  }
  let resolvedCredential: string;
  try {
    resolvedCredential = await credentialFor(request, profile);
  } catch (error) {
    if (error instanceof IcarusError) throw error;
    return invalid("GITHUB_CREDENTIAL_UNAVAILABLE", "GitHub credential resolution failed");
  }
  const credential = assertCredential(resolvedCredential);
  const route = wireRoute(request, profile);
  const transport: GitHubLandingTransportRequest = {
    origin: GITHUB_API_ORIGIN,
    method: request.method,
    path: route.path,
    query: route.query,
    headers: {
      accept: GITHUB_JSON_ACCEPT,
      authorization: `Bearer ${credential}`,
      contentType: request.method === "POST" ? "application/json" : null,
      userAgent: GITHUB_LANDING_USER_AGENT,
      xGitHubApiVersion: GITHUB_API_VERSION,
    },
    body: encodedBody === null ? null : Buffer.from(encodedBody, "utf8"),
    timeoutMs: GITHUB_LANDING_REQUEST_TIMEOUT_MS,
    responseMaxBytes: GITHUB_LANDING_RESPONSE_MAX_BYTES,
    redirect: "error",
  };
  const wireRequestSha256 = digestLandingRecord({
    schemaVersion: 1,
    origin: transport.origin,
    method: transport.method,
    path: transport.path,
    query: transport.query,
    headers: {
      accept: transport.headers.accept,
      authorization: "present",
      contentType: transport.headers.contentType,
      userAgent: transport.headers.userAgent,
      xGitHubApiVersion: transport.headers.xGitHubApiVersion,
    },
    bodySha256: transport.body === null ? null : sha256(transport.body),
    timeoutMs: transport.timeoutMs,
    responseMaxBytes: transport.responseMaxBytes,
    redirect: transport.redirect,
  });
  return {
    request,
    profile,
    landing,
    material,
    transport,
    requestSha256: digestLandingRecord(request),
    wireRequestSha256,
  };
}

function normalizedResponseHeaders(
  entries: readonly (readonly [name: string, value: string])[],
): ReadonlyMap<string, string> {
  if (!Array.isArray(entries) || entries.length > 64) {
    invalid("GITHUB_PROTOCOL_ERROR", "GitHub response has too many headers");
  }
  const headers = new Map<string, string>();
  let bytes = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      invalid("GITHUB_PROTOCOL_ERROR", "GitHub response header is malformed");
    }
    const [rawName, rawValue] = entry;
    if (
      typeof rawName !== "string" ||
      typeof rawValue !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName) ||
      hasForbiddenAsciiControl(rawValue, true)
    ) {
      invalid("GITHUB_PROTOCOL_ERROR", "GitHub response header is malformed");
    }
    bytes += Buffer.byteLength(rawName, "utf8") + Buffer.byteLength(rawValue, "utf8");
    if (bytes > 32 * 1024) {
      invalid("GITHUB_PROTOCOL_ERROR", "GitHub response headers exceed the byte ceiling");
    }
    const name = rawName.toLowerCase();
    if (name !== "content-type" && name !== "content-length" && name !== "link") {
      continue;
    }
    if (headers.has(name)) {
      invalid("GITHUB_PROTOCOL_ERROR", "GitHub response contains a duplicate consumed header");
    }
    headers.set(name, rawValue.trim());
  }
  return headers;
}

function decodeResponseBody(response: GitHubLandingTransportResponse): {
  readonly value: unknown;
  readonly bodySha256: string;
  readonly headers: ReadonlyMap<string, string>;
} {
  if (
    !Number.isSafeInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    !(response.body instanceof Uint8Array)
  ) {
    invalid("GITHUB_PROTOCOL_ERROR", "GitHub transport response is malformed");
  }
  if (response.body.byteLength > GITHUB_LANDING_RESPONSE_MAX_BYTES) {
    invalid("GITHUB_RESPONSE_TOO_LARGE", "GitHub response exceeds the byte ceiling");
  }
  const headers = normalizedResponseHeaders(response.headers);
  const declaredLength = headers.get("content-length");
  if (declaredLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      invalid("GITHUB_PROTOCOL_ERROR", "GitHub content-length is malformed");
    }
    const parsed = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed !== response.body.byteLength ||
      parsed > GITHUB_LANDING_RESPONSE_MAX_BYTES
    ) {
      invalid("GITHUB_PROTOCOL_ERROR", "GitHub content-length does not match the body");
    }
  }
  const contentType = headers.get("content-type");
  if (
    contentType === undefined ||
    !/^application\/(?:vnd\.github\+json|json)(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    invalid("GITHUB_PROTOCOL_ERROR", "GitHub response is not bounded JSON");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
  } catch {
    return invalid("GITHUB_PROTOCOL_ERROR", "GitHub response is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = parseStrictJson(source, 32);
  } catch {
    return invalid("GITHUB_PROTOCOL_ERROR", "GitHub response is not strict JSON");
  }
  return { value, bodySha256: sha256(response.body), headers };
}

function refProjection(value: unknown, expectedRef: string): LandingHttpProjectionV1 {
  const object = asRecord(value, "GitHub ref response");
  const ref = asString(object.ref, "GitHub ref response.ref");
  const target = asRecord(object.object, "GitHub ref response.object");
  if (
    ref !== expectedRef ||
    asString(target.type, "GitHub ref response.object.type") !== "commit"
  ) {
    invalid("GITHUB_IDENTITY_MISMATCH", "GitHub ref response changed identity");
  }
  return {
    type: "ref",
    state: "direct",
    ref,
    sha1: assertSha1(target.sha, "GitHub ref response.object.sha"),
  };
}

function actorProjection(value: unknown): LandingHttpProjectionV1 {
  const object = asRecord(value, "GitHub actor response");
  return {
    type: "actor",
    login: canonicalIdentity(object.login, "GitHub actor response.login"),
  };
}

function objectProjection(
  value: unknown,
  objectKind: "blob" | "tree" | "commit",
): LandingHttpProjectionV1 {
  const object = asRecord(value, "GitHub object response");
  return {
    type: "object",
    objectKind,
    sha1: assertSha1(object.sha, "GitHub object response.sha"),
  };
}

function pullRequestProjection(
  value: unknown,
  material: DecodedGitHubLandingMaterial,
  expectedHeadRef: string,
  expectedHeadSha1: string,
  expectedBaseSha1: string,
): LandingHttpProjectionV1 {
  const { landing, profile, text } = material;
  const object = asRecord(value, "GitHub pull request");
  const head = asRecord(object.head, "GitHub pull request.head");
  const base = asRecord(object.base, "GitHub pull request.base");
  const headRepository = asRecord(head.repo, "GitHub pull request.head.repo");
  const baseRepository = asRecord(base.repo, "GitHub pull request.base.repo");
  const headOwner = asRecord(headRepository.owner, "GitHub pull request.head.repo.owner");
  const baseOwner = asRecord(baseRepository.owner, "GitHub pull request.base.repo.owner");
  const owner = canonicalIdentity(baseOwner.login, "GitHub pull request.base.repo.owner.login");
  const repository = canonicalRepository(baseRepository.name, "GitHub pull request.base.repo.name");
  const canonicalHeadOwner = canonicalIdentity(
    headOwner.login,
    "GitHub pull request.head.repo.owner.login",
  );
  const canonicalHeadRepository = canonicalRepository(
    headRepository.name,
    "GitHub pull request.head.repo.name",
  );
  const headRef = assertGitBranchName(head.ref, "GitHub pull request.head.ref");
  const baseRef = assertGitBranchName(base.ref, "GitHub pull request.base.ref");
  const headSha1 = assertSha1(head.sha, "GitHub pull request.head.sha");
  const baseSha1 = assertSha1(base.sha, "GitHub pull request.base.sha");
  const expectedBranch = refBranch(expectedHeadRef, "expectedHeadRef");
  if (
    owner !== profile.owner ||
    repository !== profile.repository ||
    canonicalHeadOwner !== profile.owner ||
    canonicalHeadRepository !== profile.repository ||
    headRef !== expectedBranch ||
    baseRef !== profile.baseBranch ||
    headSha1 !== expectedHeadSha1 ||
    baseSha1 !== expectedBaseSha1
  ) {
    invalid("GITHUB_IDENTITY_MISMATCH", "GitHub pull request changed repository or ref identity");
  }
  const state = asString(object.state, "GitHub pull request.state");
  const draft = asBoolean(object.draft, "GitHub pull request.draft");
  const maintainerCanModify = asBoolean(
    object.maintainer_can_modify,
    "GitHub pull request.maintainer_can_modify",
  );
  if (state !== "open" || !draft || maintainerCanModify) {
    invalid("GITHUB_PULL_REQUEST_DRIFT", "GitHub pull request is not the required immutable draft");
  }
  const title = asString(object.title, "GitHub pull request.title");
  const body = asString(object.body, "GitHub pull request.body");
  const marker = `<!-- icarus-landing:v1:${landing.landingId}:${digestLandingRecord(landing)} -->`;
  const markerCount = body.split(marker).length - 1;
  const expectedBody = renderPullRequestBodyV1({
    landing,
    landingSha256: digestLandingRecord(landing),
    bodyPrefix: text.pullRequestBodyPrefix,
  });
  if (
    markerCount !== 1 ||
    sha256(title) !== landing.pullRequestTitleSha256 ||
    sha256(body) !== sha256(expectedBody)
  ) {
    invalid("GITHUB_PULL_REQUEST_DRIFT", "GitHub pull request text or marker changed");
  }
  return {
    type: "pull_request",
    number: asSafePositiveInteger(object.number, "GitHub pull request.number"),
    state: "open",
    draft: true,
    owner,
    repository,
    headOwner: canonicalHeadOwner,
    headRef,
    headSha1,
    baseRef,
    baseSha1,
    titleSha256: sha256(title),
    bodySha256: sha256(body),
    markerCount: 1,
    maintainerCanModify: false,
  };
}

function hasNextPage(link: string | undefined): boolean {
  if (link === undefined || link === "") return false;
  const parts = link.split(",");
  let next = false;
  for (const part of parts) {
    const match = /^\s*<https:\/\/api\.github\.com\/[^>]+>\s*;\s*rel="([a-z]+)"\s*$/.exec(part);
    if (match === null) {
      invalid("GITHUB_PROTOCOL_ERROR", "GitHub pagination header is malformed");
    }
    if (match[1] === "next") next = true;
  }
  return next;
}

function pullRequestListProjection(
  value: unknown,
  headers: ReadonlyMap<string, string>,
  request: LandingHttpRequestV1,
  material: DecodedGitHubLandingMaterial,
): LandingHttpProjectionV1 {
  if (!Array.isArray(value)) {
    invalid("GITHUB_PROTOCOL_ERROR", "GitHub pull request list must be an array");
  }
  const expectedHeadRef = `refs/heads/${String(request.subject.headRef)}`;
  const expectedHeadSha1 = material.landing.candidateCommitSha1;
  const expectedBaseSha1 = material.landing.expectedRemoteBaseSha1;
  const objects = value
    .map((entry) =>
      pullRequestProjection(entry, material, expectedHeadRef, expectedHeadSha1, expectedBaseSha1),
    )
    .map((entry) => {
      if (entry.type !== "pull_request") {
        return invalid("GITHUB_PROTOCOL_ERROR", "GitHub pull request projection is invalid");
      }
      return entry;
    })
    .sort((left, right) => left.number - right.number);
  for (let index = 1; index < objects.length; index += 1) {
    if (objects[index - 1]?.number === objects[index]?.number) {
      invalid("GITHUB_PROTOCOL_ERROR", "GitHub pull request list contains a duplicate number");
    }
  }
  return {
    type: "pull_request_list",
    complete: objects.length < 100 && !hasNextPage(headers.get("link")),
    count: objects.length,
    objects,
  };
}

function expectedRef(request: LandingHttpRequestV1): string {
  return request.kind === "github.base_ref.get"
    ? String(request.subject.baseRef)
    : String(request.subject.headRef);
}

function projectSuccess(
  prepared: PreparedWireRequest,
  value: unknown,
  headers: ReadonlyMap<string, string>,
): LandingHttpProjectionV1 {
  const request = prepared.request;
  const subject = request.subject;
  switch (request.kind) {
    case "github.actor.get": {
      const projection = actorProjection(value);
      if (projection.type !== "actor" || projection.login !== prepared.profile.expectedActor) {
        invalid("GITHUB_ACTOR_MISMATCH", "GitHub credential actor does not match the profile");
      }
      return projection;
    }
    case "github.base_ref.get":
    case "github.head_ref.get": {
      const projection = refProjection(value, expectedRef(request));
      if (
        projection.type !== "ref" ||
        projection.state !== "direct" ||
        projection.sha1 !== subject.expectedSha1
      ) {
        invalid("GITHUB_REF_MISMATCH", "GitHub ref does not match the admitted identity");
      }
      return projection;
    }
    case "github.pull_requests.get":
      return pullRequestListProjection(value, headers, request, prepared.material);
    case "github.blob.post": {
      const projection = objectProjection(value, "blob");
      if (projection.type !== "object" || projection.sha1 !== subject.expectedBlobSha1) {
        invalid("GITHUB_OBJECT_MISMATCH", "GitHub blob identity does not match local Git");
      }
      return projection;
    }
    case "github.tree.post": {
      const projection = objectProjection(value, "tree");
      if (projection.type !== "object" || projection.sha1 !== subject.expectedTreeSha1) {
        invalid("GITHUB_OBJECT_MISMATCH", "GitHub tree identity does not match local Git");
      }
      return projection;
    }
    case "github.commit.post": {
      const projection = objectProjection(value, "commit");
      if (projection.type !== "object" || projection.sha1 !== subject.expectedCommitSha1) {
        invalid("GITHUB_OBJECT_MISMATCH", "GitHub commit identity does not match local Git");
      }
      return projection;
    }
    case "github.ref.post": {
      const ref = refProjection(value, String(subject.headRef));
      if (
        ref.type !== "ref" ||
        ref.state !== "direct" ||
        ref.sha1 !== subject.candidateCommitSha1
      ) {
        invalid("GITHUB_REF_MISMATCH", "GitHub created ref points at another commit");
      }
      return {
        type: "object",
        objectKind: "ref",
        sha1: assertSha1(ref.sha1, "GitHub ref create response.object.sha"),
      };
    }
    case "github.pull_request.post": {
      const projection = pullRequestProjection(
        value,
        prepared.material,
        String(subject.headRef),
        String(subject.candidateCommitSha1),
        String(subject.expectedRemoteBaseSha1),
      );
      if (
        projection.type !== "pull_request" ||
        projection.titleSha256 !== subject.pullRequestTitleSha256 ||
        projection.bodySha256 !== subject.pullRequestBodySha256
      ) {
        invalid("GITHUB_PULL_REQUEST_DRIFT", "GitHub pull request text changed");
      }
      return projection;
    }
  }
}

function expectedSuccessStatus(kind: LandingHttpRequestV1["kind"]): number {
  return kind.endsWith(".get") ? 200 : 201;
}

function errorCodeForStatus(kind: LandingHttpRequestV1["kind"], status: number): string {
  if (status === 401) return "GITHUB_AUTHENTICATION_FAILED";
  if (status === 403) return "GITHUB_PERMISSION_DENIED";
  if (status === 429) return "GITHUB_RATE_LIMITED";
  if (status === 404) return "GITHUB_NOT_FOUND_OR_PERMISSION_DENIED";
  if ((status === 409 || status === 422) && kind === "github.ref.post") {
    return "GITHUB_REF_CONFLICT";
  }
  if ((status === 409 || status === 422) && kind === "github.pull_request.post") {
    return "GITHUB_PULL_REQUEST_CONFLICT";
  }
  if (status >= 500) return "GITHUB_UPSTREAM_UNAVAILABLE";
  return "GITHUB_HTTP_ERROR";
}

function result(
  request: LandingHttpRequestV1,
  input: Omit<LandingHttpResultV1, "schemaVersion" | "requestId" | "kind">,
): LandingHttpResultV1 {
  return decodeLandingHttpResultV1({
    schemaVersion: 1,
    requestId: request.requestId,
    kind: request.kind,
    ...input,
  });
}

function responseFailureResult(
  request: LandingHttpRequestV1,
  httpStatus: number | null,
  errorCode: string,
): LandingHttpResultV1 {
  const mutationOutcomeIsAmbiguous =
    request.method === "POST" &&
    (httpStatus === null || (httpStatus >= 200 && httpStatus < 300) || httpStatus >= 500);
  return result(request, {
    outcome: mutationOutcomeIsAmbiguous ? "ambiguous" : "failed",
    httpStatus: mutationOutcomeIsAmbiguous ? null : httpStatus,
    projection: null,
    errorCode: mutationOutcomeIsAmbiguous ? "GITHUB_OUTCOME_AMBIGUOUS" : errorCode,
  });
}

function settledExchange(
  prepared: PreparedWireRequest,
  responseBodySha256: string | null,
  settled: LandingHttpResultV1,
): GitHubGatewaySettledExchangeV1 {
  return {
    kind: "settled",
    request: prepared.request,
    requestSha256: prepared.requestSha256,
    wireRequestSha256: prepared.wireRequestSha256,
    responseBodySha256,
    result: settled,
    resultSha256: digestLandingRecord(settled),
  };
}

function transportFailureResult(
  request: LandingHttpRequestV1,
  failure: GitHubLandingTransportFailure,
): LandingHttpResultV1 {
  const errorCode =
    failure.reason === "cancelled"
      ? "GITHUB_REQUEST_CANCELLED"
      : failure.reason === "timeout"
        ? "GITHUB_REQUEST_TIMEOUT"
        : "GITHUB_TRANSPORT_ERROR";
  return result(request, {
    outcome: failure.phase === "after_dispatch" ? "ambiguous" : "failed",
    httpStatus: null,
    projection: null,
    errorCode: failure.phase === "after_dispatch" ? "GITHUB_OUTCOME_AMBIGUOUS" : errorCode,
  });
}

function isExactHeadRefNotFoundBody(value: unknown): boolean {
  const object = asRecord(value, "GitHub not-found response");
  exactKeys(object, ["message", "documentation_url", "status"], "GitHub not-found response");
  const documentation = asString(
    object.documentation_url,
    "GitHub not-found response.documentation_url",
  );
  return (
    object.message === "Not Found" &&
    documentation === HEAD_REF_NOT_FOUND_DOCUMENTATION_URL &&
    object.status === "404"
  );
}

export class GitHubLandingGatewayV1 {
  readonly #transport: GitHubLandingTransport;
  readonly #requestClaimer: GitHubLandingAdmittedRequestClaimerV1;
  readonly #materialReader: GitHubLandingMaterialReaderV1;
  readonly #credentialResolver: GitHubLandingCredentialResolverV1;
  #operationSession: GitHubLandingOperationSession | null = null;
  #closed = false;
  readonly #claimedRequestIds = new Set<string>();

  constructor(dependencies: {
    readonly transport: GitHubLandingTransport;
    readonly requestClaimer: GitHubLandingAdmittedRequestClaimerV1;
    readonly materialReader: GitHubLandingMaterialReaderV1;
    readonly credentialResolver: GitHubLandingCredentialResolverV1;
  }) {
    if (
      typeof dependencies !== "object" ||
      dependencies === null ||
      typeof dependencies.transport?.dispatch !== "function" ||
      typeof dependencies.requestClaimer?.claimAdmitted !== "function" ||
      typeof dependencies.materialReader?.read !== "function" ||
      typeof dependencies.credentialResolver?.resolve !== "function"
    ) {
      invalid("GITHUB_GATEWAY_ARGUMENT_INVALID", "GitHub gateway dependencies are invalid");
    }
    this.#transport = dependencies.transport;
    this.#requestClaimer = dependencies.requestClaimer;
    this.#materialReader = dependencies.materialReader;
    this.#credentialResolver = dependencies.credentialResolver;
  }

  async #credentialFor(
    request: LandingHttpRequestV1,
    profile: GitHubLandingProfileV1,
  ): Promise<string> {
    const session = this.#operationSession;
    if (session === null) {
      if (request.kind !== "github.actor.get") {
        return invalid(
          "GITHUB_ACTOR_PROOF_REQUIRED",
          "The operation-scoped credential must be verified by its admitted actor request first",
        );
      }
      let credential: string;
      try {
        credential = assertCredential(
          await this.#credentialResolver.resolve(profile.credentialRef),
        );
      } catch (error) {
        if (error instanceof IcarusError) throw error;
        return invalid("GITHUB_CREDENTIAL_UNAVAILABLE", "GitHub credential resolution failed");
      }
      this.#operationSession = {
        landingId: request.landingId,
        operationId: request.operationId,
        operationKind: request.operationKind,
        coordinatorAttempt: request.coordinatorAttempt,
        credential,
        actorVerified: false,
        baseVerifiedSha1: null,
      };
      return credential;
    }
    if (
      session.landingId !== request.landingId ||
      session.operationId !== request.operationId ||
      session.operationKind !== request.operationKind ||
      session.coordinatorAttempt !== request.coordinatorAttempt
    ) {
      return invalid(
        "GITHUB_OPERATION_SESSION_MISMATCH",
        "A gateway instance cannot cross an admitted landing operation boundary",
      );
    }
    if (!session.actorVerified && request.kind !== "github.actor.get") {
      return invalid(
        "GITHUB_ACTOR_PROOF_REQUIRED",
        "The pinned operation credential has no successful actor proof",
      );
    }
    if (request.kind === "github.head_ref.get" && session.baseVerifiedSha1 === null) {
      return invalid(
        "GITHUB_BASE_PROOF_REQUIRED",
        "Head-ref visibility requires a same-operation exact base proof",
      );
    }
    return session.credential;
  }

  #recordSuccessfulProof(request: LandingHttpRequestV1, projection: LandingHttpProjectionV1): void {
    const session = this.#operationSession;
    if (session === null || session.operationId !== request.operationId) {
      invalid("GITHUB_OPERATION_SESSION_MISMATCH", "GitHub operation session disappeared");
    }
    if (request.kind === "github.actor.get" && projection.type === "actor") {
      session.actorVerified = true;
    }
    if (
      request.kind === "github.base_ref.get" &&
      projection.type === "ref" &&
      projection.state === "direct"
    ) {
      session.baseVerifiedSha1 = projection.sha1;
    }
  }

  /** Drops the operation-scoped raw credential after coordinator settlement. */
  closeOperation(): void {
    this.#operationSession = null;
    this.#claimedRequestIds.clear();
    this.#closed = true;
  }

  async executeAdmitted(
    input: ExecuteGitHubLandingRequestV1,
    signal?: AbortSignal,
  ): Promise<GitHubGatewayExchangeV1> {
    if (this.#closed) {
      invalid("GITHUB_OPERATION_SESSION_CLOSED", "GitHub operation gateway is closed");
    }
    const requestId = decodeGatewayRequestId(input);
    if (this.#claimedRequestIds.has(requestId)) {
      invalid(
        "GITHUB_REQUEST_ALREADY_CLAIMED",
        "GitHub request was already claimed by this gateway",
      );
    }
    this.#claimedRequestIds.add(requestId);
    const prepared = await prepareWireRequest(
      requestId,
      this.#requestClaimer,
      this.#materialReader,
      (request, profile) => this.#credentialFor(request, profile),
    );
    let outcome: GitHubLandingTransportOutcome;
    try {
      outcome = await this.#transport.dispatch(prepared.transport, signal);
    } catch {
      outcome = { kind: "failure", phase: "after_dispatch", reason: "transport" };
    }
    if (outcome.kind === "failure") {
      return settledExchange(prepared, null, transportFailureResult(prepared.request, outcome));
    }
    let decoded: ReturnType<typeof decodeResponseBody>;
    try {
      decoded = decodeResponseBody(outcome);
    } catch (error) {
      const errorCode = error instanceof IcarusError ? error.code : "GITHUB_PROTOCOL_ERROR";
      const bodySha256 =
        outcome.body instanceof Uint8Array &&
        outcome.body.byteLength <= GITHUB_LANDING_RESPONSE_MAX_BYTES
          ? sha256(outcome.body)
          : null;
      const httpStatus =
        Number.isSafeInteger(outcome.status) && outcome.status >= 100 && outcome.status <= 599
          ? outcome.status
          : null;
      return settledExchange(
        prepared,
        bodySha256,
        responseFailureResult(prepared.request, httpStatus, errorCode),
      );
    }
    if (
      prepared.request.kind === "github.head_ref.get" &&
      outcome.status === 404 &&
      (() => {
        try {
          return isExactHeadRefNotFoundBody(decoded.value);
        } catch {
          return false;
        }
      })()
    ) {
      return settledExchange(
        prepared,
        decoded.bodySha256,
        result(prepared.request, {
          outcome: "succeeded",
          httpStatus: 404,
          projection: {
            type: "ref",
            state: "absent",
            ref: String(prepared.request.subject.headRef),
            sha1: null,
          },
          errorCode: null,
        }),
      );
    }
    if (outcome.status !== expectedSuccessStatus(prepared.request.kind)) {
      return settledExchange(
        prepared,
        decoded.bodySha256,
        responseFailureResult(
          prepared.request,
          outcome.status,
          errorCodeForStatus(prepared.request.kind, outcome.status),
        ),
      );
    }
    let projection: LandingHttpProjectionV1;
    try {
      projection = projectSuccess(prepared, decoded.value, decoded.headers);
    } catch (error) {
      if (!(error instanceof IcarusError)) throw error;
      return settledExchange(
        prepared,
        decoded.bodySha256,
        responseFailureResult(prepared.request, outcome.status, error.code),
      );
    }
    this.#recordSuccessfulProof(prepared.request, projection);
    return settledExchange(
      prepared,
      decoded.bodySha256,
      result(prepared.request, {
        outcome: "succeeded",
        httpStatus: outcome.status,
        projection,
        errorCode: null,
      }),
    );
  }
}

/**
 * Packet 4 deliberately does not provide a production fetch transport yet.
 * The only executable seam in this slice is the injected deterministic
 * transport above; ambient credential resolution and live networking remain
 * absent.
 */
export function assertNoLiveGitHubTransport(): never {
  return invalid(
    "GITHUB_LIVE_TRANSPORT_UNAVAILABLE",
    "Packet 4 fake-transport slice has no live GitHub transport",
  );
}
