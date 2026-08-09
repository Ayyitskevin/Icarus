import { createRequire } from "node:module";

import { sha256 } from "../../packages/core/src/digest.js";
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
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
  type LandingOperationObservationV1,
  type LandingOperationRequestV1,
  type LandingOperationResultV1,
} from "../../packages/core/src/landing-records.js";
import type { RunLeaseGuard } from "../../packages/core/src/lease.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import {
  createLandingGitHubMaterialFixture,
  type LandingGitHubMaterialFixture,
} from "../support/landing-github-material-fixture.js";

export interface ReconciliationTestDatabase {
  prepare(sql: string): {
    run(...parameters: unknown[]): { readonly changes: number };
    get(...parameters: unknown[]): unknown;
  };
  close(): void;
}

export const ReconciliationDatabase = createRequire(
  new URL("../../packages/core/package.json", import.meta.url),
)("better-sqlite3") as new (
  filename: string,
) => ReconciliationTestDatabase;

export const OBJECT_OPERATION_ID = "a0000000-0000-4000-8000-000000000001";
const OBJECT_REQUEST_IDS = Array.from(
  { length: 8 },
  (_, index) => `a0000000-0000-4000-8000-${(index + 16).toString(16).padStart(12, "0")}`,
);
const STARTED_AT = "2026-07-19T12:00:00.000Z";
const FINISHED_AT = "2026-07-19T12:00:00.000Z";

interface PersistedExchange extends GitHubObjectsHistoryExchangeV1 {
  readonly request: LandingHttpRequestV1;
  readonly requestSha256: string;
  readonly result: LandingHttpResultV1;
  readonly resultSha256: string;
}

export interface ObjectReconciliationScenario {
  readonly fixture: LandingGitHubMaterialFixture;
  readonly preflightStatus: LandingStatusV1;
  readonly material: LandingGitHubMaterialSnapshotV1;
  readonly operation: LandingOperationRequestV1 & { readonly kind: "github.objects.upload" };
  readonly startedStatus: LandingStatusV1;
}

function requireChange(result: { readonly changes: number }, message: string): void {
  if (result.changes !== 1) throw new Error(message);
}

export function appendReconciliationEvent(
  database: ReconciliationTestDatabase,
  landingId: string,
  type: string,
  payload: unknown,
): void {
  const source = database
    .prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM landing_events WHERE landing_id = ?",
    )
    .get(landingId) as { readonly sequence: number };
  requireChange(
    database
      .prepare(
        "INSERT INTO landing_events (landing_id, sequence, type, payload_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .run(landingId, source.sequence + 1, type, canonicalLandingJson(payload), STARTED_AT),
    "Could not append landing fixture event",
  );
}

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
    throw new Error(`Unexpected preflight fixture request ${request.kind}`);
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

function preflightSettlement(
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
      preflightSettlement(admitted.request, result),
    );
  }
  if (material === null) throw new Error("Preflight fixture lost immutable object material");
  return { status: fixture.store.getLandingStatus(fixture.landingId), material };
}

