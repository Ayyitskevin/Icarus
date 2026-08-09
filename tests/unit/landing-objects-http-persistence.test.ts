import { describe, expect, it } from "vitest";
import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { decodePersistedGitHubObjectsHttpExchangeV1 } from "../../packages/core/src/landing-objects-http-persistence.js";
import {
  canonicalLandingJson,
  type LandingGitHubRequestAdmittedEventV1,
  type LandingGitHubRequestSettledEventV1,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
} from "../../packages/core/src/landing-records.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const LANDING_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";
const PROFILE_SHA256 = "a".repeat(64);
const BODY_SHA256 = "b".repeat(64);
const PATH_SHA256 = "c".repeat(64);
const CONTENT_SHA256 = "d".repeat(64);
const ENTRIES_SHA256 = "e".repeat(64);
const COMMIT_PAYLOAD_SHA256 = "f".repeat(64);
const BLOB_SHA1 = "1".repeat(40);
const TREE_SHA1 = "2".repeat(40);
const COMMIT_SHA1 = "3".repeat(40);
const BASE_TREE_SHA1 = "4".repeat(40);
const BASE_COMMIT_SHA1 = "5".repeat(40);
const ADMITTED_AT = "2026-08-08T12:00:00.000Z";
const SETTLED_AT = "2026-08-08T12:00:01.000Z";

type MutableRow = Record<string, unknown>;
type FixtureOutcome = "admitted" | "succeeded" | "failed" | "ambiguous";

interface RequestCase {
  readonly name: "actor" | "blob" | "tree" | "commit";
  readonly request: LandingHttpRequestV1;
  readonly expectedObjectSha1: string | null;
}

const ACTOR_REQUEST: LandingHttpRequestV1 = {
  schemaVersion: 1,
  requestId: REQUEST_ID,
  landingId: LANDING_ID,
  operationId: OPERATION_ID,
  coordinatorAttempt: 2,
  operationKind: "github.objects.upload",
  requestOrdinal: 4,
  kind: "github.actor.get",
  method: "GET",
  profileSha256: PROFILE_SHA256,
  bodySha256: null,
  subject: { expectedActor: "octocat" },
};

const BLOB_REQUEST: LandingHttpRequestV1 = {
  ...ACTOR_REQUEST,
  requestOrdinal: 5,
  kind: "github.blob.post",
  method: "POST",
  bodySha256: BODY_SHA256,
  subject: {
    pathSha256: PATH_SHA256,
    contentBytes: 12,
    contentSha256: CONTENT_SHA256,
    expectedBlobSha1: BLOB_SHA1,
  },
};

const TREE_REQUEST: LandingHttpRequestV1 = {
  ...ACTOR_REQUEST,
  requestOrdinal: 6,
  kind: "github.tree.post",
  method: "POST",
  bodySha256: BODY_SHA256,
  subject: {
    baseTreeSha1: BASE_TREE_SHA1,
    entriesSha256: ENTRIES_SHA256,
    expectedTreeSha1: TREE_SHA1,
  },
};

const COMMIT_REQUEST: LandingHttpRequestV1 = {
  ...ACTOR_REQUEST,
  requestOrdinal: 7,
  kind: "github.commit.post",
  method: "POST",
  bodySha256: BODY_SHA256,
  subject: {
    candidateTreeSha1: TREE_SHA1,
    baseCommitSha1: BASE_COMMIT_SHA1,
    candidateCommitPayloadSha256: COMMIT_PAYLOAD_SHA256,
    expectedCommitSha1: COMMIT_SHA1,
    commitIso8601: "2026-08-08T12:00:00Z",
  },
};

const REQUEST_CASES: readonly RequestCase[] = [
  { name: "actor", request: ACTOR_REQUEST, expectedObjectSha1: null },
  { name: "blob", request: BLOB_REQUEST, expectedObjectSha1: BLOB_SHA1 },
  { name: "tree", request: TREE_REQUEST, expectedObjectSha1: TREE_SHA1 },
  { name: "commit", request: COMMIT_REQUEST, expectedObjectSha1: COMMIT_SHA1 },
];

