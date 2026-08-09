import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  type GitHubObjectsHistoryExchangeV1,
  validateGitHubObjectsUploadHttpHistoryV1,
} from "../../packages/core/src/landing-objects-history.js";
import { validatePersistedGitHubObjectsReconciliationV1 } from "../../packages/core/src/landing-objects-reconciliation-persistence.js";
import {
  buildUnsignedCommitPayloadV1,
  canonicalLandingJson,
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  decodeCandidateObjectManifestV1,
  decodeLandingOperationObservationV1,
  decodeLandingOperationResultV1,
  digestLandingRecord,
  type GitHubLandingProfileV1,
  gitObjectSha1,
  type LandingDigestV1,
  type LandingEventPayloadV1,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
  type LandingOperationObservationV1,
  type LandingOperationRequestV1,
  type LandingOperationResultV1,
} from "../../packages/core/src/landing-records.js";

const LANDING_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const REVIEW_ID = "44444444-4444-4444-8444-444444444444";
const PREFLIGHT_ID = "55555555-5555-4555-8555-555555555555";
const SUBJECT_ID = "66666666-6666-4666-8666-666666666666";
const RECONCILIATION_IDS = [
  "90000000-0000-4000-8000-000000000001",
  "90000000-0000-4000-8000-000000000002",
] as const;
const REQUEST_IDS = [
  "70000000-0000-4000-8000-000000000001",
  "70000000-0000-4000-8000-000000000002",
] as const;
const PREFLIGHT_REQUEST_IDS = [
  "80000000-0000-4000-8000-000000000001",
  "80000000-0000-4000-8000-000000000002",
  "80000000-0000-4000-8000-000000000003",
] as const;
const BASE_COMMIT = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const CANDIDATE_TREE = "c".repeat(40);
const PATH = "src/main.ts";
const CONTENT = Buffer.from("export const ready = true;\n", "utf8");
const COMMIT_EPOCH_SECONDS = 1_700_000_000;
const COMMIT_MESSAGE = "Upload one reviewed object\n";
const TITLE = "Upload one reviewed object";
const BODY_PREFIX = "Durable evidence accompanies this change.";
const OBJECT_START_VERSION = 4;
const RECONCILIATION_VERSION = OBJECT_START_VERSION + 2;
const SUBJECT_ATTEMPT = 2;
const TAKEOVER_ERROR = "LANDING_COORDINATOR_TAKEOVER";

const PROFILE: GitHubLandingProfileV1 = {
  version: 1,
  provider: "github",
  owner: "octocat",
  repository: "icarus-objects-reconciliation",
  baseBranch: "main",
  branchNamespace: "icarus/",
  credentialRef: { kind: "environment", name: "ICARUS_GITHUB_TOKEN_TEST" },
  expectedActor: "octocat",
  commitIdentity: { name: "Icarus Landing", email: "landing@example.invalid" },
  derivativeEffects: {
    version: 1,
    disposition: "inert-repository",
    evidenceSha256: sha256("inert-repository-assessment"),
  },
};

const COMMIT_INSTANT = commitEpochToGitInstant(COMMIT_EPOCH_SECONDS);
const COMMIT_PAYLOAD = buildUnsignedCommitPayloadV1({
  candidateTreeSha1: CANDIDATE_TREE,
  baseCommitSha1: BASE_COMMIT,
  commitIdentity: PROFILE.commitIdentity,
  commitEpochSeconds: COMMIT_EPOCH_SECONDS,
  commitMessage: COMMIT_MESSAGE,
});
const CANDIDATE_COMMIT = gitObjectSha1("commit", COMMIT_PAYLOAD);
const MANIFEST = decodeCandidateObjectManifestV1({
  schemaVersion: 1,
  baseCommitSha1: BASE_COMMIT,
  baseTreeSha1: BASE_TREE,
  candidateTreeSha1: CANDIDATE_TREE,
  candidateCommitSha1: CANDIDATE_COMMIT,
  candidateCommitPayloadSha256: sha256(COMMIT_PAYLOAD),
  entries: [
    {
      path: PATH,
      op: "create",
      mode: "100644",
      blobSha1: gitObjectSha1("blob", CONTENT),
      contentBytes: CONTENT.byteLength,
      contentSha256: sha256(CONTENT),
    },
  ],
});

