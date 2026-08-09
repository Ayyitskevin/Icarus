/**
 * Pure persisted aggregate validation for the first GitHub object-upload slice.
 *
 * This module correlates supplied canonical SQLite-shaped records only. It
 * performs no database read, lease check, credential resolution, filesystem
 * access, or network operation. Its projection never authorizes a request,
 * retry, settlement, reconciliation, or provider effect.
 */
import { sha256 } from "./digest.js";
import { IcarusError } from "./errors.js";
import {
  type GitHubObjectsNextRequestV1,
  validateGitHubObjectsUploadHttpHistoryV1,
} from "./landing-objects-history.js";
import {
  decodePersistedGitHubObjectsHttpExchangeV1,
  type PersistedGitHubObjectsHttpExchangeV1,
} from "./landing-objects-http-persistence.js";
import {
  assertInstant,
  assertSafeCode,
  assertSha256,
  assertUuid,
  canonicalLandingJson,
  decodeCanonicalLandingEventPayloadJsonV1,
  decodeCanonicalLandingJson,
  decodeLandingDigestV1,
  decodeLandingOperationObservationV1,
  decodeLandingOperationRequestV1,
  decodeLandingOperationResultV1,
  digestLandingRecord,
  type GitHubObjectsUploadInputV1,
  type GitHubPreflightInputV1,
  type LandingDigestV1,
  type LandingGitHubRequestAdmittedEventV1,
  type LandingGitHubRequestSettledEventV1,
  type LandingHttpRequestV1,
  type LandingOperationObservationV1,
  type LandingOperationRequestV1,
  type LandingOperationResultV1,
  type LandingOperationSettledEventV1,
  type LandingOperationStartedEventV1,
  type LandingStateChangedEventV1,
} from "./landing-records.js";
import { MAX_CHANGED_FILES } from "./policy.js";

type JsonRecord = Record<string, unknown>;

const TAKEOVER_ERROR_CODE = "LANDING_COORDINATOR_TAKEOVER" as const;
const AMBIGUOUS_ERROR_CODE = "GITHUB_OUTCOME_AMBIGUOUS" as const;
const MAX_CANONICAL_JSON_BYTES = 64 * 1024;
const MAX_OBJECT_REQUESTS = MAX_CHANGED_FILES + 3;

const INPUT_KEYS = [
  "material",
  "landingSha256",
  "operationStartState",
  "operationStartVersion",
  "preflightOperationRow",
  "preflightSettlementEventRow",
  "operationRow",
  "actionStateEventRow",
  "previousRequestOrdinal",
  "httpRows",
  "requestEvents",
  "operationEvents",
] as const;

const MATERIAL_KEYS = ["landing", "profile", "objectManifest", "text", "changedBlobs"] as const;

const OPERATION_ROW_KEYS = [
  "id",
  "landing_id",
  "coordinator_attempt",
  "kind",
  "kind_attempt",
  "status",
  "request_sha256",
  "request_json",
  "observation_sha256",
  "observation_json",
  "result_sha256",
  "result_json",
  "error_code",
  "started_at",
  "finished_at",
] as const;

const HTTP_ROW_KEYS = [
  "id",
  "landing_id",
  "operation_id",
  "coordinator_attempt",
  "operation_kind",
  "request_ordinal",
  "kind",
  "method",
  "request_sha256",
  "request_json",
  "status",
  "outcome",
  "http_status",
  "result_sha256",
  "result_json",
  "error_code",
  "admitted_at",
  "settled_at",
] as const;

const EVENT_ROW_KEYS = [
  "id",
  "landing_id",
  "sequence",
  "type",
  "payload_json",
  "created_at",
] as const;

type OperationStatusV1 = "started" | "completed" | "failed" | "interrupted";

interface StoredOperationV1 {
  readonly id: string;
  readonly landingId: string;
  readonly coordinatorAttempt: number;
  readonly kindAttempt: number;
  readonly status: OperationStatusV1;
  readonly request: LandingOperationRequestV1;
  readonly requestSha256: string;
  readonly observation: LandingOperationObservationV1 | null;
  readonly observationSha256: string | null;
  readonly result: LandingOperationResultV1 | null;
  readonly resultSha256: string | null;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

interface StoredPreflightV1 extends StoredOperationV1 {
  readonly status: "completed";
  readonly request: LandingOperationRequestV1 & {
    readonly kind: "github.preflight";
    readonly expectedState: "local_ready";
    readonly input: GitHubPreflightInputV1 & {
      readonly includePullRequestAbsence: false;
    };
  };
  readonly observation: LandingOperationObservationV1;
  readonly observationSha256: string;
  readonly result: LandingOperationResultV1;
  readonly resultSha256: string;
  readonly errorCode: null;
  readonly finishedAt: string;
}

interface StoredObjectsOperationV1 extends StoredOperationV1 {
  readonly request: LandingOperationRequestV1 & {
    readonly kind: "github.objects.upload";
    readonly expectedState: "local_ready";
    readonly input: GitHubObjectsUploadInputV1 & {
      readonly retrySubjectOperationId: null;
      readonly retrySubjectRequestSha256: null;
    };
  };
}

type CorrelatedEventPayloadV1 =
  | LandingGitHubRequestAdmittedEventV1
  | LandingGitHubRequestSettledEventV1
  | LandingOperationStartedEventV1
  | LandingOperationSettledEventV1
  | LandingStateChangedEventV1;

interface DecodedEventV1 {
  readonly id: number;
  readonly landingId: string;
  readonly sequence: number;
  readonly type:
    | "landing.github.request.admitted"
    | "landing.github.request.settled"
    | "landing.operation.started"
    | "landing.operation.settled"
    | "landing.state.changed";
  readonly payload: CorrelatedEventPayloadV1;
  readonly createdAt: string;
}

interface ProjectionBaseV1 {
  readonly operationId: string;
  readonly operationRequestSha256: string;
  readonly preflightOperationId: string;
  readonly preflightResultSha256: string;
  readonly observation: LandingOperationObservationV1 | null;
  readonly observationSha256: string | null;
  readonly exchanges: readonly PersistedGitHubObjectsHttpExchangeV1[];
}

export interface PersistedGitHubObjectsNextRequestEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "next_request";
  readonly nextRequest: GitHubObjectsNextRequestV1;
  readonly observationPending: boolean;
}

export interface PersistedGitHubObjectsAdmittedEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "admitted";
  readonly request: LandingHttpRequestV1 & {
    readonly operationKind: "github.objects.upload";
  };
  readonly requestSha256: string;
}

export interface PersistedGitHubObjectsCompleteEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "complete";
  readonly observation: LandingOperationObservationV1;
  readonly observationSha256: string;
  readonly result: LandingOperationResultV1;
  readonly resultSha256: string;
}

export interface PersistedGitHubObjectsPreEffectTerminalEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "pre_effect_terminal";
  readonly httpOutcome: "failed" | "ambiguous";
  readonly operationOutcome: "failed" | "interrupted";
  readonly errorCode: string;
  readonly result: LandingOperationResultV1;
  readonly resultSha256: string;
}

export interface PersistedGitHubObjectsReconciliationEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "reconciliation_required";
  readonly trigger: "ambiguous" | "post_effect";
  readonly operationOutcome: "reconciliation_required";
  readonly errorCode: string;
  readonly result: LandingOperationResultV1;
  readonly resultSha256: string;
}

export interface PersistedGitHubObjectsTakeoverEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "takeover";
  readonly operationOutcome: "reconciliation_required";
  readonly errorCode: typeof TAKEOVER_ERROR_CODE;
  readonly result: LandingOperationResultV1;
  readonly resultSha256: string;
}

export type PersistedGitHubObjectsEvidenceV1 =
  | PersistedGitHubObjectsNextRequestEvidenceV1
  | PersistedGitHubObjectsAdmittedEvidenceV1
  | PersistedGitHubObjectsCompleteEvidenceV1
  | PersistedGitHubObjectsPreEffectTerminalEvidenceV1
  | PersistedGitHubObjectsReconciliationEvidenceV1
  | PersistedGitHubObjectsTakeoverEvidenceV1;

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
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return invalid(`${field} cannot be inspected as an array`);
  }
  if (!isArray) return invalid(`${field} must be an array`);
  let length: number;
  try {
    length = (value as unknown[]).length;
  } catch {
    return invalid(`${field} cannot expose a stable length`);
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    return invalid(`${field} exceeds its fixed bound`);
  }
  const dense: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value as object, String(index));
    } catch {
      return invalid(`${field} cannot expose stable element descriptors`);
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid(`${field} must be a dense array of own data elements`);
    }
    dense.push(descriptor.value);
  }
  return dense;
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

function boundedRecordArray(
  value: unknown,
  key: string,
  field: string,
  maximum: number,
): readonly unknown[] {
  return denseArray(recordDataProperty(value, key, field), field, maximum);
}

function text(value: unknown, field: string): string {
  return typeof value === "string" ? value : invalid(`${field} must be text`);
}

function boundedJson(value: unknown, field: string): string {
  const encoded = text(value, field);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_JSON_BYTES) {
    return invalid(`${field} exceeds the persisted JSON byte ceiling`);
  }
  return encoded;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(`${field} must be a bounded safe integer`);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    return invalid(`${field} has an unsupported value`);
  }
  return value as T[number];
}

function canonicalDigest(encoded: string, digest: unknown, field: string): string {
  const decoded = assertSha256(digest, field);
  if (sha256(encoded) !== decoded) return invalid(`${field} does not match canonical bytes`);
  return decoded;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalLandingJson(left) === canonicalLandingJson(right);
}

