/**
 * Pure ADR 0027 persisted object-upload HTTP-row correlation.
 *
 * This decoder proves that one SQLite-shaped request row and its supplied
 * request events are canonical and mutually consistent. It does not prove
 * query completeness, operation grammar, global ordinal continuity, durable
 * origin, an owning attempt/lease, or any retry/admission authority.
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

const MAX_CANONICAL_JSON_BYTES = 64 * 1024;

const OBJECT_HTTP_KINDS = [
  "github.actor.get",
  "github.blob.post",
  "github.tree.post",
  "github.commit.post",
] as const;

type ObjectHttpKindV1 = (typeof OBJECT_HTTP_KINDS)[number];

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

export interface PersistedGitHubObjectsHttpAdmittedV1 {
  readonly status: "admitted";
  readonly request: LandingHttpRequestV1 & {
    readonly operationKind: "github.objects.upload";
    readonly kind: ObjectHttpKindV1;
  };
  readonly requestSha256: string;
}

export interface PersistedGitHubObjectsHttpSettledV1 {
  readonly status: "settled";
  readonly request: LandingHttpRequestV1 & {
    readonly operationKind: "github.objects.upload";
    readonly kind: ObjectHttpKindV1;
  };
  readonly requestSha256: string;
  readonly result: LandingHttpResultV1 & { readonly kind: ObjectHttpKindV1 };
  readonly resultSha256: string;
}

export type PersistedGitHubObjectsHttpExchangeV1 =
  | PersistedGitHubObjectsHttpAdmittedV1
  | PersistedGitHubObjectsHttpSettledV1;

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

function denseEvents(value: unknown, expected: number): readonly unknown[] {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return invalid("Landing HTTP events cannot be inspected as an array");
  }
  if (!isArray) {
    return invalid("Landing HTTP row does not have its exact admitted/settled event count");
  }
  let length: number;
  try {
    length = (value as unknown[]).length;
  } catch {
    return invalid("Landing HTTP events cannot expose a stable length");
  }
  if (length !== expected) {
    return invalid("Landing HTTP row does not have its exact admitted/settled event count");
  }
  const events: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value as object, String(index));
    } catch {
      return invalid("Landing HTTP events cannot expose stable element descriptors");
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid("Landing HTTP events must be a dense array of own data elements");
    }
    events.push(descriptor.value);
  }
  return events;
}

function text(value: unknown, field: string): string {
  return typeof value === "string" ? value : invalid(`${field} must be text`);
}

function boundedCanonicalJson(value: unknown, field: string): string {
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

function expectedSuccessStatus(kind: ObjectHttpKindV1): 200 | 201 {
  // The generic v1 record accepts 2xx, while the admitted GitHub gateway
  // deterministically settles reads as 200 and creates as 201. Persisted
  // gateway replay must preserve that narrower outcome boundary.
  return kind === "github.actor.get" ? 200 : 201;
}

function assertSucceededProjectionMatchesSubject(
  request: LandingHttpRequestV1 & { readonly kind: ObjectHttpKindV1 },
  result: LandingHttpResultV1,
): void {
  if (result.outcome !== "succeeded") return;
  if (result.httpStatus !== expectedSuccessStatus(request.kind)) {
    invalid("Succeeded GitHub object response has an impossible gateway status");
  }
  const projection = result.projection;
  switch (request.kind) {
    case "github.actor.get":
      if (projection?.type !== "actor" || projection.login !== request.subject.expectedActor) {
        invalid("Succeeded GitHub actor projection does not match its admitted subject");
      }
      return;
    case "github.blob.post":
      if (
        projection?.type !== "object" ||
        projection.objectKind !== "blob" ||
        projection.sha1 !== request.subject.expectedBlobSha1
      ) {
        invalid("Succeeded GitHub blob projection does not match its admitted subject");
      }
      return;
    case "github.tree.post":
      if (
        projection?.type !== "object" ||
        projection.objectKind !== "tree" ||
        projection.sha1 !== request.subject.expectedTreeSha1
      ) {
        invalid("Succeeded GitHub tree projection does not match its admitted subject");
      }
      return;
    case "github.commit.post":
      if (
        projection?.type !== "object" ||
        projection.objectKind !== "commit" ||
        projection.sha1 !== request.subject.expectedCommitSha1
      ) {
        invalid("Succeeded GitHub commit projection does not match its admitted subject");
      }
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
  const payloadJson = boundedCanonicalJson(row.payload_json, `${field}.payload_json`);
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
    invalid("Landing object HTTP event does not match its persisted request row");
  }
}

/**
 * Strictly decodes one persisted object-upload request and exactly its
 * admitted event, plus its settled event when the row is settled.
 *
 * The caller must supply the full row and a complete row-specific event
 * selection in ascending sequence. This component performs no database,
 * lease, credential, filesystem, or network operation and grants no next
 * request, settlement, retry, or operation-grammar authority.
 */
