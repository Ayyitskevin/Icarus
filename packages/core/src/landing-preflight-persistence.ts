/**
 * Pure persisted aggregate validation for the first GitHub preflight slice.
 *
 * This module correlates canonical SQLite-shaped rows and their exact
 * operation-owned events. It performs no database read, lease check,
 * credential resolution, filesystem access, or network operation. Its
 * projection is evidence about supplied records only and never authorizes a
 * request, retry, or provider effect.
 */
import { sha256 } from "./digest.js";
import { IcarusError } from "./errors.js";
import {
  type GitHubPreflightNextRequestV1,
  validateGitHubPreflightHttpHistoryV1,
} from "./landing-http-history.js";
import {
  decodePersistedGitHubPreflightHttpExchangeV1,
  type PersistedGitHubPreflightHttpExchangeV1,
} from "./landing-http-persistence.js";
import {
  assertInstant,
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
} from "./landing-records.js";

type JsonRecord = Record<string, unknown>;

const TAKEOVER_ERROR_CODE = "LANDING_COORDINATOR_TAKEOVER" as const;

const INPUT_KEYS = [
  "landing",
  "landingSha256",
  "operationStartState",
  "operationStartVersion",
  "operationRow",
  "previousRequestOrdinal",
  "httpRows",
  "requestEvents",
  "operationEvents",
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

type PersistedPreflightOperationStatus = "started" | "completed" | "failed" | "interrupted";

interface PersistedPreflightOperationV1 {
  readonly id: string;
  readonly landingId: string;
  readonly coordinatorAttempt: number;
  readonly kindAttempt: number;
  readonly status: PersistedPreflightOperationStatus;
  readonly request: LandingOperationRequestV1 & {
    readonly kind: "github.preflight";
    readonly expectedState: "local_ready";
    readonly input: GitHubPreflightInputV1 & {
      readonly includePullRequestAbsence: false;
    };
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

type RequestEventPayload = LandingGitHubRequestAdmittedEventV1 | LandingGitHubRequestSettledEventV1;
type OperationEventPayload = LandingOperationStartedEventV1 | LandingOperationSettledEventV1;

interface DecodedEventV1<TPayload extends RequestEventPayload | OperationEventPayload> {
  readonly id: number;
  readonly landingId: string;
  readonly sequence: number;
  readonly type:
    | "landing.github.request.admitted"
    | "landing.github.request.settled"
    | "landing.operation.started"
    | "landing.operation.settled";
  readonly payload: TPayload;
  readonly createdAt: string;
}

interface ProjectionBaseV1 {
  readonly operationId: string;
  readonly operationRequestSha256: string;
  readonly exchanges: readonly PersistedGitHubPreflightHttpExchangeV1[];
}

export interface PersistedGitHubPreflightNextRequestEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "next_request";
  readonly nextRequest: GitHubPreflightNextRequestV1;
}

export interface PersistedGitHubPreflightAdmittedEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "admitted";
  readonly request: LandingHttpRequestV1 & { readonly operationKind: "github.preflight" };
  readonly requestSha256: string;
}

export interface PersistedGitHubPreflightCompleteEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "complete";
  readonly observation: LandingOperationObservationV1;
  readonly observationSha256: string;
  readonly result: LandingOperationResultV1;
  readonly resultSha256: string;
}

export interface PersistedGitHubPreflightTerminalEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "terminal";
  readonly httpOutcome: "failed" | "ambiguous";
  readonly operationOutcome: "failed" | "interrupted";
  readonly errorCode: string;
  readonly result: LandingOperationResultV1;
  readonly resultSha256: string;
}

export interface PersistedGitHubPreflightTakeoverEvidenceV1 extends ProjectionBaseV1 {
  readonly status: "takeover";
  readonly operationOutcome: "interrupted";
  readonly errorCode: typeof TAKEOVER_ERROR_CODE;
  readonly result: LandingOperationResultV1;
  readonly resultSha256: string;
}