function decodeStoredOperationRow(rawValue: unknown, field: string): StoredOperationV1 {
  const row = exactRecord(rawValue, OPERATION_ROW_KEYS, field);
  const requestJson = boundedJson(row.request_json, `${field}.request_json`);
  const request = decodeCanonicalLandingJson(requestJson, decodeLandingOperationRequestV1);
  const requestSha256 = canonicalDigest(requestJson, row.request_sha256, `${field}.request_sha256`);
  const status = oneOf(
    row.status,
    ["started", "completed", "failed", "interrupted"] as const,
    `${field}.status`,
  );
  const observationJson =
    row.observation_json === null
      ? null
      : boundedJson(row.observation_json, `${field}.observation_json`);
  const observation =
    observationJson === null
      ? null
      : decodeCanonicalLandingJson(observationJson, decodeLandingOperationObservationV1);
  const observationSha256 =
    observationJson === null
      ? row.observation_sha256 === null
        ? null
        : invalid(`${field} has an observation digest without canonical bytes`)
      : canonicalDigest(observationJson, row.observation_sha256, `${field}.observation_sha256`);
  const resultJson =
    row.result_json === null ? null : boundedJson(row.result_json, `${field}.result_json`);
  const result =
    resultJson === null
      ? null
      : decodeCanonicalLandingJson(resultJson, decodeLandingOperationResultV1);
  const resultSha256 =
    resultJson === null
      ? row.result_sha256 === null
        ? null
        : invalid(`${field} has a result digest without canonical bytes`)
      : canonicalDigest(resultJson, row.result_sha256, `${field}.result_sha256`);
  const errorCode =
    row.error_code === null ? null : assertSafeCode(row.error_code, `${field}.error_code`);
  const startedAt = assertInstant(row.started_at, `${field}.started_at`);
  const finishedAt =
    row.finished_at === null ? null : assertInstant(row.finished_at, `${field}.finished_at`);
  if (finishedAt !== null && finishedAt < startedAt) {
    invalid(`${field} finished before it started`);
  }
  if (
    assertUuid(row.id, `${field}.id`) !== request.operationId ||
    assertUuid(row.landing_id, `${field}.landing_id`) !== request.landingId ||
    integer(row.coordinator_attempt, `${field}.coordinator_attempt`, 1, 8) !==
      request.coordinatorAttempt ||
    row.kind !== request.kind ||
    integer(row.kind_attempt, `${field}.kind_attempt`, 1, 9) !== request.kindAttempt
  ) {
    invalid(`${field} SQL identity columns do not match canonical request bytes`);
  }
  if (
    result !== null &&
    (result.operationId !== request.operationId || result.kind !== request.kind)
  ) {
    invalid(`${field} result does not match its canonical request`);
  }
  const startedShape =
    status === "started" &&
    result === null &&
    resultSha256 === null &&
    errorCode === null &&
    finishedAt === null;
  const completedShape =
    status === "completed" &&
    result?.outcome === "completed" &&
    errorCode === null &&
    finishedAt !== null;
  const failedShape =
    status === "failed" &&
    result?.outcome === "failed" &&
    errorCode !== null &&
    result.errorCode === errorCode &&
    finishedAt !== null;
  const interruptedShape =
    status === "interrupted" &&
    result !== null &&
    (result.outcome === "interrupted" || result.outcome === "reconciliation_required") &&
    errorCode !== null &&
    result.errorCode === errorCode &&
    finishedAt !== null;
  if (!(startedShape || completedShape || failedShape || interruptedShape)) {
    invalid(`${field} settlement columns disagree`);
  }
  return {
    id: request.operationId,
    landingId: request.landingId,
    coordinatorAttempt: request.coordinatorAttempt,
    kindAttempt: request.kindAttempt,
    status,
    request,
    requestSha256,
    observation,
    observationSha256,
    result,
    resultSha256,
    errorCode,
    startedAt,
    finishedAt,
  };
}

function expectedPreflightValue(landing: LandingDigestV1): unknown {
  return {
    actor: landing.profile.expectedActor,
    baseSha1: landing.expectedRemoteBaseSha1,
    headState: "absent",
    pullRequestCount: null,
  };
}

function decodePreflightOperation(
  rawValue: unknown,
  landing: LandingDigestV1,
  landingSha256: string,
): StoredPreflightV1 {
  const operation = decodeStoredOperationRow(rawValue, "preflightOperationRow");
  const request = operation.request;
  const input = request.input as GitHubPreflightInputV1;
  if (
    operation.status !== "completed" ||
    request.kind !== "github.preflight" ||
    request.expectedState !== "local_ready" ||
    input.includePullRequestAbsence !== false ||
    request.landingId !== landing.landingId ||
    input.landingSha256 !== landingSha256 ||
    input.profileSha256 !== landing.profileSha256 ||
    input.baseRef !== landing.baseRef ||
    input.expectedRemoteBaseSha1 !== landing.expectedRemoteBaseSha1 ||
    input.headRef !== landing.headRef ||
    input.candidateCommitSha1 !== landing.candidateCommitSha1 ||
    operation.observation === null ||
    operation.observationSha256 === null ||
    operation.result === null ||
    operation.resultSha256 === null ||
    operation.errorCode !== null ||
    operation.finishedAt === null
  ) {
    invalid("Immediate object preflight is not one completed local-ready proof");
  }
  const facts = operation.observation.facts;
  const expectedFactKinds = ["actor", "base_ref", "head_ref"] as const;
  if (
    operation.observation.operationId !== operation.id ||
    operation.observation.kind !== "github.preflight" ||
    operation.observation.phase !== "pre_effect" ||
    facts.length !== expectedFactKinds.length ||
    !facts.every(
      (fact, index) =>
        fact.fact === expectedFactKinds[index] &&
        fact.requestId !== null &&
        operation.result?.evidence[index]?.requestId === fact.requestId &&
        operation.result.evidence[index]?.resultSha256 === fact.resultSha256,
    ) ||
    operation.result.evidence.length !== facts.length ||
    operation.result.outcome !== "completed" ||
    operation.result.boundary !== "preflight_exact" ||
    operation.result.errorCode !== null ||
    !sameCanonical(operation.result.value, expectedPreflightValue(landing))
  ) {
    invalid("Immediate object preflight observation and result are not exact");
  }
  return operation as StoredPreflightV1;
}

