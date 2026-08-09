/**
 * Pure persisted aggregate validation for zero-HTTP object reconciliation.
 *
 * The original object subject is revalidated by the existing persisted object
 * aggregate validator. This component then correlates only the bounded
 * attempt/operation/event suffix owned by `landing.reconcile`. It performs no
 * database read, lease check, credential resolution, filesystem access, or
 * network operation. Its projection is evidence about supplied records only;
 * it never authorizes an HTTP request, object replay, retry, settlement, or
 * provider effect.
 *
 * This first composition slice inherits the current object aggregate's
 * deliberate scope fence: the subject operation's own retry-subject pair must
 * be null. Therefore a zero-POST subject projects a null retry pair only inside
 * that proved first/null-inherited scope. A later subject carrying inherited
 * non-null ancestry must be rejected until the object aggregate itself can
 * validate and preserve that ancestry; it must never be silently cleared.
 *
 * A durable caller must independently prove that every supplied row/event
 * carrier is the complete landing-scoped query result for this suffix, that
 * the object subject is the currently selected uninterrupted subject, that no
 * competing operation exists, that final landing state/version columns match
 * replay, that the first reconciliation `kindAttempt` follows the greatest
 * earlier landing-wide reconcile ordinal, and that the run lease remains held.
 * The nested `subjectAggregate`
 * is deliberately the exact input to `validatePersistedGitHubObjectsOperationV1`;
 * this module never accepts a caller-provided POST/effect boolean.
 */
import { sha256 } from "./digest.js";
import { IcarusError } from "./errors.js";
import {
  type PersistedGitHubObjectsReconciliationEvidenceV1 as PersistedGitHubObjectsSubjectReconciliationEvidenceV1,
  type PersistedGitHubObjectsTakeoverEvidenceV1,
  validatePersistedGitHubObjectsOperationV1,
} from "./landing-objects-persistence.js";
import {
  assertInstant,
  assertSafeCode,
  assertSha256,
  assertUuid,
  canonicalLandingJson,
  decodeCanonicalLandingEventPayloadJsonV1,
  decodeCanonicalLandingJson,
  decodeLandingOperationObservationV1,
  decodeLandingOperationRequestV1,
  decodeLandingOperationResultV1,
  digestLandingRecord,
  type GitHubObjectsUploadInputV1,
  type LandingAttemptSettledEventV1,
  type LandingAttemptStartedEventV1,
  type LandingOperationObservationV1,
  type LandingOperationRequestV1,
  type LandingOperationResultV1,
  type LandingOperationSettledEventV1,
  type LandingOperationStartedEventV1,
  type LandingReconcileInputV1,
  type LandingStateChangedEventV1,
} from "./landing-records.js";

type JsonRecord = Record<string, unknown>;

const MAX_RECONCILIATION_LINKS = 7;
const MAX_RECONCILIATION_EVENTS = MAX_RECONCILIATION_LINKS * 4 + 1;
const MAX_CANONICAL_JSON_BYTES = 64 * 1024;

const INPUT_KEYS = [
  "subjectAggregate",
  "subjectAttemptRow",
  "subjectAttemptSettlementEventRow",
  "subjectStateEventRow",
  "reconciliationAttemptRows",
  "reconciliationOperationRows",
  "reconciliationHttpRows",
  "reconciliationEventRows",
] as const;