export type PersistedGitHubPreflightEvidenceV1 =
  | PersistedGitHubPreflightNextRequestEvidenceV1
  | PersistedGitHubPreflightAdmittedEvidenceV1
  | PersistedGitHubPreflightCompleteEvidenceV1
  | PersistedGitHubPreflightTerminalEvidenceV1
  | PersistedGitHubPreflightTakeoverEvidenceV1;

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
  if (!Number.isSafeInteger(length) || length < 0) {
    return invalid(`${field} must expose a bounded nonnegative length`);
  }
  if (length > maximum) return invalid(`${field} exceeds its fixed bound`);
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

function text(value: unknown, field: string): string {
  return typeof value === "string" ? value : invalid(`${field} must be text`);
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

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}

function canonicalDigest(encoded: string, digest: unknown, field: string): string {
  const decoded = assertSha256(digest, field);
  if (sha256(encoded) !== decoded) return invalid(`${field} does not match canonical bytes`);
  return decoded;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalLandingJson(left) === canonicalLandingJson(right);
}

function decodeOperationRow(
  rawValue: unknown,
  landing: LandingDigestV1,
  landingSha256: string,
): PersistedPreflightOperationV1 {
  const row = exactRecord(rawValue, OPERATION_ROW_KEYS, "landingOperation");
  const requestJson = text(row.request_json, "landing_operations.request_json");
  const request = decodeCanonicalLandingJson(requestJson, decodeLandingOperationRequestV1);
  const requestSha256 = canonicalDigest(
    requestJson,
    row.request_sha256,
    "landing_operations.request_sha256",
  );
  if (
    request.kind !== "github.preflight" ||
    request.expectedState !== "local_ready" ||
    (request.input as GitHubPreflightInputV1).includePullRequestAbsence !== false
  ) {
    invalid("Persisted preflight operation is outside the local-ready first slice");
  }
  const input = request.input as GitHubPreflightInputV1;
  if (
    request.landingId !== landing.landingId ||
    input.landingSha256 !== landingSha256 ||
    input.profileSha256 !== landing.profileSha256 ||
    input.baseRef !== landing.baseRef ||
    input.expectedRemoteBaseSha1 !== landing.expectedRemoteBaseSha1 ||
    input.headRef !== landing.headRef ||
    input.candidateCommitSha1 !== landing.candidateCommitSha1
  ) {
    invalid("Persisted preflight operation does not bind immutable landing authority");
  }

  const status = oneOf(
    row.status,
    ["started", "completed", "failed", "interrupted"] as const,
    "landing_operations.status",
  );
  const observationJson = nullableText(row.observation_json, "landing_operations.observation_json");
  const observation =
    observationJson === null
      ? null
      : decodeCanonicalLandingJson(observationJson, decodeLandingOperationObservationV1);
  const observationSha256 =
    observationJson === null
      ? row.observation_sha256 === null
        ? null
        : invalid("Landing operation has observation digest without canonical bytes")
      : canonicalDigest(
          observationJson,
          row.observation_sha256,
          "landing_operations.observation_sha256",
        );
  const resultJson = nullableText(row.result_json, "landing_operations.result_json");
  const result =
    resultJson === null
      ? null
      : decodeCanonicalLandingJson(resultJson, decodeLandingOperationResultV1);
  const resultSha256 =
    resultJson === null
      ? row.result_sha256 === null
        ? null
        : invalid("Landing operation has result digest without canonical bytes")
      : canonicalDigest(resultJson, row.result_sha256, "landing_operations.result_sha256");
  const errorCode = nullableText(row.error_code, "landing_operations.error_code");
  const startedAt = assertInstant(row.started_at, "landing_operations.started_at");
  const finishedAt =
    row.finished_at === null
      ? null
      : assertInstant(row.finished_at, "landing_operations.finished_at");
  if (finishedAt !== null && finishedAt < startedAt) {
    invalid("Landing operation finished before it started");
  }
  if (
    assertUuid(row.id, "landing_operations.id") !== request.operationId ||
    assertUuid(row.landing_id, "landing_operations.landing_id") !== request.landingId ||
    integer(row.coordinator_attempt, "landing_operations.coordinator_attempt", 1, 8) !==
      request.coordinatorAttempt ||
    row.kind !== request.kind ||
    integer(row.kind_attempt, "landing_operations.kind_attempt", 1, 9) !== request.kindAttempt
  ) {
    invalid("Landing operation SQL identity columns do not match canonical request bytes");
  }

  if (status === "started") {
    if (
      observation !== null ||
      observationSha256 !== null ||
      result !== null ||
      resultSha256 !== null ||
      errorCode !== null ||
      finishedAt !== null
    ) {
      invalid("Started preflight operation contains settlement or observation columns");
    }
  } else if (
    result === null ||
    resultSha256 === null ||
    finishedAt === null ||
    result.operationId !== request.operationId ||
    result.kind !== request.kind ||
    (status === "completed" && (result.outcome !== "completed" || errorCode !== null)) ||
    (status === "failed" &&
      (result.outcome !== "failed" || errorCode === null || result.errorCode !== errorCode)) ||
    (status === "interrupted" &&
      (result.outcome !== "interrupted" || errorCode === null || result.errorCode !== errorCode))
  ) {
    invalid("Settled preflight operation columns do not match canonical result bytes");
  }

  return {
    id: request.operationId,
    landingId: request.landingId,
    coordinatorAttempt: request.coordinatorAttempt,
    kindAttempt: request.kindAttempt,
    status,
    request: request as PersistedPreflightOperationV1["request"],
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

function decodeEventRow<TPayload extends RequestEventPayload | OperationEventPayload>(
  rawValue: unknown,
  index: number,
  permittedTypes: readonly DecodedEventV1<TPayload>["type"][],
  fieldPrefix: string,
): DecodedEventV1<TPayload> {
  const field = `${fieldPrefix}[${index}]`;
  const row = exactRecord(rawValue, EVENT_ROW_KEYS, field);
  const type = oneOf(row.type, permittedTypes, `${field}.type`);
  return {
    id: integer(row.id, `${field}.id`, 1, Number.MAX_SAFE_INTEGER),
    landingId: assertUuid(row.landing_id, `${field}.landing_id`),
    sequence: integer(row.sequence, `${field}.sequence`, 1, Number.MAX_SAFE_INTEGER),
    type,
    payload: decodeCanonicalLandingEventPayloadJsonV1(
      type,
      text(row.payload_json, `${field}.payload_json`),
    ) as TPayload,
    createdAt: assertInstant(row.created_at, `${field}.created_at`),
  };
}

function assertStrictEventOrder(
  events: readonly DecodedEventV1<RequestEventPayload | OperationEventPayload>[],
  field: string,
): void {
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (
      previous === undefined ||
      current === undefined ||
      current.sequence <= previous.sequence ||
      current.id <= previous.id
    ) {
      invalid(`${field} are not in strict persisted order`);
    }
  }
}

function expectedOperationStart(
  operation: PersistedPreflightOperationV1,
): LandingOperationStartedEventV1 {
  return {
    schemaVersion: 1,
    landingId: operation.landingId,
    operationId: operation.id,
    coordinatorAttempt: operation.coordinatorAttempt,
    kind: "github.preflight",
    kindAttempt: operation.kindAttempt,
    requestSha256: operation.requestSha256,
  };
}

function expectedOperationSettlement(
  operation: PersistedPreflightOperationV1,
): LandingOperationSettledEventV1 {
  if (operation.result === null || operation.resultSha256 === null) {
    return invalid("Settled preflight operation has no canonical result");
  }
  return {
    schemaVersion: 1,
    landingId: operation.landingId,
    operationId: operation.id,
    coordinatorAttempt: operation.coordinatorAttempt,
    kind: "github.preflight",
    outcome: operation.result.outcome,
    resultSha256: operation.resultSha256,
    errorCode: operation.errorCode,
  };
}

function decodeOperationEvents(
  rawEvents: readonly unknown[],
  operation: PersistedPreflightOperationV1,
): readonly DecodedEventV1<OperationEventPayload>[] {
  const expectedCount = operation.status === "started" ? 1 : 2;
  if (rawEvents.length !== expectedCount) {
    invalid("Preflight operation does not have its exact start/settlement event count");
  }
  const events = rawEvents.map((event, index) =>
    decodeEventRow<OperationEventPayload>(
      event,
      index,
      ["landing.operation.started", "landing.operation.settled"],
      "operationEvents",
    ),
  );
  assertStrictEventOrder(events, "Preflight operation events");
  const start = events[0];
  if (
    start === undefined ||
    start.type !== "landing.operation.started" ||
    start.landingId !== operation.landingId ||
    !sameCanonical(start.payload, expectedOperationStart(operation))
  ) {
    invalid("Preflight operation start event does not match its persisted row");
  }
  if (operation.status !== "started") {
    const settlement = events[1];
    if (
      settlement === undefined ||
      settlement.type !== "landing.operation.settled" ||
      settlement.landingId !== operation.landingId ||
      !sameCanonical(settlement.payload, expectedOperationSettlement(operation))
    ) {
      invalid("Preflight operation settlement event does not match its persisted row");
    }
  }
  return events;
}

function decodeRequestEvents(
  rawEvents: readonly unknown[],
  operation: PersistedPreflightOperationV1,
): readonly DecodedEventV1<RequestEventPayload>[] {
  const events = rawEvents.map((event, index) =>
    decodeEventRow<RequestEventPayload>(
      event,
      index,
      ["landing.github.request.admitted", "landing.github.request.settled"],
      "requestEvents",
    ),
  );
  assertStrictEventOrder(events, "Preflight request events");
  for (const event of events) {
    if (
      event.landingId !== operation.landingId ||
      event.payload.landingId !== operation.landingId ||
      event.payload.operationId !== operation.id ||
      event.payload.coordinatorAttempt !== operation.coordinatorAttempt ||
      event.payload.operationKind !== "github.preflight"
    ) {
      invalid("Preflight request event crosses its owning operation identity");
    }
  }
  return events;
}

function requestIdFromEvent(event: DecodedEventV1<RequestEventPayload>): string {
  return event.payload.requestId;
}

function compareNextRequest(
  request: LandingHttpRequestV1,
  expected: GitHubPreflightNextRequestV1,
): void {
  const { requestId: _requestId, ...descriptor } = request;
  if (!sameCanonical(descriptor, expected)) {
    invalid("Persisted preflight request does not match its exact grammar position");
  }
}

function operationHistoryInput(
  landing: LandingDigestV1,
  landingSha256: string,
  operation: PersistedPreflightOperationV1,
  previousRequestOrdinal: number,
  exchanges: readonly PersistedGitHubPreflightHttpExchangeV1[],
): unknown {
  return {
    landing,
    landingSha256,
    operation: operation.request,
    operationRequestSha256: operation.requestSha256,
    previousRequestOrdinal,
    exchanges: exchanges.map((exchange) => {
      if (exchange.status !== "settled") {
        return invalid("Only settled requests can enter preflight history evidence");
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

function terminalOperationResult(
  operation: PersistedPreflightOperationV1,
  exchanges: readonly PersistedGitHubPreflightHttpExchangeV1[],
): LandingOperationResultV1 {
  const tail = exchanges.at(-1);
  if (tail === undefined || tail.status !== "settled" || tail.result.outcome === "succeeded") {
    return invalid("Terminal preflight topology has no failed or ambiguous request");
  }
  const outcome = tail.result.outcome === "failed" ? "failed" : "interrupted";
  return decodeLandingOperationResultV1({
    schemaVersion: 1,
    operationId: operation.id,
    kind: "github.preflight",
    outcome,
    boundary: outcome === "failed" ? "operation_failed" : "operation_interrupted",
    evidence: exchanges.map((exchange) => {
      if (exchange.status !== "settled") {
        return invalid("Terminal preflight evidence contains an admitted request");
      }
      return { requestId: exchange.request.requestId, resultSha256: exchange.resultSha256 };
    }),
    value: null,
    errorCode: tail.result.errorCode,
  });
}

function takeoverOperationResult(
  operation: PersistedPreflightOperationV1,
  exchanges: readonly PersistedGitHubPreflightHttpExchangeV1[],
): LandingOperationResultV1 {
  return decodeLandingOperationResultV1({
    schemaVersion: 1,
    operationId: operation.id,
    kind: "github.preflight",
    outcome: "interrupted",
    boundary: "operation_interrupted",
    evidence: exchanges.map((exchange) => {
      if (exchange.status !== "settled") {
        return invalid("Takeover preflight evidence contains an admitted request");
      }
      return { requestId: exchange.request.requestId, resultSha256: exchange.resultSha256 };
    }),
    value: null,
    errorCode: TAKEOVER_ERROR_CODE,
  });
}

function projectTakeover(
  base: ProjectionBaseV1,
  operation: PersistedPreflightOperationV1,
  exchanges: readonly PersistedGitHubPreflightHttpExchangeV1[],
): PersistedGitHubPreflightTakeoverEvidenceV1 {
  const expected = takeoverOperationResult(operation, exchanges);
  if (
    operation.status !== "interrupted" ||
    operation.observation !== null ||
    operation.observationSha256 !== null ||
    operation.result === null ||
    operation.resultSha256 === null ||
    operation.errorCode !== TAKEOVER_ERROR_CODE ||
    !sameCanonical(operation.result, expected) ||
    operation.resultSha256 !== digestLandingRecord(expected)
  ) {
    invalid("Takeover preflight operation does not exactly settle its persisted prefix");
  }
  return {
    ...base,
    status: "takeover",
    operationOutcome: "interrupted",
    errorCode: TAKEOVER_ERROR_CODE,
    result: operation.result,
    resultSha256: operation.resultSha256,
  };
}

function assertEventTopology(
  operationEvents: readonly DecodedEventV1<OperationEventPayload>[],
  requestEvents: readonly DecodedEventV1<RequestEventPayload>[],
  exchanges: readonly PersistedGitHubPreflightHttpExchangeV1[],
): void {
  const start = operationEvents[0];
  if (start === undefined) invalid("Preflight operation start event is missing");
  const expected: Array<{
    readonly type: DecodedEventV1<RequestEventPayload | OperationEventPayload>["type"];
    readonly requestId: string | null;
  }> = [{ type: "landing.operation.started", requestId: null }];
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
  const combined = [...operationEvents, ...requestEvents].sort(
    (left, right) => left.sequence - right.sequence,
  );
  if (combined.length !== expected.length) {
    invalid("Preflight event stream has an omitted or extra operation-owned event");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const event = combined[index];
    const wanted = expected[index];
    if (
      event === undefined ||
      wanted === undefined ||
      event.sequence !== start.sequence + index ||
      event.type !== wanted.type ||
      (wanted.requestId !== null &&
        (event.type === "landing.operation.started" ||
          event.type === "landing.operation.settled" ||
          requestIdFromEvent(event as DecodedEventV1<RequestEventPayload>) !== wanted.requestId))
    ) {
      invalid("Preflight event stream is gapped, reordered, or cross-correlated");
    }
    if (index > 0 && (combined[index - 1]?.id ?? 0) >= event.id) {
      invalid("Preflight event insertion identities are reordered");
    }
  }
}

/**
 * Validates one supplied local-ready GitHub preflight persisted aggregate.
 *
 * `previousRequestOrdinal` must be derived by the store from all earlier HTTP
 * rows in the same coordinator attempt. This component cannot prove query
 * completeness, current/final SQL landing state, resume/error/version fields,
 * global kind-attempt or operation ordering, owning attempt rows/events,
 * terminal state-change events, SQLite transaction grouping, or a continuously
 * held run lease; callers must establish those independently.
 * `operationStartState` and `operationStartVersion` are chronological replay
 * inputs at the operation-start event, not claims about current landing state.
 * The returned discriminant is evidence only, never request or retry authority.
 *
 * Ordinary terminal settlement maps a failed GET to a failed operation and an
 * ambiguous GET to an interrupted operation using the same terminal error. A
 * takeover is separately recognizable only as an exact interrupted operation
 * over either an incomplete successful GET prefix or that prefix followed by
 * the canonical ambiguous settlement of the request admitted before restart.
 * This projection remains evidence only and grants no request or retry.
 */
export function validatePersistedGitHubPreflightOperationV1(
  rawValue: unknown,
): PersistedGitHubPreflightEvidenceV1 {
  const input = exactRecord(rawValue, INPUT_KEYS, "persistedPreflight");
  const rawHttpRows = denseArray(input.httpRows, "httpRows", 3);
  const rawRequestEvents = denseArray(input.requestEvents, "requestEvents", 6);
  const rawOperationEvents = denseArray(input.operationEvents, "operationEvents", 2);
  const landing = decodeLandingDigestV1(input.landing);
  const landingSha256 = assertSha256(input.landingSha256, "persistedPreflight.landingSha256");
  if (digestLandingRecord(landing) !== landingSha256) {
    invalid("Persisted preflight landing digest does not match canonical authority");
  }
  if (input.operationStartState !== "local_ready") {
    invalid("Persisted preflight requires a replay-derived local-ready operation start");
  }
  const operationStartVersion = integer(
    input.operationStartVersion,
    "persistedPreflight.operationStartVersion",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const previousRequestOrdinal = integer(
    input.previousRequestOrdinal,
    "persistedPreflight.previousRequestOrdinal",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const operation = decodeOperationRow(input.operationRow, landing, landingSha256);
  if (operation.request.expectedVersion !== operationStartVersion) {
    invalid("Persisted preflight operation expects a different replayed start version");
  }
  const operationEvents = decodeOperationEvents(rawOperationEvents, operation);
  const requestEvents = decodeRequestEvents(rawRequestEvents, operation);

  const eventGroups = new Map<string, unknown[]>();
  for (let index = 0; index < requestEvents.length; index += 1) {
    const event = requestEvents[index];
    const rawEvent = rawRequestEvents[index];
    if (event === undefined || rawEvent === undefined) invalid("Preflight request event vanished");
    const group = eventGroups.get(requestIdFromEvent(event)) ?? [];
    group.push(rawEvent);
    eventGroups.set(requestIdFromEvent(event), group);
  }

  const exchanges = rawHttpRows.map((rawRow, index) =>
    exactRecord(rawRow, HTTP_ROW_KEYS, `httpRows[${index}]`),
  );
  // Decode request IDs without trusting a partial SQL projection: the stable
  // row decoder below remains the authority for the exact HTTP row shape.
  const decodedExchanges: PersistedGitHubPreflightHttpExchangeV1[] = [];
  const seenRequestIds = new Set<string>();
  for (const rawRow of exchanges) {
    const candidate = rawRow as JsonRecord;
    const requestId = assertUuid(candidate.id, "landing_http_requests.id");
    if (seenRequestIds.has(requestId)) invalid("Preflight HTTP history reuses a request ID");
    seenRequestIds.add(requestId);
    const events = eventGroups.get(requestId);
    if (events === undefined) invalid("Preflight HTTP row has no exact request events");
    decodedExchanges.push(decodePersistedGitHubPreflightHttpExchangeV1(rawRow, events));
    eventGroups.delete(requestId);
  }
  if (eventGroups.size !== 0) {
    invalid("Preflight request event has no persisted HTTP source row");
  }

  let terminalIndex: number | null = null;
  let admittedIndex: number | null = null;
  for (let index = 0; index < decodedExchanges.length; index += 1) {
    const exchange = decodedExchanges[index];
    if (exchange === undefined) invalid("Preflight HTTP exchange vanished");
    if (
      exchange.request.landingId !== operation.landingId ||
      exchange.request.operationId !== operation.id ||
      exchange.request.coordinatorAttempt !== operation.coordinatorAttempt ||
      exchange.request.operationKind !== "github.preflight"
    ) {
      invalid("Preflight HTTP row crosses its owning operation identity");
    }
    if (exchange.request.requestOrdinal !== previousRequestOrdinal + index + 1) {
      invalid("Preflight HTTP request ordinals are gapped or reordered");
    }
    if (exchange.status === "admitted") {
      if (
        admittedIndex !== null ||
        terminalIndex !== null ||
        index !== decodedExchanges.length - 1
      ) {
        invalid("Preflight has more than one or a non-trailing admitted request");
      }
      admittedIndex = index;
    } else if (exchange.result.outcome !== "succeeded") {
      if (
        terminalIndex !== null ||
        admittedIndex !== null ||
        index !== decodedExchanges.length - 1
      ) {
        invalid("Preflight has a non-trailing failed or ambiguous settlement");
      }
      terminalIndex = index;
    }
  }

  assertEventTopology(operationEvents, requestEvents, decodedExchanges);
  const settledSuccesses = decodedExchanges.slice(
    0,
    admittedIndex ?? terminalIndex ?? decodedExchanges.length,
  );
  if (
    settledSuccesses.some(
      (exchange) => exchange.status !== "settled" || exchange.result.outcome !== "succeeded",
    )
  ) {
    invalid("Preflight history before its tail is not an exact successful prefix");
  }
  const history = validateGitHubPreflightHttpHistoryV1(
    operationHistoryInput(
      landing,
      landingSha256,
      operation,
      previousRequestOrdinal,
      settledSuccesses,
    ),
  );
  const base: ProjectionBaseV1 = {
    operationId: operation.id,
    operationRequestSha256: operation.requestSha256,
    exchanges: decodedExchanges,
  };
  const isTakeover =
    operation.status === "interrupted" && operation.errorCode === TAKEOVER_ERROR_CODE;

  if (admittedIndex !== null) {
    if (operation.status !== "started" || history.status !== "next_request") {
      invalid("Admitted preflight tail is not owned by a started next-request topology");
    }
    const admitted = decodedExchanges[admittedIndex];
    if (admitted === undefined || admitted.status !== "admitted") {
      return invalid("Admitted preflight tail is missing");
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
    if (history.status !== "next_request" || operation.observation !== null) {
      invalid("Terminal preflight does not follow one exact incomplete successful prefix");
    }
    const terminal = decodedExchanges[terminalIndex];
    if (terminal === undefined || terminal.status !== "settled") {
      return invalid("Terminal preflight request is missing");
    }
    compareNextRequest(terminal.request, history.nextRequest);
    if (isTakeover) {
      if (
        terminal.result.outcome !== "ambiguous" ||
        terminal.result.errorCode !== "GITHUB_OUTCOME_AMBIGUOUS"
      ) {
        invalid("Takeover preflight tail is not the canonical ambiguous request settlement");
      }
      return projectTakeover(base, operation, decodedExchanges);
    }
    const expected = terminalOperationResult(operation, decodedExchanges);
    const expectedStatus = terminal.result.outcome === "failed" ? "failed" : "interrupted";
    if (
      operation.status !== expectedStatus ||
      operation.result === null ||
      operation.resultSha256 === null ||
      operation.errorCode !== terminal.result.errorCode ||
      !sameCanonical(operation.result, expected) ||
      operation.resultSha256 !== digestLandingRecord(expected)
    ) {
      invalid("Terminal preflight operation does not exactly settle its HTTP evidence");
    }
    return {
      ...base,
      status: "terminal",
      httpOutcome: terminal.result.outcome as "failed" | "ambiguous",
      operationOutcome: expected.outcome as "failed" | "interrupted",
      errorCode:
        operation.errorCode ?? invalid("Terminal preflight operation has no safe error code"),
      result: operation.result,
      resultSha256: operation.resultSha256,
    };
  }

  if (isTakeover) {
    if (history.status !== "next_request") {
      invalid("Takeover preflight cannot interrupt a complete successful history");
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
      invalid("Complete preflight HTTP history is not exactly reflected by its operation rows");
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
    invalid("Incomplete successful preflight prefix does not have started topology");
  }
  return { ...base, status: "next_request", nextRequest: history.nextRequest };
}
