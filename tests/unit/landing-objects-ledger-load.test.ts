import { rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import type {
  LandingGitHubMaterialSnapshotV1,
  LandingGitHubPreflightSettlementInputV1,
  LandingStatusV1,
} from "../../packages/core/src/landing-ledger.js";
import {
  type GitHubObjectsHistoryExchangeV1,
  validateGitHubObjectsUploadHttpHistoryV1,
} from "../../packages/core/src/landing-objects-history.js";
import {
  canonicalLandingJson,
  digestLandingRecord,
  type LandingGitHubRequestAdmittedEventV1,
  type LandingGitHubRequestSettledEventV1,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
  type LandingOperationObservationV1,
  type LandingOperationRequestV1,
  type LandingOperationResultV1,
  type LandingOperationSettledEventV1,
  type LandingOperationStartedEventV1,
  type LandingStateChangedEventV1,
} from "../../packages/core/src/landing-records.js";
import type { RunLeaseGuard } from "../../packages/core/src/lease.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import {
  createLandingGitHubMaterialFixture,
  type LandingGitHubMaterialFixture,
} from "../support/landing-github-material-fixture.js";
import { UNIT_RUN_ID } from "../support/unit-fixtures.js";

interface TestDatabase {
  prepare(sql: string): {
    run(...parameters: unknown[]): { readonly changes: number };
    get(...parameters: unknown[]): unknown;
  };
  close(): void;
}

