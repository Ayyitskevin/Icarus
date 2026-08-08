import { IcarusError } from "./errors.js";
import {
  assertSha256,
  canonicalLandingJson,
  decodeLandingDigestV1,
  decodeLandingHttpRequestV1,
  decodeLandingHttpResultV1,
  decodeLandingOperationObservationV1,
  decodeLandingOperationRequestV1,
  decodeLandingOperationResultV1,
  digestLandingRecord,
  type GitHubPreflightInputV1,
  type LandingDigestV1,
  type LandingHttpResultV1,
  type LandingOperationObservationV1,
  type LandingOperationRequestV1,
  type LandingOperationResultV1,
  type PreflightExactValueV1,
} from "./landing-records.js";

type JsonRecord = Record<string, unknown>;

const PREFLIGHT_SEQUENCE = [
  "github.actor.get",
  "github.base_ref.get",
  "github.head_ref.get",
  "github.pull_requests.get",
] as const;

type GitHubPreflightHttpKindV1 = (typeof PREFLIGHT_SEQUENCE)[number];

export interface GitHubPreflightHistoryExchangeV1 {
  readonly request: unknown;
  readonly requestSha256: unknown;
  readonly result: unknown;
  readonly resultSha256: unknown;
}

/**
 * Component-only correlation input. The caller must independently prove SQL
 * durability, admitted/settled row status and events, the owning active
 * attempt/lease, and coordinator-wide ordinal continuity. Supplying this
 * object is not evidence that any of those store invariants hold.
 */
export interface GitHubPreflightHistoryInputV1 {
  readonly landing: unknown;
  readonly landingSha256: unknown;
  readonly operation: unknown;
  readonly operationRequestSha256: unknown;
  /** Coordinator-wide request ordinal immediately before this operation. */
  readonly previousRequestOrdinal: unknown;
  readonly exchanges: unknown;
}

export interface GitHubPreflightFactV1 {
  readonly fact: "actor" | "base_ref" | "head_ref" | "pull_requests";
  readonly requestId: string;
  readonly resultSha256: string;
}

export type GitHubPreflightRequestSubjectV1 =
  | { readonly expectedActor: string }
  | {
      readonly owner: string;
      readonly repository: string;
      readonly baseRef: string;
      readonly expectedSha1: string;
    }
  | {
      readonly owner: string;
      readonly repository: string;
      readonly headRef: string;
      readonly expectedSha1: string;
    }
  | {
      readonly owner: string;
      readonly repository: string;
      readonly headOwner: string;
      readonly headRef: string;
      readonly baseBranch: string;
      readonly state: "all";
      readonly page: 1;
      readonly perPage: 100;
    };

/** All canonical request fields except the fresh, independently generated request ID. */
export interface GitHubPreflightNextRequestV1 {
  readonly schemaVersion: 1;
  readonly landingId: string;
  readonly operationId: string;
  readonly coordinatorAttempt: number;
  readonly operationKind: "github.preflight";
  readonly requestOrdinal: number;
  readonly kind: GitHubPreflightHttpKindV1;
  readonly method: "GET";
  readonly profileSha256: string;
  readonly bodySha256: null;
  readonly subject: GitHubPreflightRequestSubjectV1;
}

export interface GitHubPreflightNextHistoryV1 {
  readonly status: "next_request";
  readonly facts: readonly GitHubPreflightFactV1[];
  readonly nextRequest: GitHubPreflightNextRequestV1;
}

export interface GitHubPreflightCompleteHistoryV1 {
  readonly status: "complete";
  readonly facts: readonly GitHubPreflightFactV1[];
  readonly value: PreflightExactValueV1;
  readonly observation: LandingOperationObservationV1;
  readonly observationSha256: string;
  readonly operationResult: LandingOperationResultV1;
  readonly operationResultSha256: string;
}

export type GitHubPreflightHistoryProjectionV1 =
  | GitHubPreflightNextHistoryV1
  | GitHubPreflightCompleteHistoryV1;