function injectStartedObject(
  fixture: LandingGitHubMaterialFixture,
  completedPreflight: LandingStatusV1,
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
    throw new Error("Object fixture lacks its completed same-attempt preflight");
  }
  const operation: LandingOperationRequestV1 & { readonly kind: "github.objects.upload" } = {
    schemaVersion: 1,
    operationId: OBJECT_OPERATION_ID,
    landingId: fixture.landingId,
    coordinatorAttempt: attempt.ordinal,
    kindAttempt: 1,
    kind: "github.objects.upload",
    expectedState: "local_ready",
    expectedVersion: completedPreflight.landing.version,
    input: {
      landingSha256: completedPreflight.landing.landingSha256,
      candidateObjectManifestSha256: fixture.candidateManifestSha256,
      changedPathsSha256: completedPreflight.landing.changedPathsSha256,
      preflightOperationId: preflight.id,
      preflightResultSha256: preflight.resultSha256,
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    },
  };
  const operationJson = canonicalLandingJson(operation);
  const requestSha256 = sha256(operationJson);
  const database = new ReconciliationDatabase(fixture.databasePath);
  try {
    requireChange(
      database
        .prepare(
          "INSERT INTO landing_operations " +
            "(id, landing_id, coordinator_attempt, kind, kind_attempt, status, request_sha256, " +
            "request_json, observation_sha256, observation_json, result_sha256, result_json, " +
            "error_code, started_at, finished_at) " +
            "VALUES (?, ?, ?, 'github.objects.upload', 1, 'started', ?, ?, NULL, NULL, NULL, " +
            "NULL, NULL, ?, NULL)",
        )
        .run(
          operation.operationId,
          fixture.landingId,
          attempt.ordinal,
          requestSha256,
          operationJson,
          STARTED_AT,
        ),
      "Could not insert object fixture operation",
    );
    appendReconciliationEvent(database, fixture.landingId, "landing.operation.started", {
      schemaVersion: 1,
      landingId: fixture.landingId,
      operationId: operation.operationId,
      coordinatorAttempt: attempt.ordinal,
      kind: "github.objects.upload",
      kindAttempt: 1,
      requestSha256,
    });
    requireChange(
      database
        .prepare(
          "UPDATE landings SET state = 'uploading_objects', resume_state = NULL, " +
            "error_code = NULL, version = version + 1, updated_at = ? " +
            "WHERE id = ? AND state = 'local_ready' AND version = ?",
        )
        .run(STARTED_AT, fixture.landingId, completedPreflight.landing.version),
      "Could not enter the object fixture action state",
    );
    appendReconciliationEvent(database, fixture.landingId, "landing.state.changed", {
      schemaVersion: 1,
      landingId: fixture.landingId,
      from: "local_ready",
      to: "uploading_objects",
      version: completedPreflight.landing.version + 1,
      operationId: operation.operationId,
    });
  } finally {
    database.close();
  }
  return operation;
}