function decodeObjectsOperation(
  rawValue: unknown,
  landing: LandingDigestV1,
  landingSha256: string,
  preflight: StoredPreflightV1,
  operationStartVersion: number,
): StoredObjectsOperationV1 {
  const operation = decodeStoredOperationRow(rawValue, "operationRow");
  const request = operation.request;
  const input = request.input as GitHubObjectsUploadInputV1;
  if (
    request.kind !== "github.objects.upload" ||
    request.expectedState !== "local_ready" ||
    request.expectedVersion !== operationStartVersion ||
    request.landingId !== landing.landingId ||
    request.coordinatorAttempt !== preflight.coordinatorAttempt ||
    request.expectedVersion !== preflight.request.expectedVersion ||
    input.landingSha256 !== landingSha256 ||
    input.candidateObjectManifestSha256 !== landing.candidateObjectManifestSha256 ||
    input.changedPathsSha256 !== landing.changedPathsSha256 ||
    input.preflightOperationId !== preflight.id ||
    input.preflightResultSha256 !== preflight.resultSha256 ||
    input.retrySubjectOperationId !== null ||
    input.retrySubjectRequestSha256 !== null ||
    operation.startedAt < preflight.finishedAt
  ) {
    invalid("Persisted object operation is not bound to its immediate immutable preflight");
  }
  if (
    operation.observation !== null &&
    (operation.observation.operationId !== operation.id ||
      operation.observation.kind !== "github.objects.upload" ||
      operation.observation.phase !== "pre_effect" ||
      operation.observation.facts.length !== 1 ||
      operation.observation.facts[0]?.fact !== "actor" ||
      operation.observation.facts[0].requestId === null)
  ) {
    invalid("Persisted object observation is not the exact one-actor projection");
  }
  return operation as StoredObjectsOperationV1;
}

function decodeEventRow(
  rawValue: unknown,
  field: string,
  permittedTypes: readonly DecodedEventV1["type"][],
): DecodedEventV1 {
  const row = exactRecord(rawValue, EVENT_ROW_KEYS, field);
  const type = oneOf(row.type, permittedTypes, `${field}.type`);
  const payloadJson = boundedJson(row.payload_json, `${field}.payload_json`);
  return {
    id: integer(row.id, `${field}.id`, 1, Number.MAX_SAFE_INTEGER),
    landingId: assertUuid(row.landing_id, `${field}.landing_id`),
    sequence: integer(row.sequence, `${field}.sequence`, 1, Number.MAX_SAFE_INTEGER),
    type,
    payload: decodeCanonicalLandingEventPayloadJsonV1(
      type,
      payloadJson,
    ) as CorrelatedEventPayloadV1,
    createdAt: assertInstant(row.created_at, `${field}.created_at`),
  };
}

function expectedOperationStart(
  operation: StoredObjectsOperationV1,
): LandingOperationStartedEventV1 {
  return {
    schemaVersion: 1,
    landingId: operation.landingId,
    operationId: operation.id,
    coordinatorAttempt: operation.coordinatorAttempt,
    kind: "github.objects.upload",
    kindAttempt: operation.kindAttempt,
    requestSha256: operation.requestSha256,
  };
}

function expectedOperationSettlement(
  operation: StoredObjectsOperationV1,
): LandingOperationSettledEventV1 {
  if (operation.result === null || operation.resultSha256 === null) {
    return invalid("Settled object operation has no canonical result");
  }
  return {
    schemaVersion: 1,
    landingId: operation.landingId,
    operationId: operation.id,
    coordinatorAttempt: operation.coordinatorAttempt,
    kind: "github.objects.upload",
    outcome: operation.result.outcome,
    resultSha256: operation.resultSha256,
    errorCode: operation.errorCode,
  };
}

function expectedPreflightSettlement(preflight: StoredPreflightV1): LandingOperationSettledEventV1 {
  return {
    schemaVersion: 1,
    landingId: preflight.landingId,
    operationId: preflight.id,
    coordinatorAttempt: preflight.coordinatorAttempt,
    kind: "github.preflight",
    outcome: "completed",
    resultSha256: preflight.resultSha256,
    errorCode: null,
  };
}

function decodeOperationEvents(
  rawEvents: readonly unknown[],
  operation: StoredObjectsOperationV1,
): readonly DecodedEventV1[] {
  const expectedCount = operation.status === "started" ? 1 : 2;
  if (rawEvents.length !== expectedCount) {
    invalid("Object operation does not have its exact start/settlement event count");
  }
  const events = rawEvents.map((event, index) =>
    decodeEventRow(event, `operationEvents[${index}]`, [
      "landing.operation.started",
      "landing.operation.settled",
    ]),
  );
  const start = events[0];
  if (
    start === undefined ||
    start.type !== "landing.operation.started" ||
    start.landingId !== operation.landingId ||
    !sameCanonical(start.payload, expectedOperationStart(operation))
  ) {
    invalid("Object operation start event does not match its persisted row");
  }
  if (operation.status !== "started") {
    const settlement = events[1];
    if (
      settlement === undefined ||
      settlement.type !== "landing.operation.settled" ||
      settlement.landingId !== operation.landingId ||
      settlement.sequence <= start.sequence ||
      settlement.id <= start.id ||
      !sameCanonical(settlement.payload, expectedOperationSettlement(operation))
    ) {
      invalid("Object operation settlement event does not match its persisted row");
    }
  }
  return events;
}

function requestIdFromEvent(event: DecodedEventV1): string {
  if (
    event.type !== "landing.github.request.admitted" &&
    event.type !== "landing.github.request.settled"
  ) {
    return invalid("Object request event has the wrong type");
  }
  return (event.payload as LandingGitHubRequestAdmittedEventV1).requestId;
}