export function decodePersistedGitHubObjectsHttpExchangeV1(
  rawHttpRow: unknown,
  rawEventRows: readonly unknown[],
): PersistedGitHubObjectsHttpExchangeV1 {
  const row = exactRecord(rawHttpRow, HTTP_ROW_KEYS, "landingHttpRequest");
  const requestJson = boundedCanonicalJson(row.request_json, "landing_http_requests.request_json");
  const request = decodeCanonicalLandingJson(requestJson, decodeLandingHttpRequestV1);
  if (
    request.operationKind !== "github.objects.upload" ||
    !(OBJECT_HTTP_KINDS as readonly string[]).includes(request.kind)
  ) {
    invalid("Persisted object decoder requires a github.objects.upload request kind");
  }
  const objectRequest = request as LandingHttpRequestV1 & {
    readonly operationKind: "github.objects.upload";
    readonly kind: ObjectHttpKindV1;
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
    invalid("Landing object HTTP SQL identity columns do not match canonical request bytes");
  }

  const expectedEventCount = status === "admitted" ? 1 : 2;
  const events = denseEvents(rawEventRows, expectedEventCount).map((event, index) =>
    decodeEventRow(event, index),
  );
  const admission = events[0];
  if (admission === undefined) invalid("Landing object HTTP admission event is missing");
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
      invalid("Admitted landing object HTTP row contains settlement columns");
    }
    return { status: "admitted", request: objectRequest, requestSha256 };
  }

  const resultJson = boundedCanonicalJson(row.result_json, "landing_http_requests.result_json");
  const rawResult = decodeCanonicalLandingJson(resultJson, (value) =>
    exactRecord(
      value,
      ["schemaVersion", "requestId", "kind", "outcome", "httpStatus", "projection", "errorCode"],
      "landing_http_requests.result_json",
    ),
  );
  if (rawResult.kind !== request.kind) {
    invalid("Landing object HTTP result kind changed before projection decoding");
  }
  const result = decodeLandingHttpResultV1(rawResult) as LandingHttpResultV1 & {
    readonly kind: ObjectHttpKindV1;
  };
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
    outcome !== result.outcome ||
    httpStatus !== result.httpStatus ||
    errorCode !== result.errorCode
  ) {
    invalid("Landing object HTTP settlement columns do not match canonical result bytes");
  }
  assertSucceededProjectionMatchesSubject(objectRequest, result);
  if (settledAt < admittedAt) {
    invalid("Landing object HTTP settlement timestamp precedes admission");
  }
  const settlement = events[1];
  if (settlement === undefined) invalid("Landing object HTTP settlement event is missing");
  if (settlement.sequence <= admission.sequence || settlement.id <= admission.id) {
    invalid("Landing object HTTP settlement event does not follow admission");
  }
  assertEvent(
    settlement,
    "landing.github.request.settled",
    request.landingId,
    expectedSettlement(request, result, resultSha256),
  );

  return {
    status: "settled",
    request: objectRequest,
    requestSha256,
    result,
    resultSha256,
  };
}