interface DecodedHistoryInput {
  readonly landing: LandingDigestV1;
  readonly landingSha256: string;
  readonly operation: LandingOperationRequestV1 & {
    readonly kind: "github.preflight";
    readonly input: GitHubPreflightInputV1;
  };
  readonly previousRequestOrdinal: number;
  readonly exchanges: readonly GitHubPreflightHistoryExchangeV1[];
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
    if (typeof key !== "string") {
      return invalid(`${field} cannot contain symbol members`);
    }
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

function safeInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    return invalid(`${field} must be a bounded safe nonnegative integer`);
  }
  return value;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalLandingJson(left) === canonicalLandingJson(right);
}

function assertCanonicalDigest(value: unknown, digest: unknown, field: string): string {
  const decodedDigest = assertSha256(digest, field);
  if (digestLandingRecord(value) !== decodedDigest) {
    return invalid(`${field} does not match the canonical record`);
  }
  return decodedDigest;
}

function preflightKinds(includePullRequestAbsence: boolean): readonly GitHubPreflightHttpKindV1[] {
  return includePullRequestAbsence ? PREFLIGHT_SEQUENCE : PREFLIGHT_SEQUENCE.slice(0, 3);
}

function requestSubject(
  kind: GitHubPreflightHttpKindV1,
  landing: LandingDigestV1,
): GitHubPreflightRequestSubjectV1 {
  const { profile } = landing;
  switch (kind) {
    case "github.actor.get":
      return { expectedActor: profile.expectedActor };
    case "github.base_ref.get":
      return {
        owner: profile.owner,
        repository: profile.repository,
        baseRef: landing.baseRef,
        expectedSha1: landing.expectedRemoteBaseSha1,
      };
    case "github.head_ref.get":
      return {
        owner: profile.owner,
        repository: profile.repository,
        headRef: landing.headRef,
        expectedSha1: landing.candidateCommitSha1,
      };
    case "github.pull_requests.get":
      return {
        owner: profile.owner,
        repository: profile.repository,
        headOwner: profile.owner,
        headRef: landing.headRef.slice("refs/heads/".length),
        baseBranch: profile.baseBranch,
        state: "all",
        page: 1,
        perPage: 100,
      };
  }
}

function nextRequest(
  operation: DecodedHistoryInput["operation"],
  landing: LandingDigestV1,
  requestOrdinal: number,
  kind: GitHubPreflightHttpKindV1,
): GitHubPreflightNextRequestV1 {
  return {
    schemaVersion: 1,
    landingId: landing.landingId,
    operationId: operation.operationId,
    coordinatorAttempt: operation.coordinatorAttempt,
    operationKind: "github.preflight",
    requestOrdinal,
    kind,
    method: "GET",
    profileSha256: landing.profileSha256,
    bodySha256: null,
    subject: requestSubject(kind, landing),
  };
}

function assertOperationBinding(
  operation: LandingOperationRequestV1,
  landing: LandingDigestV1,
  landingSha256: string,
): asserts operation is LandingOperationRequestV1 & {
  readonly kind: "github.preflight";
  readonly input: GitHubPreflightInputV1;
} {
  if (operation.kind !== "github.preflight") {
    invalid("HTTP preflight history requires a github.preflight operation");
  }
  const input = operation.input as GitHubPreflightInputV1;
  if (
    operation.landingId !== landing.landingId ||
    input.landingSha256 !== landingSha256 ||
    input.profileSha256 !== landing.profileSha256 ||
    input.baseRef !== landing.baseRef ||
    input.expectedRemoteBaseSha1 !== landing.expectedRemoteBaseSha1 ||
    input.headRef !== landing.headRef ||
    input.candidateCommitSha1 !== landing.candidateCommitSha1 ||
    (input.includePullRequestAbsence && operation.expectedState !== "remote_ready") ||
    (!input.includePullRequestAbsence && operation.expectedState === "remote_ready")
  ) {
    invalid("GitHub preflight operation is not bound to immutable landing authority");
  }
}