function objectHistoryInput(
  scenario: ObjectReconciliationScenario,
  exchanges: readonly GitHubObjectsHistoryExchangeV1[],
): Record<string, unknown> {
  const preflight = scenario.preflightStatus.operations.at(-1);
  if (
    preflight?.kind !== "github.preflight" ||
    preflight.result === null ||
    preflight.resultSha256 === null
  ) {
    throw new Error("Object fixture history lost its completed preflight");
  }
  return {
    material: scenario.material,
    landingSha256: digestLandingRecord(scenario.material.landing),
    preflightOperation: preflight.request,
    preflightOperationRequestSha256: preflight.requestSha256,
    preflightResult: preflight.result,
    preflightResultSha256: preflight.resultSha256,
    operation: scenario.operation,
    operationRequestSha256: digestLandingRecord(scenario.operation),
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
  throw new Error(`Unexpected object fixture request ${request.kind}`);
}

function nextObjectRequest(
  scenario: ObjectReconciliationScenario,
  exchanges: readonly PersistedExchange[],
): LandingHttpRequestV1 {
  const projection = validateGitHubObjectsUploadHttpHistoryV1(
    objectHistoryInput(scenario, exchanges),
  );
  if (projection.status !== "next_request") {
    throw new Error("Object fixture has no next request");
  }
  const requestId = OBJECT_REQUEST_IDS[exchanges.length];
  if (requestId === undefined) throw new Error("Object fixture request identities are exhausted");
  return { ...projection.nextRequest, requestId } as LandingHttpRequestV1;
}

function persistSettledExchange(
  database: ReconciliationTestDatabase,
  landingId: string,
  exchange: PersistedExchange,
): void {
  const { request, result } = exchange;
  requireChange(
    database
      .prepare(
        "INSERT INTO landing_http_requests " +
          "(id, landing_id, operation_id, coordinator_attempt, operation_kind, request_ordinal, " +
          "kind, method, request_sha256, request_json, status, outcome, http_status, " +
          "result_sha256, result_json, error_code, admitted_at, settled_at) " +
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
        result.outcome,
        result.httpStatus,
        exchange.resultSha256,
        canonicalLandingJson(result),
        result.errorCode,
        STARTED_AT,
        FINISHED_AT,
      ),
    "Could not persist settled object exchange",
  );
  appendReconciliationEvent(database, landingId, "landing.github.request.admitted", {
    schemaVersion: 1,
    landingId,
    operationId: request.operationId,
    requestId: request.requestId,
    coordinatorAttempt: request.coordinatorAttempt,
    operationKind: "github.objects.upload",
    requestOrdinal: request.requestOrdinal,
    kind: request.kind,
    requestSha256: exchange.requestSha256,
  });
  appendReconciliationEvent(database, landingId, "landing.github.request.settled", {
    schemaVersion: 1,
    landingId,
    operationId: request.operationId,
    requestId: request.requestId,
    coordinatorAttempt: request.coordinatorAttempt,
    operationKind: "github.objects.upload",
    requestOrdinal: request.requestOrdinal,
    kind: request.kind,
    outcome: result.outcome,
    resultSha256: exchange.resultSha256,
    errorCode: result.errorCode,
  });
}

function persistAdmittedRequest(
  database: ReconciliationTestDatabase,
  landingId: string,
  request: LandingHttpRequestV1,
): void {
  const requestSha256 = digestLandingRecord(request);
  requireChange(
    database
      .prepare(
        "INSERT INTO landing_http_requests " +
          "(id, landing_id, operation_id, coordinator_attempt, operation_kind, request_ordinal, " +
          "kind, method, request_sha256, request_json, status, outcome, http_status, " +
          "result_sha256, result_json, error_code, admitted_at, settled_at) " +
          "VALUES (?, ?, ?, ?, 'github.objects.upload', ?, ?, ?, ?, ?, 'admitted', NULL, NULL, " +
          "NULL, NULL, NULL, ?, NULL)",
      )
      .run(
        request.requestId,
        landingId,
        request.operationId,
        request.coordinatorAttempt,
        request.requestOrdinal,
        request.kind,
        request.method,
        requestSha256,
        canonicalLandingJson(request),
        STARTED_AT,
      ),
    "Could not persist admitted object request",
  );
  appendReconciliationEvent(database, landingId, "landing.github.request.admitted", {
    schemaVersion: 1,
    landingId,
    operationId: request.operationId,
    requestId: request.requestId,
    coordinatorAttempt: request.coordinatorAttempt,
    operationKind: "github.objects.upload",
    requestOrdinal: request.requestOrdinal,
    kind: request.kind,
    requestSha256,
  });
}

function actorSuccess(scenario: ObjectReconciliationScenario): {
  readonly exchange: PersistedExchange;
  readonly observation: LandingOperationObservationV1;
} {
  const request = nextObjectRequest(scenario, []);
  const result = successfulObjectResult(scenario.preflightStatus, request);
  const exchange = {
    request,
    requestSha256: digestLandingRecord(request),
    result,
    resultSha256: digestLandingRecord(result),
  } satisfies PersistedExchange;
  return {
    exchange,
    observation: {
      schemaVersion: 1,
      operationId: scenario.operation.operationId,
      kind: "github.objects.upload",
      phase: "pre_effect",
      facts: [
        {
          fact: "actor",
          requestId: request.requestId,
          resultSha256: exchange.resultSha256,
        },
      ],
    },
  };
}

function persistObjectObservation(
  database: ReconciliationTestDatabase,
  scenario: ObjectReconciliationScenario,
  observation: LandingOperationObservationV1,
): void {
  const observationJson = canonicalLandingJson(observation);
  requireChange(
    database
      .prepare(
        "UPDATE landing_operations SET observation_sha256 = ?, observation_json = ? " +
          "WHERE id = ? AND landing_id = ? AND status = 'started'",
      )
      .run(
        sha256(observationJson),
        observationJson,
        scenario.operation.operationId,
        scenario.fixture.landingId,
      ),
    "Could not persist object actor observation",
  );
}

async function advancePreflightFailuresToAttemptEight(
  fixture: LandingGitHubMaterialFixture,
  guard: RunLeaseGuard,
): Promise<void> {
  for (let expectedAttempt = 3; expectedAttempt < 8; expectedAttempt += 1) {
    const activeAttempt = fixture.store
      .getLandingStatus(fixture.landingId)
      .attempts.find((attempt) => attempt.status === "started");
    if (activeAttempt?.ordinal !== expectedAttempt) {
      throw new Error(`Expected active preflight attempt ${expectedAttempt}`);
    }
    const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
    const admitted = await fixture.store.admitNextGitHubPreflightRequest(
      guard,
      fixture.landingId,
      started.operationId,
    );
    await fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId);
    const result: LandingHttpResultV1 = {
      schemaVersion: 1,
      requestId: admitted.request.requestId,
      kind: admitted.request.kind,
      outcome: "failed",
      httpStatus: 403,
      projection: null,
      errorCode: "GITHUB_PERMISSION_DENIED",
    };
    await fixture.store.settleGitHubPreflightRequest(
      guard,
      fixture.landingId,
      started.operationId,
      preflightSettlement(admitted.request, result),
    );
    const resumed = await fixture.store.admitGuardedLandingResume(guard, fixture.landingId);
    if (resumed.attemptOrdinal !== expectedAttempt + 1 || resumed.operationId !== null) {
      throw new Error(`Could not advance to preflight attempt ${expectedAttempt + 1}`);
    }
  }
}