const LANDING: LandingDigestV1 = {
  schemaVersion: 1,
  policyVersion: 1,
  githubApiVersion: "2026-03-10",
  landingId: LANDING_ID,
  runId: RUN_ID,
  projectId: PROJECT_ID,
  baseCommitSha1: BASE_COMMIT,
  baseTreeSha1: BASE_TREE,
  planSha256: sha256("plan"),
  diffSha256: sha256("diff"),
  checkpointSha256: sha256("checkpoint"),
  verificationSha256: sha256("verification"),
  reviewDecisionId: REVIEW_ID,
  reviewDecisionSha256: sha256("review"),
  changedPaths: [PATH],
  changedPathsSha256: digestLandingRecord({ schemaVersion: 1, paths: [PATH] }),
  candidateCredentialAuditSha256: sha256("credential-audit"),
  profileVersion: 1,
  profileSha256: digestLandingRecord(PROFILE),
  profile: PROFILE,
  objectFormat: "sha1",
  candidateParentSha1: BASE_COMMIT,
  candidateTreeSha1: CANDIDATE_TREE,
  candidateCommitSha1: CANDIDATE_COMMIT,
  candidateCommitPayloadSha256: sha256(COMMIT_PAYLOAD),
  candidateObjectManifestSha256: digestLandingRecord(MANIFEST),
  commitMessageSha256: sha256(COMMIT_MESSAGE),
  commitAuthor: PROFILE.commitIdentity,
  commitCommitter: PROFILE.commitIdentity,
  commitEpochSeconds: COMMIT_EPOCH_SECONDS,
  commitIso8601: COMMIT_INSTANT,
  baseRef: "refs/heads/main",
  expectedRemoteBaseSha1: BASE_COMMIT,
  headRef: `refs/heads/icarus/${RUN_ID}`,
  pullRequestTitleSha256: sha256(TITLE),
  pullRequestBodyPrefixSha256: sha256(BODY_PREFIX),
  pullRequestMarkerVersion: 1,
  draft: true,
  maintainerCanModify: false,
  directIcarusEffects: DIRECT_ICARUS_EFFECTS,
  derivativeEffectDisclosure: {
    version: 1,
    githubEvents: DERIVATIVE_GITHUB_EVENTS,
    mayTrigger: DERIVATIVE_EFFECTS,
    disposition: PROFILE.derivativeEffects.disposition,
    evidenceSha256: PROFILE.derivativeEffects.evidenceSha256,
  },
};

const MATERIAL = {
  landing: LANDING,
  profile: PROFILE,
  objectManifest: MANIFEST,
  text: {
    commitMessage: COMMIT_MESSAGE,
    pullRequestTitle: TITLE,
    pullRequestBodyPrefix: BODY_PREFIX,
  },
  changedBlobs: [{ path: PATH, content: CONTENT }],
};

type MutableRow = Record<string, unknown>;
type PersistedInput = Record<string, unknown>;

function canonical(value: unknown): string {
  return canonicalLandingJson(value);
}

