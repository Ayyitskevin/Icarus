import { sha256 } from "./digest.js";
import { IcarusError } from "./errors.js";
import {
  assertLandingDigestTextBindingsV1,
  assertSha256,
  buildUnsignedCommitPayloadV1,
  type CandidateObjectManifestV1,
  canonicalGitHubPostBodyV1,
  canonicalLandingJson,
  decodeCandidateObjectManifestV1,
  decodeGitHubLandingProfileV1,
  decodeLandingDigestV1,
  decodeLandingHttpRequestV1,
  decodeLandingHttpResultV1,
  decodeLandingOperationObservationV1,
  decodeLandingOperationRequestV1,
  decodeLandingOperationResultV1,
  digestLandingRecord,
  type GitHubObjectsUploadInputV1,
  type GitHubPostBodyV1,
  gitObjectSha1,
  type LandingDigestV1,
  type LandingHttpProjectionV1,
  type LandingOperationObservationV1,
  type LandingOperationRequestV1,
  type LandingOperationResultV1,
  type ObjectsExactValueV1,
  type PreflightExactValueV1,
} from "./landing-records.js";
import { MAX_CHANGED_FILES } from "./policy.js";

type JsonRecord = Record<string, unknown>;

// The admitted checkpoint/material seam applies this same hard controller
// ceiling after the project's (possibly lower) maxFileBytes policy.
const MAX_OBJECT_CONTENT_BYTES = 8 * 1024 * 1024;

type ObjectsHttpKindV1 =
  | "github.actor.get"
  | "github.blob.post"
  | "github.tree.post"
  | "github.commit.post";

export interface GitHubObjectsHistoryExchangeV1 {
  readonly request: unknown;
  readonly requestSha256: unknown;
  readonly result: unknown;
  readonly resultSha256: unknown;
}

export interface GitHubObjectsUploadHistoryInputV1 {
  readonly material: unknown;
  readonly landingSha256: unknown;
  readonly preflightOperation: unknown;
  readonly preflightOperationRequestSha256: unknown;
  readonly preflightResult: unknown;
  readonly preflightResultSha256: unknown;
  readonly operation: unknown;
  readonly operationRequestSha256: unknown;
  readonly previousRequestOrdinal: unknown;
  readonly exchanges: unknown;
}

export type GitHubObjectsRequestSubjectV1 =
  | { readonly expectedActor: string }
  | {
      readonly pathSha256: string;
      readonly contentBytes: number;
      readonly contentSha256: string;
      readonly expectedBlobSha1: string;
    }
  | {
      readonly baseTreeSha1: string;
      readonly entriesSha256: string;
      readonly expectedTreeSha1: string;
    }
  | {
      readonly candidateTreeSha1: string;
      readonly baseCommitSha1: string;
      readonly candidateCommitPayloadSha256: string;
      readonly expectedCommitSha1: string;
      readonly commitIso8601: string;
    };

export interface GitHubObjectsNextRequestV1 {
  readonly schemaVersion: 1;
  readonly landingId: string;
  readonly operationId: string;
  readonly coordinatorAttempt: number;
  readonly operationKind: "github.objects.upload";
  readonly requestOrdinal: number;
  readonly kind: ObjectsHttpKindV1;
  readonly method: "GET" | "POST";
  readonly profileSha256: string;
  readonly bodySha256: string | null;
  readonly subject: GitHubObjectsRequestSubjectV1;
}

export interface GitHubObjectsFactV1 {
  readonly fact: "actor";
  readonly requestId: string;
  readonly resultSha256: string;
}

interface ProjectionBaseV1 {
  readonly exchanges: readonly GitHubObjectsHistoryExchangeV1[];
}

export interface GitHubObjectsNextHistoryV1 extends ProjectionBaseV1 {
  readonly status: "next_request";
  readonly facts: readonly GitHubObjectsFactV1[];
  readonly nextRequest: GitHubObjectsNextRequestV1;
}

export interface GitHubObjectsCompleteHistoryV1 extends ProjectionBaseV1 {
  readonly status: "complete";
  readonly facts: readonly GitHubObjectsFactV1[];
  readonly value: ObjectsExactValueV1;
  readonly observation: LandingOperationObservationV1;
  readonly observationSha256: string;
  readonly operationResult: LandingOperationResultV1;
  readonly operationResultSha256: string;
}

export type GitHubObjectsHistoryProjectionV1 =
  | GitHubObjectsNextHistoryV1
  | GitHubObjectsCompleteHistoryV1;