const SUBJECT_AGGREGATE_KEYS = [
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

const ATTEMPT_ROW_KEYS = [
  "landing_id",
  "ordinal",
  "status",
  "started_at",
  "finished_at",
  "error_code",
] as const;

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

const EVENT_ROW_KEYS = [
  "id",
  "landing_id",
  "sequence",
  "type",
  "payload_json",
  "created_at",
] as const;

type ReconciliationStatusV1 = "started" | "completed" | "interrupted";

interface SubjectOperationV1 {
  readonly id: string;
  readonly landingId: string;
  readonly coordinatorAttempt: number;
  readonly kindAttempt: number;
  readonly request: LandingOperationRequestV1 & {
    readonly kind: "github.objects.upload";
    readonly input: GitHubObjectsUploadInputV1;
  };
  readonly requestSha256: string;
  readonly observationSha256: string | null;
  readonly result: LandingOperationResultV1;
  readonly resultSha256: string;
  readonly errorCode: string;
  readonly effectfulPostAdmitted: boolean;
}

interface ReconciliationAttemptV1 {
  readonly landingId: string;
  readonly ordinal: number;
  readonly status: ReconciliationStatusV1;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
}

interface ReconciliationOperationV1 {
  readonly id: string;
  readonly landingId: string;
  readonly coordinatorAttempt: number;
  readonly kindAttempt: number;
  readonly status: ReconciliationStatusV1;
  readonly request: LandingOperationRequestV1 & {
    readonly kind: "landing.reconcile";
    readonly expectedState: "reconciliation_required";
    readonly input: LandingReconcileInputV1 & { readonly resumeState: "local_ready" };
  };
  readonly requestSha256: string;
  readonly observation: LandingOperationObservationV1 | null;
  readonly observationSha256: string | null;
  readonly result: LandingOperationResultV1 | null;
  readonly resultSha256: string | null;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

type ReconciliationEventTypeV1 =
  | "landing.attempt.started"
  | "landing.attempt.settled"
  | "landing.operation.started"
  | "landing.operation.settled"
  | "landing.state.changed";

type ReconciliationEventPayloadV1 =
  | LandingAttemptStartedEventV1
  | LandingAttemptSettledEventV1
  | LandingOperationStartedEventV1
  | LandingOperationSettledEventV1
  | LandingStateChangedEventV1;

interface DecodedEventV1 {
  readonly id: number;
  readonly landingId: string;
  readonly sequence: number;
  readonly type: ReconciliationEventTypeV1;
  readonly payload: ReconciliationEventPayloadV1;
  readonly createdAt: string;
}

export interface PersistedGitHubObjectsReconciliationLinkEvidenceV1 {
  readonly operationId: string;
  readonly coordinatorAttempt: number;
  readonly kindAttempt: number;
  readonly status: ReconciliationStatusV1;
  readonly requestSha256: string;
  readonly observationSha256: string | null;
  readonly resultSha256: string | null;
  readonly errorCode: string | null;
}

interface ProjectionBaseV1 {
  readonly subjectOperationId: string;
  readonly subjectRequestSha256: string;
  readonly subjectResultSha256: string;
  readonly effectfulPostAdmitted: boolean;
  readonly links: readonly PersistedGitHubObjectsReconciliationLinkEvidenceV1[];
}

export interface PersistedGitHubObjectsReconciliationPendingEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "pending";
  readonly operationId: string;
  readonly observationPending: boolean;
  readonly retrySubjectOperationId: null;
  readonly retrySubjectRequestSha256: null;
}

export interface PersistedGitHubObjectsReconciliationUnresolvedEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "reconciliation_required";
  readonly operationId: string;
  readonly errorCode: string;
  readonly result: LandingOperationResultV1;
  readonly resultSha256: string;
  readonly retrySubjectOperationId: null;
  readonly retrySubjectRequestSha256: null;
}

export interface PersistedGitHubObjectsRetryStageEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "retry_stage_proven";
  readonly operationId: string;
  readonly nextState: "local_ready";
  readonly observation: LandingOperationObservationV1;
  readonly observationSha256: string;
  readonly result: LandingOperationResultV1;
  readonly resultSha256: string;
  readonly retrySubjectOperationId: string | null;
  readonly retrySubjectRequestSha256: string | null;
}

export type PersistedGitHubObjectsReconciliationEvidenceV1 =
  | PersistedGitHubObjectsReconciliationPendingEvidenceV1
  | PersistedGitHubObjectsReconciliationUnresolvedEvidenceV1
  | PersistedGitHubObjectsRetryStageEvidenceV1;

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
  const snapshot = Object.create(prototype === null ? null : Object.prototype) as JsonRecord;
  for (const key of actual) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid(`${field} changed while its members were snapshotted`);
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid(`${field} changed while its members were snapshotted`);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return snapshot;
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
  const copy: unknown[] = [];
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
    copy.push(descriptor.value);
  }
  return copy;
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

function nullableInstant(value: unknown, field: string): string | null {
  return value === null ? null : assertInstant(value, field);
}

function nullableSafeCode(value: unknown, field: string): string | null {
  return value === null ? null : assertSafeCode(value, field);
}