interface PersistedObjectExchange extends GitHubObjectsHistoryExchangeV1 {
  readonly request: LandingHttpRequestV1;
  readonly requestSha256: string;
  readonly result: LandingHttpResultV1;
  readonly resultSha256: string;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const fixtures: LandingGitHubMaterialFixture[] = [];
const STARTED_AT = "2026-08-08T12:00:00.000Z";
const FINISHED_AT = "2026-08-08T12:01:00.000Z";
const OBJECT_OPERATION_ID = "90000000-0000-4000-8000-000000000001";
const RETRY_OBJECT_OPERATION_ID = "90000000-0000-4000-8000-000000000002";
const SECOND_RETRY_OBJECT_OPERATION_ID = "90000000-0000-4000-8000-000000000003";
const RECONCILIATION_OPERATION_IDS = Array.from(
  { length: 5 },
  (_, index) => `91000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
);
const OBJECT_REQUEST_IDS = Array.from(
  { length: 8 },
  (_, index) => `90000000-0000-4000-8000-${(index + 16).toString(16).padStart(12, "0")}`,
);
const RETRY_OBJECT_REQUEST_IDS = Array.from(
  { length: 8 },
  (_, index) => `92000000-0000-4000-8000-${(index + 16).toString(16).padStart(12, "0")}`,
);
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function successfulPreflightResult(
  status: LandingStatusV1,
  request: LandingHttpRequestV1,
): LandingHttpResultV1 {
  if (request.kind === "github.actor.get") {
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      kind: request.kind,
      outcome: "succeeded",
      httpStatus: 200,
      projection: { type: "actor", login: status.landing.profile.expectedActor },
      errorCode: null,
    };
  }
  if (request.kind === "github.base_ref.get") {
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      kind: request.kind,
      outcome: "succeeded",
      httpStatus: 200,
      projection: {
        type: "ref",
        state: "direct",
        ref: `refs/heads/${status.landing.profile.baseBranch}`,
        sha1: status.landing.baseCommitSha1,
      },
      errorCode: null,
    };
  }
  if (request.kind !== "github.head_ref.get") {
    throw new Error(`Unexpected preflight request ${request.kind}`);
  }
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    kind: request.kind,
    outcome: "succeeded",
    httpStatus: 404,
    projection: { type: "ref", state: "absent", ref: status.landing.headRef, sha1: null },
    errorCode: null,
  };
}

function settlement(
  request: LandingGitHubPreflightSettlementInputV1["request"],
  result: LandingHttpResultV1,
): LandingGitHubPreflightSettlementInputV1 {
  return {
    request,
    requestSha256: digestLandingRecord(request),
    result,
    resultSha256: digestLandingRecord(result),
  };
}

async function completePreflight(
  fixture: LandingGitHubMaterialFixture,
  guard: RunLeaseGuard,
): Promise<{
  readonly status: LandingStatusV1;
  readonly material: LandingGitHubMaterialSnapshotV1;
}> {
  const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
  let material: LandingGitHubMaterialSnapshotV1 | null = null;
  for (let index = 0; index < 3; index += 1) {
    const admitted = await fixture.store.admitNextGitHubPreflightRequest(
      guard,
      fixture.landingId,
      started.operationId,
    );
    if (index === 0) {
      await fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
        guard,
        admitted.request.requestId,
      );
      material = await fixture.store.readClaimedGitHubLandingMaterial(
        guard,
        admitted.request.requestId,
        fixture.landingId,
      );
    } else {
      await fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId);
    }
    const result = successfulPreflightResult(admitted.status, admitted.request);
    await fixture.store.settleGitHubPreflightRequest(
      guard,
      fixture.landingId,
      started.operationId,
      settlement(admitted.request, result),
    );
  }
  if (material === null) throw new Error("Preflight did not register immutable object material");
  return { status: fixture.store.getLandingStatus(fixture.landingId), material };
}

function appendEvent(
  database: TestDatabase,
  landingId: string,
  type: string,
  payload: unknown,
): void {
  const source = database
    .prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM landing_events WHERE landing_id = ?",
    )
    .get(landingId) as { readonly sequence: number };
  expect(
    database
      .prepare(
        "INSERT INTO landing_events (landing_id, sequence, type, payload_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .run(landingId, source.sequence + 1, type, canonicalLandingJson(payload), STARTED_AT).changes,
  ).toBe(1);
}

function injectStartedObjects(
  fixture: LandingGitHubMaterialFixture,
  completedPreflight: LandingStatusV1,
  options: {
    readonly operationId?: string;
    readonly kindAttempt?: number;
    readonly retrySubjectOperationId?: string | null;
    readonly retrySubjectRequestSha256?: string | null;
  } = {},
): LandingOperationRequestV1 & { readonly kind: "github.objects.upload" } {
  const preflight = completedPreflight.operations.at(-1);
  const attempt = completedPreflight.attempts.at(-1);
  if (
    preflight?.kind !== "github.preflight" ||
    preflight.status !== "completed" ||
    preflight.resultSha256 === null ||
    attempt?.status !== "started" ||
    completedPreflight.landing.landingSha256 === null
  ) {
    throw new Error("Fixture did not reach its completed-preflight boundary");
  }
  const operationId = options.operationId ?? OBJECT_OPERATION_ID;
  const kindAttempt = options.kindAttempt ?? 1;
  const operation: LandingOperationRequestV1 = {
    schemaVersion: 1,
    operationId,
    landingId: fixture.landingId,
    coordinatorAttempt: attempt.ordinal,
    kindAttempt,
    kind: "github.objects.upload",
    expectedState: "local_ready",
    expectedVersion: completedPreflight.landing.version,
    input: {
      landingSha256: completedPreflight.landing.landingSha256,
      candidateObjectManifestSha256: fixture.candidateManifestSha256,
      changedPathsSha256: completedPreflight.landing.changedPathsSha256,
      preflightOperationId: preflight.id,
      preflightResultSha256: preflight.resultSha256,
      retrySubjectOperationId: options.retrySubjectOperationId ?? null,
      retrySubjectRequestSha256: options.retrySubjectRequestSha256 ?? null,
    },
  };
  const operationJson = canonicalLandingJson(operation);
  const requestSha256 = sha256(operationJson);
  const database = new Database(fixture.databasePath);
  try {
    expect(
      database
        .prepare(
          "INSERT INTO landing_operations " +
            "(id, landing_id, coordinator_attempt, kind, kind_attempt, status, request_sha256, " +
            "request_json, observation_sha256, observation_json, result_sha256, result_json, " +
            "error_code, started_at, finished_at) " +
            "VALUES (?, ?, ?, 'github.objects.upload', ?, 'started', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL)",
        )
        .run(
          operation.operationId,
          fixture.landingId,
          attempt.ordinal,
          kindAttempt,
          requestSha256,
          operationJson,
          STARTED_AT,
        ).changes,
    ).toBe(1);
    appendEvent(database, fixture.landingId, "landing.operation.started", {
      schemaVersion: 1,
      landingId: fixture.landingId,
      operationId: operation.operationId,
      coordinatorAttempt: attempt.ordinal,
      kind: "github.objects.upload",
      kindAttempt,
      requestSha256,
    } satisfies LandingOperationStartedEventV1);
    expect(
      database
        .prepare(
          "UPDATE landings SET state = 'uploading_objects', resume_state = NULL, " +
            "error_code = NULL, version = version + 1, updated_at = ? " +
            "WHERE id = ? AND state = 'local_ready' AND version = ?",
        )
        .run(STARTED_AT, fixture.landingId, completedPreflight.landing.version).changes,
    ).toBe(1);
    appendEvent(database, fixture.landingId, "landing.state.changed", {
      schemaVersion: 1,
      landingId: fixture.landingId,
      from: "local_ready",
      to: "uploading_objects",
      version: completedPreflight.landing.version + 1,
      operationId: operation.operationId,
    } satisfies LandingStateChangedEventV1);
  } finally {
    database.close();
  }
  return operation as LandingOperationRequestV1 & { readonly kind: "github.objects.upload" };
}

function objectHistoryInput(
  material: LandingGitHubMaterialSnapshotV1,
  preflightStatus: LandingStatusV1,
  operation: LandingOperationRequestV1 & { readonly kind: "github.objects.upload" },
  exchanges: readonly GitHubObjectsHistoryExchangeV1[],
): Record<string, unknown> {
  const preflight = preflightStatus.operations.at(-1);
  if (
    preflight?.kind !== "github.preflight" ||
    preflight.result === null ||
    preflight.resultSha256 === null
  ) {
    throw new Error("Object history lacks its completed preflight");
  }
  return {
    material,
    landingSha256: digestLandingRecord(material.landing),
    preflightOperation: preflight.request,
    preflightOperationRequestSha256: preflight.requestSha256,
    preflightResult: preflight.result,
    preflightResultSha256: preflight.resultSha256,
    operation,
    operationRequestSha256: digestLandingRecord(operation),
    previousRequestOrdinal: 3,
    exchanges,
  };
}

function successfulObjectResult(
  status: LandingStatusV1,
  request: LandingHttpRequestV1,
): LandingHttpResultV1 {
  if (request.kind === "github.actor.get") {
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      kind: request.kind,
      outcome: "succeeded",
      httpStatus: 200,
      projection: { type: "actor", login: status.landing.profile.expectedActor },
      errorCode: null,
    };
  }
  if (request.kind === "github.blob.post") {
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      kind: request.kind,
      outcome: "succeeded",
      httpStatus: 201,
      projection: {
        type: "object",
        objectKind: "blob",
        sha1: (request.subject as { readonly expectedBlobSha1: string }).expectedBlobSha1,
      },
      errorCode: null,
    };
  }
  if (request.kind === "github.tree.post") {
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      kind: request.kind,
      outcome: "succeeded",
      httpStatus: 201,
      projection: {
        type: "object",
        objectKind: "tree",
        sha1: (request.subject as { readonly expectedTreeSha1: string }).expectedTreeSha1,
      },
      errorCode: null,
    };
  }
  if (request.kind === "github.commit.post") {
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      kind: request.kind,
      outcome: "succeeded",
      httpStatus: 201,
      projection: {
        type: "object",
        objectKind: "commit",
        sha1: (request.subject as { readonly expectedCommitSha1: string }).expectedCommitSha1,
      },
      errorCode: null,
    };
  }
  throw new Error(`Unexpected object request ${request.kind}`);
}

function completeObjectExchanges(
  material: LandingGitHubMaterialSnapshotV1,
  preflightStatus: LandingStatusV1,
  operation: LandingOperationRequestV1 & { readonly kind: "github.objects.upload" },
  requestIds: readonly string[] = OBJECT_REQUEST_IDS,
): PersistedObjectExchange[] {
  const exchanges: PersistedObjectExchange[] = [];
  for (let index = 0; index < requestIds.length; index += 1) {
    const projection = validateGitHubObjectsUploadHttpHistoryV1(
      objectHistoryInput(material, preflightStatus, operation, exchanges),
    );
    if (projection.status === "complete") return exchanges;
    const requestId = requestIds[index];
    if (requestId === undefined) throw new Error("Object request ID fixture is exhausted");
    const request = { ...projection.nextRequest, requestId } as LandingHttpRequestV1;
    const result = successfulObjectResult(preflightStatus, request);
    exchanges.push({
      request,
      requestSha256: digestLandingRecord(request),
      result,
      resultSha256: digestLandingRecord(result),
    });
  }
  throw new Error("Object history did not reach its bounded completion");
}

function terminalActorExchange(
  material: LandingGitHubMaterialSnapshotV1,
  preflightStatus: LandingStatusV1,
  operation: LandingOperationRequestV1 & { readonly kind: "github.objects.upload" },
  outcome: "failed" | "ambiguous",
  requestId = OBJECT_REQUEST_IDS[0] ?? "",
): PersistedObjectExchange {
  const projection = validateGitHubObjectsUploadHttpHistoryV1(
    objectHistoryInput(material, preflightStatus, operation, []),
  );
  if (projection.status !== "next_request" || projection.nextRequest.kind !== "github.actor.get") {
    throw new Error("Object history did not begin with its actor request");
  }
  const request = {
    ...projection.nextRequest,
    requestId,
  } as LandingHttpRequestV1;
  const result: LandingHttpResultV1 = {
    schemaVersion: 1,
    requestId: request.requestId,
    kind: "github.actor.get",
    outcome,
    httpStatus: outcome === "failed" ? 403 : null,
    projection: null,
    errorCode: outcome === "failed" ? "GITHUB_PERMISSION_DENIED" : "GITHUB_OUTCOME_AMBIGUOUS",
  };
  return {
    request,
    requestSha256: digestLandingRecord(request),
    result,
    resultSha256: digestLandingRecord(result),
  };
}

function effectfulAmbiguousExchanges(
  material: LandingGitHubMaterialSnapshotV1,
  preflightStatus: LandingStatusV1,
  operation: LandingOperationRequestV1 & { readonly kind: "github.objects.upload" },
  requestIds: readonly string[],
): readonly PersistedObjectExchange[] {
  const actorProjection = validateGitHubObjectsUploadHttpHistoryV1(
    objectHistoryInput(material, preflightStatus, operation, []),
  );
  const actorRequestId = requestIds[0];
  const postRequestId = requestIds[1];
  if (
    actorProjection.status !== "next_request" ||
    actorProjection.nextRequest.kind !== "github.actor.get" ||
    actorRequestId === undefined ||
    postRequestId === undefined
  ) {
    throw new Error("Effectful object fixture lacks its bounded request identities");
  }
  const actorRequest = { ...actorProjection.nextRequest, requestId: actorRequestId };
  const actorResult = successfulObjectResult(preflightStatus, actorRequest);
  const actor = {
    request: actorRequest,
    requestSha256: digestLandingRecord(actorRequest),
    result: actorResult,
    resultSha256: digestLandingRecord(actorResult),
  } satisfies PersistedObjectExchange;
  const postProjection = validateGitHubObjectsUploadHttpHistoryV1(
    objectHistoryInput(material, preflightStatus, operation, [actor]),
  );
  if (postProjection.status !== "next_request" || postProjection.nextRequest.method !== "POST") {
    throw new Error("Effectful object fixture did not reach its first immutable-object POST");
  }
  const postRequest = { ...postProjection.nextRequest, requestId: postRequestId };
  const postResult: LandingHttpResultV1 = {
    schemaVersion: 1,
    requestId: postRequest.requestId,
    kind: postRequest.kind,
    outcome: "ambiguous",
    httpStatus: null,
    projection: null,
    errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
  };
  return [
    actor,
    {
      request: postRequest,
      requestSha256: digestLandingRecord(postRequest),
      result: postResult,
      resultSha256: digestLandingRecord(postResult),
    },
  ];
}

function persistObjectExchange(
  database: TestDatabase,
  landingId: string,
  exchange: PersistedObjectExchange,
): void {
  const request = exchange.request;
  expect(
    database
      .prepare(
        "INSERT INTO landing_http_requests " +
          "(id, landing_id, operation_id, coordinator_attempt, operation_kind, request_ordinal, " +
          "kind, method, request_sha256, request_json, status, outcome, http_status, result_sha256, " +
          "result_json, error_code, admitted_at, settled_at) " +
          "VALUES (?, ?, ?, ?, 'github.objects.upload', ?, ?, ?, ?, ?, 'settled', ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        request.requestId,
        landingId,
        request.operationId,
        request.coordinatorAttempt,
        request.requestOrdinal,
        request.kind,
        request.method,
        exchange.requestSha256,
        canonicalLandingJson(request),
        exchange.result.outcome,
        exchange.result.httpStatus,
        exchange.resultSha256,
        canonicalLandingJson(exchange.result),
        exchange.result.errorCode,
        STARTED_AT,
        FINISHED_AT,
      ).changes,
  ).toBe(1);
  appendEvent(database, landingId, "landing.github.request.admitted", {
    schemaVersion: 1,
    landingId,
    operationId: request.operationId,
    requestId: request.requestId,
    coordinatorAttempt: request.coordinatorAttempt,
    operationKind: "github.objects.upload",
    requestOrdinal: request.requestOrdinal,
    kind: request.kind,
    requestSha256: exchange.requestSha256,
  } satisfies LandingGitHubRequestAdmittedEventV1);
  appendEvent(database, landingId, "landing.github.request.settled", {
    schemaVersion: 1,
    landingId,
    operationId: request.operationId,
    requestId: request.requestId,
    coordinatorAttempt: request.coordinatorAttempt,
    operationKind: "github.objects.upload",
    requestOrdinal: request.requestOrdinal,
    kind: request.kind,
    outcome: exchange.result.outcome,
    resultSha256: exchange.resultSha256,
    errorCode: exchange.result.errorCode,
  } satisfies LandingGitHubRequestSettledEventV1);
}

function settleObjects(
  fixture: LandingGitHubMaterialFixture,
  preflightStatus: LandingStatusV1,
  material: LandingGitHubMaterialSnapshotV1,
  operation: LandingOperationRequestV1 & { readonly kind: "github.objects.upload" },
  startedStatus: LandingStatusV1,
  mode: "complete" | "failed" | "ambiguous" | "post_ambiguous",
  requestIds: readonly string[] = OBJECT_REQUEST_IDS,
): void {
  const exchanges =
    mode === "complete"
      ? completeObjectExchanges(material, preflightStatus, operation, requestIds)
      : mode === "post_ambiguous"
        ? effectfulAmbiguousExchanges(material, preflightStatus, operation, requestIds)
        : [terminalActorExchange(material, preflightStatus, operation, mode, requestIds[0])];
  const completed =
    mode === "complete"
      ? validateGitHubObjectsUploadHttpHistoryV1(
          objectHistoryInput(material, preflightStatus, operation, exchanges),
        )
      : null;
  if (mode === "complete" && completed?.status !== "complete") {
    throw new Error("Successful object exchanges did not complete");
  }
  const actor = exchanges[0];
  const observation: LandingOperationObservationV1 | null =
    completed?.status === "complete"
      ? completed.observation
      : mode === "post_ambiguous" && actor !== undefined
        ? {
            schemaVersion: 1,
            operationId: operation.operationId,
            kind: "github.objects.upload",
            phase: "pre_effect",
            facts: [
              {
                fact: "actor",
                requestId: actor.request.requestId,
                resultSha256: actor.resultSha256,
              },
            ],
          }
        : null;
  const errorCode =
    mode === "failed"
      ? "GITHUB_PERMISSION_DENIED"
      : mode === "ambiguous" || mode === "post_ambiguous"
        ? "GITHUB_OUTCOME_AMBIGUOUS"
        : null;
  const result: LandingOperationResultV1 =
    completed?.status === "complete"
      ? completed.operationResult
      : {
          schemaVersion: 1,
          operationId: operation.operationId,
          kind: "github.objects.upload",
          outcome: mode === "failed" ? "failed" : "reconciliation_required",
          boundary: mode === "failed" ? "operation_failed" : "reconciliation_required",
          evidence: exchanges.map((exchange) => ({
            requestId: (exchange.request as LandingHttpRequestV1).requestId,
            resultSha256: exchange.resultSha256,
          })),
          value:
            mode === "failed"
              ? null
              : { subjectOperationId: operation.operationId, remoteResidue: "none" },
          errorCode,
        };
  const observationJson = observation === null ? null : canonicalLandingJson(observation);
  const resultJson = canonicalLandingJson(result);
  const resultSha256 = sha256(resultJson);
  const database = new Database(fixture.databasePath);
  try {
    for (const exchange of exchanges) persistObjectExchange(database, fixture.landingId, exchange);
    expect(
      database
        .prepare(
          "UPDATE landing_operations SET status = ?, observation_sha256 = ?, observation_json = ?, " +
            "result_sha256 = ?, result_json = ?, error_code = ?, finished_at = ? " +
            "WHERE id = ? AND status = 'started'",
        )
        .run(
          mode === "complete" ? "completed" : mode === "failed" ? "failed" : "interrupted",
          observationJson === null ? null : sha256(observationJson),
          observationJson,
          resultSha256,
          resultJson,
          errorCode,
          FINISHED_AT,
          operation.operationId,
        ).changes,
    ).toBe(1);
    appendEvent(database, fixture.landingId, "landing.operation.settled", {
      schemaVersion: 1,
      landingId: fixture.landingId,
      operationId: operation.operationId,
      coordinatorAttempt: operation.coordinatorAttempt,
      kind: "github.objects.upload",
      outcome: result.outcome,
      resultSha256,
      errorCode,
    } satisfies LandingOperationSettledEventV1);
    if (mode === "complete") {
      expect(
        database
          .prepare(
            "UPDATE landings SET state = 'objects_ready', resume_state = NULL, error_code = NULL, " +
              "version = version + 1, updated_at = ? WHERE id = ? AND state = 'uploading_objects'",
          )
          .run(FINISHED_AT, fixture.landingId).changes,
      ).toBe(1);
      appendEvent(database, fixture.landingId, "landing.state.changed", {
        schemaVersion: 1,
        landingId: fixture.landingId,
        from: "uploading_objects",
        to: "objects_ready",
        version: startedStatus.landing.version + 1,
        operationId: operation.operationId,
      } satisfies LandingStateChangedEventV1);
      return;
    }
    const attemptStatus = mode === "failed" ? "failed" : "interrupted";
    expect(
      database
        .prepare(
          "UPDATE landing_attempts SET status = ?, finished_at = ?, error_code = ? " +
            "WHERE landing_id = ? AND ordinal = ? AND status = 'started'",
        )
        .run(attemptStatus, FINISHED_AT, errorCode, fixture.landingId, operation.coordinatorAttempt)
        .changes,
    ).toBe(1);
    appendEvent(database, fixture.landingId, "landing.attempt.settled", {
      schemaVersion: 1,
      landingId: fixture.landingId,
      coordinatorAttempt: operation.coordinatorAttempt,
      outcome: attemptStatus,
      errorCode,
    });
    const state = mode === "failed" ? "failed" : "reconciliation_required";
    expect(
      database
        .prepare(
          `UPDATE landings SET state = '${state}', resume_state = 'local_ready', error_code = ?, ` +
            "version = version + 1, updated_at = ? WHERE id = ? AND state = 'uploading_objects'",
        )
        .run(errorCode, FINISHED_AT, fixture.landingId).changes,
    ).toBe(1);
    appendEvent(database, fixture.landingId, "landing.state.changed", {
      schemaVersion: 1,
      landingId: fixture.landingId,
      from: "uploading_objects",
      to: state,
      version: startedStatus.landing.version + 1,
      operationId: operation.operationId,
    } satisfies LandingStateChangedEventV1);
  } finally {
    database.close();
  }
}

async function createStartedObjectFixture(): Promise<{
  readonly fixture: LandingGitHubMaterialFixture;
  readonly preflightStatus: LandingStatusV1;
  readonly material: LandingGitHubMaterialSnapshotV1;
  readonly operation: LandingOperationRequestV1 & { readonly kind: "github.objects.upload" };
  readonly startedStatus: LandingStatusV1;
}> {
  const fixture = await createLandingGitHubMaterialFixture();
  fixtures.push(fixture);
  let preflight!: Awaited<ReturnType<typeof completePreflight>>;
  await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
    preflight = await completePreflight(fixture, guard);
  });
  const operation = injectStartedObjects(fixture, preflight.status);
  const startedStatus = fixture.store.getLandingStatus(fixture.landingId);
  return {
    fixture,
    preflightStatus: preflight.status,
    material: preflight.material,
    operation,
    startedStatus,
  };
}

async function createProvenEffectfulRetryFixture(): Promise<
  Awaited<ReturnType<typeof createStartedObjectFixture>> & {
    readonly retrySubjectOperationId: string;
    readonly retrySubjectRequestSha256: string;
  }
> {
  const scenario = await createStartedObjectFixture();
  settleObjects(
    scenario.fixture,
    scenario.preflightStatus,
    scenario.material,
    scenario.operation,
    scenario.startedStatus,
    "post_ambiguous",
  );
  const unresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
  const subject = unresolved.operations.at(-1);
  if (
    subject?.kind !== "github.objects.upload" ||
    subject.status !== "interrupted" ||
    subject.result?.outcome !== "reconciliation_required"
  ) {
    throw new Error("Effectful retry fixture lost its unresolved object subject");
  }
  injectCompletedObjectRetryReconciliation(scenario.fixture, unresolved);
  scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
  return {
    ...scenario,
    retrySubjectOperationId: subject.id,
    retrySubjectRequestSha256: subject.requestSha256,
  };
}

async function resumeAndCompletePreflight(
  fixture: LandingGitHubMaterialFixture,
): Promise<Awaited<ReturnType<typeof completePreflight>>> {
  fixture.store.admitLandingResume(fixture.landingId);
  let preflight!: Awaited<ReturnType<typeof completePreflight>>;
  await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
    preflight = await completePreflight(fixture, guard);
  });
  return preflight;
}

function expectRecordInvalid(action: () => unknown): void {
  try {
    action();
    throw new Error("Expected LANDING_RECORD_INVALID");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe("LANDING_RECORD_INVALID");
  }
}

function injectCompletedObjectTakeover(
  fixture: LandingGitHubMaterialFixture,
  completed: LandingStatusV1,
): number {
  const operation = completed.operations.at(-1);
  const attempt = completed.attempts.at(-1);
  if (
    operation?.kind !== "github.objects.upload" ||
    operation.status !== "completed" ||
    attempt?.status !== "started" ||
    attempt.ordinal >= 8
  ) {
    throw new Error("Completed object fixture cannot enter takeover");
  }
  const successor = attempt.ordinal + 1;
  const database = new Database(fixture.databasePath);
  try {
    expect(
      database
        .prepare(
          "UPDATE landing_attempts SET status = 'interrupted', finished_at = ?, " +
            "error_code = 'LANDING_COORDINATOR_TAKEOVER' " +
            "WHERE landing_id = ? AND ordinal = ? AND status = 'started'",
        )
        .run(FINISHED_AT, fixture.landingId, attempt.ordinal).changes,
    ).toBe(1);
    appendEvent(database, fixture.landingId, "landing.attempt.settled", {
      schemaVersion: 1,
      landingId: fixture.landingId,
      coordinatorAttempt: attempt.ordinal,
      outcome: "interrupted",
      errorCode: "LANDING_COORDINATOR_TAKEOVER",
    });
    expect(
      database
        .prepare(
          "INSERT INTO landing_attempts " +
            "(landing_id, ordinal, status, started_at, finished_at, error_code) " +
            "VALUES (?, ?, 'started', ?, NULL, NULL)",
        )
        .run(fixture.landingId, successor, FINISHED_AT).changes,
    ).toBe(1);
    expect(
      database
        .prepare("UPDATE landings SET attempt_count = ?, updated_at = ? WHERE id = ?")
        .run(successor, FINISHED_AT, fixture.landingId).changes,
    ).toBe(1);
    appendEvent(database, fixture.landingId, "landing.attempt.started", {
      schemaVersion: 1,
      landingId: fixture.landingId,
      coordinatorAttempt: successor,
    });
  } finally {
    database.close();
  }
  return successor;
}

function injectCompletedObjectRetryReconciliation(
  fixture: LandingGitHubMaterialFixture,
  unresolved: LandingStatusV1,
  takeoverLinks = 0,
  subjectOverride?: LandingStatusV1["operations"][number],
  terminalSubjectOverride?: LandingStatusV1["operations"][number],
): {
  readonly operationIds: readonly string[];
  readonly terminalOperationId: string;
} {
  const boundarySubject = unresolved.operations.at(-1);
  const subject = subjectOverride ?? boundarySubject;
  if (
    boundarySubject?.kind !== "github.objects.upload" ||
    boundarySubject.status !== "interrupted" ||
    boundarySubject.result?.outcome !== "reconciliation_required" ||
    subject?.kind !== "github.objects.upload" ||
    subject.status !== "interrupted" ||
    subject.result?.outcome !== "reconciliation_required" ||
    subject.resultSha256 === null ||
    (terminalSubjectOverride !== undefined &&
      (terminalSubjectOverride.kind !== "github.objects.upload" ||
        terminalSubjectOverride.status !== "interrupted" ||
        terminalSubjectOverride.result?.outcome !== "reconciliation_required" ||
        terminalSubjectOverride.resultSha256 === null)) ||
    unresolved.landing.state !== "reconciliation_required" ||
    unresolved.landing.resumeState !== "local_ready" ||
    unresolved.landing.landingSha256 === null
  ) {
    throw new Error("Fixture did not reach an unresolved object reconciliation boundary");
  }
  const linkCount = takeoverLinks + 1;
  const priorKindAttempts = unresolved.operations.filter(
    (operation) => operation.kind === "landing.reconcile",
  ).length;
  const operationIds = RECONCILIATION_OPERATION_IDS.slice(
    priorKindAttempts,
    priorKindAttempts + linkCount,
  );
  if (operationIds.length !== linkCount || boundarySubject.coordinatorAttempt + linkCount > 8) {
    throw new Error("Reconciliation fixture exceeds its bounded identities or attempts");
  }
  const database = new Database(fixture.databasePath);
  try {
    for (const [index, operationId] of operationIds.entries()) {
      const coordinatorAttempt = boundarySubject.coordinatorAttempt + index + 1;
      const kindAttempt = priorKindAttempts + index + 1;
      const completed = index === operationIds.length - 1;
      const linkSubject =
        completed && terminalSubjectOverride !== undefined ? terminalSubjectOverride : subject;
      const linkSubjectResultSha256 = linkSubject.resultSha256;
      if (linkSubjectResultSha256 === null) {
        throw new Error("Reconciliation link subject lost its settled result digest");
      }
      const subjectProjection = {
        schemaVersion: 1,
        operationId: linkSubject.id,
        landingId: linkSubject.landingId,
        coordinatorAttempt: linkSubject.coordinatorAttempt,
        kind: linkSubject.kind,
        kindAttempt: linkSubject.kindAttempt,
        status: linkSubject.status,
        requestSha256: linkSubject.requestSha256,
        observationSha256: linkSubject.observationSha256,
        resultSha256: linkSubject.resultSha256,
        errorCode: linkSubject.errorCode,
      };
      const observation: LandingOperationObservationV1 = {
        schemaVersion: 1,
        operationId,
        kind: "landing.reconcile",
        phase: "reconciliation",
        facts: [
          {
            fact: "subject_operation",
            requestId: null,
            resultSha256: digestLandingRecord(subjectProjection),
          },
        ],
      };
      const request: LandingOperationRequestV1 = {
        schemaVersion: 1,
        operationId,
        landingId: fixture.landingId,
        coordinatorAttempt,
        kindAttempt,
        kind: "landing.reconcile",
        expectedState: "reconciliation_required",
        expectedVersion: unresolved.landing.version,
        input: {
          landingSha256: unresolved.landing.landingSha256,
          resumeState: "local_ready",
          subjectOperationId: linkSubject.id,
          subjectRequestSha256: linkSubject.requestSha256,
          subjectResultSha256: linkSubjectResultSha256,
        },
      };
      const result: LandingOperationResultV1 = completed
        ? {
            schemaVersion: 1,
            operationId,
            kind: "landing.reconcile",
            outcome: "completed",
            boundary: "retry_stage_proven",
            evidence: observation.facts.map(({ requestId, resultSha256 }) => ({
              requestId,
              resultSha256,
            })),
            value: {
              subjectOperationId: linkSubject.id,
              nextState: "local_ready",
              remoteResidue: "none",
              stageValue: null,
            },
            errorCode: null,
          }
        : {
            schemaVersion: 1,
            operationId,
            kind: "landing.reconcile",
            outcome: "reconciliation_required",
            boundary: "reconciliation_required",
            evidence: observation.facts.map(({ requestId, resultSha256 }) => ({
              requestId,
              resultSha256,
            })),
            value: { subjectOperationId: linkSubject.id, remoteResidue: "none" },
            errorCode: "LANDING_COORDINATOR_TAKEOVER",
          };
      const requestJson = canonicalLandingJson(request);
      const observationJson = canonicalLandingJson(observation);
      const resultJson = canonicalLandingJson(result);
      expect(
        database
          .prepare(
            "INSERT INTO landing_attempts " +
              "(landing_id, ordinal, status, started_at, finished_at, error_code) " +
              "VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            fixture.landingId,
            coordinatorAttempt,
            completed ? "completed" : "interrupted",
            STARTED_AT,
            FINISHED_AT,
            completed ? null : "LANDING_COORDINATOR_TAKEOVER",
          ).changes,
      ).toBe(1);
      appendEvent(database, fixture.landingId, "landing.attempt.started", {
        schemaVersion: 1,
        landingId: fixture.landingId,
        coordinatorAttempt,
      });
      expect(
        database
          .prepare(
            "INSERT INTO landing_operations " +
              "(id, landing_id, coordinator_attempt, kind, kind_attempt, status, request_sha256, " +
              "request_json, observation_sha256, observation_json, result_sha256, result_json, " +
              "error_code, started_at, finished_at) " +
              "VALUES (?, ?, ?, 'landing.reconcile', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            operationId,
            fixture.landingId,
            coordinatorAttempt,
            kindAttempt,
            completed ? "completed" : "interrupted",
            sha256(requestJson),
            requestJson,
            sha256(observationJson),
            observationJson,
            sha256(resultJson),
            resultJson,
            completed ? null : "LANDING_COORDINATOR_TAKEOVER",
            STARTED_AT,
            FINISHED_AT,
          ).changes,
      ).toBe(1);
      appendEvent(database, fixture.landingId, "landing.operation.started", {
        schemaVersion: 1,
        landingId: fixture.landingId,
        operationId,
        coordinatorAttempt,
        kind: "landing.reconcile",
        kindAttempt,
        requestSha256: sha256(requestJson),
      } satisfies LandingOperationStartedEventV1);
      appendEvent(database, fixture.landingId, "landing.operation.settled", {
        schemaVersion: 1,
        landingId: fixture.landingId,
        operationId,
        coordinatorAttempt,
        kind: "landing.reconcile",
        outcome: result.outcome,
        resultSha256: sha256(resultJson),
        errorCode: result.errorCode,
      } satisfies LandingOperationSettledEventV1);
      appendEvent(database, fixture.landingId, "landing.attempt.settled", {
        schemaVersion: 1,
        landingId: fixture.landingId,
        coordinatorAttempt,
        outcome: completed ? "completed" : "interrupted",
        errorCode: completed ? null : "LANDING_COORDINATOR_TAKEOVER",
      });
      if (completed) {
        expect(
          database
            .prepare(
              "UPDATE landings SET state = 'local_ready', resume_state = NULL, error_code = NULL, " +
                "attempt_count = ?, version = version + 1, updated_at = ? " +
                "WHERE id = ? AND state = 'reconciliation_required' AND version = ?",
            )
            .run(coordinatorAttempt, FINISHED_AT, fixture.landingId, unresolved.landing.version)
            .changes,
        ).toBe(1);
        appendEvent(database, fixture.landingId, "landing.state.changed", {
          schemaVersion: 1,
          landingId: fixture.landingId,
          from: "reconciliation_required",
          to: "local_ready",
          version: unresolved.landing.version + 1,
          operationId,
        } satisfies LandingStateChangedEventV1);
      } else {
        expect(
          database
            .prepare("UPDATE landings SET attempt_count = ?, updated_at = ? WHERE id = ?")
            .run(coordinatorAttempt, FINISHED_AT, fixture.landingId).changes,
        ).toBe(1);
      }
    }
  } finally {
    database.close();
  }
  const terminalOperationId = operationIds.at(-1);
  if (terminalOperationId === undefined) throw new Error("Reconciliation terminal vanished");
  return { operationIds, terminalOperationId };
}

describe("landing ledger persisted GitHub object loader", () => {
  it("loads a started object upload immediately after its completed same-attempt preflight", async () => {
    const { fixture, preflightStatus, startedStatus } = await createStartedObjectFixture();
    const preflightId = preflightStatus.operations.at(-1)?.id;
    if (preflightId === undefined) throw new Error("Started fixture lost its preflight");
    const database = new Database(fixture.databasePath);
    try {
      expect(
        database
          .prepare(
            "UPDATE landing_operations SET rowid = " +
              "(SELECT MAX(rowid) + 100 FROM landing_operations WHERE landing_id = ?) " +
              "WHERE id = ? AND landing_id = ?",
          )
          .run(fixture.landingId, preflightId, fixture.landingId).changes,
      ).toBe(1);
    } finally {
      database.close();
    }
    const loaded = fixture.store.getLandingStatus(fixture.landingId);
    expect(loaded.landing).toMatchObject({
      state: "uploading_objects",
      version: preflightStatus.landing.version + 1,
      resumeState: null,
      errorCode: null,
    });
    expect(loaded.attempts.at(-1)).toMatchObject({
      ordinal: preflightStatus.attempts.at(-1)?.ordinal,
      status: "started",
    });
    expect(loaded.operations.slice(-2)).toMatchObject([
      { kind: "github.preflight", status: "completed" },
      {
        id: OBJECT_OPERATION_ID,
        kind: "github.objects.upload",
        status: "started",
        observation: null,
        result: null,
      },
    ]);
    expect(loaded).toEqual(startedStatus);
  });

  it("loads exact full object success at objects-ready without settling its attempt", async () => {
    const scenario = await createStartedObjectFixture();
    settleObjects(
      scenario.fixture,
      scenario.preflightStatus,
      scenario.material,
      scenario.operation,
      scenario.startedStatus,
      "complete",
    );

    const loaded = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(loaded.landing).toMatchObject({
      state: "objects_ready",
      resumeState: null,
      errorCode: null,
      version: scenario.startedStatus.landing.version + 1,
    });
    expect(loaded.attempts.at(-1)).toMatchObject({ status: "started", errorCode: null });
    expect(loaded.operations.at(-1)).toMatchObject({
      kind: "github.objects.upload",
      status: "completed",
      result: { outcome: "completed", boundary: "objects_exact" },
    });
  });

  it("loads failed actor settlement and its later ordinary local-ready resume", async () => {
    const scenario = await createStartedObjectFixture();
    settleObjects(
      scenario.fixture,
      scenario.preflightStatus,
      scenario.material,
      scenario.operation,
      scenario.startedStatus,
      "failed",
    );
    const failed = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "local_ready",
      errorCode: "GITHUB_PERMISSION_DENIED",
    });
    expect(failed.attempts.at(-1)).toMatchObject({
      status: "failed",
      errorCode: "GITHUB_PERMISSION_DENIED",
    });
    expect(failed.operations.at(-1)).toMatchObject({
      status: "failed",
      result: { outcome: "failed", boundary: "operation_failed" },
    });

    const resumed = scenario.fixture.store.admitLandingResume(scenario.fixture.landingId).status;
    expect(resumed.landing).toMatchObject({
      state: "local_ready",
      resumeState: null,
      errorCode: null,
    });
    expect(resumed.attempts.at(-1)?.status).toBe("started");
  });

  it("loads ambiguous actor settlement only as interrupted reconciliation-required", async () => {
    const scenario = await createStartedObjectFixture();
    settleObjects(
      scenario.fixture,
      scenario.preflightStatus,
      scenario.material,
      scenario.operation,
      scenario.startedStatus,
      "ambiguous",
    );

    const loaded = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(loaded.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "local_ready",
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    expect(loaded.attempts.at(-1)).toMatchObject({
      status: "interrupted",
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    expect(loaded.operations.at(-1)).toMatchObject({
      status: "interrupted",
      result: { outcome: "reconciliation_required", boundary: "reconciliation_required" },
    });
  });

  it("restarts from a completed zero-HTTP object retry proof without inventing a second local-ready proof", async () => {
    const scenario = await createStartedObjectFixture();
    settleObjects(
      scenario.fixture,
      scenario.preflightStatus,
      scenario.material,
      scenario.operation,
      scenario.startedStatus,
      "ambiguous",
    );
    const unresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    const injected = injectCompletedObjectRetryReconciliation(scenario.fixture, unresolved);

    const loaded = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(loaded.landing).toMatchObject({
      state: "local_ready",
      resumeState: null,
      errorCode: null,
      version: unresolved.landing.version + 1,
    });
    expect(loaded.attempts.at(-1)).toMatchObject({ status: "completed", errorCode: null });
    expect(loaded.operations.at(-1)).toMatchObject({
      id: injected.terminalOperationId,
      kind: "landing.reconcile",
      status: "completed",
      result: {
        outcome: "completed",
        boundary: "retry_stage_proven",
        value: { nextState: "local_ready", stageValue: null },
      },
    });
    expect(scenario.fixture.store.getLandingStatus(scenario.fixture.landingId)).toEqual(loaded);
  });

  it("truthfully reopens local-ready after reconciling an effectful ambiguous object POST", async () => {
    const scenario = await createStartedObjectFixture();
    settleObjects(
      scenario.fixture,
      scenario.preflightStatus,
      scenario.material,
      scenario.operation,
      scenario.startedStatus,
      "post_ambiguous",
    );
    const unresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    injectCompletedObjectRetryReconciliation(scenario.fixture, unresolved);

    const loaded = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(loaded.landing).toMatchObject({
      state: "local_ready",
      resumeState: null,
      errorCode: null,
    });
    expect(loaded.operations.at(-1)?.result).toMatchObject({
      outcome: "completed",
      boundary: "retry_stage_proven",
    });
  });

  it("restarts with the exact effectful object subject bound into its next retry", async () => {
    const scenario = await createProvenEffectfulRetryFixture();
    const retryPreflight = await resumeAndCompletePreflight(scenario.fixture);
    const retryOperation = injectStartedObjects(scenario.fixture, retryPreflight.status, {
      operationId: RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 2,
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });

    const restartedStore = new IcarusStore(scenario.fixture.databasePath);
    let loaded: LandingStatusV1;
    try {
      loaded = restartedStore.getLandingStatus(scenario.fixture.landingId);
    } finally {
      restartedStore.close();
    }
    expect(loaded.landing.state).toBe("uploading_objects");
    expect(retryOperation.input).toMatchObject({
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });
    expect(loaded.operations.at(-1)?.request).toEqual(retryOperation);
    expect(scenario.fixture.store.getLandingStatus(scenario.fixture.landingId)).toEqual(loaded);
  });

  it("preserves effectful ancestry through a zero-POST subject and its completed reconciliation", async () => {
    const scenario = await createProvenEffectfulRetryFixture();
    const retryPreflight = await resumeAndCompletePreflight(scenario.fixture);
    const zeroPostSubject = injectStartedObjects(scenario.fixture, retryPreflight.status, {
      operationId: RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 2,
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });
    const retryStarted = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    settleObjects(
      scenario.fixture,
      retryPreflight.status,
      retryPreflight.material,
      zeroPostSubject,
      retryStarted,
      "ambiguous",
      RETRY_OBJECT_REQUEST_IDS,
    );
    const unresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    injectCompletedObjectRetryReconciliation(scenario.fixture, unresolved);

    const nextPreflight = await resumeAndCompletePreflight(scenario.fixture);
    const nextRetry = injectStartedObjects(scenario.fixture, nextPreflight.status, {
      operationId: SECOND_RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 3,
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });
    const loaded = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);

    expect(nextRetry.input).toMatchObject({
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });
    expect(loaded.operations.at(-1)?.id).toBe(SECOND_RETRY_OBJECT_OPERATION_ID);
  });

  it("supersedes effectful ancestry only after the later effectful subject is reconciled", async () => {
    const scenario = await createProvenEffectfulRetryFixture();
    const retryPreflight = await resumeAndCompletePreflight(scenario.fixture);
    const laterEffectfulSubject = injectStartedObjects(scenario.fixture, retryPreflight.status, {
      operationId: RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 2,
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });
    const retryStarted = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    settleObjects(
      scenario.fixture,
      retryPreflight.status,
      retryPreflight.material,
      laterEffectfulSubject,
      retryStarted,
      "post_ambiguous",
      RETRY_OBJECT_REQUEST_IDS,
    );
    const unresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    injectCompletedObjectRetryReconciliation(scenario.fixture, unresolved);

    const nextPreflight = await resumeAndCompletePreflight(scenario.fixture);
    const nextRetry = injectStartedObjects(scenario.fixture, nextPreflight.status, {
      operationId: SECOND_RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 3,
      retrySubjectOperationId: laterEffectfulSubject.operationId,
      retrySubjectRequestSha256: digestLandingRecord(laterEffectfulSubject),
    });
    const loaded = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);

    expect(nextRetry.input).toMatchObject({
      retrySubjectOperationId: laterEffectfulSubject.operationId,
      retrySubjectRequestSha256: digestLandingRecord(laterEffectfulSubject),
    });
    expect(loaded.operations.at(-1)?.id).toBe(SECOND_RETRY_OBJECT_OPERATION_ID);
  });

  it("does not clear or replace proven ancestry after a deterministic actor failure", async () => {
    const scenario = await createProvenEffectfulRetryFixture();
    const retryPreflight = await resumeAndCompletePreflight(scenario.fixture);
    const failedSubject = injectStartedObjects(scenario.fixture, retryPreflight.status, {
      operationId: RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 2,
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });
    const retryStarted = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    settleObjects(
      scenario.fixture,
      retryPreflight.status,
      retryPreflight.material,
      failedSubject,
      retryStarted,
      "failed",
      RETRY_OBJECT_REQUEST_IDS,
    );
    scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);

    const nextPreflight = await resumeAndCompletePreflight(scenario.fixture);
    injectStartedObjects(scenario.fixture, nextPreflight.status, {
      operationId: SECOND_RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 3,
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });
    const loaded = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);

    expect(loaded.operations.at(-1)?.request.input).toMatchObject({
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });
  });

  it("inherits null retry authority across repeated zero-POST object reconciliation episodes", async () => {
    const scenario = await createStartedObjectFixture();
    settleObjects(
      scenario.fixture,
      scenario.preflightStatus,
      scenario.material,
      scenario.operation,
      scenario.startedStatus,
      "ambiguous",
    );
    const firstUnresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    injectCompletedObjectRetryReconciliation(scenario.fixture, firstUnresolved);
    scenario.fixture.store.admitLandingResume(scenario.fixture.landingId);
    let retryPreflight!: Awaited<ReturnType<typeof completePreflight>>;
    await scenario.fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      retryPreflight = await completePreflight(scenario.fixture, guard);
    });
    const retryOperation = injectStartedObjects(scenario.fixture, retryPreflight.status, {
      operationId: RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 2,
    });
    const retryStarted = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(retryOperation.input).toMatchObject({
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    });
    settleObjects(
      scenario.fixture,
      retryPreflight.status,
      retryPreflight.material,
      retryOperation,
      retryStarted,
      "ambiguous",
      RETRY_OBJECT_REQUEST_IDS,
    );
    const secondUnresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    injectCompletedObjectRetryReconciliation(scenario.fixture, secondUnresolved);

    const loaded = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(loaded.landing.state).toBe("local_ready");
    expect(
      loaded.operations.filter(
        (operation) => operation.kind === "landing.reconcile" && operation.status === "completed",
      ),
    ).toHaveLength(2);
  });

  it("uses event chronology through the bounded attempt-eight takeover chain, independent of rowid", async () => {
    const scenario = await createStartedObjectFixture();
    settleObjects(
      scenario.fixture,
      scenario.preflightStatus,
      scenario.material,
      scenario.operation,
      scenario.startedStatus,
      "ambiguous",
    );
    const unresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    const injected = injectCompletedObjectRetryReconciliation(scenario.fixture, unresolved, 4);
    const firstReconciliationId = injected.operationIds[0];
    if (firstReconciliationId === undefined) throw new Error("Bounded chain lost its first link");
    const database = new Database(scenario.fixture.databasePath);
    try {
      expect(
        database
          .prepare(
            "UPDATE landing_operations SET rowid = " +
              "(SELECT MAX(rowid) + 100 FROM landing_operations WHERE landing_id = ?) " +
              "WHERE id = ? AND landing_id = ?",
          )
          .run(scenario.fixture.landingId, firstReconciliationId, scenario.fixture.landingId)
          .changes,
      ).toBe(1);
    } finally {
      database.close();
    }

    const loaded = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(loaded.landing).toMatchObject({ state: "local_ready", attemptCount: 8 });
    expect(loaded.attempts.at(-1)).toMatchObject({ ordinal: 8, status: "completed" });
    expect(
      loaded.operations
        .filter((operation) => operation.kind === "landing.reconcile")
        .map((operation) => operation.id),
    ).toEqual(injected.operationIds);
  });

  it("rejects reconciliation-owned HTTP and persisted-event order corruption", async () => {
    const httpScenario = await createStartedObjectFixture();
    settleObjects(
      httpScenario.fixture,
      httpScenario.preflightStatus,
      httpScenario.material,
      httpScenario.operation,
      httpScenario.startedStatus,
      "ambiguous",
    );
    const httpUnresolved = httpScenario.fixture.store.getLandingStatus(
      httpScenario.fixture.landingId,
    );
    const httpReconciliation = injectCompletedObjectRetryReconciliation(
      httpScenario.fixture,
      httpUnresolved,
    );
    const httpTerminal = httpScenario.fixture.store
      .getLandingStatus(httpScenario.fixture.landingId)
      .operations.find((operation) => operation.id === httpReconciliation.terminalOperationId);
    if (httpTerminal === undefined) throw new Error("HTTP corruption lost reconciliation link");
    const httpDatabase = new Database(httpScenario.fixture.databasePath);
    try {
      const requestId = "93000000-0000-4000-8000-000000000001";
      const requestJson = "{}";
      expect(
        httpDatabase
          .prepare(
            "INSERT INTO landing_http_requests " +
              "(id, landing_id, operation_id, coordinator_attempt, operation_kind, " +
              "request_ordinal, kind, method, request_sha256, request_json, status, outcome, " +
              "http_status, result_sha256, result_json, error_code, admitted_at, settled_at) " +
              "VALUES (?, ?, ?, ?, 'landing.reconcile', 1, 'github.actor.get', 'GET', ?, ?, " +
              "'admitted', NULL, NULL, NULL, NULL, NULL, ?, NULL)",
          )
          .run(
            requestId,
            httpScenario.fixture.landingId,
            httpTerminal.id,
            httpTerminal.coordinatorAttempt,
            sha256(requestJson),
            requestJson,
            FINISHED_AT,
          ).changes,
      ).toBe(1);
    } finally {
      httpDatabase.close();
    }
    expectRecordInvalid(() =>
      httpScenario.fixture.store.getLandingStatus(httpScenario.fixture.landingId),
    );

    const eventScenario = await createStartedObjectFixture();
    settleObjects(
      eventScenario.fixture,
      eventScenario.preflightStatus,
      eventScenario.material,
      eventScenario.operation,
      eventScenario.startedStatus,
      "ambiguous",
    );
    const eventUnresolved = eventScenario.fixture.store.getLandingStatus(
      eventScenario.fixture.landingId,
    );
    injectCompletedObjectRetryReconciliation(eventScenario.fixture, eventUnresolved);
    const eventDatabase = new Database(eventScenario.fixture.databasePath);
    try {
      expect(
        eventDatabase
          .prepare(
            "UPDATE landing_events SET id = " +
              "(SELECT MAX(id) + 100 FROM landing_events) " +
              "WHERE landing_id = ? AND sequence = (" +
              "SELECT MAX(sequence) FROM landing_events " +
              "WHERE landing_id = ? AND type = 'landing.attempt.started')",
          )
          .run(eventScenario.fixture.landingId, eventScenario.fixture.landingId).changes,
      ).toBe(1);
    } finally {
      eventDatabase.close();
    }
    expectRecordInvalid(() =>
      eventScenario.fixture.store.getLandingStatus(eventScenario.fixture.landingId),
    );
  });

  it("refuses to clear effectful retry ancestry on the next object operation", async () => {
    const scenario = await createProvenEffectfulRetryFixture();
    const retryPreflight = await resumeAndCompletePreflight(scenario.fixture);
    injectStartedObjects(scenario.fixture, retryPreflight.status, {
      operationId: RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 2,
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    });

    expectRecordInvalid(() => scenario.fixture.store.getLandingStatus(scenario.fixture.landingId));
  });

  it("refuses wrong-digest, self, future, and non-effectful retry substitutes", async () => {
    for (const substitution of ["wrong_digest", "self", "future", "preflight"] as const) {
      const scenario = await createProvenEffectfulRetryFixture();
      const retryPreflight = await resumeAndCompletePreflight(scenario.fixture);
      const immediatePreflight = retryPreflight.status.operations.at(-1);
      if (immediatePreflight?.kind !== "github.preflight") {
        throw new Error("Retry substitution fixture lost its immediate preflight");
      }
      const retrySubjectOperationId =
        substitution === "wrong_digest"
          ? scenario.retrySubjectOperationId
          : substitution === "self"
            ? RETRY_OBJECT_OPERATION_ID
            : substitution === "future"
              ? SECOND_RETRY_OBJECT_OPERATION_ID
              : immediatePreflight.id;
      const retrySubjectRequestSha256 =
        substitution === "preflight"
          ? immediatePreflight.requestSha256
          : substitution === "wrong_digest"
            ? sha256("wrong proved subject request")
            : sha256(`${substitution} unproved retry subject`);
      injectStartedObjects(scenario.fixture, retryPreflight.status, {
        operationId: RETRY_OBJECT_OPERATION_ID,
        kindAttempt: 2,
        retrySubjectOperationId,
        retrySubjectRequestSha256,
      });

      expectRecordInvalid(() =>
        scenario.fixture.store.getLandingStatus(scenario.fixture.landingId),
      );
    }
  });

  it("refuses to substitute a reconciled zero-POST subject for older effectful ancestry", async () => {
    const scenario = await createProvenEffectfulRetryFixture();
    const retryPreflight = await resumeAndCompletePreflight(scenario.fixture);
    const zeroPostSubject = injectStartedObjects(scenario.fixture, retryPreflight.status, {
      operationId: RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 2,
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });
    const retryStarted = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    settleObjects(
      scenario.fixture,
      retryPreflight.status,
      retryPreflight.material,
      zeroPostSubject,
      retryStarted,
      "ambiguous",
      RETRY_OBJECT_REQUEST_IDS,
    );
    const unresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    injectCompletedObjectRetryReconciliation(scenario.fixture, unresolved);

    const nextPreflight = await resumeAndCompletePreflight(scenario.fixture);
    injectStartedObjects(scenario.fixture, nextPreflight.status, {
      operationId: SECOND_RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 3,
      retrySubjectOperationId: zeroPostSubject.operationId,
      retrySubjectRequestSha256: digestLandingRecord(zeroPostSubject),
    });

    expectRecordInvalid(() => scenario.fixture.store.getLandingStatus(scenario.fixture.landingId));
  });

  it("refuses stale earlier ancestry after a later effectful subject earns authority", async () => {
    const scenario = await createProvenEffectfulRetryFixture();
    const retryPreflight = await resumeAndCompletePreflight(scenario.fixture);
    const laterEffectfulSubject = injectStartedObjects(scenario.fixture, retryPreflight.status, {
      operationId: RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 2,
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });
    const retryStarted = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    settleObjects(
      scenario.fixture,
      retryPreflight.status,
      retryPreflight.material,
      laterEffectfulSubject,
      retryStarted,
      "post_ambiguous",
      RETRY_OBJECT_REQUEST_IDS,
    );
    const unresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    injectCompletedObjectRetryReconciliation(scenario.fixture, unresolved);

    const nextPreflight = await resumeAndCompletePreflight(scenario.fixture);
    injectStartedObjects(scenario.fixture, nextPreflight.status, {
      operationId: SECOND_RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 3,
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });

    expectRecordInvalid(() => scenario.fixture.store.getLandingStatus(scenario.fixture.landingId));
  });

  it("rejects a persisted half-null retry pair before it can become ancestry", async () => {
    const scenario = await createProvenEffectfulRetryFixture();
    const retryPreflight = await resumeAndCompletePreflight(scenario.fixture);
    const retryOperation = injectStartedObjects(scenario.fixture, retryPreflight.status, {
      operationId: RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 2,
      retrySubjectOperationId: scenario.retrySubjectOperationId,
      retrySubjectRequestSha256: scenario.retrySubjectRequestSha256,
    });
    const database = new Database(scenario.fixture.databasePath);
    try {
      const halfPair = {
        ...retryOperation,
        input: {
          ...retryOperation.input,
          retrySubjectRequestSha256: null,
        },
      };
      const requestJson = canonicalLandingJson(halfPair);
      expect(
        database
          .prepare(
            "UPDATE landing_operations SET request_json = ?, request_sha256 = ? " +
              "WHERE landing_id = ? AND id = ?",
          )
          .run(
            requestJson,
            sha256(requestJson),
            scenario.fixture.landingId,
            retryOperation.operationId,
          ).changes,
      ).toBe(1);
    } finally {
      database.close();
    }

    expectRecordInvalid(() => scenario.fixture.store.getLandingStatus(scenario.fixture.landingId));
  });

  it("refuses an older-subject reconcile after an interrupted current-subject link", async () => {
    const scenario = await createStartedObjectFixture();
    settleObjects(
      scenario.fixture,
      scenario.preflightStatus,
      scenario.material,
      scenario.operation,
      scenario.startedStatus,
      "ambiguous",
    );
    const firstUnresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    const olderSubject = firstUnresolved.operations.at(-1);
    if (olderSubject?.kind !== "github.objects.upload") {
      throw new Error("Competing-subject fixture lost its first object subject");
    }
    injectCompletedObjectRetryReconciliation(scenario.fixture, firstUnresolved);
    scenario.fixture.store.admitLandingResume(scenario.fixture.landingId);
    let retryPreflight!: Awaited<ReturnType<typeof completePreflight>>;
    await scenario.fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      retryPreflight = await completePreflight(scenario.fixture, guard);
    });
    const retryOperation = injectStartedObjects(scenario.fixture, retryPreflight.status, {
      operationId: RETRY_OBJECT_OPERATION_ID,
      kindAttempt: 2,
    });
    const retryStarted = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    settleObjects(
      scenario.fixture,
      retryPreflight.status,
      retryPreflight.material,
      retryOperation,
      retryStarted,
      "ambiguous",
      RETRY_OBJECT_REQUEST_IDS,
    );
    const currentUnresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    injectCompletedObjectRetryReconciliation(
      scenario.fixture,
      currentUnresolved,
      1,
      undefined,
      olderSubject,
    );

    expectRecordInvalid(() => scenario.fixture.store.getLandingStatus(scenario.fixture.landingId));
  });

  it("keeps object subject_settled reconciliation outside the loader authority slice", async () => {
    const scenario = await createStartedObjectFixture();
    settleObjects(
      scenario.fixture,
      scenario.preflightStatus,
      scenario.material,
      scenario.operation,
      scenario.startedStatus,
      "ambiguous",
    );
    const unresolved = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    const injected = injectCompletedObjectRetryReconciliation(scenario.fixture, unresolved);
    const settled = scenario.fixture.store
      .getLandingStatus(scenario.fixture.landingId)
      .operations.find((operation) => operation.id === injected.terminalOperationId);
    const subjectId = (
      settled?.request.input as { readonly subjectOperationId?: string } | undefined
    )?.subjectOperationId;
    if (
      settled?.kind !== "landing.reconcile" ||
      settled.observation === null ||
      subjectId === undefined ||
      unresolved.landing.candidateCommitSha1 === null
    ) {
      throw new Error("Subject-settled corruption lost its reconciliation evidence");
    }
    const result: LandingOperationResultV1 = {
      schemaVersion: 1,
      operationId: settled.id,
      kind: "landing.reconcile",
      outcome: "completed",
      boundary: "subject_settled",
      evidence: settled.observation.facts.map(({ requestId, resultSha256 }) => ({
        requestId,
        resultSha256,
      })),
      value: {
        subjectOperationId: subjectId,
        nextState: "local_ready",
        remoteResidue: "none",
        stageValue: {
          headRef: unresolved.landing.headRef,
          candidateCommitSha1: unresolved.landing.candidateCommitSha1,
          localRefOutcome: "reconciled",
          updateRefExitCode: null,
        },
      },
      errorCode: null,
    };
    const resultJson = canonicalLandingJson(result);
    const resultSha256 = sha256(resultJson);
    const settledEvent = {
      schemaVersion: 1,
      landingId: scenario.fixture.landingId,
      operationId: settled.id,
      coordinatorAttempt: settled.coordinatorAttempt,
      kind: "landing.reconcile",
      outcome: "completed",
      resultSha256,
      errorCode: null,
    } satisfies LandingOperationSettledEventV1;
    const database = new Database(scenario.fixture.databasePath);
    try {
      expect(
        database
          .prepare("UPDATE landing_operations SET result_sha256 = ?, result_json = ? WHERE id = ?")
          .run(resultSha256, resultJson, settled.id).changes,
      ).toBe(1);
      expect(
        database
          .prepare(
            "UPDATE landing_events SET payload_json = ? WHERE landing_id = ? " +
              "AND type = 'landing.operation.settled' AND sequence = (" +
              "SELECT MAX(sequence) FROM landing_events WHERE landing_id = ? " +
              "AND type = 'landing.operation.settled')",
          )
          .run(
            canonicalLandingJson(settledEvent),
            scenario.fixture.landingId,
            scenario.fixture.landingId,
          ).changes,
      ).toBe(1);
    } finally {
      database.close();
    }

    expectRecordInvalid(() => scenario.fixture.store.getLandingStatus(scenario.fixture.landingId));
  });

  it("preserves completed object bytes across takeover into a zero-op objects-ready successor", async () => {
    const scenario = await createStartedObjectFixture();
    settleObjects(
      scenario.fixture,
      scenario.preflightStatus,
      scenario.material,
      scenario.operation,
      scenario.startedStatus,
      "complete",
    );
    const completed = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    const completedObject = completed.operations.at(-1);
    const successor = injectCompletedObjectTakeover(scenario.fixture, completed);

    const loaded = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(loaded.landing.state).toBe("objects_ready");
    expect(loaded.attempts.slice(-2)).toMatchObject([
      { status: "interrupted", errorCode: "LANDING_COORDINATOR_TAKEOVER" },
      { ordinal: successor, status: "started", errorCode: null },
    ]);
    expect(loaded.operations.at(-1)).toEqual(completedObject);
  });

  it("rejects an orphan object request event before treating it as durable history", async () => {
    const scenario = await createStartedObjectFixture();
    const projection = validateGitHubObjectsUploadHttpHistoryV1(
      objectHistoryInput(scenario.material, scenario.preflightStatus, scenario.operation, []),
    );
    if (projection.status !== "next_request") throw new Error("Expected actor request");
    const request = {
      ...projection.nextRequest,
      requestId: OBJECT_REQUEST_IDS[0] ?? "",
    } as LandingHttpRequestV1;
    const database = new Database(scenario.fixture.databasePath);
    try {
      appendEvent(database, scenario.fixture.landingId, "landing.github.request.admitted", {
        schemaVersion: 1,
        landingId: scenario.fixture.landingId,
        operationId: scenario.operation.operationId,
        requestId: request.requestId,
        coordinatorAttempt: scenario.operation.coordinatorAttempt,
        operationKind: "github.objects.upload",
        requestOrdinal: request.requestOrdinal,
        kind: request.kind,
        requestSha256: digestLandingRecord(request),
      } satisfies LandingGitHubRequestAdmittedEventV1);
    } finally {
      database.close();
    }
    expectRecordInvalid(() => scenario.fixture.store.getLandingStatus(scenario.fixture.landingId));
  });
});