interface ChangedBlobV1 {
  readonly path: string;
  readonly content: Uint8Array;
}

interface DecodedMaterialV1 {
  readonly landing: LandingDigestV1;
  readonly manifest: CandidateObjectManifestV1;
  readonly text: { readonly commitMessage: string };
  readonly changedBlobs: readonly ChangedBlobV1[];
}

interface SequenceMemberV1 {
  readonly kind: ObjectsHttpKindV1;
  readonly method: "GET" | "POST";
  readonly bodySha256: string | null;
  readonly subject: GitHubObjectsRequestSubjectV1;
  readonly projection: LandingHttpProjectionV1;
}

interface DecodedInputV1 {
  readonly material: DecodedMaterialV1;
  readonly operation: LandingOperationRequestV1 & {
    readonly kind: "github.objects.upload";
    readonly input: GitHubObjectsUploadInputV1;
  };
  readonly previousRequestOrdinal: number;
  readonly exchanges: readonly GitHubObjectsHistoryExchangeV1[];
}

function invalid(message: string): never {
  throw new IcarusError("LANDING_RECORD_INVALID", message);
}

function exactRecord(value: unknown, keys: readonly string[], field: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${field} must be an object`);
  }
  let prototype: object | null;
  let ownKeys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return invalid(`${field} cannot expose a stable own-key set`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(`${field} must be a plain object`);
  }
  const actual: string[] = [];
  for (const key of ownKeys) {
    if (typeof key !== "string") return invalid(`${field} cannot contain symbol members`);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid(`${field} cannot expose stable own-property descriptors`);
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid(`${field} members must be enumerable own data properties`);
    }
    actual.push(key);
  }
  actual.sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) {
    return invalid(`${field} does not have the exact expected members`);
  }
  return value as JsonRecord;
}

function denseArray(value: unknown, field: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) return invalid(`${field} must be an array`);
  if (!Number.isSafeInteger(value.length) || value.length > maximum) {
    return invalid(`${field} exceeds its fixed bound`);
  }
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    } catch {
      return invalid(`${field} cannot expose stable element descriptors`);
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid(`${field} must be a dense array of own data elements`);
    }
    copy.push(descriptor.value);
  }
  return copy;
}

function boundedRecordArray(
  value: unknown,
  key: string,
  field: string,
  maximum: number,
): readonly unknown[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${field} owner must be an object`);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  } catch {
    return invalid(`${field} cannot expose a stable property descriptor`);
  }
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    return invalid(`${field} must be an enumerable own data property`);
  }
  return denseArray(descriptor.value, field, maximum);
}

