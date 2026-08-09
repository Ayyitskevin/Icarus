import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  type GitHubObjectsHistoryExchangeV1,
  validateGitHubObjectsUploadHttpHistoryV1,
} from "../../packages/core/src/landing-objects-history.js";
import { validatePersistedGitHubObjectsOperationV1 } from "../../packages/core/src/landing-objects-persistence.js";
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
import { MAX_CHANGED_FILES } from "../../packages/core/src/policy.js";

const LANDING_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const REVIEW_ID = "44444444-4444-4444-8444-444444444444";
const PREFLIGHT_ID = "55555555-5555-4555-8555-555555555555";
const OPERATION_ID = "66666666-6666-4666-8666-666666666666";
const REQUEST_IDS = [
  "70000000-0000-4000-8000-000000000001",
  "70000000-0000-4000-8000-000000000002",
  "70000000-0000-4000-8000-000000000003",
  "70000000-0000-4000-8000-000000000004",
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
const START_VERSION = 4;
const STARTED_AT = "2026-08-08T12:00:02.000Z";
const FINISHED_AT = "2026-08-08T12:00:03.000Z";

const PROFILE: GitHubLandingProfileV1 = {
  version: 1,
  provider: "github",
  owner: "octocat",
  repository: "icarus-objects",
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

function preflightRequest(): LandingOperationRequestV1 {
  return {
    schemaVersion: 1,
    operationId: PREFLIGHT_ID,
    landingId: LANDING_ID,
    coordinatorAttempt: 2,
    kindAttempt: 1,
    kind: "github.preflight",
    expectedState: "local_ready",
    expectedVersion: START_VERSION,
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

function objectsRequest(
  retrySubjectOperationId: string | null = null,
  retrySubjectRequestSha256: string | null = null,
): LandingOperationRequestV1 {
  const prior = preflightResult();
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    landingId: LANDING_ID,
    coordinatorAttempt: 2,
    kindAttempt: 1,
    kind: "github.objects.upload",
    expectedState: "local_ready",
    expectedVersion: START_VERSION,
    input: {
      landingSha256: digestLandingRecord(LANDING),
      candidateObjectManifestSha256: LANDING.candidateObjectManifestSha256,
      changedPathsSha256: LANDING.changedPathsSha256,
      preflightOperationId: PREFLIGHT_ID,
      preflightResultSha256: digestLandingRecord(prior),
      retrySubjectOperationId,
      retrySubjectRequestSha256,
    },
  };
}

function history(exchanges: readonly GitHubObjectsHistoryExchangeV1[]): Record<string, unknown> {
  const priorRequest = preflightRequest();
  const priorResult = preflightResult();
  const operation = objectsRequest();
  return {
    material: MATERIAL,
    landingSha256: digestLandingRecord(LANDING),
    preflightOperation: priorRequest,
    preflightOperationRequestSha256: digestLandingRecord(priorRequest),
    preflightResult: priorResult,
    preflightResultSha256: digestLandingRecord(priorResult),
    operation,
    operationRequestSha256: digestLandingRecord(operation),
    previousRequestOrdinal: 3,
    exchanges,
  };
}

function successResult(request: LandingHttpRequestV1): LandingHttpResultV1 {
  switch (request.kind) {
    case "github.actor.get":
      return {
        schemaVersion: 1,
        requestId: request.requestId,
        kind: request.kind,
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "actor", login: PROFILE.expectedActor },
        errorCode: null,
      };
    case "github.blob.post":
      return {
        schemaVersion: 1,
        requestId: request.requestId,
        kind: request.kind,
        outcome: "succeeded",
        httpStatus: 201,
        projection: {
          type: "object",
          objectKind: "blob",
          sha1: request.subject.expectedBlobSha1 as string,
        },
        errorCode: null,
      };
    case "github.tree.post":
      return {
        schemaVersion: 1,
        requestId: request.requestId,
        kind: request.kind,
        outcome: "succeeded",
        httpStatus: 201,
        projection: {
          type: "object",
          objectKind: "tree",
          sha1: request.subject.expectedTreeSha1 as string,
        },
        errorCode: null,
      };
    case "github.commit.post":
      return {
        schemaVersion: 1,
        requestId: request.requestId,
        kind: request.kind,
        outcome: "succeeded",
        httpStatus: 201,
        projection: {
          type: "object",
          objectKind: "commit",
          sha1: request.subject.expectedCommitSha1 as string,
        },
        errorCode: null,
      };
    default:
      throw new Error("unexpected object request kind");
  }
}

function completeSuccesses(): GitHubObjectsHistoryExchangeV1[] {
  const exchanges: GitHubObjectsHistoryExchangeV1[] = [];
  for (let index = 0; index < REQUEST_IDS.length; index += 1) {
    const projected = validateGitHubObjectsUploadHttpHistoryV1(history(exchanges));
    if (projected.status !== "next_request") throw new Error("expected next object request");
    const request = {
      ...projected.nextRequest,
      requestId: REQUEST_IDS[index],
    } as LandingHttpRequestV1;
    const result = successResult(request);
    exchanges.push({
      request,
      requestSha256: digestLandingRecord(request),
      result,
      resultSha256: digestLandingRecord(result),
    });
  }
  return exchanges;
}

function admittedAfter(successes: readonly GitHubObjectsHistoryExchangeV1[]): {
  readonly request: LandingHttpRequestV1;
  readonly requestSha256: string;
} {
  const projected = validateGitHubObjectsUploadHttpHistoryV1(history(successes));
  if (projected.status !== "next_request") throw new Error("expected admitted descriptor");
  const request = {
    ...projected.nextRequest,
    requestId: REQUEST_IDS[successes.length],
  } as LandingHttpRequestV1;
  return { request, requestSha256: digestLandingRecord(request) };
}

function terminalAfter(
  successes: readonly GitHubObjectsHistoryExchangeV1[],
  outcome: "failed" | "ambiguous",
): GitHubObjectsHistoryExchangeV1 {
  const admitted = admittedAfter(successes);
  const result: LandingHttpResultV1 =
    outcome === "failed"
      ? {
          schemaVersion: 1,
          requestId: admitted.request.requestId,
          kind: admitted.request.kind,
          outcome,
          httpStatus: 422,
          projection: null,
          errorCode: "GITHUB_REQUEST_FAILED",
        }
      : {
          schemaVersion: 1,
          requestId: admitted.request.requestId,
          kind: admitted.request.kind,
          outcome,
          httpStatus: null,
          projection: null,
          errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
        };
  return {
    ...admitted,
    result,
    resultSha256: digestLandingRecord(result),
  };
}

function actorObservation(
  exchanges: readonly GitHubObjectsHistoryExchangeV1[],
): LandingOperationObservationV1 | null {
  const actor = exchanges[0];
  if (actor === undefined || (actor.result as LandingHttpResultV1).outcome !== "succeeded") {
    return null;
  }
  return decodeLandingOperationObservationV1({
    schemaVersion: 1,
    operationId: OPERATION_ID,
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

function evidence(exchanges: readonly GitHubObjectsHistoryExchangeV1[]) {
  return exchanges.map((exchange) => ({
    requestId: (exchange.request as LandingHttpRequestV1).requestId,
    resultSha256: exchange.resultSha256,
  }));
}

function failedOperationResult(
  exchanges: readonly GitHubObjectsHistoryExchangeV1[],
): LandingOperationResultV1 {
  const tail = exchanges.at(-1);
  if (tail === undefined) throw new Error("missing failed tail");
  return decodeLandingOperationResultV1({
    schemaVersion: 1,
    operationId: OPERATION_ID,
    kind: "github.objects.upload",
    outcome: "failed",
    boundary: "operation_failed",
    evidence: evidence(exchanges),
    value: null,
    errorCode: (tail.result as LandingHttpResultV1).errorCode,
  });
}

function reconciliationOperationResult(
  exchanges: readonly GitHubObjectsHistoryExchangeV1[],
  errorCode: string,
): LandingOperationResultV1 {
  return decodeLandingOperationResultV1({
    schemaVersion: 1,
    operationId: OPERATION_ID,
    kind: "github.objects.upload",
    outcome: "reconciliation_required",
    boundary: "reconciliation_required",
    evidence: evidence(exchanges),
    value: { subjectOperationId: OPERATION_ID, remoteResidue: "none" },
    errorCode,
  });
}

function operationRow(
  request: LandingOperationRequestV1,
  status: "started" | "completed" | "failed" | "interrupted",
  observation: LandingOperationObservationV1 | null,
  result: LandingOperationResultV1 | null,
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
    started_at: request.kind === "github.preflight" ? "2026-08-08T12:00:00.000Z" : STARTED_AT,
    finished_at:
      status === "started"
        ? null
        : request.kind === "github.preflight"
          ? "2026-08-08T12:00:01.000Z"
          : FINISHED_AT,
  };
}

function canonical(value: unknown): string {
  return canonicalLandingJson(value);
}

function eventRow(sequence: number, type: string, payload: LandingEventPayloadV1): MutableRow {
  return {
    id: sequence,
    landing_id: LANDING_ID,
    sequence,
    type,
    payload_json: canonical(payload),
    created_at: `2026-08-08T12:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}

function admittedPayload(request: LandingHttpRequestV1, requestSha256: string) {
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

function settledPayload(
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

interface RowProjection {
  readonly httpRows: MutableRow[];
  readonly requestEvents: MutableRow[];
  readonly nextSequence: number;
}

function httpRows(
  exchanges: ReadonlyArray<
    | GitHubObjectsHistoryExchangeV1
    | { readonly request: LandingHttpRequestV1; readonly requestSha256: string }
  >,
  firstSequence = 13,
): RowProjection {
  const rows: MutableRow[] = [];
  const events: MutableRow[] = [];
  let sequence = firstSequence;
  for (const exchange of exchanges) {
    const request = exchange.request as LandingHttpRequestV1;
    const requestSha256 = exchange.requestSha256 as string;
    const requestJson = canonical(request);
    const isSettled = "result" in exchange;
    const result = isSettled ? (exchange.result as LandingHttpResultV1) : null;
    const resultSha256 = isSettled ? (exchange.resultSha256 as unknown as string) : null;
    const resultJson = result === null ? null : canonical(result);
    rows.push({
      id: request.requestId,
      landing_id: request.landingId,
      operation_id: request.operationId,
      coordinator_attempt: request.coordinatorAttempt,
      operation_kind: request.operationKind,
      request_ordinal: request.requestOrdinal,
      kind: request.kind,
      method: request.method,
      request_sha256: requestSha256,
      request_json: requestJson,
      status: result === null ? "admitted" : "settled",
      outcome: result?.outcome ?? null,
      http_status: result?.httpStatus ?? null,
      result_sha256: resultSha256,
      result_json: resultJson,
      error_code: result?.errorCode ?? null,
      admitted_at: "2026-08-08T12:00:04.000Z",
      settled_at: result === null ? null : "2026-08-08T12:00:05.000Z",
    });
    events.push(
      eventRow(
        sequence,
        "landing.github.request.admitted",
        admittedPayload(request, requestSha256),
      ),
    );
    sequence += 1;
    if (result !== null && resultSha256 !== null) {
      events.push(
        eventRow(
          sequence,
          "landing.github.request.settled",
          settledPayload(request, result, resultSha256),
        ),
      );
      sequence += 1;
    }
  }
  return { httpRows: rows, requestEvents: events, nextSequence: sequence };
}

interface PersistedOptions {
  readonly exchanges: ReadonlyArray<
    | GitHubObjectsHistoryExchangeV1
    | { readonly request: LandingHttpRequestV1; readonly requestSha256: string }
  >;
  readonly status?: "started" | "completed" | "failed" | "interrupted";
  readonly observation?: LandingOperationObservationV1 | null;
  readonly result?: LandingOperationResultV1 | null;
  readonly request?: LandingOperationRequestV1;
}

function persisted(options: PersistedOptions): PersistedInput {
  const request = options.request ?? objectsRequest();
  const status = options.status ?? "started";
  const observation = options.observation === undefined ? null : options.observation;
  const result = options.result === undefined ? null : options.result;
  const priorRequest = preflightRequest();
  const priorObservation = preflightObservation();
  const priorResult = preflightResult();
  const priorRow = operationRow(priorRequest, "completed", priorObservation, priorResult);
  const objectRow = operationRow(request, status, observation, result);
  const projectedRows = httpRows(options.exchanges);
  const operationStartPayload = {
    schemaVersion: 1 as const,
    landingId: LANDING_ID,
    operationId: OPERATION_ID,
    coordinatorAttempt: 2,
    kind: "github.objects.upload" as const,
    kindAttempt: 1,
    requestSha256: objectRow.request_sha256 as string,
  };
  const operationEvents = [eventRow(11, "landing.operation.started", operationStartPayload)];
  if (status !== "started") {
    if (result === null) throw new Error("settled fixture requires a result");
    operationEvents.push(
      eventRow(projectedRows.nextSequence, "landing.operation.settled", {
        schemaVersion: 1,
        landingId: LANDING_ID,
        operationId: OPERATION_ID,
        coordinatorAttempt: 2,
        kind: "github.objects.upload",
        outcome: result.outcome,
        resultSha256: objectRow.result_sha256 as string,
        errorCode: result.errorCode,
      }),
    );
  }
  return {
    material: MATERIAL,
    landingSha256: digestLandingRecord(LANDING),
    operationStartState: "local_ready",
    operationStartVersion: START_VERSION,
    preflightOperationRow: priorRow,
    preflightSettlementEventRow: eventRow(10, "landing.operation.settled", {
      schemaVersion: 1,
      landingId: LANDING_ID,
      operationId: PREFLIGHT_ID,
      coordinatorAttempt: 2,
      kind: "github.preflight",
      outcome: "completed",
      resultSha256: priorRow.result_sha256 as string,
      errorCode: null,
    }),
    operationRow: objectRow,
    actionStateEventRow: eventRow(12, "landing.state.changed", {
      schemaVersion: 1,
      landingId: LANDING_ID,
      from: "local_ready",
      to: "uploading_objects",
      version: START_VERSION + 1,
      operationId: OPERATION_ID,
    }),
    previousRequestOrdinal: 3,
    httpRows: projectedRows.httpRows,
    requestEvents: projectedRows.requestEvents,
    operationEvents,
  };
}

function expectInvalid(value: unknown): void {
  try {
    validatePersistedGitHubObjectsOperationV1(value);
    throw new Error("expected persisted object aggregate to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe("LANDING_RECORD_INVALID");
  }
}

function settledSuccessPrefix(length: number): GitHubObjectsHistoryExchangeV1[] {
  return completeSuccesses().slice(0, length);
}

describe("persisted ADR 0027 GitHub object-upload aggregate", () => {
  it("projects every successful incomplete prefix and the actor observation crash seam", () => {
    const empty = validatePersistedGitHubObjectsOperationV1(persisted({ exchanges: [] }));
    expect(empty.status).toBe("next_request");
    if (empty.status !== "next_request") throw new Error("expected next actor");
    expect(empty.nextRequest.kind).toBe("github.actor.get");
    expect(empty.observationPending).toBe(false);

    const actor = settledSuccessPrefix(1);
    const pending = validatePersistedGitHubObjectsOperationV1(persisted({ exchanges: actor }));
    expect(pending.status).toBe("next_request");
    if (pending.status !== "next_request") throw new Error("expected next blob");
    expect(pending.nextRequest.kind).toBe("github.blob.post");
    expect(pending.observationPending).toBe(true);

    for (let length = 1; length < REQUEST_IDS.length; length += 1) {
      const exchanges = settledSuccessPrefix(length);
      const projected = validatePersistedGitHubObjectsOperationV1(
        persisted({ exchanges, observation: actorObservation(exchanges) }),
      );
      expect(projected.status).toBe("next_request");
      if (projected.status !== "next_request") throw new Error("expected successful prefix");
      expect(projected.observationPending).toBe(false);
      expect(projected.nextRequest.requestOrdinal).toBe(4 + length);
    }
  });

  it("accepts one exact admitted tail at every grammar position", () => {
    for (let length = 0; length < REQUEST_IDS.length; length += 1) {
      const successes = settledSuccessPrefix(length);
      const admitted = admittedAfter(successes);
      const exchanges = [...successes, admitted];
      const projected = validatePersistedGitHubObjectsOperationV1(
        persisted({
          exchanges,
          observation: length === 0 ? null : actorObservation(successes),
        }),
      );
      expect(projected.status).toBe("admitted");
      if (projected.status !== "admitted") throw new Error("expected admitted tail");
      expect(projected.request.requestId).toBe(admitted.request.requestId);
      expect(projected.requestSha256).toBe(admitted.requestSha256);
    }
  });

  it("accepts exact completed object evidence while the attempt remains external", () => {
    const exchanges = completeSuccesses();
    const completed = validateGitHubObjectsUploadHttpHistoryV1(history(exchanges));
    if (completed.status !== "complete") throw new Error("expected complete history");
    const projected = validatePersistedGitHubObjectsOperationV1(
      persisted({
        exchanges,
        status: "completed",
        observation: completed.observation,
        result: completed.operationResult,
      }),
    );
    expect(projected.status).toBe("complete");
    if (projected.status !== "complete") throw new Error("expected complete evidence");
    expect(projected.resultSha256).toBe(completed.operationResultSha256);
    expect(projected.observationSha256).toBe(completed.observationSha256);
    expect(projected.exchanges).toHaveLength(4);
  });

  it("distinguishes failed actor refusal from ambiguous or post-effect reconciliation", () => {
    const failedActor = [terminalAfter([], "failed")];
    const failed = validatePersistedGitHubObjectsOperationV1(
      persisted({
        exchanges: failedActor,
        status: "failed",
        result: failedOperationResult(failedActor),
      }),
    );
    expect(failed.status).toBe("pre_effect_terminal");

    const ambiguousActor = [terminalAfter([], "ambiguous")];
    const actorRecon = reconciliationOperationResult(ambiguousActor, "GITHUB_OUTCOME_AMBIGUOUS");
    const ambiguous = validatePersistedGitHubObjectsOperationV1(
      persisted({
        exchanges: ambiguousActor,
        status: "interrupted",
        result: actorRecon,
      }),
    );
    expect(ambiguous.status).toBe("reconciliation_required");
    if (ambiguous.status !== "reconciliation_required") {
      throw new Error("expected ambiguous reconciliation");
    }
    expect(ambiguous.trigger).toBe("ambiguous");

    for (const outcome of ["failed", "ambiguous"] as const) {
      for (let position = 1; position < REQUEST_IDS.length; position += 1) {
        const successes = settledSuccessPrefix(position);
        const exchanges = [...successes, terminalAfter(successes, outcome)];
        const errorCode =
          outcome === "failed" ? "GITHUB_REQUEST_FAILED" : "GITHUB_OUTCOME_AMBIGUOUS";
        const projected = validatePersistedGitHubObjectsOperationV1(
          persisted({
            exchanges,
            status: "interrupted",
            observation: actorObservation(successes),
            result: reconciliationOperationResult(exchanges, errorCode),
          }),
        );
        expect(projected.status).toBe("reconciliation_required");
      }
    }
  });

  it("accepts bounded takeover over incomplete successes or a canonical ambiguous tail", () => {
    for (let length = 0; length < REQUEST_IDS.length; length += 1) {
      const successes = settledSuccessPrefix(length);
      const projected = validatePersistedGitHubObjectsOperationV1(
        persisted({
          exchanges: successes,
          status: "interrupted",
          observation: length > 1 ? actorObservation(successes) : null,
          result: reconciliationOperationResult(successes, "LANDING_COORDINATOR_TAKEOVER"),
        }),
      );
      expect(projected.status).toBe("takeover");

      const exchanges = [...successes, terminalAfter(successes, "ambiguous")];
      const withTail = validatePersistedGitHubObjectsOperationV1(
        persisted({
          exchanges,
          status: "interrupted",
          observation: exchanges.some(
            (exchange) => (exchange.request as LandingHttpRequestV1).method === "POST",
          )
            ? actorObservation(successes)
            : null,
          result: reconciliationOperationResult(exchanges, "LANDING_COORDINATOR_TAKEOVER"),
        }),
      );
      expect(withTail.status).toBe("takeover");
    }
  });

  it("rejects POST admission before the durable actor observation", () => {
    const actor = settledSuccessPrefix(1);
    const input = persisted({ exchanges: [...actor, admittedAfter(actor)] });
    expectInvalid(input);
  });

  it("rejects stale preflight, retry, action-state, adjacency, and ordinal authority", () => {
    const stalePreflight = persisted({ exchanges: [] });
    const preflightRow = stalePreflight.preflightOperationRow as MutableRow;
    const preflightRequestValue = JSON.parse(preflightRow.request_json as string) as MutableRow;
    preflightRequestValue.expectedVersion = START_VERSION - 1;
    preflightRow.request_json = canonical(preflightRequestValue);
    preflightRow.request_sha256 = sha256(preflightRow.request_json as string);
    expectInvalid(stalePreflight);

    const retried = persisted({
      exchanges: [],
      request: objectsRequest(PREFLIGHT_ID, sha256("retry")),
    });
    expectInvalid(retried);

    const wrongAction = persisted({ exchanges: [] });
    const action = wrongAction.actionStateEventRow as MutableRow;
    const actionPayload = JSON.parse(action.payload_json as string) as MutableRow;
    actionPayload.version = START_VERSION + 2;
    action.payload_json = canonical(actionPayload);
    expectInvalid(wrongAction);

    const gap = persisted({ exchanges: [] });
    (gap.preflightSettlementEventRow as MutableRow).sequence = 9;
    expectInvalid(gap);

    const ordinal = persisted({ exchanges: [admittedAfter([])] });
    const row = (ordinal.httpRows as MutableRow[])[0];
    if (row === undefined) throw new Error("missing ordinal row");
    const request = JSON.parse(row.request_json as string) as MutableRow;
    request.requestOrdinal = 1;
    row.request_ordinal = 1;
    row.request_json = canonical(request);
    row.request_sha256 = sha256(row.request_json as string);
    const admittedEvent = (ordinal.requestEvents as MutableRow[])[0];
    if (admittedEvent === undefined) throw new Error("missing admitted event");
    const admittedPayloadValue = JSON.parse(admittedEvent.payload_json as string) as MutableRow;
    admittedPayloadValue.requestOrdinal = 1;
    admittedPayloadValue.requestSha256 = row.request_sha256;
    admittedEvent.payload_json = canonical(admittedPayloadValue);
    expectInvalid(ordinal);
  });

  it("binds preflight observation, settlement, and object observation evidence", () => {
    const preflightObservationDrift = persisted({ exchanges: [] });
    const priorRow = preflightObservationDrift.preflightOperationRow as MutableRow;
    const priorObservation = JSON.parse(priorRow.observation_json as string) as {
      facts: Array<{ resultSha256: string }>;
    };
    const firstPriorFact = priorObservation.facts[0];
    if (firstPriorFact === undefined) throw new Error("missing preflight fact");
    firstPriorFact.resultSha256 = sha256("drifted actor fact");
    priorRow.observation_json = canonical(priorObservation);
    priorRow.observation_sha256 = sha256(priorRow.observation_json as string);
    expectInvalid(preflightObservationDrift);

    const preflightEventDrift = persisted({ exchanges: [] });
    const priorEvent = preflightEventDrift.preflightSettlementEventRow as MutableRow;
    const priorPayload = JSON.parse(priorEvent.payload_json as string) as MutableRow;
    priorPayload.resultSha256 = sha256("another preflight result");
    priorEvent.payload_json = canonical(priorPayload);
    expectInvalid(preflightEventDrift);

    const actor = settledSuccessPrefix(1);
    const observationDrift = persisted({
      exchanges: actor,
      observation: actorObservation(actor),
    });
    const objectRow = observationDrift.operationRow as MutableRow;
    const storedObservation = JSON.parse(objectRow.observation_json as string) as {
      facts: Array<{ resultSha256: string }>;
    };
    const actorFact = storedObservation.facts[0];
    if (actorFact === undefined) throw new Error("missing object actor fact");
    actorFact.resultSha256 = sha256("different durable actor");
    objectRow.observation_json = canonical(storedObservation);
    objectRow.observation_sha256 = sha256(objectRow.observation_json as string);
    expectInvalid(observationDrift);

    const actionOwner = persisted({ exchanges: [] });
    const actionEvent = actionOwner.actionStateEventRow as MutableRow;
    const actionPayload = JSON.parse(actionEvent.payload_json as string) as MutableRow;
    actionPayload.operationId = PREFLIGHT_ID;
    actionEvent.payload_json = canonical(actionPayload);
    expectInvalid(actionOwner);
  });

  it("rejects unsafe effect settlement classifications and event-source corruption", () => {
    const actor = settledSuccessPrefix(1);
    const failedPost = [...actor, terminalAfter(actor, "failed")];
    expectInvalid(
      persisted({
        exchanges: failedPost,
        status: "failed",
        observation: actorObservation(actor),
        result: failedOperationResult(failedPost),
      }),
    );

    const successfulPost = settledSuccessPrefix(2);
    expectInvalid(
      persisted({
        exchanges: successfulPost,
        status: "interrupted",
        observation: actorObservation(successfulPost),
        result: reconciliationOperationResult(successfulPost, "GITHUB_CONTROLLER_FAILURE"),
      }),
    );

    expectInvalid(
      persisted({
        exchanges: failedPost,
        status: "interrupted",
        observation: actorObservation(actor),
        result: reconciliationOperationResult(failedPost, "LANDING_COORDINATOR_TAKEOVER"),
      }),
    );

    const missingOperationSettlement = persisted({
      exchanges: failedPost,
      status: "interrupted",
      observation: actorObservation(actor),
      result: reconciliationOperationResult(failedPost, "GITHUB_REQUEST_FAILED"),
    });
    (missingOperationSettlement.operationEvents as MutableRow[]).pop();
    expectInvalid(missingOperationSettlement);

    const orphanRequestEvent = persisted({ exchanges: [] });
    (orphanRequestEvent.requestEvents as MutableRow[]).push(
      eventRow(13, "landing.github.request.admitted", {
        schemaVersion: 1,
        landingId: LANDING_ID,
        operationId: OPERATION_ID,
        requestId: REQUEST_IDS[0],
        coordinatorAttempt: 2,
        operationKind: "github.objects.upload",
        requestOrdinal: 4,
        kind: "github.actor.get",
        requestSha256: sha256("orphan"),
      }),
    );
    expectInvalid(orphanRequestEvent);
  });

  it("rejects result-evidence drift, non-self residue, ordinary interruption, and complete takeover", () => {
    const actor = settledSuccessPrefix(1);
    const ambiguousTail = terminalAfter(actor, "ambiguous");
    const exchanges = [...actor, ambiguousTail];
    const drifted = structuredClone(
      reconciliationOperationResult(exchanges, "GITHUB_OUTCOME_AMBIGUOUS"),
    ) as unknown as { evidence: Array<{ requestId: string; resultSha256: string }> };
    drifted.evidence.reverse();
    expectInvalid(
      persisted({
        exchanges,
        status: "interrupted",
        observation: actorObservation(actor),
        result: drifted as unknown as LandingOperationResultV1,
      }),
    );

    const residue = structuredClone(
      reconciliationOperationResult(exchanges, "GITHUB_OUTCOME_AMBIGUOUS"),
    ) as LandingOperationResultV1 & { value: { remoteResidue: string } };
    residue.value.remoteResidue = "branch";
    expectInvalid(
      persisted({
        exchanges,
        status: "interrupted",
        observation: actorObservation(actor),
        result: residue,
      }),
    );

    const interrupted = decodeLandingOperationResultV1({
      schemaVersion: 1,
      operationId: OPERATION_ID,
      kind: "github.objects.upload",
      outcome: "interrupted",
      boundary: "operation_interrupted",
      evidence: evidence(exchanges),
      value: null,
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    expectInvalid(
      persisted({
        exchanges,
        status: "interrupted",
        observation: actorObservation(actor),
        result: interrupted,
      }),
    );

    const complete = completeSuccesses();
    expectInvalid(
      persisted({
        exchanges: complete,
        status: "interrupted",
        observation: actorObservation(complete),
        result: reconciliationOperationResult(complete, "LANDING_COORDINATOR_TAKEOVER"),
      }),
    );
  });

  it("fails closed on sparse and over-bound aggregate containers", () => {
    const sparse = persisted({ exchanges: [] });
    const sparseRows = new Array(1);
    sparse.httpRows = sparseRows;
    expectInvalid(sparse);

    const overRows = persisted({ exchanges: [] });
    overRows.httpRows = Array.from({ length: 68 }, () => ({}));
    expectInvalid(overRows);

    const overEvents = persisted({ exchanges: [] });
    overEvents.requestEvents = Array.from({ length: 135 }, () => ({}));
    expectInvalid(overEvents);

    const extra = persisted({ exchanges: [] });
    extra.unexpected = true;
    expectInvalid(extra);

    const oversizedOperation = persisted({ exchanges: [] });
    const operation = oversizedOperation.operationRow as MutableRow;
    operation.request_json = "x".repeat(64 * 1024 + 1);
    operation.request_sha256 = sha256(operation.request_json as string);
    expectInvalid(oversizedOperation);

    let overBoundElementRead = false;
    const overBoundPaths = Array.from({ length: MAX_CHANGED_FILES }, (_, index) =>
      index === 0 ? PATH : `src/file-${index}.ts`,
    );
    Object.defineProperty(overBoundPaths, MAX_CHANGED_FILES, {
      enumerable: true,
      configurable: true,
      get() {
        overBoundElementRead = true;
        throw new Error("over-bound changed path was evaluated");
      },
    });
    const nestedMaterial = persisted({ exchanges: [] });
    nestedMaterial.material = {
      ...MATERIAL,
      landing: { ...LANDING, changedPaths: overBoundPaths },
    };
    expectInvalid(nestedMaterial);
    expect(overBoundElementRead).toBe(false);
  });
});