function decodeInput(value: unknown): DecodedHistoryInput {
  const decoded = exactRecord(
    value,
    [
      "landing",
      "landingSha256",
      "operation",
      "operationRequestSha256",
      "previousRequestOrdinal",
      "exchanges",
    ],
    "preflightHistory",
  );
  const landing = decodeLandingDigestV1(decoded.landing);
  const landingSha256 = assertCanonicalDigest(
    landing,
    decoded.landingSha256,
    "preflightHistory.landingSha256",
  );
  const operation = decodeLandingOperationRequestV1(decoded.operation);
  assertCanonicalDigest(
    operation,
    decoded.operationRequestSha256,
    "preflightHistory.operationRequestSha256",
  );
  assertOperationBinding(operation, landing, landingSha256);
  if (!Array.isArray(decoded.exchanges)) {
    invalid("preflightHistory.exchanges must be an array");
  }
  if (decoded.exchanges.length > 4) {
    invalid("GitHub preflight HTTP history exceeds its fixed request bound");
  }
  const exchanges = decoded.exchanges.map((entry, index) => {
    const exchange = exactRecord(
      entry,
      ["request", "requestSha256", "result", "resultSha256"],
      `preflightHistory.exchanges[${index}]`,
    );
    return {
      request: exchange.request,
      requestSha256: exchange.requestSha256,
      result: exchange.result,
      resultSha256: exchange.resultSha256,
    };
  });
  return {
    landing,
    landingSha256,
    operation,
    previousRequestOrdinal: safeInteger(
      decoded.previousRequestOrdinal,
      "preflightHistory.previousRequestOrdinal",
    ),
    exchanges,
  };
}

function expectedProjection(
  kind: GitHubPreflightHttpKindV1,
  landing: LandingDigestV1,
  expectedHeadState: PreflightExactValueV1["headState"],
): LandingHttpResultV1["projection"] {
  switch (kind) {
    case "github.actor.get":
      return { type: "actor", login: landing.profile.expectedActor };
    case "github.base_ref.get":
      return {
        type: "ref",
        state: "direct",
        ref: landing.baseRef,
        sha1: landing.expectedRemoteBaseSha1,
      };
    case "github.head_ref.get":
      if (expectedHeadState === "absent") {
        return { type: "ref", state: "absent", ref: landing.headRef, sha1: null };
      }
      return {
        type: "ref",
        state: "direct",
        ref: landing.headRef,
        sha1: landing.candidateCommitSha1,
      };
    case "github.pull_requests.get":
      return { type: "pull_request_list", complete: true, count: 0, objects: [] };
  }
}

function factName(kind: GitHubPreflightHttpKindV1): GitHubPreflightFactV1["fact"] {
  switch (kind) {
    case "github.actor.get":
      return "actor";
    case "github.base_ref.get":
      return "base_ref";
    case "github.head_ref.get":
      return "head_ref";
    case "github.pull_requests.get":
      return "pull_requests";
  }
}

/**
 * Component-only validation of one bounded ADR 0027 GitHub preflight HTTP
 * prefix. This proves record correlation only: it is not proof of SQL
 * durability, row status or events, an owning active attempt/lease, or global
 * ordinal continuity. The caller must establish those store invariants before
 * using this projection for admission or settlement. This function performs
 * no reads, writes, credential resolution, or network activity.
 */