function decodeEventRow(
  rawValue: unknown,
  field: string,
  permittedTypes: readonly ReconciliationEventTypeV1[],
): DecodedEventV1 {
  const row = exactRecord(rawValue, EVENT_ROW_KEYS, field);
  const type = oneOf(row.type, permittedTypes, `${field}.type`);
  return {
    id: integer(row.id, `${field}.id`, 1, Number.MAX_SAFE_INTEGER),
    landingId: assertUuid(row.landing_id, `${field}.landing_id`),
    sequence: integer(row.sequence, `${field}.sequence`, 1, Number.MAX_SAFE_INTEGER),
    type,
    payload: decodeCanonicalLandingEventPayloadJsonV1(
      type,
      boundedJson(row.payload_json, `${field}.payload_json`),
    ) as ReconciliationEventPayloadV1,
    createdAt: assertInstant(row.created_at, `${field}.created_at`),
  };
}

function decodeSubject(rawAggregate: unknown): {
  readonly subject: SubjectOperationV1;
  readonly landingSha256: string;
  readonly reconciliationVersion: number;
  readonly settlementEvent: DecodedEventV1;
} {
  const rawSnapshot = exactRecord(rawAggregate, SUBJECT_AGGREGATE_KEYS, "subjectAggregate");
  const operationRow = exactRecord(
    rawSnapshot.operationRow,
    OPERATION_ROW_KEYS,
    "subjectAggregate.operationRow",
  );
  const operationEvents = denseArray(
    rawSnapshot.operationEvents,
    "subjectAggregate.operationEvents",
    2,
  ).map((event, index) =>
    exactRecord(event, EVENT_ROW_KEYS, `subjectAggregate.operationEvents[${index}]`),
  );
  const aggregate: JsonRecord = {
    ...rawSnapshot,
    operationRow,
    operationEvents,
  };
  const evidence = validatePersistedGitHubObjectsOperationV1(aggregate);
  if (!(evidence.status === "reconciliation_required" || evidence.status === "takeover")) {
    invalid("Object reconciliation subject is not one validated uncertain object operation");
  }
  const terminalEvidence = evidence as
    | PersistedGitHubObjectsSubjectReconciliationEvidenceV1
    | PersistedGitHubObjectsTakeoverEvidenceV1;
  const landingSha256 = assertSha256(aggregate.landingSha256, "subjectAggregate.landingSha256");
  const requestJson = boundedJson(
    operationRow.request_json,
    "subjectAggregate.operationRow.request_json",
  );
  const request = decodeCanonicalLandingJson(requestJson, decodeLandingOperationRequestV1);
  const requestSha256 = canonicalDigest(
    requestJson,
    operationRow.request_sha256,
    "subjectAggregate.operationRow.request_sha256",
  );
  const input = request.input as GitHubObjectsUploadInputV1;
  if (
    request.kind !== "github.objects.upload" ||
    request.operationId !== terminalEvidence.operationId ||
    requestSha256 !== terminalEvidence.operationRequestSha256 ||
    input.landingSha256 !== landingSha256 ||
    input.retrySubjectOperationId !== null ||
    input.retrySubjectRequestSha256 !== null ||
    operationRow.status !== "interrupted" ||
    terminalEvidence.result.outcome !== "reconciliation_required" ||
    terminalEvidence.result.value === null ||
    !("subjectOperationId" in terminalEvidence.result.value) ||
    terminalEvidence.result.value.subjectOperationId !== request.operationId ||
    terminalEvidence.result.value.remoteResidue !== "none"
  ) {
    invalid("Object reconciliation subject does not bind its immutable original operation");
  }
  if (operationEvents.length !== 2) {
    invalid("Object reconciliation subject lacks its exact settled operation events");
  }
  const settlementEvent = decodeEventRow(
    operationEvents[1],
    "subjectAggregate.operationEvents[1]",
    ["landing.operation.settled"],
  );
  const expectedSettlement: LandingOperationSettledEventV1 = {
    schemaVersion: 1,
    landingId: request.landingId,
    operationId: request.operationId,
    coordinatorAttempt: request.coordinatorAttempt,
    kind: "github.objects.upload",
    outcome: "reconciliation_required",
    resultSha256: terminalEvidence.resultSha256,
    errorCode: terminalEvidence.errorCode,
  };
  if (
    settlementEvent.landingId !== request.landingId ||
    !sameCanonical(settlementEvent.payload, expectedSettlement)
  ) {
    invalid("Object reconciliation subject settlement event is inconsistent");
  }
  const operationStartVersion = integer(
    aggregate.operationStartVersion,
    "subjectAggregate.operationStartVersion",
    0,
    Number.MAX_SAFE_INTEGER - 2,
  );
  const observationSha256 =
    operationRow.observation_sha256 === null
      ? null
      : assertSha256(
          operationRow.observation_sha256,
          "subjectAggregate.operationRow.observation_sha256",
        );
  const errorCode = assertSafeCode(
    operationRow.error_code,
    "subjectAggregate.operationRow.error_code",
  );
  if (
    errorCode !== terminalEvidence.errorCode ||
    assertUuid(operationRow.id, "subjectAggregate.operationRow.id") !== request.operationId ||
    assertUuid(operationRow.landing_id, "subjectAggregate.operationRow.landing_id") !==
      request.landingId ||
    integer(
      operationRow.coordinator_attempt,
      "subjectAggregate.operationRow.coordinator_attempt",
      1,
      8,
    ) !== request.coordinatorAttempt ||
    integer(operationRow.kind_attempt, "subjectAggregate.operationRow.kind_attempt", 1, 9) !==
      request.kindAttempt
  ) {
    invalid("Object reconciliation subject SQL identity is inconsistent");
  }
  return {
    subject: {
      id: request.operationId,
      landingId: request.landingId,
      coordinatorAttempt: request.coordinatorAttempt,
      kindAttempt: request.kindAttempt,
      request: request as SubjectOperationV1["request"],
      requestSha256,
      observationSha256,
      result: terminalEvidence.result,
      resultSha256: terminalEvidence.resultSha256,
      errorCode,
      effectfulPostAdmitted: terminalEvidence.exchanges.some(
        (exchange) => exchange.request.method === "POST",
      ),
    },
    landingSha256,
    reconciliationVersion: operationStartVersion + 2,
    settlementEvent,
  };
}