async function createStartedObjectScenarioForAttempt(
  admitted: "none" | "actor" | "blob" = "none",
  attemptEight = false,
): Promise<ObjectReconciliationScenario> {
  const fixture = await createLandingGitHubMaterialFixture();
  let preflight!: Awaited<ReturnType<typeof completePreflight>>;
  await fixture.leases.withLease(
    fixture.store.getLandingStatus(fixture.landingId).landing.runId,
    async (guard) => {
      if (attemptEight) await advancePreflightFailuresToAttemptEight(fixture, guard);
      preflight = await completePreflight(fixture, guard);
    },
  );
  const operation = injectStartedObject(fixture, preflight.status);
  const scenario: ObjectReconciliationScenario = {
    fixture,
    preflightStatus: preflight.status,
    material: preflight.material,
    operation,
    startedStatus: fixture.store.getLandingStatus(fixture.landingId),
  };
  if (admitted === "none") return scenario;
  const database = new ReconciliationDatabase(fixture.databasePath);
  try {
    if (admitted === "actor") {
      persistAdmittedRequest(database, fixture.landingId, nextObjectRequest(scenario, []));
    } else {
      const actor = actorSuccess(scenario);
      persistSettledExchange(database, fixture.landingId, actor.exchange);
      persistObjectObservation(database, scenario, actor.observation);
      persistAdmittedRequest(
        database,
        fixture.landingId,
        nextObjectRequest(scenario, [actor.exchange]),
      );
    }
  } finally {
    database.close();
  }
  return scenario;
}

export async function createStartedObjectScenario(
  admitted: "none" | "actor" | "blob" = "none",
): Promise<ObjectReconciliationScenario> {
  return createStartedObjectScenarioForAttempt(admitted);
}

export async function createStartedObjectScenarioAtAttemptEight(
  admitted: "none" | "actor" | "blob" = "none",
): Promise<ObjectReconciliationScenario> {
  return createStartedObjectScenarioForAttempt(admitted, true);
}