export function validateGitHubPreflightHttpHistoryV1(
  rawValue: unknown,
): GitHubPreflightHistoryProjectionV1 {
  const input = decodeInput(rawValue);
  const sequence = preflightKinds(input.operation.input.includePullRequestAbsence);
  if (input.exchanges.length > sequence.length) {
    invalid("GitHub preflight HTTP history contains a request after the complete grammar");
  }
  const maximumRequestOrdinal = 2 * input.landing.changedPaths.length + 32;
  const facts: GitHubPreflightFactV1[] = [];
  const requestIds = new Set<string>();
  const expectedHeadState = input.operation.input.includePullRequestAbsence ? "exact" : "absent";
  let headState: PreflightExactValueV1["headState"] | null = null;

  for (let index = 0; index < input.exchanges.length; index += 1) {
    const kind = sequence[index];
    const raw = input.exchanges[index];
    if (kind === undefined || raw === undefined) {
      invalid("GitHub preflight HTTP history is not a bounded grammar prefix");
    }
    const requestOrdinal = input.previousRequestOrdinal + index + 1;
    if (!Number.isSafeInteger(requestOrdinal) || requestOrdinal > maximumRequestOrdinal) {
      invalid("GitHub preflight HTTP request ordinal exceeds the landing bound");
    }
    const expected = nextRequest(input.operation, input.landing, requestOrdinal, kind);
    const request = decodeLandingHttpRequestV1(raw.request);
    const { requestId: _requestId, ...descriptor } = request;
    if (!sameCanonical(descriptor, expected)) {
      invalid("GitHub preflight HTTP request does not match its exact grammar position");
    }
    assertCanonicalDigest(request, raw.requestSha256, "preflightHistory.requestSha256");
    if (requestIds.has(request.requestId)) {
      invalid("GitHub preflight HTTP history reuses a request identity");
    }
    requestIds.add(request.requestId);

    const result = decodeLandingHttpResultV1(raw.result);
    const resultSha256 = assertCanonicalDigest(
      result,
      raw.resultSha256,
      "preflightHistory.resultSha256",
    );
    const expectedStatus =
      kind === "github.head_ref.get" && expectedHeadState === "absent" ? 404 : 200;
    if (
      result.requestId !== request.requestId ||
      result.kind !== request.kind ||
      result.outcome !== "succeeded" ||
      result.httpStatus !== expectedStatus ||
      result.errorCode !== null ||
      !sameCanonical(result.projection, expectedProjection(kind, input.landing, expectedHeadState))
    ) {
      invalid("GitHub preflight HTTP result does not prove the exact required projection");
    }
    if (kind === "github.head_ref.get") {
      headState = result.httpStatus === 404 ? "absent" : "exact";
    }
    facts.push({ fact: factName(kind), requestId: request.requestId, resultSha256 });
  }

  if (input.exchanges.length < sequence.length) {
    const kind = sequence[input.exchanges.length];
    if (kind === undefined) invalid("GitHub preflight HTTP grammar has no next request");
    const requestOrdinal = input.previousRequestOrdinal + input.exchanges.length + 1;
    if (!Number.isSafeInteger(requestOrdinal) || requestOrdinal > maximumRequestOrdinal) {
      invalid("GitHub preflight HTTP request ordinal exceeds the landing bound");
    }
    return {
      status: "next_request",
      facts,
      nextRequest: nextRequest(input.operation, input.landing, requestOrdinal, kind),
    };
  }

  if (headState === null) invalid("Complete GitHub preflight history lacks a head projection");
  const completedValue: PreflightExactValueV1 = {
    actor: input.landing.profile.expectedActor,
    baseSha1: input.landing.expectedRemoteBaseSha1,
    headState,
    pullRequestCount: input.operation.input.includePullRequestAbsence ? 0 : null,
  };
  const observation = decodeLandingOperationObservationV1({
    schemaVersion: 1,
    operationId: input.operation.operationId,
    kind: "github.preflight",
    phase: "pre_effect",
    facts,
  });
  const operationResult = decodeLandingOperationResultV1({
    schemaVersion: 1,
    operationId: input.operation.operationId,
    kind: "github.preflight",
    outcome: "completed",
    boundary: "preflight_exact",
    evidence: facts.map(({ requestId, resultSha256 }) => ({ requestId, resultSha256 })),
    value: completedValue,
    errorCode: null,
  });
  return {
    status: "complete",
    facts,
    value: completedValue,
    observation,
    observationSha256: digestLandingRecord(observation),
    operationResult,
    operationResultSha256: digestLandingRecord(operationResult),
  };
}