function decodeAttemptRow(
  rawValue: unknown,
  field: string,
  landingId: string,
): ReconciliationAttemptV1 {
  const row = exactRecord(rawValue, ATTEMPT_ROW_KEYS, field);
  const status = oneOf(
    row.status,
    ["started", "completed", "interrupted"] as const,
    `${field}.status`,
  );
  const startedAt = assertInstant(row.started_at, `${field}.started_at`);
  const finishedAt = nullableInstant(row.finished_at, `${field}.finished_at`);
  const errorCode = nullableSafeCode(row.error_code, `${field}.error_code`);
  if (
    (status === "started" && (finishedAt !== null || errorCode !== null)) ||
    (status === "completed" && (finishedAt === null || errorCode !== null)) ||
    (status === "interrupted" && (finishedAt === null || errorCode === null)) ||
    (finishedAt !== null && finishedAt < startedAt)
  ) {
    invalid(`${field} settlement columns disagree`);
  }
  const decodedLandingId = assertUuid(row.landing_id, `${field}.landing_id`);
  if (decodedLandingId !== landingId) invalid(`${field} belongs to another landing`);
  return {
    landingId: decodedLandingId,
    ordinal: integer(row.ordinal, `${field}.ordinal`, 1, 8),
    status,
    startedAt,
    finishedAt,
    errorCode,
  };
}

function subjectProjection(subject: SubjectOperationV1): unknown {
  return {
    schemaVersion: 1,
    operationId: subject.id,
    landingId: subject.landingId,
    coordinatorAttempt: subject.coordinatorAttempt,
    kind: "github.objects.upload",
    kindAttempt: subject.kindAttempt,
    status: "interrupted",
    requestSha256: subject.requestSha256,
    observationSha256: subject.observationSha256,
    resultSha256: subject.resultSha256,
    errorCode: subject.errorCode,
  };
}

function expectedObservation(
  operationId: string,
  subjectProjectionSha256: string,
): LandingOperationObservationV1 {
  return decodeLandingOperationObservationV1({
    schemaVersion: 1,
    operationId,
    kind: "landing.reconcile",
    phase: "reconciliation",
    facts: [
      {
        fact: "subject_operation",
        requestId: null,
        resultSha256: subjectProjectionSha256,
      },
    ],
  });
}