function operationRow(
  request: LandingOperationRequestV1,
  status: "started" | "completed" | "interrupted",
  observation: LandingOperationObservationV1 | null,
  result: LandingOperationResultV1 | null,
  startedAt: string,
  finishedAt: string | null,
): MutableRow {
  const requestJson = canonical(request);
  const observationJson = observation === null ? null : canonical(observation);
  const resultJson = result === null ? null : canonical(result);
  return {
    id: request.operationId,
    landing_id: request.landingId,
    coordinator_attempt: request.coordinatorAttempt,
    kind: request.kind,
    kind_attempt: request.kindAttempt,
    status,
    request_sha256: sha256(requestJson),
    request_json: requestJson,
    observation_sha256: observationJson === null ? null : sha256(observationJson),
    observation_json: observationJson,
    result_sha256: resultJson === null ? null : sha256(resultJson),
    result_json: resultJson,
    error_code: result?.errorCode ?? null,
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

function attemptRow(
  ordinal: number,
  status: "started" | "completed" | "interrupted",
  errorCode: string | null,
): MutableRow {
  return {
    landing_id: LANDING_ID,
    ordinal,
    status,
    started_at: `2026-08-08T12:${String(ordinal).padStart(2, "0")}:00.000Z`,
    finished_at:
      status === "started" ? null : `2026-08-08T12:${String(ordinal).padStart(2, "0")}:02.000Z`,
    error_code: errorCode,
  };
}

function eventRow(sequence: number, type: string, payload: LandingEventPayloadV1): MutableRow {
  return {
    id: sequence,
    landing_id: LANDING_ID,
    sequence,
    type,
    payload_json: canonical(payload),
    created_at: `2026-08-08T13:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}

function preflightRequest(): LandingOperationRequestV1 {
  return {
    schemaVersion: 1,
    operationId: PREFLIGHT_ID,
    landingId: LANDING_ID,
    coordinatorAttempt: SUBJECT_ATTEMPT,
    kindAttempt: 1,
    kind: "github.preflight",
    expectedState: "local_ready",
    expectedVersion: OBJECT_START_VERSION,
    input: {
      landingSha256: digestLandingRecord(LANDING),
      profileSha256: LANDING.profileSha256,
      baseRef: LANDING.baseRef,
      expectedRemoteBaseSha1: LANDING.expectedRemoteBaseSha1,
      headRef: LANDING.headRef,
      candidateCommitSha1: LANDING.candidateCommitSha1,
      includePullRequestAbsence: false,
    },
  };
}

function preflightObservation(): LandingOperationObservationV1 {
  return decodeLandingOperationObservationV1({
    schemaVersion: 1,
    operationId: PREFLIGHT_ID,
    kind: "github.preflight",
    phase: "pre_effect",
    facts: [
      { fact: "actor", requestId: PREFLIGHT_REQUEST_IDS[0], resultSha256: sha256("actor") },
      { fact: "base_ref", requestId: PREFLIGHT_REQUEST_IDS[1], resultSha256: sha256("base") },
      { fact: "head_ref", requestId: PREFLIGHT_REQUEST_IDS[2], resultSha256: sha256("head") },
    ],
  });
}

function preflightResult(): LandingOperationResultV1 {
  const observation = preflightObservation();
  return decodeLandingOperationResultV1({
    schemaVersion: 1,
    operationId: PREFLIGHT_ID,
    kind: "github.preflight",
    outcome: "completed",
    boundary: "preflight_exact",
    evidence: observation.facts.map(({ requestId, resultSha256 }) => ({
      requestId,
      resultSha256,
    })),
    value: {
      actor: PROFILE.expectedActor,
      baseSha1: BASE_COMMIT,
      headState: "absent",
      pullRequestCount: null,
    },
    errorCode: null,
  });
}

function subjectRequest(
  retrySubjectOperationId: string | null = null,
  retrySubjectRequestSha256: string | null = null,
): LandingOperationRequestV1 {
  const preflight = preflightResult();
  return {
    schemaVersion: 1,
    operationId: SUBJECT_ID,
    landingId: LANDING_ID,
    coordinatorAttempt: SUBJECT_ATTEMPT,
    kindAttempt: 1,
    kind: "github.objects.upload",
    expectedState: "local_ready",
    expectedVersion: OBJECT_START_VERSION,
    input: {
      landingSha256: digestLandingRecord(LANDING),
      candidateObjectManifestSha256: LANDING.candidateObjectManifestSha256,
      changedPathsSha256: LANDING.changedPathsSha256,
      preflightOperationId: PREFLIGHT_ID,
      preflightResultSha256: digestLandingRecord(preflight),
      retrySubjectOperationId,
      retrySubjectRequestSha256,
    },
  };
}

function history(
  exchanges: readonly GitHubObjectsHistoryExchangeV1[],
  operation: LandingOperationRequestV1 = subjectRequest(),
) {
  const preflight = preflightRequest();
  const preflightProof = preflightResult();
  return {
    material: MATERIAL,
    landingSha256: digestLandingRecord(LANDING),
    preflightOperation: preflight,
    preflightOperationRequestSha256: digestLandingRecord(preflight),
    preflightResult: preflightProof,
    preflightResultSha256: digestLandingRecord(preflightProof),
    operation,
    operationRequestSha256: digestLandingRecord(operation),
    previousRequestOrdinal: 3,
    exchanges,
  };
}

function nextObjectRequest(
  successes: readonly GitHubObjectsHistoryExchangeV1[],
  operation: LandingOperationRequestV1 = subjectRequest(),
): LandingHttpRequestV1 {
  const projected = validateGitHubObjectsUploadHttpHistoryV1(history(successes, operation));
  if (projected.status !== "next_request") throw new Error("expected next object request");
  const requestId = REQUEST_IDS[successes.length];
  if (requestId === undefined) throw new Error("missing request fixture identity");
  return { ...projected.nextRequest, requestId } as LandingHttpRequestV1;
}

function actorSuccess(
  operation: LandingOperationRequestV1 = subjectRequest(),
): GitHubObjectsHistoryExchangeV1 {
  const request = nextObjectRequest([], operation);
  const result: LandingHttpResultV1 = {
    schemaVersion: 1,
    requestId: request.requestId,
    kind: "github.actor.get",
    outcome: "succeeded",
    httpStatus: 200,
    projection: { type: "actor", login: PROFILE.expectedActor },
    errorCode: null,
  };
  return {
    request,
    requestSha256: digestLandingRecord(request),
    result,
    resultSha256: digestLandingRecord(result),
  };
}

function ambiguousTail(
  successes: readonly GitHubObjectsHistoryExchangeV1[],
  operation: LandingOperationRequestV1 = subjectRequest(),
): GitHubObjectsHistoryExchangeV1 {
  const request = nextObjectRequest(successes, operation);
  const result: LandingHttpResultV1 = {
    schemaVersion: 1,
    requestId: request.requestId,
    kind: request.kind,
    outcome: "ambiguous",
    httpStatus: null,
    projection: null,
    errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
  };
  return {
    request,
    requestSha256: digestLandingRecord(request),
    result,
    resultSha256: digestLandingRecord(result),
  };
}

function subjectObservation(
  exchanges: readonly GitHubObjectsHistoryExchangeV1[],
): LandingOperationObservationV1 | null {
  const actor = exchanges[0];
  if (actor === undefined || (actor.result as LandingHttpResultV1).outcome !== "succeeded") {
    return null;
  }
  return decodeLandingOperationObservationV1({
    schemaVersion: 1,
    operationId: SUBJECT_ID,
    kind: "github.objects.upload",
    phase: "pre_effect",
    facts: [
      {
        fact: "actor",
        requestId: (actor.request as LandingHttpRequestV1).requestId,
        resultSha256: actor.resultSha256,
      },
    ],
  });
}

function subjectResult(
  exchanges: readonly GitHubObjectsHistoryExchangeV1[],
  errorCode = "GITHUB_OUTCOME_AMBIGUOUS",
): LandingOperationResultV1 {
  return decodeLandingOperationResultV1({
    schemaVersion: 1,
    operationId: SUBJECT_ID,
    kind: "github.objects.upload",
    outcome: "reconciliation_required",
    boundary: "reconciliation_required",
    evidence: exchanges.map((exchange) => ({
      requestId: (exchange.request as LandingHttpRequestV1).requestId,
      resultSha256: exchange.resultSha256,
    })),
    value: { subjectOperationId: SUBJECT_ID, remoteResidue: "none" },
    errorCode,
  });
}

function requestEventPayload(request: LandingHttpRequestV1, requestSha256: string) {
  return {
    schemaVersion: 1 as const,
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

function resultEventPayload(
  request: LandingHttpRequestV1,
  result: LandingHttpResultV1,
  resultSha256: string,
) {
  return {
    schemaVersion: 1 as const,
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

interface RetrySubjectFixture {
  readonly operationId: string;
  readonly requestSha256: string;
}

function subjectAggregate(
  effectful: boolean,
  takeover = false,
  retrySubject: RetrySubjectFixture | null = null,
): PersistedInput {
  if (effectful && takeover) throw new Error("effectful takeover fixture is not implemented");
  const request = subjectRequest(
    retrySubject?.operationId ?? null,
    retrySubject?.requestSha256 ?? null,
  );
  const successes = effectful ? [actorSuccess(request)] : [];
  const exchanges = takeover ? [] : [...successes, ambiguousTail(successes, request)];
  const observation = subjectObservation(exchanges);
  const subjectError = takeover ? TAKEOVER_ERROR : "GITHUB_OUTCOME_AMBIGUOUS";
  const result = subjectResult(exchanges, subjectError);
  const preflight = preflightRequest();
  const preflightProof = preflightResult();
  const preflightRow = operationRow(
    preflight,
    "completed",
    preflightObservation(),
    preflightProof,
    "2026-08-08T12:00:00.000Z",
    "2026-08-08T12:00:01.000Z",
  );
  const objectRow = operationRow(
    request,
    "interrupted",
    observation,
    result,
    "2026-08-08T12:00:02.000Z",
    "2026-08-08T12:00:05.000Z",
  );
  const httpRows: MutableRow[] = [];
  const requestEvents: MutableRow[] = [];
  let sequence = 13;
  for (const exchange of exchanges) {
    const httpRequest = exchange.request as LandingHttpRequestV1;
    const httpResult = exchange.result as LandingHttpResultV1;
    const requestJson = canonical(httpRequest);
    const resultJson = canonical(httpResult);
    httpRows.push({
      id: httpRequest.requestId,
      landing_id: LANDING_ID,
      operation_id: SUBJECT_ID,
      coordinator_attempt: SUBJECT_ATTEMPT,
      operation_kind: "github.objects.upload",
      request_ordinal: httpRequest.requestOrdinal,
      kind: httpRequest.kind,
      method: httpRequest.method,
      request_sha256: exchange.requestSha256,
      request_json: requestJson,
      status: "settled",
      outcome: httpResult.outcome,
      http_status: httpResult.httpStatus,
      result_sha256: exchange.resultSha256,
      result_json: resultJson,
      error_code: httpResult.errorCode,
      admitted_at: "2026-08-08T12:00:03.000Z",
      settled_at: "2026-08-08T12:00:04.000Z",
    });
    requestEvents.push(
      eventRow(
        sequence,
        "landing.github.request.admitted",
        requestEventPayload(httpRequest, exchange.requestSha256 as string),
      ),
    );
    sequence += 1;
    requestEvents.push(
      eventRow(
        sequence,
        "landing.github.request.settled",
        resultEventPayload(httpRequest, httpResult, exchange.resultSha256 as string),
      ),
    );
    sequence += 1;
  }
  return {
    material: MATERIAL,
    landingSha256: digestLandingRecord(LANDING),
    operationStartState: "local_ready",
    operationStartVersion: OBJECT_START_VERSION,
    preflightOperationRow: preflightRow,
    preflightSettlementEventRow: eventRow(10, "landing.operation.settled", {
      schemaVersion: 1,
      landingId: LANDING_ID,
      operationId: PREFLIGHT_ID,
      coordinatorAttempt: SUBJECT_ATTEMPT,
      kind: "github.preflight",
      outcome: "completed",
      resultSha256: preflightRow.result_sha256 as string,
      errorCode: null,
    }),
    operationRow: objectRow,
    actionStateEventRow: eventRow(12, "landing.state.changed", {
      schemaVersion: 1,
      landingId: LANDING_ID,
      from: "local_ready",
      to: "uploading_objects",
      version: OBJECT_START_VERSION + 1,
      operationId: SUBJECT_ID,
    }),
    previousRequestOrdinal: 3,
    httpRows,
    requestEvents,
    operationEvents: [
      eventRow(11, "landing.operation.started", {
        schemaVersion: 1,
        landingId: LANDING_ID,
        operationId: SUBJECT_ID,
        coordinatorAttempt: SUBJECT_ATTEMPT,
        kind: "github.objects.upload",
        kindAttempt: 1,
        requestSha256: objectRow.request_sha256 as string,
      }),
      eventRow(sequence, "landing.operation.settled", {
        schemaVersion: 1,
        landingId: LANDING_ID,
        operationId: SUBJECT_ID,
        coordinatorAttempt: SUBJECT_ATTEMPT,
        kind: "github.objects.upload",
        outcome: "reconciliation_required",
        resultSha256: objectRow.result_sha256 as string,
        errorCode: subjectError,
      }),
    ],
  };
}

function subjectProjection(subject: PersistedInput): unknown {
  const row = subject.operationRow as MutableRow;
  const request = JSON.parse(row.request_json as string) as LandingOperationRequestV1;
  return {
    schemaVersion: 1,
    operationId: SUBJECT_ID,
    landingId: LANDING_ID,
    coordinatorAttempt: SUBJECT_ATTEMPT,
    kind: "github.objects.upload",
    kindAttempt: 1,
    status: "interrupted",
    requestSha256: row.request_sha256,
    observationSha256: row.observation_sha256,
    resultSha256: row.result_sha256,
    errorCode: row.error_code,
    request,
  };
}

interface LinkFixture {
  readonly attempt: MutableRow;
  readonly operation: MutableRow;
}

function reconciliationLink(
  subject: PersistedInput,
  index: number,
  status: "started" | "completed" | "interrupted",
  options: {
    readonly observation?: boolean;
    readonly boundary?: "retry" | "subject";
    readonly operationId?: string;
  } = {},
): LinkFixture {
  const operationId = options.operationId ?? RECONCILIATION_IDS[index];
  if (operationId === undefined) throw new Error("missing reconciliation operation identity");
  const coordinatorAttempt = SUBJECT_ATTEMPT + index + 1;
  const subjectRow = subject.operationRow as MutableRow;
  const request: LandingOperationRequestV1 = {
    schemaVersion: 1,
    operationId,
    landingId: LANDING_ID,
    coordinatorAttempt,
    kindAttempt: index + 1,
    kind: "landing.reconcile",
    expectedState: "reconciliation_required",
    expectedVersion: RECONCILIATION_VERSION,
    input: {
      landingSha256: digestLandingRecord(LANDING),
      resumeState: "local_ready",
      subjectOperationId: SUBJECT_ID,
      subjectRequestSha256: subjectRow.request_sha256 as string,
      subjectResultSha256: subjectRow.result_sha256 as string,
    },
  };
  const projection = subjectProjection(subject) as Record<string, unknown>;
  delete projection.request;
  const observation =
    options.observation === false
      ? null
      : decodeLandingOperationObservationV1({
          schemaVersion: 1,
          operationId,
          kind: "landing.reconcile",
          phase: "reconciliation",
          facts: [
            {
              fact: "subject_operation",
              requestId: null,
              resultSha256: digestLandingRecord(projection),
            },
          ],
        });
  const operationEvidence =
    observation?.facts.map(({ requestId, resultSha256 }) => ({ requestId, resultSha256 })) ?? [];
  let result: LandingOperationResultV1 | null = null;
  if (status === "interrupted") {
    result = decodeLandingOperationResultV1({
      schemaVersion: 1,
      operationId,
      kind: "landing.reconcile",
      outcome: "reconciliation_required",
      boundary: "reconciliation_required",
      evidence: operationEvidence,
      value: { subjectOperationId: SUBJECT_ID, remoteResidue: "none" },
      errorCode: TAKEOVER_ERROR,
    });
  } else if (status === "completed") {
    const subjectSettled = options.boundary === "subject";
    result = decodeLandingOperationResultV1({
      schemaVersion: 1,
      operationId,
      kind: "landing.reconcile",
      outcome: "completed",
      boundary: subjectSettled ? "subject_settled" : "retry_stage_proven",
      evidence: operationEvidence,
      value: subjectSettled
        ? {
            subjectOperationId: SUBJECT_ID,
            nextState: "objects_ready",
            remoteResidue: "none",
            stageValue: {
              candidateObjectManifestSha256: LANDING.candidateObjectManifestSha256,
              remoteObjectOutcome: "created_or_exact",
            },
          }
        : {
            subjectOperationId: SUBJECT_ID,
            nextState: "local_ready",
            remoteResidue: "none",
            stageValue: null,
          },
      errorCode: null,
    });
  }
  const errorCode = status === "interrupted" ? TAKEOVER_ERROR : null;
  return {
    attempt: attemptRow(coordinatorAttempt, status, errorCode),
    operation: operationRow(
      request,
      status,
      observation,
      result,
      `2026-08-08T12:${String(coordinatorAttempt).padStart(2, "0")}:01.000Z`,
      status === "started"
        ? null
        : `2026-08-08T12:${String(coordinatorAttempt).padStart(2, "0")}:02.000Z`,
    ),
  };
}

function reconciliationEvents(firstSequence: number, links: readonly LinkFixture[]): MutableRow[] {
  const events: MutableRow[] = [];
  let sequence = firstSequence;
  for (const link of links) {
    const request = JSON.parse(link.operation.request_json as string) as LandingOperationRequestV1;
    events.push(
      eventRow(sequence, "landing.attempt.started", {
        schemaVersion: 1,
        landingId: LANDING_ID,
        coordinatorAttempt: request.coordinatorAttempt,
      }),
    );
    sequence += 1;
    events.push(
      eventRow(sequence, "landing.operation.started", {
        schemaVersion: 1,
        landingId: LANDING_ID,
        operationId: request.operationId,
        coordinatorAttempt: request.coordinatorAttempt,
        kind: "landing.reconcile",
        kindAttempt: request.kindAttempt,
        requestSha256: link.operation.request_sha256 as string,
      }),
    );
    sequence += 1;
    if (link.operation.status !== "started") {
      const result = JSON.parse(link.operation.result_json as string) as LandingOperationResultV1;
      events.push(
        eventRow(sequence, "landing.operation.settled", {
          schemaVersion: 1,
          landingId: LANDING_ID,
          operationId: request.operationId,
          coordinatorAttempt: request.coordinatorAttempt,
          kind: "landing.reconcile",
          outcome: result.outcome,
          resultSha256: link.operation.result_sha256 as string,
          errorCode: result.errorCode,
        }),
      );
      sequence += 1;
      events.push(
        eventRow(sequence, "landing.attempt.settled", {
          schemaVersion: 1,
          landingId: LANDING_ID,
          coordinatorAttempt: request.coordinatorAttempt,
          outcome: link.attempt.status as "completed" | "interrupted",
          errorCode: link.attempt.error_code as string | null,
        }),
      );
      sequence += 1;
      if (link.operation.status === "completed") {
        events.push(
          eventRow(sequence, "landing.state.changed", {
            schemaVersion: 1,
            landingId: LANDING_ID,
            from: "reconciliation_required",
            to: "local_ready",
            version: RECONCILIATION_VERSION + 1,
            operationId: request.operationId,
          }),
        );
        sequence += 1;
      }
    }
  }
  return events;
}

function persistedReconciliation(
  effectful: boolean,
  statuses: readonly ("started" | "completed" | "interrupted")[] = ["completed"],
  firstObservation?: boolean,
  subjectTakeover = false,
  retrySubject: RetrySubjectFixture | null = null,
): PersistedInput {
  const subject = subjectAggregate(effectful, subjectTakeover, retrySubject);
  const subjectOperationEvents = subject.operationEvents as MutableRow[];
  const subjectSettlement = subjectOperationEvents[1];
  if (subjectSettlement === undefined) throw new Error("subject settlement event missing");
  const subjectSettlementSequence = subjectSettlement.sequence as number;
  const subjectRow = subject.operationRow as MutableRow;
  const links = statuses.map((status, index) =>
    reconciliationLink(subject, index, status, {
      observation:
        index === 0 && firstObservation !== undefined
          ? firstObservation
          : status !== "interrupted" || index !== 0,
    }),
  );
  return {
    subjectAggregate: subject,
    subjectAttemptRow: attemptRow(SUBJECT_ATTEMPT, "interrupted", subjectRow.error_code as string),
    subjectAttemptSettlementEventRow: eventRow(
      subjectSettlementSequence + 1,
      "landing.attempt.settled",
      {
        schemaVersion: 1,
        landingId: LANDING_ID,
        coordinatorAttempt: SUBJECT_ATTEMPT,
        outcome: "interrupted",
        errorCode: subjectRow.error_code as string,
      },
    ),
    subjectStateEventRow: eventRow(subjectSettlementSequence + 2, "landing.state.changed", {
      schemaVersion: 1,
      landingId: LANDING_ID,
      from: "uploading_objects",
      to: "reconciliation_required",
      version: RECONCILIATION_VERSION,
      operationId: SUBJECT_ID,
    }),
    reconciliationAttemptRows: links.map((link) => link.attempt),
    reconciliationOperationRows: links.map((link) => link.operation),
    reconciliationHttpRows: [],
    reconciliationEventRows: reconciliationEvents(subjectSettlementSequence + 3, links),
  };
}

function expectInvalid(value: unknown): void {
  try {
    validatePersistedGitHubObjectsReconciliationV1(value);
    throw new Error("expected persisted object reconciliation aggregate to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe("LANDING_RECORD_INVALID");
  }
}

describe("persisted ADR 0027 zero-HTTP object reconciliation", () => {
  it("proves local-ready with a null retry subject when the validated subject admitted no POST", () => {
    const projected = validatePersistedGitHubObjectsReconciliationV1(
      persistedReconciliation(false),
    );

    expect(projected).toMatchObject({
      status: "retry_stage_proven",
      subjectOperationId: SUBJECT_ID,
      effectfulPostAdmitted: false,
      nextState: "local_ready",
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    });
    expect(projected.links).toHaveLength(1);
  });

  it("preserves inherited retry ancestry across a completed zero-POST subject", () => {
    const inherited = {
      operationId: RECONCILIATION_IDS[1] ?? "",
      requestSha256: "d".repeat(64),
    };
    const projected = validatePersistedGitHubObjectsReconciliationV1(
      persistedReconciliation(false, ["completed"], undefined, false, inherited),
    );

    expect(projected).toMatchObject({
      status: "retry_stage_proven",
      effectfulPostAdmitted: false,
      retrySubjectOperationId: inherited.operationId,
      retrySubjectRequestSha256: inherited.requestSha256,
    });
  });

  it("supersedes inherited ancestry only after proving an effectful subject retry stage", () => {
    const inherited = {
      operationId: RECONCILIATION_IDS[1] ?? "",
      requestSha256: "d".repeat(64),
    };
    const input = persistedReconciliation(true, ["completed"], undefined, false, inherited);
    const projected = validatePersistedGitHubObjectsReconciliationV1(input);
    const subjectRow = (input.subjectAggregate as PersistedInput).operationRow as MutableRow;

    expect(projected).toMatchObject({
      status: "retry_stage_proven",
      effectfulPostAdmitted: true,
      retrySubjectOperationId: SUBJECT_ID,
      retrySubjectRequestSha256: subjectRow.request_sha256,
    });
  });

  it("accepts a zero-HTTP takeover subject without fabricating retry ancestry", () => {
    const projected = validatePersistedGitHubObjectsReconciliationV1(
      persistedReconciliation(false, ["completed"], true, true),
    );

    expect(projected).toMatchObject({
      status: "retry_stage_proven",
      subjectOperationId: SUBJECT_ID,
      effectfulPostAdmitted: false,
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    });
  });

  it("carries the exact original object subject across an interrupted takeover chain", () => {
    const input = persistedReconciliation(true, ["interrupted", "completed"]);
    const projected = validatePersistedGitHubObjectsReconciliationV1(input);
    const subjectRow = (input.subjectAggregate as PersistedInput).operationRow as MutableRow;

    expect(projected).toMatchObject({
      status: "retry_stage_proven",
      subjectOperationId: SUBJECT_ID,
      subjectRequestSha256: subjectRow.request_sha256,
      effectfulPostAdmitted: true,
      retrySubjectOperationId: SUBJECT_ID,
      retrySubjectRequestSha256: subjectRow.request_sha256,
    });
    expect(projected.links.map((link) => link.status)).toEqual(["interrupted", "completed"]);
    expect(projected.links[0]).toMatchObject({
      observationSha256: null,
      errorCode: TAKEOVER_ERROR,
    });
  });

  it("keeps pending and unresolved chains non-authorizing", () => {
    const pendingWithObservation = validatePersistedGitHubObjectsReconciliationV1(
      persistedReconciliation(true, ["started"], true),
    );
    expect(pendingWithObservation).toMatchObject({
      status: "pending",
      observationPending: false,
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    });

    const pendingWithoutObservation = validatePersistedGitHubObjectsReconciliationV1(
      persistedReconciliation(true, ["started"], false),
    );
    expect(pendingWithoutObservation).toMatchObject({
      status: "pending",
      observationPending: true,
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    });

    const unresolvedWithObservation = validatePersistedGitHubObjectsReconciliationV1(
      persistedReconciliation(true, ["interrupted"], true),
    );
    expect(unresolvedWithObservation).toMatchObject({
      status: "reconciliation_required",
      errorCode: TAKEOVER_ERROR,
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    });

    const inheritedPending = validatePersistedGitHubObjectsReconciliationV1(
      persistedReconciliation(true, ["started"], true, false, {
        operationId: RECONCILIATION_IDS[1] ?? "",
        requestSha256: "d".repeat(64),
      }),
    );
    expect(inheritedPending).toMatchObject({
      status: "pending",
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    });
  });

  it("rejects any reconciliation-owned HTTP row and any event adjacency gap", () => {
    const withHttp = persistedReconciliation(false);
    withHttp.reconciliationHttpRows = [{ unexpected: true }];
    expectInvalid(withHttp);

    const gapped = persistedReconciliation(false);
    const events = gapped.reconciliationEventRows as MutableRow[];
    const first = events[0];
    if (first === undefined) throw new Error("missing reconciliation event");
    first.sequence = (first.sequence as number) + 1;
    expectInvalid(gapped);

    const wrongAttemptOwner = persistedReconciliation(false);
    const attemptSettlement = wrongAttemptOwner.subjectAttemptSettlementEventRow as MutableRow;
    const attemptPayload = JSON.parse(attemptSettlement.payload_json as string) as MutableRow;
    attemptSettlement.payload_json = canonical({
      ...attemptPayload,
      errorCode: "OTHER_INTERRUPTION",
    });
    expectInvalid(wrongAttemptOwner);

    const wrongStateOwner = persistedReconciliation(false);
    const stateEvent = wrongStateOwner.subjectStateEventRow as MutableRow;
    const statePayload = JSON.parse(stateEvent.payload_json as string) as MutableRow;
    stateEvent.payload_json = canonical({
      ...statePayload,
      operationId: RECONCILIATION_IDS[1],
    });
    expectInvalid(wrongStateOwner);
  });

  it("rejects subject-settled object claims without a separately accepted exact proof", () => {
    const input = persistedReconciliation(false);
    const subject = input.subjectAggregate as PersistedInput;
    const link = reconciliationLink(subject, 0, "completed", { boundary: "subject" });
    input.reconciliationAttemptRows = [link.attempt];
    input.reconciliationOperationRows = [link.operation];
    const subjectSettlement = ((subject.operationEvents as MutableRow[])[1]?.sequence ??
      0) as number;
    input.reconciliationEventRows = reconciliationEvents(subjectSettlement + 3, [link]);

    expectInvalid(input);
  });

  it("rejects digest drift, subject switching, extra carriers, and half retry pairs", () => {
    const digestDrift = persistedReconciliation(false);
    const operation = (digestDrift.reconciliationOperationRows as MutableRow[])[0];
    if (operation === undefined) throw new Error("missing reconciliation row");
    operation.observation_sha256 = "f".repeat(64);
    expectInvalid(digestDrift);

    const projectionDrift = persistedReconciliation(false);
    const projectionRow = (projectionDrift.reconciliationOperationRows as MutableRow[])[0];
    if (projectionRow === undefined) throw new Error("missing reconciliation row");
    const projectionObservation = JSON.parse(
      projectionRow.observation_json as string,
    ) as MutableRow;
    const projectionFacts = projectionObservation.facts as MutableRow[];
    const projectionFact = projectionFacts[0];
    if (projectionFact === undefined) throw new Error("missing subject projection fact");
    projectionFact.resultSha256 = "e".repeat(64);
    projectionRow.observation_json = canonical(projectionObservation);
    projectionRow.observation_sha256 = sha256(projectionRow.observation_json as string);
    expectInvalid(projectionDrift);

    const subjectSwitch = persistedReconciliation(false);
    const switchedRow = (subjectSwitch.reconciliationOperationRows as MutableRow[])[0];
    if (switchedRow === undefined) throw new Error("missing reconciliation row");
    const originalSwitchedRequest = JSON.parse(
      switchedRow.request_json as string,
    ) as LandingOperationRequestV1;
    const switchedRequest = {
      ...originalSwitchedRequest,
      input: {
        ...(originalSwitchedRequest.input as unknown as Record<string, unknown>),
        subjectOperationId: RECONCILIATION_IDS[1],
      },
    } as unknown as LandingOperationRequestV1;
    switchedRow.request_json = canonical(switchedRequest);
    switchedRow.request_sha256 = sha256(switchedRow.request_json as string);
    expectInvalid(subjectSwitch);

    const extra = persistedReconciliation(false);
    (extra as Record<string, unknown>).callerEffectful = false;
    expectInvalid(extra);

    const halfPair = persistedReconciliation(false);
    const nestedSubject = halfPair.subjectAggregate as PersistedInput;
    const subjectRow = nestedSubject.operationRow as MutableRow;
    const originalRequest = JSON.parse(
      subjectRow.request_json as string,
    ) as LandingOperationRequestV1;
    const halfPairRequest = {
      ...originalRequest,
      input: {
        ...(originalRequest.input as unknown as Record<string, unknown>),
        retrySubjectOperationId: RECONCILIATION_IDS[1],
        retrySubjectRequestSha256: null,
      },
    } as unknown as LandingOperationRequestV1;
    subjectRow.request_json = canonical(halfPairRequest);
    subjectRow.request_sha256 = sha256(subjectRow.request_json as string);
    expectInvalid(halfPair);

    const outputDrift = persistedReconciliation(false);
    const outputRow = (outputDrift.reconciliationOperationRows as MutableRow[])[0];
    if (outputRow === undefined) throw new Error("missing output row");
    const outputResult = JSON.parse(outputRow.result_json as string) as {
      value: Record<string, unknown>;
    };
    outputResult.value.nextState = "objects_ready";
    outputRow.result_json = canonical(outputResult);
    outputRow.result_sha256 = sha256(outputRow.result_json as string);
    expectInvalid(outputDrift);
  });

  it("rejects duplicate reconciliation operation identities and unstable subject carriers", () => {
    const duplicate = persistedReconciliation(false, ["interrupted", "completed"]);
    const subject = duplicate.subjectAggregate as PersistedInput;
    const first = reconciliationLink(subject, 0, "interrupted", { observation: false });
    const second = reconciliationLink(subject, 1, "completed", {
      operationId: RECONCILIATION_IDS[0],
    });
    duplicate.reconciliationAttemptRows = [first.attempt, second.attempt];
    duplicate.reconciliationOperationRows = [first.operation, second.operation];
    const subjectSettlement = ((subject.operationEvents as MutableRow[])[1]?.sequence ??
      0) as number;
    duplicate.reconciliationEventRows = reconciliationEvents(subjectSettlement + 3, [
      first,
      second,
    ]);
    expectInvalid(duplicate);

    const unstable = persistedReconciliation(false);
    const stableSubject = unstable.subjectAggregate as PersistedInput;
    let descriptorReads = 0;
    unstable.subjectAggregate = new Proxy(stableSubject, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property !== "operationStartVersion" || descriptor === undefined) return descriptor;
        descriptorReads += 1;
        return {
          ...descriptor,
          value: descriptorReads === 1 ? descriptor.value : 99,
        };
      },
    });
    expectInvalid(unstable);
    expect(descriptorReads).toBeGreaterThanOrEqual(2);
  });

  it("rejects sparse/oversized chains and a completed proof without its subject observation", () => {
    const sparse = persistedReconciliation(false);
    const attempts = sparse.reconciliationAttemptRows as MutableRow[];
    delete attempts[0];
    expectInvalid(sparse);

    const oversized = persistedReconciliation(false);
    oversized.reconciliationAttemptRows = Array.from({ length: 8 }, () => ({}));
    oversized.reconciliationOperationRows = Array.from({ length: 8 }, () => ({}));
    expectInvalid(oversized);

    const missingObservation = persistedReconciliation(false);
    const completed = (missingObservation.reconciliationOperationRows as MutableRow[])[0];
    if (completed === undefined) throw new Error("missing completed reconciliation row");
    completed.observation_json = null;
    completed.observation_sha256 = null;
    expectInvalid(missingObservation);
  });
});