export async function createUnresolvedObjectScenario(
  effectfulPost = false,
): Promise<ObjectReconciliationScenario> {
  const scenario = await createStartedObjectScenario();
  const exchanges: PersistedExchange[] = [];
  let observation: LandingOperationObservationV1 | null = null;
  if (effectfulPost) {
    const actor = actorSuccess(scenario);
    exchanges.push(actor.exchange);
    observation = actor.observation;
    const request = nextObjectRequest(scenario, exchanges);
    const result: LandingHttpResultV1 = {
      schemaVersion: 1,
      requestId: request.requestId,
      kind: request.kind,
      outcome: "ambiguous",
      httpStatus: null,
      projection: null,
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    };
    exchanges.push({
      request,
      requestSha256: digestLandingRecord(request),
      result,
      resultSha256: digestLandingRecord(result),
    });
  } else {
    const request = nextObjectRequest(scenario, []);
    const result: LandingHttpResultV1 = {
      schemaVersion: 1,
      requestId: request.requestId,
      kind: request.kind,
      outcome: "ambiguous",
      httpStatus: null,
      projection: null,
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    };
    exchanges.push({
      request,
      requestSha256: digestLandingRecord(request),
      result,
      resultSha256: digestLandingRecord(result),
    });
  }
  const result: LandingOperationResultV1 = {
    schemaVersion: 1,
    operationId: scenario.operation.operationId,
    kind: "github.objects.upload",
    outcome: "reconciliation_required",
    boundary: "reconciliation_required",
    evidence: exchanges.map((exchange) => ({
      requestId: exchange.request.requestId,
      resultSha256: exchange.resultSha256,
    })),
    value: { subjectOperationId: scenario.operation.operationId, remoteResidue: "none" },
    errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
  };
  const database = new ReconciliationDatabase(scenario.fixture.databasePath);
  try {
    for (const exchange of exchanges) {
      persistSettledExchange(database, scenario.fixture.landingId, exchange);
    }
    if (observation !== null) persistObjectObservation(database, scenario, observation);
    const resultJson = canonicalLandingJson(result);
    requireChange(
      database
        .prepare(
          "UPDATE landing_operations SET status = 'interrupted', result_sha256 = ?, " +
            "result_json = ?, error_code = 'GITHUB_OUTCOME_AMBIGUOUS', finished_at = ? " +
            "WHERE id = ? AND landing_id = ? AND status = 'started'",
        )
        .run(
          sha256(resultJson),
          resultJson,
          FINISHED_AT,
          scenario.operation.operationId,
          scenario.fixture.landingId,
        ),
      "Could not settle object reconciliation subject",
    );
    appendReconciliationEvent(database, scenario.fixture.landingId, "landing.operation.settled", {
      schemaVersion: 1,
      landingId: scenario.fixture.landingId,
      operationId: scenario.operation.operationId,
      coordinatorAttempt: scenario.operation.coordinatorAttempt,
      kind: "github.objects.upload",
      outcome: "reconciliation_required",
      resultSha256: sha256(resultJson),
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    requireChange(
      database
        .prepare(
          "UPDATE landing_attempts SET status = 'interrupted', finished_at = ?, " +
            "error_code = 'GITHUB_OUTCOME_AMBIGUOUS' WHERE landing_id = ? AND ordinal = ? " +
            "AND status = 'started'",
        )
        .run(FINISHED_AT, scenario.fixture.landingId, scenario.operation.coordinatorAttempt),
      "Could not settle object subject attempt",
    );
    appendReconciliationEvent(database, scenario.fixture.landingId, "landing.attempt.settled", {
      schemaVersion: 1,
      landingId: scenario.fixture.landingId,
      coordinatorAttempt: scenario.operation.coordinatorAttempt,
      outcome: "interrupted",
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    requireChange(
      database
        .prepare(
          "UPDATE landings SET state = 'reconciliation_required', resume_state = 'local_ready', " +
            "error_code = 'GITHUB_OUTCOME_AMBIGUOUS', version = version + 1, updated_at = ? " +
            "WHERE id = ? AND state = 'uploading_objects'",
        )
        .run(FINISHED_AT, scenario.fixture.landingId),
      "Could not enter object reconciliation state",
    );
    appendReconciliationEvent(database, scenario.fixture.landingId, "landing.state.changed", {
      schemaVersion: 1,
      landingId: scenario.fixture.landingId,
      from: "uploading_objects",
      to: "reconciliation_required",
      version: scenario.startedStatus.landing.version + 1,
      operationId: scenario.operation.operationId,
    });
  } finally {
    database.close();
  }
  scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
  return scenario;
}

async function completeObjectScenario(
  scenario: ObjectReconciliationScenario,
): Promise<ObjectReconciliationScenario> {
  const exchanges: PersistedExchange[] = [];
  while (true) {
    const projection = validateGitHubObjectsUploadHttpHistoryV1(
      objectHistoryInput(scenario, exchanges),
    );
    if (projection.status === "complete") {
      const database = new ReconciliationDatabase(scenario.fixture.databasePath);
      try {
        for (const exchange of exchanges) {
          persistSettledExchange(database, scenario.fixture.landingId, exchange);
        }
        const observationJson = canonicalLandingJson(projection.observation);
        const resultJson = canonicalLandingJson(projection.operationResult);
        requireChange(
          database
            .prepare(
              "UPDATE landing_operations SET status = 'completed', observation_sha256 = ?, " +
                "observation_json = ?, result_sha256 = ?, result_json = ?, finished_at = ? " +
                "WHERE id = ? AND landing_id = ? AND status = 'started'",
            )
            .run(
              sha256(observationJson),
              observationJson,
              sha256(resultJson),
              resultJson,
              FINISHED_AT,
              scenario.operation.operationId,
              scenario.fixture.landingId,
            ),
          "Could not complete object operation",
        );
        appendReconciliationEvent(
          database,
          scenario.fixture.landingId,
          "landing.operation.settled",
          {
            schemaVersion: 1,
            landingId: scenario.fixture.landingId,
            operationId: scenario.operation.operationId,
            coordinatorAttempt: scenario.operation.coordinatorAttempt,
            kind: "github.objects.upload",
            outcome: "completed",
            resultSha256: sha256(resultJson),
            errorCode: null,
          },
        );
        requireChange(
          database
            .prepare(
              "UPDATE landings SET state = 'objects_ready', resume_state = NULL, error_code = NULL, " +
                "version = version + 1, updated_at = ? WHERE id = ? AND state = 'uploading_objects'",
            )
            .run(FINISHED_AT, scenario.fixture.landingId),
          "Could not enter objects-ready fixture state",
        );
        appendReconciliationEvent(database, scenario.fixture.landingId, "landing.state.changed", {
          schemaVersion: 1,
          landingId: scenario.fixture.landingId,
          from: "uploading_objects",
          to: "objects_ready",
          version: scenario.startedStatus.landing.version + 1,
          operationId: scenario.operation.operationId,
        });
      } finally {
        database.close();
      }
      scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
      return scenario;
    }
    const requestId = OBJECT_REQUEST_IDS[exchanges.length];
    if (requestId === undefined) throw new Error("Completed object fixture exceeded its IDs");
    const request = { ...projection.nextRequest, requestId } as LandingHttpRequestV1;
    const result = successfulObjectResult(scenario.preflightStatus, request);
    exchanges.push({
      request,
      requestSha256: digestLandingRecord(request),
      result,
      resultSha256: digestLandingRecord(result),
    });
  }
}

export async function createCompletedObjectScenario(): Promise<ObjectReconciliationScenario> {
  return completeObjectScenario(await createStartedObjectScenario());
}

export async function createCompletedObjectScenarioAtAttemptEight(): Promise<ObjectReconciliationScenario> {
  return completeObjectScenario(await createStartedObjectScenarioAtAttemptEight());
}

export function reopenReconciliationStore(scenario: ObjectReconciliationScenario): IcarusStore {
  scenario.fixture.store.close();
  return new IcarusStore(scenario.fixture.databasePath);
}