function decodeReconciliationOperationRow(
  rawValue: unknown,
  field: string,
  subject: SubjectOperationV1,
  landingSha256: string,
  reconciliationVersion: number,
  subjectProjectionSha256: string,
): ReconciliationOperationV1 {
  const row = exactRecord(rawValue, OPERATION_ROW_KEYS, field);
  const requestJson = boundedJson(row.request_json, `${field}.request_json`);
  const request = decodeCanonicalLandingJson(requestJson, decodeLandingOperationRequestV1);
  const requestSha256 = canonicalDigest(requestJson, row.request_sha256, `${field}.request_sha256`);
  const input = request.input as LandingReconcileInputV1;
  if (
    request.kind !== "landing.reconcile" ||
    request.expectedState !== "reconciliation_required" ||
    request.expectedVersion !== reconciliationVersion ||
    request.landingId !== subject.landingId ||
    input.landingSha256 !== landingSha256 ||
    input.resumeState !== "local_ready" ||
    input.subjectOperationId !== subject.id ||
    input.subjectRequestSha256 !== subject.requestSha256 ||
    input.subjectResultSha256 !== subject.resultSha256
  ) {
    invalid(`${field} does not bind the exact object reconciliation subject`);
  }
  const status = oneOf(
    row.status,
    ["started", "completed", "interrupted"] as const,
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
        : invalid(`${field} has an observation digest without bytes`)
      : canonicalDigest(observationJson, row.observation_sha256, `${field}.observation_sha256`);
  const canonicalObservation = expectedObservation(request.operationId, subjectProjectionSha256);
  if (observation !== null && !sameCanonical(observation, canonicalObservation)) {
    invalid(`${field} observation does not hash the settled original object subject`);
  }
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
        : invalid(`${field} has a result digest without bytes`)
      : canonicalDigest(resultJson, row.result_sha256, `${field}.result_sha256`);
  const errorCode = nullableSafeCode(row.error_code, `${field}.error_code`);
  const startedAt = assertInstant(row.started_at, `${field}.started_at`);
  const finishedAt = nullableInstant(row.finished_at, `${field}.finished_at`);
  if (finishedAt !== null && finishedAt < startedAt) invalid(`${field} finished before it started`);
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
  const expectedEvidence = observation?.facts ?? [];
  if (
    result !== null &&
    (result.operationId !== request.operationId ||
      result.kind !== "landing.reconcile" ||
      result.evidence.length !== expectedEvidence.length ||
      !result.evidence.every(
        (entry, index) =>
          entry.requestId === expectedEvidence[index]?.requestId &&
          entry.resultSha256 === expectedEvidence[index]?.resultSha256,
      ))
  ) {
    invalid(`${field} result evidence does not equal its exact observation`);
  }
  if (status === "started") {
    if (result !== null || resultSha256 !== null || errorCode !== null || finishedAt !== null) {
      invalid(`${field} started row contains settlement columns`);
    }
  } else if (status === "interrupted") {
    if (
      result?.outcome !== "reconciliation_required" ||
      result.boundary !== "reconciliation_required" ||
      result.value === null ||
      !("subjectOperationId" in result.value) ||
      result.value.subjectOperationId !== subject.id ||
      result.value.remoteResidue !== "none" ||
      resultSha256 === null ||
      errorCode === null ||
      result.errorCode !== errorCode ||
      finishedAt === null
    ) {
      invalid(`${field} interrupted row does not preserve the object subject`);
    }
  } else {
    if (
      result?.outcome !== "completed" ||
      resultSha256 === null ||
      errorCode !== null ||
      finishedAt === null
    ) {
      invalid(`${field} completed row has invalid settlement columns`);
    }
    if (result.boundary === "subject_settled") {
      invalid("Object subject_settled reconciliation lacks an accepted zero-HTTP proof");
    }
    if (
      result.boundary !== "retry_stage_proven" ||
      observation === null ||
      observationSha256 === null ||
      result.value === null ||
      !("nextState" in result.value) ||
      result.value.subjectOperationId !== subject.id ||
      result.value.nextState !== "local_ready" ||
      result.value.remoteResidue !== "none" ||
      result.value.stageValue !== null
    ) {
      invalid(`${field} completed row is not the exact local-ready retry proof`);
    }
  }
  return {
    id: request.operationId,
    landingId: request.landingId,
    coordinatorAttempt: request.coordinatorAttempt,
    kindAttempt: request.kindAttempt,
    status,
    request: request as ReconciliationOperationV1["request"],
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

function expectedAttemptStart(attempt: ReconciliationAttemptV1): LandingAttemptStartedEventV1 {
  return {
    schemaVersion: 1,
    landingId: attempt.landingId,
    coordinatorAttempt: attempt.ordinal,
  };
}

function expectedAttemptSettlement(attempt: ReconciliationAttemptV1): LandingAttemptSettledEventV1 {
  if (attempt.status === "started") return invalid("Started attempt has no settlement event");
  return {
    schemaVersion: 1,
    landingId: attempt.landingId,
    coordinatorAttempt: attempt.ordinal,
    outcome: attempt.status,
    errorCode: attempt.errorCode,
  };
}

function expectedOperationStart(
  operation: ReconciliationOperationV1,
): LandingOperationStartedEventV1 {
  return {
    schemaVersion: 1,
    landingId: operation.landingId,
    operationId: operation.id,
    coordinatorAttempt: operation.coordinatorAttempt,
    kind: "landing.reconcile",
    kindAttempt: operation.kindAttempt,
    requestSha256: operation.requestSha256,
  };
}

function expectedOperationSettlement(
  operation: ReconciliationOperationV1,
): LandingOperationSettledEventV1 {
  if (operation.result === null || operation.resultSha256 === null) {
    return invalid("Settled reconciliation operation has no canonical result");
  }
  return {
    schemaVersion: 1,
    landingId: operation.landingId,
    operationId: operation.id,
    coordinatorAttempt: operation.coordinatorAttempt,
    kind: "landing.reconcile",
    outcome: operation.result.outcome,
    resultSha256: operation.resultSha256,
    errorCode: operation.errorCode,
  };
}

function assertSubjectBoundary(
  subject: SubjectOperationV1,
  reconciliationVersion: number,
  subjectSettlement: DecodedEventV1,
  rawAttempt: unknown,
  rawAttemptSettlement: unknown,
  rawState: unknown,
): DecodedEventV1 {
  const attempt = decodeAttemptRow(rawAttempt, "subjectAttemptRow", subject.landingId);
  if (
    attempt.ordinal !== subject.coordinatorAttempt ||
    attempt.status !== "interrupted" ||
    attempt.errorCode !== subject.errorCode
  ) {
    invalid("Object subject attempt does not match its interrupted operation");
  }
  const attemptSettlement = decodeEventRow(
    rawAttemptSettlement,
    "subjectAttemptSettlementEventRow",
    ["landing.attempt.settled"],
  );
  const state = decodeEventRow(rawState, "subjectStateEventRow", ["landing.state.changed"]);
  const expectedAttempt = expectedAttemptSettlement(attempt);
  const expectedState: LandingStateChangedEventV1 = {
    schemaVersion: 1,
    landingId: subject.landingId,
    from: "uploading_objects",
    to: "reconciliation_required",
    version: reconciliationVersion,
    operationId: subject.id,
  };
  if (
    attemptSettlement.landingId !== subject.landingId ||
    state.landingId !== subject.landingId ||
    !sameCanonical(attemptSettlement.payload, expectedAttempt) ||
    !sameCanonical(state.payload, expectedState) ||
    attemptSettlement.sequence !== subjectSettlement.sequence + 1 ||
    state.sequence !== attemptSettlement.sequence + 1 ||
    attemptSettlement.id <= subjectSettlement.id ||
    state.id <= attemptSettlement.id
  ) {
    invalid("Object subject settlement/attempt/state events are not exactly adjacent");
  }
  return state;
}

function assertChainTopology(
  subject: SubjectOperationV1,
  reconciliationVersion: number,
  predecessor: DecodedEventV1,
  attempts: readonly ReconciliationAttemptV1[],
  operations: readonly ReconciliationOperationV1[],
  rawEvents: readonly unknown[],
): void {
  const expected: Array<{
    readonly type: ReconciliationEventTypeV1;
    readonly payload: ReconciliationEventPayloadV1;
  }> = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const attempt = attempts[index];
    if (operation === undefined || attempt === undefined) {
      invalid("Object reconciliation attempt/operation carrier lengths differ");
    }
    expected.push({ type: "landing.attempt.started", payload: expectedAttemptStart(attempt) });
    expected.push({
      type: "landing.operation.started",
      payload: expectedOperationStart(operation),
    });
    if (operation.status !== "started") {
      expected.push({
        type: "landing.operation.settled",
        payload: expectedOperationSettlement(operation),
      });
      expected.push({
        type: "landing.attempt.settled",
        payload: expectedAttemptSettlement(attempt),
      });
      if (operation.status === "completed") {
        expected.push({
          type: "landing.state.changed",
          payload: {
            schemaVersion: 1,
            landingId: subject.landingId,
            from: "reconciliation_required",
            to: "local_ready",
            version: reconciliationVersion + 1,
            operationId: operation.id,
          },
        });
      }
    }
  }
  if (rawEvents.length !== expected.length) {
    invalid("Object reconciliation event suffix has an omitted or extra event");
  }
  let prior = predecessor;
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index];
    if (wanted === undefined) invalid("Object reconciliation expected event vanished");
    const event = decodeEventRow(rawEvents[index], `reconciliationEventRows[${index}]`, [
      wanted.type,
    ]);
    if (
      event.landingId !== subject.landingId ||
      event.sequence !== prior.sequence + 1 ||
      event.id <= prior.id ||
      !sameCanonical(event.payload, wanted.payload)
    ) {
      invalid("Object reconciliation event suffix is gapped, reordered, or cross-correlated");
    }
    prior = event;
  }
}