function decodeRequestEvents(
  rawEvents: readonly unknown[],
  operation: StoredObjectsOperationV1,
): readonly DecodedEventV1[] {
  const events = rawEvents.map((event, index) =>
    decodeEventRow(event, `requestEvents[${index}]`, [
      "landing.github.request.admitted",
      "landing.github.request.settled",
    ]),
  );
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const prior = events[index - 1];
    if (
      event === undefined ||
      event.landingId !== operation.landingId ||
      event.payload.landingId !== operation.landingId ||
      (event.payload as LandingGitHubRequestAdmittedEventV1).operationId !== operation.id ||
      (event.payload as LandingGitHubRequestAdmittedEventV1).coordinatorAttempt !==
        operation.coordinatorAttempt ||
      (event.payload as LandingGitHubRequestAdmittedEventV1).operationKind !==
        "github.objects.upload" ||
      (prior !== undefined && (event.sequence <= prior.sequence || event.id <= prior.id))
    ) {
      invalid("Object request event crosses identity or persisted order");
    }
  }
  return events;
}

function compareNextRequest(
  request: LandingHttpRequestV1,
  expected: GitHubObjectsNextRequestV1,
): void {
  const { requestId: _requestId, ...descriptor } = request;
  if (!sameCanonical(descriptor, expected)) {
    invalid("Persisted object request does not match its exact grammar position");
  }
}

function actorObservation(
  operation: StoredObjectsOperationV1,
  exchanges: readonly PersistedGitHubObjectsHttpExchangeV1[],
): LandingOperationObservationV1 | null {
  const actor = exchanges[0];
  if (
    actor === undefined ||
    actor.status !== "settled" ||
    actor.request.kind !== "github.actor.get" ||
    actor.result.outcome !== "succeeded"
  ) {
    return null;
  }
  return decodeLandingOperationObservationV1({
    schemaVersion: 1,
    operationId: operation.id,
    kind: "github.objects.upload",
    phase: "pre_effect",
    facts: [
      {
        fact: "actor",
        requestId: actor.request.requestId,
        resultSha256: actor.resultSha256,
      },
    ],
  });
}

function assertObservationTopology(
  operation: StoredObjectsOperationV1,
  exchanges: readonly PersistedGitHubObjectsHttpExchangeV1[],
  requireObservation: boolean,
): { readonly expected: LandingOperationObservationV1 | null; readonly pending: boolean } {
  const expected = actorObservation(operation, exchanges);
  if (expected === null) {
    if (operation.observation !== null || operation.observationSha256 !== null) {
      invalid("Object observation exists before a successful actor request");
    }
    return { expected: null, pending: false };
  }
  const expectedSha256 = digestLandingRecord(expected);
  if (operation.observation === null) {
    if (operation.observationSha256 !== null || requireObservation) {
      invalid("Object POST boundary lacks its durable actor observation");
    }
    return { expected, pending: true };
  }
  if (
    operation.observationSha256 !== expectedSha256 ||
    !sameCanonical(operation.observation, expected)
  ) {
    invalid("Persisted object observation does not match its actor result");
  }
  return { expected, pending: false };
}

function settledEvidence(
  exchanges: readonly PersistedGitHubObjectsHttpExchangeV1[],
): readonly { readonly requestId: string; readonly resultSha256: string }[] {
  return exchanges.map((exchange) => {
    if (exchange.status !== "settled") {
      return invalid("Settled object operation evidence contains an admitted request");
    }
    return { requestId: exchange.request.requestId, resultSha256: exchange.resultSha256 };
  });
}

function failedResult(
  operation: StoredObjectsOperationV1,
  exchanges: readonly PersistedGitHubObjectsHttpExchangeV1[],
  errorCode: string,
): LandingOperationResultV1 {
  return decodeLandingOperationResultV1({
    schemaVersion: 1,
    operationId: operation.id,
    kind: "github.objects.upload",
    outcome: "failed",
    boundary: "operation_failed",
    evidence: settledEvidence(exchanges),
    value: null,
    errorCode,
  });
}

function interruptedResult(
  operation: StoredObjectsOperationV1,
  exchanges: readonly PersistedGitHubObjectsHttpExchangeV1[],
  errorCode: string,
): LandingOperationResultV1 {
  return decodeLandingOperationResultV1({
    schemaVersion: 1,
    operationId: operation.id,
    kind: "github.objects.upload",
    outcome: "interrupted",
    boundary: "operation_interrupted",
    evidence: settledEvidence(exchanges),
    value: null,
    errorCode,
  });
}

function reconciliationResult(
  operation: StoredObjectsOperationV1,
  exchanges: readonly PersistedGitHubObjectsHttpExchangeV1[],
  errorCode: string,
): LandingOperationResultV1 {
  return decodeLandingOperationResultV1({
    schemaVersion: 1,
    operationId: operation.id,
    kind: "github.objects.upload",
    outcome: "reconciliation_required",
    boundary: "reconciliation_required",
    evidence: settledEvidence(exchanges),
    value: { subjectOperationId: operation.id, remoteResidue: "none" },
    errorCode,
  });
}