function succeededResult(entry: RequestCase): LandingHttpResultV1 {
  if (entry.name === "actor") {
    return {
      schemaVersion: 1,
      requestId: entry.request.requestId,
      kind: entry.request.kind,
      outcome: "succeeded",
      httpStatus: 200,
      projection: { type: "actor", login: "octocat" },
      errorCode: null,
    };
  }
  return {
    schemaVersion: 1,
    requestId: entry.request.requestId,
    kind: entry.request.kind,
    outcome: "succeeded",
    httpStatus: 201,
    projection: {
      type: "object",
      objectKind: entry.name,
      sha1: entry.expectedObjectSha1 as string,
    },
    errorCode: null,
  };
}

function terminalResult(
  request: LandingHttpRequestV1,
  outcome: "failed" | "ambiguous",
): LandingHttpResultV1 {
  return outcome === "failed"
    ? {
        schemaVersion: 1,
        requestId: request.requestId,
        kind: request.kind,
        outcome,
        httpStatus: 422,
        projection: null,
        errorCode: "GITHUB_REQUEST_FAILED",
      }
    : {
        schemaVersion: 1,
        requestId: request.requestId,
        kind: request.kind,
        outcome,
        httpStatus: null,
        projection: null,
        errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
      };
}

function admittedPayload(
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

function settledPayload(
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

function eventRow(
  id: number,
  sequence: number,
  type: "landing.github.request.admitted" | "landing.github.request.settled",
  payload: LandingGitHubRequestAdmittedEventV1 | LandingGitHubRequestSettledEventV1,
): MutableRow {
  return {
    id,
    landing_id: payload.landingId,
    sequence,
    type,
    payload_json: canonicalLandingJson(payload),
    created_at: type === "landing.github.request.admitted" ? ADMITTED_AT : SETTLED_AT,
  };
}

function fixture(
  entry: RequestCase,
  outcome: FixtureOutcome,
  resultOverride?: LandingHttpResultV1,
): {
  row: MutableRow;
  events: MutableRow[];
  requestSha256: string;
  result: LandingHttpResultV1 | null;
  resultSha256: string | null;
} {
  const requestJson = canonicalLandingJson(entry.request);
  const requestSha256 = sha256(requestJson);
  const row: MutableRow = {
    id: entry.request.requestId,
    landing_id: entry.request.landingId,
    operation_id: entry.request.operationId,
    coordinator_attempt: entry.request.coordinatorAttempt,
    operation_kind: entry.request.operationKind,
    request_ordinal: entry.request.requestOrdinal,
    kind: entry.request.kind,
    method: entry.request.method,
    request_sha256: requestSha256,
    request_json: requestJson,
    status: outcome === "admitted" ? "admitted" : "settled",
    outcome: null,
    http_status: null,
    result_sha256: null,
    result_json: null,
    error_code: null,
    admitted_at: ADMITTED_AT,
    settled_at: null,
  };
  const events = [
    eventRow(
      101,
      11,
      "landing.github.request.admitted",
      admittedPayload(entry.request, requestSha256),
    ),
  ];
  if (outcome === "admitted") {
    return { row, events, requestSha256, result: null, resultSha256: null };
  }
  const result =
    resultOverride ??
    (outcome === "succeeded" ? succeededResult(entry) : terminalResult(entry.request, outcome));
  if (result.outcome !== outcome) throw new Error("fixture result outcome does not match");
  const resultJson = canonicalLandingJson(result);
  const resultSha256 = sha256(resultJson);
  row.outcome = result.outcome;
  row.http_status = result.httpStatus;
  row.result_sha256 = resultSha256;
  row.result_json = resultJson;
  row.error_code = result.errorCode;
  row.settled_at = SETTLED_AT;
  events.push(
    eventRow(
      102,
      12,
      "landing.github.request.settled",
      settledPayload(entry.request, result, resultSha256),
    ),
  );
  return { row, events, requestSha256, result, resultSha256 };
}

function requestCase(request: LandingHttpRequestV1, name: RequestCase["name"]): RequestCase {
  const expectedObjectSha1 =
    name === "blob"
      ? (request.subject.expectedBlobSha1 as string)
      : name === "tree"
        ? (request.subject.expectedTreeSha1 as string)
        : name === "commit"
          ? (request.subject.expectedCommitSha1 as string)
          : null;
  return { name, request, expectedObjectSha1 };
}

function expectInvalid(row: unknown, events: readonly unknown[]): void {
  try {
    decodePersistedGitHubObjectsHttpExchangeV1(row, events);
    throw new Error("expected persisted object HTTP validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe("LANDING_RECORD_INVALID");
  }
}

function expectInvalidMessage(row: unknown, events: readonly unknown[], message: string): void {
  try {
    decodePersistedGitHubObjectsHttpExchangeV1(row, events);
    throw new Error("expected persisted object HTTP validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe("LANDING_RECORD_INVALID");
    expect((error as IcarusError).message).toContain(message);
  }
}

function eventAt(events: MutableRow[], index: number): MutableRow {
  const event = events[index];
  if (event === undefined) throw new Error("fixture event is missing");
  return event;
}

function replaceEventPayload(event: MutableRow, change: (payload: MutableRow) => void): void {
  const payload = JSON.parse(event.payload_json as string) as MutableRow;
  change(payload);
  event.payload_json = canonicalLandingJson(payload);
}

function replaceProjection(
  result: LandingHttpResultV1,
  change: (projection: MutableRow) => void,
): LandingHttpResultV1 {
  const copy = structuredClone(result);
  if (copy.projection === null) throw new Error("result projection is missing");
  change(copy.projection as unknown as MutableRow);
  return copy;
}

describe("persisted ADR 0027 object-upload HTTP row correlation", () => {
  it.each(REQUEST_CASES)("decodes a canonical admitted $name request", (entry) => {
    const value = fixture(entry, "admitted");
    expect(decodePersistedGitHubObjectsHttpExchangeV1(value.row, value.events)).toEqual({
      status: "admitted",
      request: entry.request,
      requestSha256: value.requestSha256,
    });
  });

  it.each(REQUEST_CASES)("decodes a canonical succeeded $name request", (entry) => {
    const value = fixture(entry, "succeeded");
    expect(decodePersistedGitHubObjectsHttpExchangeV1(value.row, value.events)).toEqual({
      status: "settled",
      request: entry.request,
      requestSha256: value.requestSha256,
      result: value.result,
      resultSha256: value.resultSha256,
    });
  });

  it.each(
    REQUEST_CASES.flatMap((entry) =>
      (["failed", "ambiguous"] as const).map((outcome) => ({ entry, outcome })),
    ),
  )("decodes a canonical $outcome $entry.name request", ({ entry, outcome }) => {
    const value = fixture(entry, outcome);
    const decoded = decodePersistedGitHubObjectsHttpExchangeV1(value.row, value.events);
    expect(decoded).toEqual({
      status: "settled",
      request: entry.request,
      requestSha256: value.requestSha256,
      result: value.result,
      resultSha256: value.resultSha256,
    });
  });

  it.each(REQUEST_CASES)(
    "rejects the wrong successful HTTP status for $name after re-digesting result and events",
    (entry) => {
      const result = structuredClone(succeededResult(entry));
      (result as { httpStatus: number }).httpStatus = entry.name === "actor" ? 201 : 200;
      const value = fixture(entry, "succeeded", result);
      expectInvalid(value.row, value.events);
    },
  );

  it.each(REQUEST_CASES)(
    "binds the succeeded $name projection to the re-digested request subject",
    (entry) => {
      const changedRequest = structuredClone(entry.request);
      if (entry.name === "actor") {
        (changedRequest.subject as MutableRow).expectedActor = "hubot";
      } else {
        const field =
          entry.name === "blob"
            ? "expectedBlobSha1"
            : entry.name === "tree"
              ? "expectedTreeSha1"
              : "expectedCommitSha1";
        (changedRequest.subject as MutableRow)[field] = "9".repeat(40);
      }
      const value = fixture(
        requestCase(changedRequest, entry.name),
        "succeeded",
        succeededResult(entry),
      );
      expectInvalid(value.row, value.events);
    },
  );

  it.each(REQUEST_CASES)(
    "rejects re-digested $name result identity drift even when SQL and events agree",
    (entry) => {
      const changed = replaceProjection(succeededResult(entry), (projection) => {
        if (entry.name === "actor") projection.login = "hubot";
        else projection.sha1 = "9".repeat(40);
      });
      const value = fixture(entry, "succeeded", changed);
      expectInvalid(value.row, value.events);
    },
  );

  it.each(REQUEST_CASES.filter((entry) => entry.name !== "actor"))(
    "rejects re-digested $name object-kind drift",
    (entry) => {
      const changed = replaceProjection(succeededResult(entry), (projection) => {
        projection.objectKind = entry.name === "blob" ? "tree" : "blob";
      });
      const value = fixture(entry, "succeeded", changed);
      expectInvalid(value.row, value.events);
    },
  );

  it("binds settled result request ID and kind before accepting its projection", () => {
    const wrongId = structuredClone(succeededResult(REQUEST_CASES[0] as RequestCase));
    (wrongId as { requestId: string }).requestId = OTHER_ID;
    const wrongIdValue = fixture(REQUEST_CASES[0] as RequestCase, "succeeded", wrongId);
    expectInvalid(wrongIdValue.row, wrongIdValue.events);

    const wrongKind: LandingHttpResultV1 = {
      ...succeededResult(REQUEST_CASES[0] as RequestCase),
      kind: "github.blob.post",
      projection: { type: "object", objectKind: "blob", sha1: BLOB_SHA1 },
    };
    const wrongKindValue = fixture(REQUEST_CASES[0] as RequestCase, "succeeded", wrongKind);
    expectInvalid(wrongKindValue.row, wrongKindValue.events);

    const wrongTerminalKind: LandingHttpResultV1 = {
      ...terminalResult(ACTOR_REQUEST, "ambiguous"),
      kind: "github.pull_requests.get",
    };
    const wrongTerminalKindValue = fixture(
      REQUEST_CASES[0] as RequestCase,
      "ambiguous",
      wrongTerminalKind,
    );
    expectInvalidMessage(
      wrongTerminalKindValue.row,
      wrongTerminalKindValue.events,
      "result kind changed before projection decoding",
    );
  });

  it("rejects noncanonical failed and ambiguous result shapes after re-digesting evidence", () => {
    const failed = terminalResult(ACTOR_REQUEST, "failed") as unknown as MutableRow;
    failed.projection = { type: "actor", login: "octocat" };
    const failedValue = fixture(
      REQUEST_CASES[0] as RequestCase,
      "failed",
      failed as unknown as LandingHttpResultV1,
    );
    expectInvalid(failedValue.row, failedValue.events);

    const ambiguous = terminalResult(ACTOR_REQUEST, "ambiguous") as unknown as MutableRow;
    ambiguous.httpStatus = 504;
    const ambiguousValue = fixture(
      REQUEST_CASES[0] as RequestCase,
      "ambiguous",
      ambiguous as unknown as LandingHttpResultV1,
    );
    expectInvalid(ambiguousValue.row, ambiguousValue.events);
  });

  it("rejects SQL identity drift from otherwise canonical request bytes", () => {
    const mutations: ReadonlyArray<readonly [string, unknown]> = [
      ["id", OTHER_ID],
      ["landing_id", OTHER_ID],
      ["operation_id", OTHER_ID],
      ["coordinator_attempt", 3],
      ["operation_kind", "github.preflight"],
      ["request_ordinal", 8],
      ["kind", "github.tree.post"],
      ["method", "GET"],
    ];
    for (const [field, replacement] of mutations) {
      const value = fixture(REQUEST_CASES[3] as RequestCase, "admitted");
      value.row[field] = replacement;
      expectInvalid(value.row, value.events);
    }
  });

  it("rejects request/result digest and canonical-byte drift", () => {
    const requestDigest = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    requestDigest.row.request_sha256 = "9".repeat(64);
    expectInvalid(requestDigest.row, requestDigest.events);

    const requestBytes = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    requestBytes.row.request_json = JSON.stringify(ACTOR_REQUEST, null, 2);
    requestBytes.row.request_sha256 = sha256(requestBytes.row.request_json as string);
    replaceEventPayload(eventAt(requestBytes.events, 0), (payload) => {
      payload.requestSha256 = requestBytes.row.request_sha256;
    });
    expectInvalid(requestBytes.row, requestBytes.events);

    const resultDigest = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    resultDigest.row.result_sha256 = "8".repeat(64);
    expectInvalid(resultDigest.row, resultDigest.events);

    const resultBytes = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    resultBytes.row.result_json = JSON.stringify(resultBytes.result, null, 2);
    resultBytes.row.result_sha256 = sha256(resultBytes.row.result_json as string);
    replaceEventPayload(eventAt(resultBytes.events, 1), (payload) => {
      payload.resultSha256 = resultBytes.row.result_sha256;
    });
    expectInvalid(resultBytes.row, resultBytes.events);
  });

  it("rejects SQL status topology, settlement-column, timestamp, and row-shape drift", () => {
    const admittedColumns: ReadonlyArray<readonly [string, unknown]> = [
      ["outcome", "failed"],
      ["http_status", 403],
      ["result_sha256", "9".repeat(64)],
      ["result_json", "{}"],
      ["error_code", "GITHUB_REQUEST_FAILED"],
      ["settled_at", SETTLED_AT],
    ];
    for (const [field, replacement] of admittedColumns) {
      const admittedSettlement = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
      admittedSettlement.row[field] = replacement;
      expectInvalid(admittedSettlement.row, admittedSettlement.events);
    }

    const missingSettlement = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    missingSettlement.row.result_json = null;
    expectInvalid(missingSettlement.row, missingSettlement.events);

    const outcomeMismatch = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    outcomeMismatch.row.outcome = "failed";
    expectInvalid(outcomeMismatch.row, outcomeMismatch.events);

    const statusMismatch = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    statusMismatch.row.http_status = 201;
    expectInvalid(statusMismatch.row, statusMismatch.events);

    const errorMismatch = fixture(REQUEST_CASES[0] as RequestCase, "failed");
    errorMismatch.row.error_code = "GITHUB_OTHER_FAILURE";
    expectInvalid(errorMismatch.row, errorMismatch.events);

    const earlySettlement = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    earlySettlement.row.settled_at = "2026-08-08T11:59:59.999Z";
    expectInvalid(earlySettlement.row, earlySettlement.events);

    const noncanonicalAdmission = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    noncanonicalAdmission.row.admitted_at = "2026-08-08T12:00:00Z";
    expectInvalid(noncanonicalAdmission.row, noncanonicalAdmission.events);

    const extraColumn = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    extraColumn.row.unexpected = true;
    expectInvalid(extraColumn.row, extraColumn.events);
  });

  it("rejects missing, extra, reordered, and cross-identity request events", () => {
    const missing = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    missing.events.pop();
    expectInvalid(missing.row, missing.events);

    const extra = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    extra.events.push(structuredClone(eventAt(extra.events, 0)));
    expectInvalid(extra.row, extra.events);

    const reordered = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    reordered.events.reverse();
    expectInvalid(reordered.row, reordered.events);

    const crossOuterLanding = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    eventAt(crossOuterLanding.events, 0).landing_id = OTHER_ID;
    expectInvalid(crossOuterLanding.row, crossOuterLanding.events);

    const crossRequest = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    replaceEventPayload(eventAt(crossRequest.events, 1), (payload) => {
      payload.requestId = OTHER_ID;
    });
    expectInvalid(crossRequest.row, crossRequest.events);

    const crossOperation = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    replaceEventPayload(eventAt(crossOperation.events, 0), (payload) => {
      payload.operationId = OTHER_ID;
    });
    expectInvalid(crossOperation.row, crossOperation.events);

    const identityMutations: ReadonlyArray<readonly [string, unknown]> = [
      ["landingId", OTHER_ID],
      ["coordinatorAttempt", 3],
      ["operationKind", "github.preflight"],
      ["requestOrdinal", 5],
      ["kind", "github.blob.post"],
    ];
    for (const [field, replacement] of identityMutations) {
      const value = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
      replaceEventPayload(eventAt(value.events, 0), (payload) => {
        payload[field] = replacement;
      });
      expectInvalid(value.row, value.events);
    }
  });

  it("rejects event digest/outcome/shape/timestamp drift", () => {
    const requestDigest = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    replaceEventPayload(eventAt(requestDigest.events, 0), (payload) => {
      payload.requestSha256 = "7".repeat(64);
    });
    expectInvalid(requestDigest.row, requestDigest.events);

    const settlement = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    replaceEventPayload(eventAt(settlement.events, 1), (payload) => {
      payload.outcome = "failed";
      payload.errorCode = "GITHUB_REQUEST_FAILED";
    });
    expectInvalid(settlement.row, settlement.events);

    const noncanonical = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    const payload = JSON.parse(eventAt(noncanonical.events, 0).payload_json as string);
    eventAt(noncanonical.events, 0).payload_json = JSON.stringify(payload, null, 2);
    expectInvalid(noncanonical.row, noncanonical.events);

    const extraColumn = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    eventAt(extraColumn.events, 0).unexpected = true;
    expectInvalid(extraColumn.row, extraColumn.events);

    const noncanonicalTime = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    eventAt(noncanonicalTime.events, 0).created_at = "2026-08-08T12:00:00Z";
    expectInvalid(noncanonicalTime.row, noncanonicalTime.events);
  });

  it("requires strict persisted settlement event ID and sequence order", () => {
    const sequence = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    eventAt(sequence.events, 1).sequence = 11;
    expectInvalid(sequence.row, sequence.events);

    const id = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    eventAt(id.events, 1).id = 101;
    expectInvalid(id.row, id.events);
  });

  it("rejects sparse, accessor-backed, and over-bound event arrays before element decoding", () => {
    const settled = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    const sparse: unknown[] = new Array(2);
    sparse[0] = settled.events[0];
    expectInvalid(settled.row, sparse);

    const accessor: unknown[] = new Array(1);
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        throw new Error("event accessors must not execute");
      },
    });
    const admitted = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    expectInvalid(admitted.row, accessor);

    const overBound = [...settled.events, structuredClone(settled.events[0])];
    expectInvalid(settled.row, overBound);

    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expectInvalid(admitted.row, revoked.proxy);

    let lengthReads = 0;
    const oneLengthRead = new Proxy(admitted.events, {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          if (lengthReads > 1) throw new Error("event length must be snapshotted once");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(decodePersistedGitHubObjectsHttpExchangeV1(admitted.row, oneLengthRead)).toEqual({
      status: "admitted",
      request: ACTOR_REQUEST,
      requestSha256: admitted.requestSha256,
    });
    expect(lengthReads).toBe(1);
  });

  it("rejects request, result, and event payload JSON over the 64 KiB ceiling", () => {
    const oversized = "x".repeat(64 * 1024 + 1);

    const request = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    request.row.request_json = oversized;
    request.row.request_sha256 = sha256(oversized);
    expectInvalid(request.row, request.events);

    const result = fixture(REQUEST_CASES[0] as RequestCase, "succeeded");
    result.row.result_json = oversized;
    result.row.result_sha256 = sha256(oversized);
    expectInvalid(result.row, result.events);

    const event = fixture(REQUEST_CASES[0] as RequestCase, "admitted");
    eventAt(event.events, 0).payload_json = oversized;
    expectInvalid(event.row, event.events);
  });

  it("rejects a wrong-kind nested-list result before object projection acceptance", () => {
    const wrongKind: LandingHttpResultV1 = {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      kind: "github.pull_requests.get",
      outcome: "succeeded",
      httpStatus: 200,
      projection: {
        type: "pull_request_list",
        complete: false,
        count: 1_000,
        objects: Array.from({ length: 1_000 }, () => ({})) as never,
      },
      errorCode: null,
    };
    const value = fixture(REQUEST_CASES[0] as RequestCase, "succeeded", wrongKind);
    expectInvalidMessage(value.row, value.events, "result kind changed before projection decoding");
  });
});