function linkEvidence(
  operation: ReconciliationOperationV1,
): PersistedGitHubObjectsReconciliationLinkEvidenceV1 {
  return {
    operationId: operation.id,
    coordinatorAttempt: operation.coordinatorAttempt,
    kindAttempt: operation.kindAttempt,
    status: operation.status,
    requestSha256: operation.requestSha256,
    observationSha256: operation.observationSha256,
    resultSha256: operation.resultSha256,
    errorCode: operation.errorCode,
  };
}

/**
 * Validates one supplied zero-HTTP object reconciliation suffix.
 *
 * `reconciliationHttpRows` must be the caller's complete operation-scoped
 * query result and must be empty. `reconciliationEventRows` begins with the
 * first reconciliation attempt-started event; the subject operation-settled,
 * subject attempt-settled, and subject state-change predecessors are validated
 * separately and must be exactly adjacent. The returned retry subject is null
 * unless the internally revalidated original object aggregate admitted at
 * least one immutable-object POST. It is present only after an exact completed
 * `retry_stage_proven -> local_ready` suffix. The nested subject validator
 * currently proves only null-inherited object subjects; non-null inherited
 * retry ancestry is a fail-closed future generalization, not a null result.
 * This suffix proves only consecutive `kindAttempt` values after its first
 * link; the durable caller must bind that first value to the greatest earlier
 * landing-wide `landing.reconcile` ordinal.
 */