function assertStoredResult(
  operation: StoredObjectsOperationV1,
  expectedStatus: Exclude<OperationStatusV1, "started">,
  expected: LandingOperationResultV1,
): asserts operation is StoredObjectsOperationV1 & {
  readonly result: LandingOperationResultV1;
  readonly resultSha256: string;
  readonly errorCode: string | null;
} {
  if (
    operation.status !== expectedStatus ||
    operation.result === null ||
    operation.resultSha256 === null ||
    !sameCanonical(operation.result, expected) ||
    operation.resultSha256 !== digestLandingRecord(expected) ||
    operation.errorCode !== expected.errorCode
  ) {
    invalid("Persisted object operation does not exactly settle its HTTP evidence");
  }
}

function historyInput(
  material: unknown,
  landingSha256: string,
  preflight: StoredPreflightV1,
  operation: StoredObjectsOperationV1,
  previousRequestOrdinal: number,
  exchanges: readonly PersistedGitHubObjectsHttpExchangeV1[],
): unknown {
  return {
    material,
    landingSha256,
    preflightOperation: preflight.request,
    preflightOperationRequestSha256: preflight.requestSha256,
    preflightResult: preflight.result,
    preflightResultSha256: preflight.resultSha256,
    operation: operation.request,
    operationRequestSha256: operation.requestSha256,
    previousRequestOrdinal,
    exchanges: exchanges.map((exchange) => {
      if (exchange.status !== "settled") {
        return invalid("Only settled successes can enter object history");
      }
      return {
        request: exchange.request,
        requestSha256: exchange.requestSha256,
        result: exchange.result,
        resultSha256: exchange.resultSha256,
      };
    }),
  };
}

function projectTakeover(
  base: ProjectionBaseV1,
  operation: StoredObjectsOperationV1,
  exchanges: readonly PersistedGitHubObjectsHttpExchangeV1[],
): PersistedGitHubObjectsTakeoverEvidenceV1 {
  const expected = reconciliationResult(operation, exchanges, TAKEOVER_ERROR_CODE);
  assertStoredResult(operation, "interrupted", expected);
  return {
    ...base,
    status: "takeover",
    operationOutcome: "reconciliation_required",
    errorCode: TAKEOVER_ERROR_CODE,
    result: operation.result,
    resultSha256: operation.resultSha256,
  };
}

function assertEventTopology(
  preflightSettlement: DecodedEventV1,
  actionState: DecodedEventV1,
  operationEvents: readonly DecodedEventV1[],
  requestEvents: readonly DecodedEventV1[],
  exchanges: readonly PersistedGitHubObjectsHttpExchangeV1[],
): void {
  const start = operationEvents[0];
  if (start === undefined) invalid("Object operation start event is missing");
  const expected: Array<{
    readonly type: DecodedEventV1["type"];
    readonly requestId: string | null;
  }> = [
    { type: "landing.operation.settled", requestId: null },
    { type: "landing.operation.started", requestId: null },
    { type: "landing.state.changed", requestId: null },
  ];
  for (const exchange of exchanges) {
    expected.push({
      type: "landing.github.request.admitted",
      requestId: exchange.request.requestId,
    });
    if (exchange.status === "settled") {
      expected.push({
        type: "landing.github.request.settled",
        requestId: exchange.request.requestId,
      });
    }
  }
  if (operationEvents.length === 2) {
    expected.push({ type: "landing.operation.settled", requestId: null });
  }
  const combined = [preflightSettlement, actionState, ...operationEvents, ...requestEvents].sort(
    (left, right) => left.sequence - right.sequence,
  );
  if (combined.length !== expected.length) {
    invalid("Object event stream has an omitted or extra operation-owned event");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const event = combined[index];
    const wanted = expected[index];
    if (
      event === undefined ||
      wanted === undefined ||
      event.sequence !== preflightSettlement.sequence + index ||
      event.type !== wanted.type ||
      (wanted.requestId !== null && requestIdFromEvent(event) !== wanted.requestId) ||
      (index > 0 && (combined[index - 1]?.id ?? 0) >= event.id)
    ) {
      invalid("Object event stream is gapped, reordered, or cross-correlated");
    }
  }
}

/**
 * Validates one supplied local-ready GitHub object-upload persisted aggregate.
 *
 * The caller must already have validated the immediate preflight's own HTTP
 * rows and must independently prove database query completeness, global
 * operation/kind/attempt ordering, attempt rows/events, final landing state and
 * resume/version suffix, SQLite transaction grouping, reconciliation successor
 * ancestry, and a continuously held run lease. `operationStartState` and
 * `operationStartVersion` are chronological replay inputs, not current-state
 * claims. Every returned discriminant is evidence only.
 */