function recordDataProperty(value: unknown, key: string, field: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${field} owner must be an object`);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  } catch {
    return invalid(`${field} cannot expose a stable property descriptor`);
  }
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    return invalid(`${field} must be an enumerable own data property`);
  }
  return descriptor.value;
}

function text(value: unknown, field: string): string {
  return typeof value === "string" ? value : invalid(`${field} must be text`);
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid(`${field} must be a safe nonnegative integer`);
  }
  return value;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalLandingJson(left) === canonicalLandingJson(right);
}

function assertDigest(value: unknown, digest: unknown, field: string): string {
  const decoded = assertSha256(digest, field);
  if (digestLandingRecord(value) !== decoded) {
    return invalid(`${field} does not match the canonical record`);
  }
  return decoded;
}

function decodeMaterial(value: unknown, landingSha256Value: unknown): DecodedMaterialV1 {
  const decoded = exactRecord(
    value,
    ["landing", "profile", "objectManifest", "text", "changedBlobs"],
    "objectsHistory.material",
  );
  boundedRecordArray(
    decoded.landing,
    "changedPaths",
    "objectsHistory.material.landing.changedPaths",
    MAX_CHANGED_FILES,
  );
  boundedRecordArray(
    decoded.landing,
    "directIcarusEffects",
    "objectsHistory.material.landing.directIcarusEffects",
    4,
  );
  const rawDisclosure = recordDataProperty(
    decoded.landing,
    "derivativeEffectDisclosure",
    "objectsHistory.material.landing.derivativeEffectDisclosure",
  );
  boundedRecordArray(
    rawDisclosure,
    "githubEvents",
    "objectsHistory.material.landing.derivativeEffectDisclosure.githubEvents",
    2,
  );
  boundedRecordArray(
    rawDisclosure,
    "mayTrigger",
    "objectsHistory.material.landing.derivativeEffectDisclosure.mayTrigger",
    5,
  );
  boundedRecordArray(
    decoded.objectManifest,
    "entries",
    "objectsHistory.material.objectManifest.entries",
    MAX_CHANGED_FILES,
  );
  const landing = decodeLandingDigestV1(decoded.landing);
  assertDigest(landing, landingSha256Value, "objectsHistory.landingSha256");
  const profile = decodeGitHubLandingProfileV1(decoded.profile);
  const manifest = decodeCandidateObjectManifestV1(decoded.objectManifest);
  if (
    digestLandingRecord(profile) !== landing.profileSha256 ||
    !sameCanonical(profile, landing.profile) ||
    digestLandingRecord(manifest) !== landing.candidateObjectManifestSha256 ||
    manifest.baseCommitSha1 !== landing.baseCommitSha1 ||
    manifest.baseTreeSha1 !== landing.baseTreeSha1 ||
    manifest.candidateTreeSha1 !== landing.candidateTreeSha1 ||
    manifest.candidateCommitSha1 !== landing.candidateCommitSha1 ||
    manifest.candidateCommitPayloadSha256 !== landing.candidateCommitPayloadSha256 ||
    manifest.entries.length !== landing.changedPaths.length ||
    !manifest.entries.every((entry, index) => entry.path === landing.changedPaths[index])
  ) {
    return invalid("GitHub object material is not bound to the immutable landing");
  }
  const rawText = exactRecord(
    decoded.text,
    ["commitMessage", "pullRequestTitle", "pullRequestBodyPrefix"],
    "objectsHistory.material.text",
  );
  const boundText = assertLandingDigestTextBindingsV1(landing, {
    commitMessage: text(rawText.commitMessage, "objectsHistory.material.text.commitMessage"),
    pullRequestTitle: text(
      rawText.pullRequestTitle,
      "objectsHistory.material.text.pullRequestTitle",
    ),
    pullRequestBodyPrefix: text(
      rawText.pullRequestBodyPrefix,
      "objectsHistory.material.text.pullRequestBodyPrefix",
    ),
  });
  const expectedBlobs = manifest.entries.filter((entry) => entry.op !== "delete");
  const rawBlobs = denseArray(
    decoded.changedBlobs,
    "objectsHistory.material.changedBlobs",
    landing.changedPaths.length,
  );
  if (rawBlobs.length !== expectedBlobs.length) {
    return invalid("GitHub object material changed-blob count is invalid");
  }
  const changedBlobs = rawBlobs.map((rawBlob, index): ChangedBlobV1 => {
    const blob = exactRecord(
      rawBlob,
      ["path", "content"],
      `objectsHistory.material.changedBlobs[${index}]`,
    );
    const expected = expectedBlobs[index];
    const path = text(blob.path, `objectsHistory.material.changedBlobs[${index}].path`);
    if (expected === undefined || path !== expected.path || !(blob.content instanceof Uint8Array)) {
      return invalid("GitHub object material changed-blob identity is invalid");
    }
    if (blob.content.byteLength > MAX_OBJECT_CONTENT_BYTES) {
      return invalid("GitHub object material changed-blob bytes exceed the fixed bound");
    }
    const content = new Uint8Array(blob.content);
    if (
      content.byteLength !== expected.contentBytes ||
      sha256(content) !== expected.contentSha256 ||
      gitObjectSha1("blob", content) !== expected.blobSha1
    ) {
      return invalid("GitHub object material changed-blob bytes are invalid");
    }
    return { path, content };
  });
  const commitPayload = buildUnsignedCommitPayloadV1({
    candidateTreeSha1: landing.candidateTreeSha1,
    baseCommitSha1: landing.baseCommitSha1,
    commitIdentity: landing.commitAuthor,
    commitEpochSeconds: landing.commitEpochSeconds,
    commitMessage: boundText.commitMessage,
  });
  if (
    !sameCanonical(landing.commitAuthor, landing.commitCommitter) ||
    sha256(commitPayload) !== landing.candidateCommitPayloadSha256 ||
    gitObjectSha1("commit", commitPayload) !== landing.candidateCommitSha1
  ) {
    return invalid("GitHub object material commit identity is invalid");
  }
  return {
    landing,
    manifest,
    text: { commitMessage: boundText.commitMessage },
    changedBlobs,
  };
}

function expectedPreflightValue(landing: LandingDigestV1): PreflightExactValueV1 {
  return {
    actor: landing.profile.expectedActor,
    baseSha1: landing.expectedRemoteBaseSha1,
    headState: "absent",
    pullRequestCount: null,
  };
}

function decodeInput(rawValue: unknown): DecodedInputV1 {
  const input = exactRecord(
    rawValue,
    [
      "material",
      "landingSha256",
      "preflightOperation",
      "preflightOperationRequestSha256",
      "preflightResult",
      "preflightResultSha256",
      "operation",
      "operationRequestSha256",
      "previousRequestOrdinal",
      "exchanges",
    ],
    "objectsHistory",
  );
  const material = decodeMaterial(input.material, input.landingSha256);
  const landingSha256 = assertSha256(input.landingSha256, "objectsHistory.landingSha256");
  const preflight = decodeLandingOperationRequestV1(input.preflightOperation);
  assertDigest(
    preflight,
    input.preflightOperationRequestSha256,
    "objectsHistory.preflightOperationRequestSha256",
  );
  const rawPreflightEvidence = boundedRecordArray(
    input.preflightResult,
    "evidence",
    "objectsHistory.preflightResult.evidence",
    4,
  );
  const preflightResult = decodeLandingOperationResultV1(input.preflightResult);
  const preflightResultSha256 = assertDigest(
    preflightResult,
    input.preflightResultSha256,
    "objectsHistory.preflightResultSha256",
  );
  const operation = decodeLandingOperationRequestV1(input.operation);
  assertDigest(operation, input.operationRequestSha256, "objectsHistory.operationRequestSha256");
  if (operation.kind !== "github.objects.upload") {
    return invalid("Object history requires a github.objects.upload operation");
  }
  const operationInput = operation.input as GitHubObjectsUploadInputV1;
  if (
    operation.landingId !== material.landing.landingId ||
    operation.expectedState !== "local_ready" ||
    operationInput.landingSha256 !== landingSha256 ||
    operationInput.candidateObjectManifestSha256 !==
      material.landing.candidateObjectManifestSha256 ||
    operationInput.changedPathsSha256 !== material.landing.changedPathsSha256 ||
    operationInput.preflightOperationId !== preflight.operationId ||
    operationInput.preflightResultSha256 !== preflightResultSha256
  ) {
    return invalid("Object operation is not bound to immutable landing and preflight authority");
  }
  const preflightInput = preflight.input as {
    readonly landingSha256: string;
    readonly profileSha256: string;
    readonly baseRef: string;
    readonly expectedRemoteBaseSha1: string;
    readonly headRef: string;
    readonly candidateCommitSha1: string;
    readonly includePullRequestAbsence: boolean;
  };
  if (
    preflight.kind !== "github.preflight" ||
    preflight.landingId !== operation.landingId ||
    preflight.coordinatorAttempt !== operation.coordinatorAttempt ||
    preflight.expectedState !== "local_ready" ||
    preflight.expectedVersion !== operation.expectedVersion ||
    preflightInput.landingSha256 !== landingSha256 ||
    preflightInput.profileSha256 !== material.landing.profileSha256 ||
    preflightInput.baseRef !== material.landing.baseRef ||
    preflightInput.expectedRemoteBaseSha1 !== material.landing.expectedRemoteBaseSha1 ||
    preflightInput.headRef !== material.landing.headRef ||
    preflightInput.candidateCommitSha1 !== material.landing.candidateCommitSha1 ||
    preflightInput.includePullRequestAbsence !== false ||
    rawPreflightEvidence.length !== 3 ||
    preflightResult.operationId !== preflight.operationId ||
    preflightResult.kind !== "github.preflight" ||
    preflightResult.outcome !== "completed" ||
    preflightResult.boundary !== "preflight_exact" ||
    preflightResult.errorCode !== null ||
    !sameCanonical(preflightResult.value, expectedPreflightValue(material.landing))
  ) {
    return invalid("Object operation lacks the exact immediately-prior preflight projection");
  }
  const previousRequestOrdinal = safeInteger(
    input.previousRequestOrdinal,
    "objectsHistory.previousRequestOrdinal",
  );
  if (previousRequestOrdinal !== 3) {
    return invalid("Object upload must immediately follow the three-request local-ready preflight");
  }
  const maximumExchanges = material.changedBlobs.length + 3;
  const rawExchanges = denseArray(input.exchanges, "objectsHistory.exchanges", maximumExchanges);
  const exchanges = rawExchanges.map((rawExchange, index) => {
    const exchange = exactRecord(
      rawExchange,
      ["request", "requestSha256", "result", "resultSha256"],
      `objectsHistory.exchanges[${index}]`,
    );
    return {
      request: exchange.request,
      requestSha256: exchange.requestSha256,
      result: exchange.result,
      resultSha256: exchange.resultSha256,
    };
  });
  return {
    material,
    operation: operation as DecodedInputV1["operation"],
    previousRequestOrdinal,
    exchanges,
  };
}

function canonicalBody(
  kind: Exclude<ObjectsHttpKindV1, "github.actor.get">,
  value: GitHubPostBodyV1,
) {
  return canonicalGitHubPostBodyV1(kind, value);
}

function sequence(material: DecodedMaterialV1): readonly SequenceMemberV1[] {
  const { landing, manifest } = material;
  const actor: SequenceMemberV1 = {
    kind: "github.actor.get",
    method: "GET",
    bodySha256: null,
    subject: { expectedActor: landing.profile.expectedActor },
    projection: { type: "actor", login: landing.profile.expectedActor },
  };
  const blobs = material.changedBlobs.map((blob): SequenceMemberV1 => {
    const entry = manifest.entries.find((candidate) => candidate.path === blob.path);
    if (
      entry === undefined ||
      entry.contentBytes === null ||
      entry.contentSha256 === null ||
      entry.blobSha1 === null
    ) {
      return invalid("Changed blob has no immutable manifest entry");
    }
    const body = canonicalBody("github.blob.post", {
      content: Buffer.from(blob.content).toString("base64"),
      encoding: "base64",
    });
    return {
      kind: "github.blob.post",
      method: "POST",
      bodySha256: body.sha256,
      subject: {
        pathSha256: sha256(blob.path),
        contentBytes: entry.contentBytes,
        contentSha256: entry.contentSha256,
        expectedBlobSha1: entry.blobSha1,
      },
      projection: { type: "object", objectKind: "blob", sha1: entry.blobSha1 },
    };
  });
  const treeEntries = manifest.entries.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    type: "blob" as const,
    sha: entry.blobSha1,
  }));
  const treeBody = canonicalBody("github.tree.post", {
    base_tree: landing.baseTreeSha1,
    tree: treeEntries,
  });
  const tree: SequenceMemberV1 = {
    kind: "github.tree.post",
    method: "POST",
    bodySha256: treeBody.sha256,
    subject: {
      baseTreeSha1: landing.baseTreeSha1,
      entriesSha256: digestLandingRecord(treeEntries),
      expectedTreeSha1: landing.candidateTreeSha1,
    },
    projection: { type: "object", objectKind: "tree", sha1: landing.candidateTreeSha1 },
  };
  const commitBody = canonicalBody("github.commit.post", {
    message: material.text.commitMessage,
    tree: landing.candidateTreeSha1,
    parents: [landing.baseCommitSha1],
    author: { ...landing.commitAuthor, date: landing.commitIso8601 },
    committer: { ...landing.commitCommitter, date: landing.commitIso8601 },
  });
  const commit: SequenceMemberV1 = {
    kind: "github.commit.post",
    method: "POST",
    bodySha256: commitBody.sha256,
    subject: {
      candidateTreeSha1: landing.candidateTreeSha1,
      baseCommitSha1: landing.baseCommitSha1,
      candidateCommitPayloadSha256: landing.candidateCommitPayloadSha256,
      expectedCommitSha1: landing.candidateCommitSha1,
      commitIso8601: landing.commitIso8601,
    },
    projection: { type: "object", objectKind: "commit", sha1: landing.candidateCommitSha1 },
  };
  return [actor, ...blobs, tree, commit];
}

function nextRequest(
  input: DecodedInputV1,
  member: SequenceMemberV1,
  requestOrdinal: number,
): GitHubObjectsNextRequestV1 {
  return {
    schemaVersion: 1,
    landingId: input.material.landing.landingId,
    operationId: input.operation.operationId,
    coordinatorAttempt: input.operation.coordinatorAttempt,
    operationKind: "github.objects.upload",
    requestOrdinal,
    kind: member.kind,
    method: member.method,
    profileSha256: input.material.landing.profileSha256,
    bodySha256: member.bodySha256,
    subject: member.subject,
  };
}

function expectedSuccessStatus(kind: ObjectsHttpKindV1): 200 | 201 {
  return kind === "github.actor.get" ? 200 : 201;
}

/**
 * Correlates one bounded successful ADR 0027 object-upload HTTP prefix.
 *
 * This component performs no database, lease, filesystem, credential, or
 * network operation. Its output is not admission, retry, settlement, or
 * adjacency authority. A durable caller must independently prove exact SQL
 * rows/events, that the preflight immediately precedes this operation with no
 * intervening operation, and the retry-subject/reconciliation ancestry.
 */
export function validateGitHubObjectsUploadHttpHistoryV1(
  rawValue: unknown,
): GitHubObjectsHistoryProjectionV1 {
  const input = decodeInput(rawValue);
  const grammar = sequence(input.material);
  if (input.exchanges.length > grammar.length) {
    return invalid("Object upload history contains a request after the complete grammar");
  }
  const maximumRequestOrdinal = 2 * input.material.landing.changedPaths.length + 32;
  const requestIds = new Set<string>();
  const facts: GitHubObjectsFactV1[] = [];

  for (let index = 0; index < input.exchanges.length; index += 1) {
    const exchange = input.exchanges[index];
    const member = grammar[index];
    if (exchange === undefined || member === undefined) {
      return invalid("Object upload history is not an exact bounded grammar prefix");
    }
    const ordinal = input.previousRequestOrdinal + index + 1;
    if (!Number.isSafeInteger(ordinal) || ordinal > maximumRequestOrdinal) {
      return invalid("Object upload request ordinal exceeds the landing bound");
    }
    const expected = nextRequest(input, member, ordinal);
    const request = decodeLandingHttpRequestV1(exchange.request);
    const { requestId, ...descriptor } = request;
    if (requestIds.has(requestId) || !sameCanonical(descriptor, expected)) {
      return invalid("Object upload request does not match its exact grammar position");
    }
    requestIds.add(requestId);
    assertDigest(request, exchange.requestSha256, "objectsHistory.requestSha256");
    const rawResult = exactRecord(
      exchange.result,
      ["schemaVersion", "requestId", "kind", "outcome", "httpStatus", "projection", "errorCode"],
      `objectsHistory.exchanges[${index}].result`,
    );
    if (rawResult.kind !== member.kind) {
      return invalid("Object upload result kind does not match its grammar position");
    }
    const result = decodeLandingHttpResultV1(exchange.result);
    const resultSha256 = assertDigest(result, exchange.resultSha256, "objectsHistory.resultSha256");
    if (
      result.requestId !== requestId ||
      result.kind !== member.kind ||
      result.outcome !== "succeeded" ||
      result.httpStatus !== expectedSuccessStatus(member.kind) ||
      result.errorCode !== null ||
      !sameCanonical(result.projection, member.projection)
    ) {
      return invalid("Object upload result does not prove its exact expected object");
    }
    if (index === 0) facts.push({ fact: "actor", requestId, resultSha256 });
  }

  if (input.exchanges.length < grammar.length) {
    const member = grammar[input.exchanges.length];
    if (member === undefined) return invalid("Object upload grammar has no next request");
    const requestOrdinal = input.previousRequestOrdinal + input.exchanges.length + 1;
    if (!Number.isSafeInteger(requestOrdinal) || requestOrdinal > maximumRequestOrdinal) {
      return invalid("Object upload request ordinal exceeds the landing bound");
    }
    return {
      status: "next_request",
      facts,
      exchanges: input.exchanges,
      nextRequest: nextRequest(input, member, requestOrdinal),
    };
  }

  const value: ObjectsExactValueV1 = {
    candidateObjectManifestSha256: input.material.landing.candidateObjectManifestSha256,
    remoteObjectOutcome: "created_or_exact",
  };
  const observation = decodeLandingOperationObservationV1({
    schemaVersion: 1,
    operationId: input.operation.operationId,
    kind: "github.objects.upload",
    phase: "pre_effect",
    facts,
  });
  const evidence = input.exchanges.map((exchange) => {
    const request = decodeLandingHttpRequestV1(exchange.request);
    return {
      requestId: request.requestId,
      resultSha256: assertSha256(exchange.resultSha256, "objectsHistory.resultSha256"),
    };
  });
  const operationResult = decodeLandingOperationResultV1({
    schemaVersion: 1,
    operationId: input.operation.operationId,
    kind: "github.objects.upload",
    outcome: "completed",
    boundary: "objects_exact",
    evidence,
    value,
    errorCode: null,
  });
  return {
    status: "complete",
    facts,
    exchanges: input.exchanges,
    value,
    observation,
    observationSha256: digestLandingRecord(observation),
    operationResult,
    operationResultSha256: digestLandingRecord(operationResult),
  };
}