export function validatePersistedGitHubObjectsReconciliationV1(
  rawValue: unknown,
): PersistedGitHubObjectsReconciliationEvidenceV1 {
  const input = exactRecord(rawValue, INPUT_KEYS, "persistedObjectsReconciliation");
  const rawAttempts = denseArray(
    input.reconciliationAttemptRows,
    "reconciliationAttemptRows",
    MAX_RECONCILIATION_LINKS,
  );
  const rawOperations = denseArray(
    input.reconciliationOperationRows,
    "reconciliationOperationRows",
    MAX_RECONCILIATION_LINKS,
  );
  const rawHttpRows = denseArray(input.reconciliationHttpRows, "reconciliationHttpRows", 0);
  const rawEvents = denseArray(
    input.reconciliationEventRows,
    "reconciliationEventRows",
    MAX_RECONCILIATION_EVENTS,
  );
  if (rawHttpRows.length !== 0) {
    invalid("Object reconciliation owns an exact empty HTTP grammar");
  }
  if (
    rawAttempts.length === 0 ||
    rawAttempts.length !== rawOperations.length ||
    rawAttempts.length > MAX_RECONCILIATION_LINKS
  ) {
    invalid("Object reconciliation requires one bounded attempt/operation chain");
  }
  const { subject, landingSha256, reconciliationVersion, settlementEvent } = decodeSubject(
    input.subjectAggregate,
  );
  if (subject.coordinatorAttempt + rawOperations.length > 8) {
    invalid("Object reconciliation chain exceeds the coordinator attempt ceiling");
  }
  const predecessor = assertSubjectBoundary(
    subject,
    reconciliationVersion,
    settlementEvent,
    input.subjectAttemptRow,
    input.subjectAttemptSettlementEventRow,
    input.subjectStateEventRow,
  );
  const projectionSha256 = digestLandingRecord(subjectProjection(subject));
  const attempts = rawAttempts.map((row, index) =>
    decodeAttemptRow(row, `reconciliationAttemptRows[${index}]`, subject.landingId),
  );
  const operations = rawOperations.map((row, index) =>
    decodeReconciliationOperationRow(
      row,
      `reconciliationOperationRows[${index}]`,
      subject,
      landingSha256,
      reconciliationVersion,
      projectionSha256,
    ),
  );
  if (new Set(operations.map((operation) => operation.id)).size !== operations.length) {
    invalid("Object reconciliation chain reuses an operation identity");
  }
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const attempt = attempts[index];
    const prior = operations[index - 1];
    if (operation === undefined || attempt === undefined) {
      invalid("Object reconciliation chain member vanished");
    }
    const expectedAttempt = subject.coordinatorAttempt + index + 1;
    if (
      operation.coordinatorAttempt !== expectedAttempt ||
      attempt.ordinal !== expectedAttempt ||
      attempt.status !== operation.status ||
      attempt.errorCode !== operation.errorCode ||
      operation.startedAt < attempt.startedAt ||
      (operation.finishedAt !== null &&
        attempt.finishedAt !== null &&
        attempt.finishedAt < operation.finishedAt) ||
      (prior !== undefined && operation.kindAttempt !== prior.kindAttempt + 1)
    ) {
      invalid("Object reconciliation attempts, operations, or kind ordinals disagree");
    }
    const terminal = index === operations.length - 1;
    if (!terminal && operation.status !== "interrupted") {
      invalid("Only interrupted links may precede the terminal reconciliation link");
    }
  }
  assertChainTopology(subject, reconciliationVersion, predecessor, attempts, operations, rawEvents);
  const terminal = operations.at(-1);
  if (terminal === undefined) invalid("Object reconciliation terminal link is missing");
  const base: ProjectionBaseV1 = {
    subjectOperationId: subject.id,
    subjectRequestSha256: subject.requestSha256,
    subjectResultSha256: subject.resultSha256,
    effectfulPostAdmitted: subject.effectfulPostAdmitted,
    links: operations.map(linkEvidence),
  };
  if (terminal.status === "started") {
    return {
      ...base,
      status: "pending",
      operationId: terminal.id,
      observationPending: terminal.observation === null,
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    };
  }
  if (terminal.status === "interrupted") {
    if (terminal.result === null || terminal.resultSha256 === null || terminal.errorCode === null) {
      return invalid("Interrupted object reconciliation terminal lacks exact result evidence");
    }
    return {
      ...base,
      status: "reconciliation_required",
      operationId: terminal.id,
      errorCode: terminal.errorCode,
      result: terminal.result,
      resultSha256: terminal.resultSha256,
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    };
  }
  if (
    terminal.observation === null ||
    terminal.observationSha256 === null ||
    terminal.result === null ||
    terminal.resultSha256 === null
  ) {
    return invalid("Completed object reconciliation terminal lacks exact proof evidence");
  }
  return {
    ...base,
    status: "retry_stage_proven",
    operationId: terminal.id,
    nextState: "local_ready",
    observation: terminal.observation,
    observationSha256: terminal.observationSha256,
    result: terminal.result,
    resultSha256: terminal.resultSha256,
    retrySubjectOperationId: subject.effectfulPostAdmitted ? subject.id : null,
    retrySubjectRequestSha256: subject.effectfulPostAdmitted ? subject.requestSha256 : null,
  };
}
