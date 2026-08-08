/**
 * Pure ADR 0027 persisted HTTP-row correlation.
 *
 * This decoder proves that one SQLite-shaped `landing_http_requests` row and
 * its supplied request events are canonical and mutually consistent. It does
 * not prove that the rows came from SQLite, that the event query was complete,
 * that global event/request ordinals are contiguous, or that an owning
 * operation, attempt, run lease, or landing aggregate is valid. Those are
 * separate store/aggregate responsibilities.
 */
import { sha256 } from "./digest.js";
import { IcarusError } from "./errors.js";
import {
  assertInstant,
  assertSha256,
  assertUuid,
  canonicalLandingJson,
  decodeCanonicalLandingEventPayloadJsonV1,
  decodeCanonicalLandingJson,
  decodeLandingHttpRequestV1,
  decodeLandingHttpResultV1,
  type LandingGitHubRequestAdmittedEventV1,
  type LandingGitHubRequestSettledEventV1,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
} from "./landing-records.js";

type JsonRecord = Record<string, unknown>;

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

export interface PersistedGitHubPreflightHttpAdmittedV1 {
  readonly status: "admitted";
  readonly request: LandingHttpRequestV1 & { readonly operationKind: "github.preflight" };
  readonly requestSha256: string;
}

export interface PersistedGitHubPreflightHttpSettledV1 {
  readonly status: "settled";
  readonly request: LandingHttpRequestV1 & { readonly operationKind: "github.preflight" };
  readonly requestSha256: string;
  readonly result: LandingHttpResultV1;
  readonly resultSha256: string;
}

export type PersistedGitHubPreflightHttpExchangeV1 =
  | PersistedGitHubPreflightHttpAdmittedV1
  | PersistedGitHubPreflightHttpSettledV1;

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

function text(value: unknown, field: string): string {
  if (typeof value !== "string") return invalid(`${field} must be text`);
  return value;
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

function nullableInteger(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field, 100, 599);
}

function canonicalDigest(encoded: string, digest: unknown, field: string): string {
  const decoded = assertSha256(digest, field);
  if (sha256(encoded) !== decoded) return invalid(`${field} does not match canonical bytes`);
  return decoded;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalLandingJson(left) === canonicalLandingJson(right);
}

function assertSucceededProjectionMatchesSubject(
  request: LandingHttpRequestV1,
  result: LandingHttpResultV1,
): void {
  if (result.outcome !== "succeeded") return;
  const projection = result.projection;
  switch (request.kind) {
    case "github.actor.get":
      if (projection?.type !== "actor" || projection.login !== request.subject.expectedActor) {
        invalid("Succeeded GitHub actor projection does not match its admitted subject");
      }
      return;
    case "github.base_ref.get":
      if (
        projection?.type !== "ref" ||
        projection.state !== "direct" ||
        projection.ref !== request.subject.baseRef ||
        projection.sha1 !== request.subject.expectedSha1
      ) {
        invalid("Succeeded GitHub base-ref projection does not match its admitted subject");
      }
      return;
    case "github.head_ref.get":
      if (
        projection?.type !== "ref" ||
        projection.ref !== request.subject.headRef ||
        (projection.state === "direct" && projection.sha1 !== request.subject.expectedSha1)
      ) {
        invalid("Succeeded GitHub head-ref projection does not match its admitted subject");
      }
      return;
    case "github.pull_requests.get":
      if (
        projection?.type !== "pull_request_list" ||
        projection.objects.some(
          (pullRequest) =>
            pullRequest.owner !== request.subject.owner ||
            pullRequest.repository !== request.subject.repository ||
            pullRequest.headOwner !== request.subject.headOwner ||
            pullRequest.headRef !== request.subject.headRef ||
            pullRequest.baseRef !== request.subject.baseBranch,
        )
      ) {
        invalid("Succeeded GitHub pull-request list does not match its admitted subject");
      }
      return;
    default:
      invalid("Persisted GitHub preflight request has an unsupported HTTP kind");
  }
}

