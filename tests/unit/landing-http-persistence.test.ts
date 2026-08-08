import { describe, expect, it } from "vitest";
import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { decodePersistedGitHubPreflightHttpExchangeV1 } from "../../packages/core/src/landing-http-persistence.js";
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
const ADMITTED_AT = "2026-08-08T12:00:00.000Z";
const SETTLED_AT = "2026-08-08T12:00:01.000Z";
const BASE_SHA1 = "b".repeat(40);
const HEAD_SHA1 = "c".repeat(40);

const REQUEST: LandingHttpRequestV1 = {
  schemaVersion: 1,
  requestId: REQUEST_ID,
  landingId: LANDING_ID,
  operationId: OPERATION_ID,
  coordinatorAttempt: 2,
  operationKind: "github.preflight",
  requestOrdinal: 7,
  kind: "github.actor.get",
  method: "GET",
  profileSha256: PROFILE_SHA256,
  bodySha256: null,
  subject: { expectedActor: "octocat" },
};

const BASE_REQUEST: LandingHttpRequestV1 = {
  ...REQUEST,
  kind: "github.base_ref.get",
  subject: {
    owner: "octocat",
    repository: "icarus-target",
    baseRef: "refs/heads/main",
    expectedSha1: BASE_SHA1,
  },
};

const HEAD_REQUEST: LandingHttpRequestV1 = {
  ...REQUEST,
  kind: "github.head_ref.get",
  subject: {
    owner: "octocat",
    repository: "icarus-target",
    headRef: "refs/heads/icarus/run",
    expectedSha1: HEAD_SHA1,
  },
};

const PULL_REQUESTS_REQUEST: LandingHttpRequestV1 = {
  ...REQUEST,
  kind: "github.pull_requests.get",
  subject: {
    owner: "octocat",
    repository: "icarus-target",
    headOwner: "octocat",
    headRef: "icarus/run",
    baseBranch: "main",
    state: "all",
    page: 1,
    perPage: 100,
  },
};

type MutableRow = Record<string, unknown>;

function result(outcome: "succeeded" | "failed" | "ambiguous"): LandingHttpResultV1 {
  if (outcome === "succeeded") {
    return {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      kind: "github.actor.get",
      outcome,
      httpStatus: 200,
      projection: { type: "actor", login: "octocat" },
      errorCode: null,
    };
  }
  if (outcome === "failed") {
    return {
      schemaVersion: 1,
      requestId: REQUEST_ID,
      kind: "github.actor.get",
      outcome,
      httpStatus: 403,
      projection: null,
      errorCode: "GITHUB_PERMISSION_DENIED",
    };
  }
  return {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    kind: "github.actor.get",
    outcome,
    httpStatus: null,
    projection: null,
    errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
  };
}

function succeededResult(
  requestValue: LandingHttpRequestV1,
  httpStatus: number,
  projection: NonNullable<LandingHttpResultV1["projection"]>,
): LandingHttpResultV1 {
  return {
    schemaVersion: 1,
    requestId: requestValue.requestId,
    kind: requestValue.kind,
    outcome: "succeeded",
    httpStatus,
    projection,
    errorCode: null,
  };
}

const BASE_RESULT = succeededResult(BASE_REQUEST, 200, {
  type: "ref",
  state: "direct",
  ref: "refs/heads/main",
  sha1: BASE_SHA1,
});

const HEAD_EXACT_RESULT = succeededResult(HEAD_REQUEST, 200, {
  type: "ref",
  state: "direct",
  ref: "refs/heads/icarus/run",
  sha1: HEAD_SHA1,
});

const HEAD_ABSENT_RESULT = succeededResult(HEAD_REQUEST, 404, {
  type: "ref",
  state: "absent",
  ref: "refs/heads/icarus/run",
  sha1: null,
});