export function validatePersistedGitHubObjectsOperationV1(
  rawValue: unknown,
): PersistedGitHubObjectsEvidenceV1 {
  const input = exactRecord(rawValue, INPUT_KEYS, "persistedObjects");
  const rawHttpRows = denseArray(input.httpRows, "httpRows", MAX_OBJECT_REQUESTS);
  const rawRequestEvents = denseArray(
    input.requestEvents,
    "requestEvents",
    MAX_OBJECT_REQUESTS * 2,
  );
  const rawOperationEvents = denseArray(input.operationEvents, "operationEvents", 2);
  const material = exactRecord(input.material, MATERIAL_KEYS, "persistedObjects.material");
  boundedRecordArray(
    material.landing,
    "changedPaths",
    "persistedObjects.material.landing.changedPaths",
    MAX_CHANGED_FILES,
  );
  boundedRecordArray(
    material.landing,
    "directIcarusEffects",
    "persistedObjects.material.landing.directIcarusEffects",
    4,
  );
  const rawDisclosure = recordDataProperty(
    material.landing,
    "derivativeEffectDisclosure",
    "persistedObjects.material.landing.derivativeEffectDisclosure",
  );
  boundedRecordArray(
    rawDisclosure,
    "githubEvents",
    "persistedObjects.material.landing.derivativeEffectDisclosure.githubEvents",
    2,
  );
  boundedRecordArray(
    rawDisclosure,
    "mayTrigger",
    "persistedObjects.material.landing.derivativeEffectDisclosure.mayTrigger",
    5,
  );
  const landing = decodeLandingDigestV1(material.landing);
  const landingSha256 = assertSha256(input.landingSha256, "persistedObjects.landingSha256");
  if (digestLandingRecord(landing) !== landingSha256) {
    invalid("Persisted object landing digest does not match canonical authority");
  }
  if (input.operationStartState !== "local_ready") {
    invalid("Persisted object operation requires replay-derived local-ready start state");
  }
  const operationStartVersion = integer(
    input.operationStartVersion,
    "persistedObjects.operationStartVersion",
    0,
    Number.MAX_SAFE_INTEGER - 1,
  );
  const previousRequestOrdinal = integer(
    input.previousRequestOrdinal,
    "persistedObjects.previousRequestOrdinal",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (previousRequestOrdinal !== 3) {
    invalid("Object upload must follow exactly three coordinator request ordinals");
  }
  const preflight = decodePreflightOperation(input.preflightOperationRow, landing, landingSha256);
  const operation = decodeObjectsOperation(
    input.operationRow,
    landing,
    landingSha256,
    preflight,
    operationStartVersion,
  );
  const preflightSettlement = decodeEventRow(
    input.preflightSettlementEventRow,
    "preflightSettlementEventRow",
    ["landing.operation.settled"],
  );
  if (
    preflightSettlement.landingId !== landing.landingId ||
    !sameCanonical(preflightSettlement.payload, expectedPreflightSettlement(preflight))
  ) {
    invalid("Immediate preflight settlement event does not match its completed row");
  }
  const operationEvents = decodeOperationEvents(rawOperationEvents, operation);
  const operationStart = operationEvents[0];
  if (operationStart === undefined) invalid("Object operation start event is missing");
  const actionState = decodeEventRow(input.actionStateEventRow, "actionStateEventRow", [
    "landing.state.changed",
  ]);
  const expectedActionState: LandingStateChangedEventV1 = {
    schemaVersion: 1,
    landingId: landing.landingId,
    from: "local_ready",
    to: "uploading_objects",
    version: operationStartVersion + 1,
    operationId: operation.id,
  };
  if (
    actionState.landingId !== landing.landingId ||
    !sameCanonical(actionState.payload, expectedActionState)
  ) {
    invalid("Object action-state event does not match its replayed start authority");
  }
  const requestEvents = decodeRequestEvents(rawRequestEvents, operation);
  const eventGroups = new Map<string, unknown[]>();
  for (let index = 0; index < requestEvents.length; index += 1) {
    const event = requestEvents[index];
    const rawEvent = rawRequestEvents[index];
    if (event === undefined || rawEvent === undefined) invalid("Object request event vanished");
    const requestId = requestIdFromEvent(event);
    const group = eventGroups.get(requestId) ?? [];
    group.push(rawEvent);
    eventGroups.set(requestId, group);
  }
  const decodedExchanges: PersistedGitHubObjectsHttpExchangeV1[] = [];
  const seenRequestIds = new Set<string>();
  for (let index = 0; index < rawHttpRows.length; index += 1) {
    const rawRow = exactRecord(rawHttpRows[index], HTTP_ROW_KEYS, `httpRows[${index}]`);
    const requestId = assertUuid(rawRow.id, `httpRows[${index}].id`);
    if (seenRequestIds.has(requestId)) invalid("Object HTTP history reuses a request ID");
    seenRequestIds.add(requestId);
    const events = eventGroups.get(requestId);
    if (events === undefined) invalid("Object HTTP row has no exact request events");
    const exchange = decodePersistedGitHubObjectsHttpExchangeV1(rawRow, events);
    if (
      exchange.request.landingId !== operation.landingId ||
      exchange.request.operationId !== operation.id ||
      exchange.request.coordinatorAttempt !== operation.coordinatorAttempt ||
      exchange.request.operationKind !== "github.objects.upload" ||
      exchange.request.requestOrdinal !== previousRequestOrdinal + index + 1
    ) {
      invalid("Object HTTP row crosses identity or coordinator ordinal order");
    }
    decodedExchanges.push(exchange);
    eventGroups.delete(requestId);
  }
  if (eventGroups.size !== 0) {
    invalid("Object request event has no persisted HTTP source row");
  }

  let admittedIndex: number | null = null;
  let terminalIndex: number | null = null;
  for (let index = 0; index < decodedExchanges.length; index += 1) {
    const exchange = decodedExchanges[index];
    if (exchange === undefined) invalid("Object HTTP exchange vanished");
    if (exchange.status === "admitted") {
      if (
        admittedIndex !== null ||
        terminalIndex !== null ||
        index !== decodedExchanges.length - 1
      ) {
        invalid("Object operation has more than one or a non-trailing admitted request");
      }
      admittedIndex = index;
    } else if (exchange.result.outcome !== "succeeded") {
      if (
        terminalIndex !== null ||
        admittedIndex !== null ||
        index !== decodedExchanges.length - 1
      ) {
        invalid("Object operation has a non-trailing terminal request");
      }
      terminalIndex = index;
    }
  }
  assertEventTopology(
    preflightSettlement,
    actionState,
    operationEvents,
    requestEvents,
    decodedExchanges,
  );
  const settledSuccesses = decodedExchanges.slice(
    0,
    admittedIndex ?? terminalIndex ?? decodedExchanges.length,
  );
  if (
    settledSuccesses.some(
      (exchange) => exchange.status !== "settled" || exchange.result.outcome !== "succeeded",
    )
  ) {
    invalid("Object history before its tail is not an exact successful prefix");
  }
  const history = validateGitHubObjectsUploadHttpHistoryV1(
    historyInput(
      input.material,
      landingSha256,
      preflight,
      operation,
      previousRequestOrdinal,
      settledSuccesses,
    ),
  );
  const hasPost = decodedExchanges.some((exchange) => exchange.request.method === "POST");
  const observation = assertObservationTopology(operation, decodedExchanges, hasPost);
  const base: ProjectionBaseV1 = {
    operationId: operation.id,
    operationRequestSha256: operation.requestSha256,
    preflightOperationId: preflight.id,
    preflightResultSha256: preflight.resultSha256,
    observation: operation.observation,
    observationSha256: operation.observationSha256,
    exchanges: decodedExchanges,
  };
  const isTakeover =
    operation.status === "interrupted" && operation.errorCode === TAKEOVER_ERROR_CODE;

  if (admittedIndex !== null) {
    if (operation.status !== "started" || history.status !== "next_request") {
      invalid("Admitted object tail is not owned by a started next-request topology");
    }
    const admitted = decodedExchanges[admittedIndex];
    if (admitted === undefined || admitted.status !== "admitted") {
      return invalid("Admitted object tail is missing");
    }
    compareNextRequest(admitted.request, history.nextRequest);
    return {
      ...base,
      status: "admitted",
      request: admitted.request,
      requestSha256: admitted.requestSha256,
    };
  }

  if (terminalIndex !== null) {
    if (history.status !== "next_request") {
      invalid("Terminal object request occurs after the complete grammar");
    }
    const terminal = decodedExchanges[terminalIndex];
    if (terminal === undefined || terminal.status !== "settled") {
      return invalid("Terminal object request is missing");
    }
    compareNextRequest(terminal.request, history.nextRequest);
    if (isTakeover) {
      if (
        terminal.result.outcome !== "ambiguous" ||
        terminal.result.errorCode !== AMBIGUOUS_ERROR_CODE
      ) {
        invalid("Object takeover tail is not the canonical ambiguous settlement");
      }
      return projectTakeover(base, operation, decodedExchanges);
    }
    const errorCode =
      terminal.result.errorCode ?? invalid("Terminal object request has no safe error code");
    if (terminalIndex === 0 && terminal.request.kind === "github.actor.get") {
      if (terminal.result.outcome === "failed") {
        const expected = failedResult(operation, decodedExchanges, errorCode);
        assertStoredResult(operation, "failed", expected);
        return {
          ...base,
          status: "pre_effect_terminal",
          httpOutcome: "failed",
          operationOutcome: "failed",
          errorCode,
          result: operation.result,
          resultSha256: operation.resultSha256,
        };
      }
      const expected = interruptedResult(operation, decodedExchanges, errorCode);
      assertStoredResult(operation, "interrupted", expected);
      return {
        ...base,
        status: "pre_effect_terminal",
        httpOutcome: "ambiguous",
        operationOutcome: "interrupted",
        errorCode,
        result: operation.result,
        resultSha256: operation.resultSha256,
      };
    }
    if (!(terminal.result.outcome === "ambiguous" || hasPost)) {
      invalid("Failed object request without a POST cannot create a reconciliation subject");
    }
    const expected = reconciliationResult(operation, decodedExchanges, errorCode);
    assertStoredResult(operation, "interrupted", expected);
    return {
      ...base,
      status: "reconciliation_required",
      trigger: terminal.result.outcome === "ambiguous" ? "ambiguous" : "post_effect",
      operationOutcome: "reconciliation_required",
      errorCode,
      result: operation.result,
      resultSha256: operation.resultSha256,
    };
  }

  if (isTakeover) {
    if (history.status !== "next_request") {
      invalid("Object takeover cannot rewrite one complete successful grammar");
    }
    return projectTakeover(base, operation, decodedExchanges);
  }

  if (history.status === "complete") {
    if (
      operation.status !== "completed" ||
      operation.observation === null ||
      operation.observationSha256 === null ||
      operation.result === null ||
      operation.resultSha256 === null ||
      !sameCanonical(operation.observation, history.observation) ||
      operation.observationSha256 !== history.observationSha256 ||
      !sameCanonical(operation.result, history.operationResult) ||
      operation.resultSha256 !== history.operationResultSha256
    ) {
      invalid("Complete object history is not exactly reflected by its operation row");
    }
    return {
      ...base,
      status: "complete",
      observation: operation.observation,
      observationSha256: operation.observationSha256,
      result: operation.result,
      resultSha256: operation.resultSha256,
    };
  }

  if (operation.status !== "started") {
    invalid("Incomplete successful object prefix does not have started topology");
  }
  return {
    ...base,
    status: "next_request",
    nextRequest: history.nextRequest,
    observationPending: observation.pending,
  };
}