interface DecodedEventRow {
  readonly id: number;
  readonly landingId: string;
  readonly sequence: number;
  readonly type: "landing.github.request.admitted" | "landing.github.request.settled";
  readonly payload: LandingGitHubRequestAdmittedEventV1 | LandingGitHubRequestSettledEventV1;
  readonly createdAt: string;
}

function decodeEventRow(value: unknown, index: number): DecodedEventRow {
  const field = `landingEvents[${index}]`;
  const row = exactRecord(value, EVENT_ROW_KEYS, field);
  const type = oneOf(
    row.type,
    ["landing.github.request.admitted", "landing.github.request.settled"] as const,
    `${field}.type`,
  );
  const payloadJson = text(row.payload_json, `${field}.payload_json`);
  return {
    id: integer(row.id, `${field}.id`, 1, Number.MAX_SAFE_INTEGER),
    landingId: assertUuid(row.landing_id, `${field}.landing_id`),
    sequence: integer(row.sequence, `${field}.sequence`, 1, Number.MAX_SAFE_INTEGER),
    type,
    payload: decodeCanonicalLandingEventPayloadJsonV1(type, payloadJson) as
      | LandingGitHubRequestAdmittedEventV1
      | LandingGitHubRequestSettledEventV1,
    createdAt: assertInstant(row.created_at, `${field}.created_at`),
  };
}

function expectedAdmission(
  request: LandingHttpRequestV1,
  requestSha256: string,
): LandingGitHubRequestAdmittedEventV1 {
  return {
    schemaVersion: 1,
    landingId: request.landingId,
    operationId: request.operationId,
    requestId: request.requestId,
    coordinatorAttempt: request.coordinatorAttempt,
    operationKind: request.operationKind,
    requestOrdinal: request.requestOrdinal,
    kind: request.kind,
    requestSha256,
  };
}

function expectedSettlement(
  request: LandingHttpRequestV1,
  result: LandingHttpResultV1,
  resultSha256: string,
): LandingGitHubRequestSettledEventV1 {
  return {
    schemaVersion: 1,
    landingId: request.landingId,
    operationId: request.operationId,
    requestId: request.requestId,
    coordinatorAttempt: request.coordinatorAttempt,
    operationKind: request.operationKind,
    requestOrdinal: request.requestOrdinal,
    kind: request.kind,
    outcome: result.outcome,
    resultSha256,
    errorCode: result.errorCode,
  };
}

function assertEvent(
  event: DecodedEventRow,
  type: DecodedEventRow["type"],
  landingId: string,
  expectedPayload: LandingGitHubRequestAdmittedEventV1 | LandingGitHubRequestSettledEventV1,
): void {
  if (
    event.type !== type ||
    event.landingId !== landingId ||
    event.payload.landingId !== landingId ||
    !sameCanonical(event.payload, expectedPayload)
  ) {
    invalid("Landing HTTP event does not match its persisted request row");
  }
}

/**
 * Strictly decodes one persisted `github.preflight` request and exactly its
 * supplied admitted event, plus its settled event when the row is settled.
 *
 * The caller must obtain the full row with `SELECT *`-equivalent columns and
 * supply a complete row-specific event selection in ascending event sequence.
 * This pure component performs no database, lease, credential, filesystem, or
 * network operation and does not authorize a next request.
 */