const PULL_REQUESTS_RESULT = succeededResult(PULL_REQUESTS_REQUEST, 200, {
  type: "pull_request_list",
  complete: true,
  count: 1,
  objects: [
    {
      type: "pull_request",
      number: 17,
      state: "open",
      draft: true,
      owner: "octocat",
      repository: "icarus-target",
      headOwner: "octocat",
      headRef: "icarus/run",
      headSha1: HEAD_SHA1,
      baseRef: "main",
      baseSha1: BASE_SHA1,
      titleSha256: "d".repeat(64),
      bodySha256: "e".repeat(64),
      markerCount: 1,
      maintainerCanModify: false,
    },
  ],
});

function admittedPayload(
  requestValue: LandingHttpRequestV1,
  requestSha256: string,
): LandingGitHubRequestAdmittedEventV1 {
  return {
    schemaVersion: 1,
    landingId: requestValue.landingId,
    operationId: requestValue.operationId,
    requestId: requestValue.requestId,
    coordinatorAttempt: requestValue.coordinatorAttempt,
    operationKind: requestValue.operationKind,
    requestOrdinal: requestValue.requestOrdinal,
    kind: requestValue.kind,
    requestSha256,
  };
}

function settledPayload(
  requestValue: LandingHttpRequestV1,
  value: LandingHttpResultV1,
  resultSha256: string,
): LandingGitHubRequestSettledEventV1 {
  return {
    schemaVersion: 1,
    landingId: requestValue.landingId,
    operationId: requestValue.operationId,
    requestId: requestValue.requestId,
    coordinatorAttempt: requestValue.coordinatorAttempt,
    operationKind: requestValue.operationKind,
    requestOrdinal: requestValue.requestOrdinal,
    kind: requestValue.kind,
    outcome: value.outcome,
    resultSha256,
    errorCode: value.errorCode,
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
    landing_id: LANDING_ID,
    sequence,
    type,
    payload_json: canonicalLandingJson(payload),
    created_at: id === 101 ? ADMITTED_AT : SETTLED_AT,
  };
}

function fixture(
  outcome: "admitted" | "succeeded" | "failed" | "ambiguous",
  requestValue: LandingHttpRequestV1 = REQUEST,
  resultOverride?: LandingHttpResultV1,
): {
  row: MutableRow;
  events: MutableRow[];
  requestSha256: string;
  resultValue: LandingHttpResultV1 | null;
  resultSha256: string | null;
} {
  const requestJson = canonicalLandingJson(requestValue);
  const requestSha256 = sha256(requestJson);
  const row: MutableRow = {
    id: requestValue.requestId,
    landing_id: requestValue.landingId,
    operation_id: requestValue.operationId,
    coordinator_attempt: requestValue.coordinatorAttempt,
    operation_kind: requestValue.operationKind,
    request_ordinal: requestValue.requestOrdinal,
    kind: requestValue.kind,
    method: requestValue.method,
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
      admittedPayload(requestValue, requestSha256),
    ),
  ];
  if (outcome === "admitted") {
    return { row, events, requestSha256, resultValue: null, resultSha256: null };
  }
  const resultValue = resultOverride ?? result(outcome);
  if (resultValue.outcome !== outcome) throw new Error("fixture result outcome does not match");
  const resultJson = canonicalLandingJson(resultValue);
  const resultSha256 = sha256(resultJson);
  row.outcome = resultValue.outcome;
  row.http_status = resultValue.httpStatus;
  row.result_sha256 = resultSha256;
  row.result_json = resultJson;
  row.error_code = resultValue.errorCode;
  row.settled_at = SETTLED_AT;
  events.push(
    eventRow(
      102,
      12,
      "landing.github.request.settled",
      settledPayload(requestValue, resultValue, resultSha256),
    ),
  );
  return { row, events, requestSha256, resultValue, resultSha256 };
}