export function decodePersistedGitHubPreflightHttpExchangeV1(
  rawHttpRow: unknown,
  rawEventRows: readonly unknown[],
): PersistedGitHubPreflightHttpExchangeV1 {
  const row = exactRecord(rawHttpRow, HTTP_ROW_KEYS, "landingHttpRequest");
  const requestJson = text(row.request_json, "landing_http_requests.request_json");
  const request = decodeCanonicalLandingJson(requestJson, decodeLandingHttpRequestV1);
  if (request.operationKind !== "github.preflight") {
    invalid("Persisted preflight decoder requires a github.preflight request");
  }
  const preflightRequest = request as LandingHttpRequestV1 & {
    readonly operationKind: "github.preflight";
  };
  const requestSha256 = canonicalDigest(
    requestJson,
    row.request_sha256,
    "landing_http_requests.request_sha256",
  );
  const status = oneOf(
    row.status,
    ["admitted", "settled"] as const,
    "landing_http_requests.status",
  );
  const admittedAt = assertInstant(row.admitted_at, "landing_http_requests.admitted_at");

  if (
    assertUuid(row.id, "landing_http_requests.id") !== request.requestId ||
    assertUuid(row.landing_id, "landing_http_requests.landing_id") !== request.landingId ||
    assertUuid(row.operation_id, "landing_http_requests.operation_id") !== request.operationId ||
    integer(row.coordinator_attempt, "landing_http_requests.coordinator_attempt", 1, 8) !==
      request.coordinatorAttempt ||
    row.operation_kind !== request.operationKind ||
    integer(
      row.request_ordinal,
      "landing_http_requests.request_ordinal",
      1,
      Number.MAX_SAFE_INTEGER,
    ) !== request.requestOrdinal ||
    row.kind !== request.kind ||
    row.method !== request.method
  ) {
    invalid("Landing HTTP SQL identity columns do not match canonical request bytes");
  }

  if (!Array.isArray(rawEventRows)) invalid("landingEvents must be an array");
  const expectedEventCount = status === "admitted" ? 1 : 2;
  if (rawEventRows.length !== expectedEventCount) {
    invalid("Landing HTTP row does not have its exact admitted/settled event count");
  }
  const events = rawEventRows.map((event, index) => decodeEventRow(event, index));
  const admission = events[0];
  if (admission === undefined) invalid("Landing HTTP admission event is missing");
  assertEvent(
    admission,
    "landing.github.request.admitted",
    request.landingId,
    expectedAdmission(request, requestSha256),
  );

  if (status === "admitted") {
    if (
      row.outcome !== null ||
      row.http_status !== null ||
      row.result_sha256 !== null ||
      row.result_json !== null ||
      row.error_code !== null ||
      row.settled_at !== null
    ) {
      invalid("Admitted landing HTTP row contains settlement columns");
    }
    return { status: "admitted", request: preflightRequest, requestSha256 };
  }

  const resultJson = text(row.result_json, "landing_http_requests.result_json");
  const result = decodeCanonicalLandingJson(resultJson, decodeLandingHttpResultV1);
  const resultSha256 = canonicalDigest(
    resultJson,
    row.result_sha256,
    "landing_http_requests.result_sha256",
  );
  const outcome = oneOf(
    row.outcome,
    ["succeeded", "failed", "ambiguous"] as const,
    "landing_http_requests.outcome",
  );
  const httpStatus = nullableInteger(row.http_status, "landing_http_requests.http_status");
  const errorCode = nullableText(row.error_code, "landing_http_requests.error_code");
  const settledAt = assertInstant(row.settled_at, "landing_http_requests.settled_at");
  if (
    result.requestId !== request.requestId ||
    result.kind !== request.kind ||
    outcome !== result.outcome ||
    httpStatus !== result.httpStatus ||
    errorCode !== result.errorCode
  ) {
    invalid("Landing HTTP settlement columns do not match canonical result bytes");
  }
  assertSucceededProjectionMatchesSubject(request, result);
  if (settledAt < admittedAt) {
    invalid("Landing HTTP settlement timestamp precedes admission");
  }
  const settlement = events[1];
  if (settlement === undefined) invalid("Landing HTTP settlement event is missing");
  // ADR 0027 makes sequence (and SQLite insertion identity), not wall-clock
  // equality or monotonicity, the event-order authority. created_at remains
  // strictly decoded above, but a clock adjustment cannot rewrite event order.
  if (settlement.sequence <= admission.sequence || settlement.id <= admission.id) {
    invalid("Landing HTTP settlement event does not follow admission");
  }
  assertEvent(
    settlement,
    "landing.github.request.settled",
    request.landingId,
    expectedSettlement(request, result, resultSha256),
  );

  return {
    status: "settled",
    request: preflightRequest,
    requestSha256,
    result,
    resultSha256,
  };
}