function expectInvalid(row: unknown, events: readonly unknown[]): void {
  try {
    decodePersistedGitHubPreflightHttpExchangeV1(row, events);
    throw new Error("expected persisted HTTP validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe("LANDING_RECORD_INVALID");
  }
}

function mutate(
  base: ReturnType<typeof fixture>,
  change: (row: MutableRow, events: MutableRow[]) => void,
): ReturnType<typeof fixture> {
  const copy = structuredClone(base);
  change(copy.row, copy.events);
  return copy;
}

function eventAt(events: MutableRow[], index: number): MutableRow {
  const event = events[index];
  if (event === undefined) throw new Error("fixture event is missing");
  return event;
}

function mutateProjection(
  base: LandingHttpResultV1,
  change: (projection: MutableRow) => void,
): LandingHttpResultV1 {
  const copy = structuredClone(base);
  if (copy.projection === null) throw new Error("fixture projection is missing");
  change(copy.projection as unknown as MutableRow);
  return copy;
}

describe("persisted ADR 0027 preflight HTTP row correlation", () => {
  it("decodes a canonical admitted row and its sole admission event", () => {
    const value = fixture("admitted");
    expect(decodePersistedGitHubPreflightHttpExchangeV1(value.row, value.events)).toEqual({
      status: "admitted",
      request: REQUEST,
      requestSha256: value.requestSha256,
    });
  });

  it.each(["succeeded", "failed", "ambiguous"] as const)(
    "decodes a canonical %s settlement without granting retry authority",
    (outcome) => {
      const value = fixture(outcome);
      expect(decodePersistedGitHubPreflightHttpExchangeV1(value.row, value.events)).toEqual({
        status: "settled",
        request: REQUEST,
        requestSha256: value.requestSha256,
        result: value.resultValue,
        resultSha256: value.resultSha256,
      });
    },
  );

  it("binds every successful preflight GET projection to its admitted subject", () => {
    const cases = [
      { request: REQUEST, result: result("succeeded") },
      { request: BASE_REQUEST, result: BASE_RESULT },
      { request: HEAD_REQUEST, result: HEAD_EXACT_RESULT },
      { request: HEAD_REQUEST, result: HEAD_ABSENT_RESULT },
      { request: PULL_REQUESTS_REQUEST, result: PULL_REQUESTS_RESULT },
    ];
    for (const entry of cases) {
      const value = fixture("succeeded", entry.request, entry.result);
      const decoded = decodePersistedGitHubPreflightHttpExchangeV1(value.row, value.events);
      expect(decoded.status).toBe("settled");
      if (decoded.status !== "settled") throw new Error("expected settled fixture");
      expect(decoded.result).toEqual(entry.result);
    }
  });

  it("rejects subject-mismatched success even when result bytes, digest, columns, and event agree", () => {
    const actorMismatch = mutateProjection(result("succeeded"), (projection) => {
      projection.login = "hubot";
    });
    const baseRefMismatch = mutateProjection(BASE_RESULT, (projection) => {
      projection.ref = "refs/heads/release";
    });
    const baseShaMismatch = mutateProjection(BASE_RESULT, (projection) => {
      projection.sha1 = "f".repeat(40);
    });
    const headShaMismatch = mutateProjection(HEAD_EXACT_RESULT, (projection) => {
      projection.sha1 = "f".repeat(40);
    });
    const absentHeadRefMismatch = mutateProjection(HEAD_ABSENT_RESULT, (projection) => {
      projection.ref = "refs/heads/icarus/other";
    });
    const mismatches = [
      { request: REQUEST, result: actorMismatch },
      { request: BASE_REQUEST, result: baseRefMismatch },
      { request: BASE_REQUEST, result: baseShaMismatch },
      { request: HEAD_REQUEST, result: headShaMismatch },
      { request: HEAD_REQUEST, result: absentHeadRefMismatch },
    ];
    const pullRequestFields = [
      ["owner", "hubot"],
      ["repository", "other-repository"],
      ["headOwner", "hubot"],
      ["headRef", "icarus/other"],
      ["baseRef", "release"],
    ] as const;
    for (const [field, replacement] of pullRequestFields) {
      mismatches.push({
        request: PULL_REQUESTS_REQUEST,
        result: mutateProjection(PULL_REQUESTS_RESULT, (projection) => {
          const objects = projection.objects;
          if (!Array.isArray(objects) || typeof objects[0] !== "object" || objects[0] === null) {
            throw new Error("pull-request fixture is missing");
          }
          (objects[0] as MutableRow)[field] = replacement;
        }),
      });
    }
    for (const entry of mismatches) {
      const value = fixture("succeeded", entry.request, entry.result);
      expectInvalid(value.row, value.events);
    }
  });

  it("rejects canonical-byte, digest, SQL-column, and status topology mutations", () => {
    const cases = [
      mutate(fixture("admitted"), (row) => {
        row.request_json = JSON.stringify(REQUEST, null, 2);
        row.request_sha256 = sha256(row.request_json as string);
      }),
      mutate(fixture("admitted"), (row) => {
        row.request_sha256 = "f".repeat(64);
      }),
      mutate(fixture("admitted"), (row) => {
        row.operation_id = OTHER_ID;
      }),
      mutate(fixture("admitted"), (row) => {
        row.error_code = "GITHUB_PERMISSION_DENIED";
      }),
      mutate(fixture("succeeded"), (row) => {
        row.result_json = JSON.stringify(result("succeeded"), null, 2);
        row.result_sha256 = sha256(row.result_json as string);
      }),
      mutate(fixture("succeeded"), (row) => {
        row.result_sha256 = "e".repeat(64);
      }),
      mutate(fixture("succeeded"), (row) => {
        row.http_status = 201;
      }),
      mutate(fixture("succeeded"), (row) => {
        row.settled_at = "2026-08-08T11:59:59.000Z";
      }),
      mutate(fixture("admitted"), (row) => {
        row.admitted_at = "2026-08-08T12:00:00Z";
      }),
      mutate(fixture("succeeded"), (row) => {
        row.unexpected = true;
      }),
    ];
    for (const value of cases) expectInvalid(value.row, value.events);
  });

  it("rejects missing, extra, reordered, noncanonical, and cross-identity events", () => {
    const cases = [
      mutate(fixture("succeeded"), (_row, events) => {
        events.pop();
      }),
      mutate(fixture("admitted"), (_row, events) => {
        events.push(structuredClone(events[0] as MutableRow));
      }),
      mutate(fixture("succeeded"), (_row, events) => {
        events.reverse();
      }),
      mutate(fixture("succeeded"), (_row, events) => {
        eventAt(events, 1).sequence = 10;
      }),
      mutate(fixture("succeeded"), (_row, events) => {
        const event = eventAt(events, 1);
        const payload = JSON.parse(event.payload_json as string) as MutableRow;
        payload.requestId = OTHER_ID;
        event.payload_json = canonicalLandingJson(payload);
      }),
      mutate(fixture("succeeded"), (_row, events) => {
        const event = eventAt(events, 0);
        const payload = JSON.parse(event.payload_json as string) as MutableRow;
        payload.requestSha256 = "d".repeat(64);
        event.payload_json = canonicalLandingJson(payload);
      }),
      mutate(fixture("succeeded"), (_row, events) => {
        const event = eventAt(events, 1);
        const payload = JSON.parse(event.payload_json as string) as MutableRow;
        payload.outcome = "failed";
        payload.errorCode = "GITHUB_PERMISSION_DENIED";
        event.payload_json = canonicalLandingJson(payload);
      }),
      mutate(fixture("succeeded"), (_row, events) => {
        eventAt(events, 0).landing_id = OTHER_ID;
      }),
      mutate(fixture("succeeded"), (_row, events) => {
        const event = eventAt(events, 0);
        const payload = JSON.parse(event.payload_json as string) as MutableRow;
        event.payload_json = JSON.stringify(payload, null, 2);
      }),
      mutate(fixture("succeeded"), (_row, events) => {
        eventAt(events, 1).unexpected = true;
      }),
      mutate(fixture("succeeded"), (_row, events) => {
        eventAt(events, 1).created_at = "2026-08-08T12:00:01Z";
      }),
    ];
    for (const value of cases) expectInvalid(value.row, value.events);
  });
});
