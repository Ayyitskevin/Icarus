import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { validatePersistedGitHubPreflightOperationV1 } from "../../packages/core/src/landing-preflight-persistence.js";
import {
  canonicalLandingJson,
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  digestLandingRecord,
  type GitHubLandingProfileV1,
  type LandingDigestV1,
  type LandingGitHubRequestAdmittedEventV1,
  type LandingGitHubRequestSettledEventV1,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
  type LandingOperationObservationV1,
  type LandingOperationRequestV1,
  type LandingOperationResultV1,
  type LandingOperationSettledEventV1,
  type LandingOperationStartedEventV1,
} from "../../packages/core/src/landing-records.js";

type MutableRow = Record<string, unknown>;

const LANDING_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const REVIEW_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_IDS = [
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
] as const;
const BASE_COMMIT = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const CANDIDATE_TREE = "c".repeat(40);
const CANDIDATE_COMMIT = "d".repeat(40);
const PREVIOUS_REQUEST_ORDINAL = 7;
const STARTED_AT = "2026-08-08T12:00:00.000Z";
const FINISHED_AT = "2026-08-08T12:01:00.000Z";

const PROFILE: GitHubLandingProfileV1 = {
  version: 1,
  provider: "github",
  owner: "octocat",
  repository: "icarus-target",
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
  changedPaths: ["src/example.ts"],
  changedPathsSha256: digestLandingRecord({ schemaVersion: 1, paths: ["src/example.ts"] }),
  candidateCredentialAuditSha256: sha256("credential-audit"),
  profileVersion: 1,
  profileSha256: digestLandingRecord(PROFILE),
  profile: PROFILE,
  objectFormat: "sha1",
  candidateParentSha1: BASE_COMMIT,
  candidateTreeSha1: CANDIDATE_TREE,
  candidateCommitSha1: CANDIDATE_COMMIT,
  candidateCommitPayloadSha256: sha256("commit-payload"),
  candidateObjectManifestSha256: sha256("object-manifest"),
  commitMessageSha256: sha256("Land reviewed change\n"),
  commitAuthor: PROFILE.commitIdentity,
  commitCommitter: PROFILE.commitIdentity,
  commitEpochSeconds: 1_700_000_000,
  commitIso8601: commitEpochToGitInstant(1_700_000_000),
  baseRef: "refs/heads/main",
  expectedRemoteBaseSha1: BASE_COMMIT,
  headRef: `refs/heads/icarus/${RUN_ID}`,
  pullRequestTitleSha256: sha256("Land reviewed change"),
  pullRequestBodyPrefixSha256: sha256("Reviewed evidence."),
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

const OPERATION: LandingOperationRequestV1 = {
  schemaVersion: 1,
  operationId: OPERATION_ID,
  landingId: LANDING_ID,
  coordinatorAttempt: 2,
  kindAttempt: 1,
  kind: "github.preflight",
  expectedState: "local_ready",
  expectedVersion: 6,
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

type Tail = "admitted" | "failed" | "ambiguous";

interface Fixture {
  input: {
    landing: LandingDigestV1;
    landingSha256: string;
    operationStartState: "local_ready";
    operationStartVersion: number;
    operationRow: MutableRow;
    previousRequestOrdinal: number;
    httpRows: MutableRow[];
    requestEvents: MutableRow[];
    operationEvents: MutableRow[];
  };
}

function request(index: number): LandingHttpRequestV1 {
  const requestId = REQUEST_IDS[index];
  if (requestId === undefined) throw new Error("fixture request index is out of range");
  const common = {
    schemaVersion: 1 as const,
    requestId,
    landingId: LANDING_ID,
    operationId: OPERATION_ID,
    coordinatorAttempt: 2,
    operationKind: "github.preflight" as const,
    requestOrdinal: PREVIOUS_REQUEST_ORDINAL + index + 1,
    method: "GET" as const,
    profileSha256: LANDING.profileSha256,
    bodySha256: null,
  };
  if (index === 0) {
    return {
      ...common,
      kind: "github.actor.get",
      subject: { expectedActor: PROFILE.expectedActor },
    };
  }
  if (index === 1) {
    return {
      ...common,
      kind: "github.base_ref.get",
      subject: {
        owner: PROFILE.owner,
        repository: PROFILE.repository,
        baseRef: LANDING.baseRef,
        expectedSha1: BASE_COMMIT,
      },
    };
  }
  return {
    ...common,
    kind: "github.head_ref.get",
    subject: {
      owner: PROFILE.owner,
      repository: PROFILE.repository,
      headRef: LANDING.headRef,
      expectedSha1: CANDIDATE_COMMIT,
    },
  };
}

function succeededResult(index: number): LandingHttpResultV1 {
  const value = request(index);
  if (index === 0) {
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      kind: "github.actor.get",
      outcome: "succeeded",
      httpStatus: 200,
      projection: { type: "actor", login: PROFILE.expectedActor },
      errorCode: null,
    };
  }
  if (index === 1) {
    return {
      schemaVersion: 1,
      requestId: value.requestId,
      kind: "github.base_ref.get",
      outcome: "succeeded",
      httpStatus: 200,
      projection: {
        type: "ref",
        state: "direct",
        ref: LANDING.baseRef,
        sha1: BASE_COMMIT,
      },
      errorCode: null,
    };
  }
  return {
    schemaVersion: 1,
    requestId: value.requestId,
    kind: "github.head_ref.get",
    outcome: "succeeded",
    httpStatus: 404,
    projection: { type: "ref", state: "absent", ref: LANDING.headRef, sha1: null },
    errorCode: null,
  };
}

function terminalResult(index: number, outcome: "failed" | "ambiguous"): LandingHttpResultV1 {
  const value = request(index);
  return {
    schemaVersion: 1,
    requestId: value.requestId,
    kind: value.kind,
    outcome,
    httpStatus: outcome === "failed" ? 403 : null,
    projection: null,
    errorCode: outcome === "failed" ? "GITHUB_PERMISSION_DENIED" : "GITHUB_OUTCOME_AMBIGUOUS",
  };
}

function operationObservation(
  results: readonly LandingHttpResultV1[],
): LandingOperationObservationV1 {
  const factNames = ["actor", "base_ref", "head_ref"] as const;
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    kind: "github.preflight",
    phase: "pre_effect",
    facts: results.map((value, index) => ({
      fact: factNames[index] ?? "head_ref",
      requestId: value.requestId,
      resultSha256: digestLandingRecord(value),
    })),
  };
}

function completedOperationResult(
  results: readonly LandingHttpResultV1[],
): LandingOperationResultV1 {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    kind: "github.preflight",
    outcome: "completed",
    boundary: "preflight_exact",
    evidence: results.map((value) => ({
      requestId: value.requestId,
      resultSha256: digestLandingRecord(value),
    })),
    value: {
      actor: PROFILE.expectedActor,
      baseSha1: BASE_COMMIT,
      headState: "absent",
      pullRequestCount: null,
    },
    errorCode: null,
  };
}

function terminalOperationResultValue(
  results: readonly LandingHttpResultV1[],
  outcome: "failed" | "ambiguous",
): LandingOperationResultV1 {
  const terminal = results.at(-1);
  if (terminal === undefined || terminal.errorCode === null) {
    throw new Error("terminal fixture has no result error");
  }
  const operationOutcome = outcome === "failed" ? "failed" : "interrupted";
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    kind: "github.preflight",
    outcome: operationOutcome,
    boundary: operationOutcome === "failed" ? "operation_failed" : "operation_interrupted",
    evidence: results.map((value) => ({
      requestId: value.requestId,
      resultSha256: digestLandingRecord(value),
    })),
    value: null,
    errorCode: terminal.errorCode,
  };
}

function eventRow(
  id: number,
  sequence: number,
  type:
    | "landing.operation.started"
    | "landing.operation.settled"
    | "landing.github.request.admitted"
    | "landing.github.request.settled",
  payload:
    | LandingOperationStartedEventV1
    | LandingOperationSettledEventV1
    | LandingGitHubRequestAdmittedEventV1
    | LandingGitHubRequestSettledEventV1,
): MutableRow {
  return {
    id,
    landing_id: LANDING_ID,
    sequence,
    type,
    payload_json: canonicalLandingJson(payload),
    created_at: STARTED_AT,
  };
}

function admittedEventPayload(
  value: LandingHttpRequestV1,
  requestSha256: string,
): LandingGitHubRequestAdmittedEventV1 {
  return {
    schemaVersion: 1,
    landingId: LANDING_ID,
    operationId: OPERATION_ID,
    requestId: value.requestId,
    coordinatorAttempt: 2,
    operationKind: "github.preflight",
    requestOrdinal: value.requestOrdinal,
    kind: value.kind,
    requestSha256,
  };
}

function settledEventPayload(
  value: LandingHttpRequestV1,
  result: LandingHttpResultV1,
  resultSha256: string,
): LandingGitHubRequestSettledEventV1 {
  return {
    schemaVersion: 1,
    landingId: LANDING_ID,
    operationId: OPERATION_ID,
    requestId: value.requestId,
    coordinatorAttempt: 2,
    operationKind: "github.preflight",
    requestOrdinal: value.requestOrdinal,
    kind: value.kind,
    outcome: result.outcome,
    resultSha256,
    errorCode: result.errorCode,
  };
}

function makeFixture(successCount: number, tail?: Tail): Fixture {
  if (successCount < 0 || successCount > 3 || (successCount === 3 && tail !== undefined)) {
    throw new Error("fixture topology is out of range");
  }
  const operationJson = canonicalLandingJson(OPERATION);
  const operationSha256 = sha256(operationJson);
  let sequence = 20;
  let eventId = 100;
  const operationEvents: MutableRow[] = [
    eventRow(eventId, sequence, "landing.operation.started", {
      schemaVersion: 1,
      landingId: LANDING_ID,
      operationId: OPERATION_ID,
      coordinatorAttempt: 2,
      kind: "github.preflight",
      kindAttempt: 1,
      requestSha256: operationSha256,
    }),
  ];
  const requestEvents: MutableRow[] = [];
  const httpRows: MutableRow[] = [];
  const settledResults: LandingHttpResultV1[] = [];

  for (let index = 0; index < successCount + (tail === undefined ? 0 : 1); index += 1) {
    const requestValue = request(index);
    const requestJson = canonicalLandingJson(requestValue);
    const requestSha256 = sha256(requestJson);
    sequence += 1;
    eventId += 1;
    requestEvents.push(
      eventRow(
        eventId,
        sequence,
        "landing.github.request.admitted",
        admittedEventPayload(requestValue, requestSha256),
      ),
    );
    const row: MutableRow = {
      id: requestValue.requestId,
      landing_id: LANDING_ID,
      operation_id: OPERATION_ID,
      coordinator_attempt: 2,
      operation_kind: "github.preflight",
      request_ordinal: requestValue.requestOrdinal,
      kind: requestValue.kind,
      method: "GET",
      request_sha256: requestSha256,
      request_json: requestJson,
      status: "admitted",
      outcome: null,
      http_status: null,
      result_sha256: null,
      result_json: null,
      error_code: null,
      admitted_at: STARTED_AT,
      settled_at: null,
    };
    const isTail = index === successCount && tail !== undefined;
    if (!(isTail && tail === "admitted")) {
      const resultValue = isTail
        ? terminalResult(index, tail as "failed" | "ambiguous")
        : succeededResult(index);
      const resultJson = canonicalLandingJson(resultValue);
      const resultSha256 = sha256(resultJson);
      row.status = "settled";
      row.outcome = resultValue.outcome;
      row.http_status = resultValue.httpStatus;
      row.result_sha256 = resultSha256;
      row.result_json = resultJson;
      row.error_code = resultValue.errorCode;
      row.settled_at = FINISHED_AT;
      settledResults.push(resultValue);
      sequence += 1;
      eventId += 1;
      requestEvents.push(
        eventRow(
          eventId,
          sequence,
          "landing.github.request.settled",
          settledEventPayload(requestValue, resultValue, resultSha256),
        ),
      );
    }
    httpRows.push(row);
  }

  const complete = successCount === 3;
  const terminal = tail === "failed" || tail === "ambiguous";
  const status = complete
    ? "completed"
    : tail === "failed"
      ? "failed"
      : tail === "ambiguous"
        ? "interrupted"
        : "started";
  const observation = complete ? operationObservation(settledResults) : null;
  const result = complete
    ? completedOperationResult(settledResults)
    : terminal
      ? terminalOperationResultValue(settledResults, tail)
      : null;
  const observationJson = observation === null ? null : canonicalLandingJson(observation);
  const resultJson = result === null ? null : canonicalLandingJson(result);
  const errorCode = result?.errorCode ?? null;
  const operationRow: MutableRow = {
    id: OPERATION_ID,
    landing_id: LANDING_ID,
    coordinator_attempt: 2,
    kind: "github.preflight",
    kind_attempt: 1,
    status,
    request_sha256: operationSha256,
    request_json: operationJson,
    observation_sha256: observationJson === null ? null : sha256(observationJson),
    observation_json: observationJson,
    result_sha256: resultJson === null ? null : sha256(resultJson),
    result_json: resultJson,
    error_code: errorCode,
    started_at: STARTED_AT,
    finished_at: result === null ? null : FINISHED_AT,
  };
  if (result !== null) {
    sequence += 1;
    eventId += 1;
    operationEvents.push(
      eventRow(eventId, sequence, "landing.operation.settled", {
        schemaVersion: 1,
        landingId: LANDING_ID,
        operationId: OPERATION_ID,
        coordinatorAttempt: 2,
        kind: "github.preflight",
        outcome: result.outcome,
        resultSha256: sha256(resultJson as string),
        errorCode,
      }),
    );
  }
  return {
    input: {
      landing: LANDING,
      landingSha256: digestLandingRecord(LANDING),
      operationStartState: "local_ready",
      operationStartVersion: OPERATION.expectedVersion,
      operationRow,
      previousRequestOrdinal: PREVIOUS_REQUEST_ORDINAL,
      httpRows,
      requestEvents,
      operationEvents,
    },
  };
}

function settleAsTakeover(fixture: Fixture): Fixture {
  const evidence = fixture.input.httpRows.flatMap((row) => {
    if (row.status !== "settled") return [];
    if (typeof row.id !== "string" || typeof row.result_sha256 !== "string") {
      throw new Error("settled takeover fixture row is incomplete");
    }
    return [{ requestId: row.id, resultSha256: row.result_sha256 }];
  });
  const result: LandingOperationResultV1 = {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    kind: "github.preflight",
    outcome: "interrupted",
    boundary: "operation_interrupted",
    evidence,
    value: null,
    errorCode: "LANDING_COORDINATOR_TAKEOVER",
  };
  const resultJson = canonicalLandingJson(result);
  const resultSha256 = sha256(resultJson);
  fixture.input.operationRow.status = "interrupted";
  fixture.input.operationRow.observation_sha256 = null;
  fixture.input.operationRow.observation_json = null;
  fixture.input.operationRow.result_sha256 = resultSha256;
  fixture.input.operationRow.result_json = resultJson;
  fixture.input.operationRow.error_code = "LANDING_COORDINATOR_TAKEOVER";
  fixture.input.operationRow.finished_at = FINISHED_AT;

  const settlementPayload: LandingOperationSettledEventV1 = {
    schemaVersion: 1,
    landingId: LANDING_ID,
    operationId: OPERATION_ID,
    coordinatorAttempt: 2,
    kind: "github.preflight",
    outcome: "interrupted",
    resultSha256,
    errorCode: "LANDING_COORDINATOR_TAKEOVER",
  };
  const existingSettlement = fixture.input.operationEvents[1];
  if (existingSettlement === undefined) {
    const ownedEvents = [...fixture.input.operationEvents, ...fixture.input.requestEvents];
    const lastSequence = Math.max(...ownedEvents.map((event) => event.sequence as number));
    const lastId = Math.max(...ownedEvents.map((event) => event.id as number));
    fixture.input.operationEvents.push(
      eventRow(lastId + 1, lastSequence + 1, "landing.operation.settled", settlementPayload),
    );
  } else {
    existingSettlement.payload_json = canonicalLandingJson(settlementPayload);
  }
  return fixture;
}

function replaceTakeoverError(fixture: Fixture, errorCode: string): void {
  const result = JSON.parse(fixture.input.operationRow.result_json as string) as MutableRow;
  result.errorCode = errorCode;
  const resultJson = canonicalLandingJson(result);
  const resultSha256 = sha256(resultJson);
  fixture.input.operationRow.result_json = resultJson;
  fixture.input.operationRow.result_sha256 = resultSha256;
  fixture.input.operationRow.error_code = errorCode;
  const settlement = operationEventAt(fixture, 1);
  const payload = JSON.parse(settlement.payload_json as string) as MutableRow;
  payload.resultSha256 = resultSha256;
  payload.errorCode = errorCode;
  settlement.payload_json = canonicalLandingJson(payload);
}

function replaceTakeoverResult(fixture: Fixture, result: MutableRow): void {
  const resultJson = canonicalLandingJson(result);
  const resultSha256 = sha256(resultJson);
  fixture.input.operationRow.result_json = resultJson;
  fixture.input.operationRow.result_sha256 = resultSha256;
  const settlement = operationEventAt(fixture, 1);
  const payload = JSON.parse(settlement.payload_json as string) as MutableRow;
  payload.resultSha256 = resultSha256;
  settlement.payload_json = canonicalLandingJson(payload);
}

function expectInvalid(value: unknown): void {
  try {
    validatePersistedGitHubPreflightOperationV1(value);
    throw new Error("expected persisted preflight aggregate validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe("LANDING_RECORD_INVALID");
  }
}

function operationEventAt(fixture: Fixture, index: number): MutableRow {
  const event = fixture.input.operationEvents[index];
  if (event === undefined) throw new Error("fixture operation event is missing");
  return event;
}

function httpRowAt(fixture: Fixture, index: number): MutableRow {
  const row = fixture.input.httpRows[index];
  if (row === undefined) throw new Error("fixture HTTP row is missing");
  return row;
}

function requestEventAt(fixture: Fixture, index: number): MutableRow {
  const event = fixture.input.requestEvents[index];
  if (event === undefined) throw new Error("fixture request event is missing");
  return event;
}

describe("persisted local-ready GitHub preflight aggregate evidence", () => {
  it.each([
    [0, "github.actor.get"],
    [1, "github.base_ref.get"],
    [2, "github.head_ref.get"],
  ] as const)("projects %i successful GETs to the exact next %s", (successes, expectedKind) => {
    const fixture = makeFixture(successes);
    const projected = validatePersistedGitHubPreflightOperationV1(fixture.input);
    expect(projected.status).toBe("next_request");
    if (projected.status !== "next_request") throw new Error("expected next-request evidence");
    expect(projected.nextRequest.kind).toBe(expectedKind);
    expect(projected.nextRequest.requestOrdinal).toBe(PREVIOUS_REQUEST_ORDINAL + successes + 1);
    expect(projected.exchanges).toHaveLength(successes);
  });

  it.each([0, 1, 2] as const)(
    "accepts one trailing admitted request after %i successful GETs without granting execution",
    (successes) => {
      const fixture = makeFixture(successes, "admitted");
      const projected = validatePersistedGitHubPreflightOperationV1(fixture.input);
      expect(projected.status).toBe("admitted");
      if (projected.status !== "admitted") throw new Error("expected admitted evidence");
      expect(projected.request.kind).toBe(
        ["github.actor.get", "github.base_ref.get", "github.head_ref.get"][successes],
      );
      expect(projected.request.requestOrdinal).toBe(PREVIOUS_REQUEST_ORDINAL + successes + 1);
    },
  );

  it.each([0, 1, 2] as const)(
    "recognizes takeover after %i successful GETs with no admitted request",
    (successes) => {
      const fixture = settleAsTakeover(makeFixture(successes));
      const projected = validatePersistedGitHubPreflightOperationV1(fixture.input);
      expect(projected.status).toBe("takeover");
      if (projected.status !== "takeover") throw new Error("expected takeover evidence");
      expect(projected).toMatchObject({
        operationOutcome: "interrupted",
        errorCode: "LANDING_COORDINATOR_TAKEOVER",
      });
      expect(projected.exchanges).toHaveLength(successes);
      expect(projected.result.evidence).toHaveLength(successes);
      expect(projected.resultSha256).toBe(digestLandingRecord(projected.result));
    },
  );

  it.each([0, 1, 2] as const)(
    "recognizes takeover after %i successes and the exact ambiguous admitted-request settlement",
    (successes) => {
      const fixture = settleAsTakeover(makeFixture(successes, "ambiguous"));
      const projected = validatePersistedGitHubPreflightOperationV1(fixture.input);
      expect(projected.status).toBe("takeover");
      if (projected.status !== "takeover") throw new Error("expected takeover evidence");
      expect(projected.exchanges).toHaveLength(successes + 1);
      const tail = projected.exchanges.at(-1);
      expect(tail?.status).toBe("settled");
      if (tail?.status !== "settled") throw new Error("expected settled takeover tail");
      expect(tail.result).toMatchObject({
        outcome: "ambiguous",
        errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
      });
      expect(projected.result).toMatchObject({
        outcome: "interrupted",
        errorCode: "LANDING_COORDINATOR_TAKEOVER",
      });
    },
  );

  it.each([0, 1, 2] as const)(
    "rejects a failed HTTP tail relabeled as takeover after %i successes",
    (successes) => {
      expectInvalid(settleAsTakeover(makeFixture(successes, "failed")).input);
    },
  );

  it.each([0, 1, 2] as const)(
    "rejects takeover settlement while an admitted request remains after %i successes",
    (successes) => {
      expectInvalid(settleAsTakeover(makeFixture(successes, "admitted")).input);
    },
  );

  it("rejects relabeling a complete three-GET history as takeover", () => {
    expectInvalid(settleAsTakeover(makeFixture(3)).input);
  });

  it("rejects takeover error swaps while preserving ordinary ambiguous settlement", () => {
    const ordinary = makeFixture(1, "ambiguous");
    const ordinaryProjected = validatePersistedGitHubPreflightOperationV1(ordinary.input);
    expect(ordinaryProjected.status).toBe("terminal");
    if (ordinaryProjected.status !== "terminal") {
      throw new Error("expected ordinary terminal evidence");
    }
    expect(ordinaryProjected.errorCode).toBe("GITHUB_OUTCOME_AMBIGUOUS");

    const prefixErrorSwap = settleAsTakeover(makeFixture(1));
    replaceTakeoverError(prefixErrorSwap, "GITHUB_OUTCOME_AMBIGUOUS");
    expectInvalid(prefixErrorSwap.input);

    const ambiguousErrorSwap = settleAsTakeover(makeFixture(1, "ambiguous"));
    replaceTakeoverError(ambiguousErrorSwap, "GITHUB_RATE_LIMITED");
    expectInvalid(ambiguousErrorSwap.input);

    const rowEventSwap = settleAsTakeover(makeFixture(1));
    rowEventSwap.input.operationRow.error_code = "GITHUB_OUTCOME_AMBIGUOUS";
    expectInvalid(rowEventSwap.input);

    const settlementEventSwap = settleAsTakeover(makeFixture(1));
    const settlement = operationEventAt(settlementEventSwap, 1);
    const settlementPayload = JSON.parse(settlement.payload_json as string) as MutableRow;
    settlementPayload.errorCode = "GITHUB_OUTCOME_AMBIGUOUS";
    settlement.payload_json = canonicalLandingJson(settlementPayload);
    expectInvalid(settlementEventSwap.input);
  });

  it("rejects takeover evidence, digest, order, and observation drift", () => {
    const evidenceDrift = settleAsTakeover(makeFixture(1));
    const evidenceResult = JSON.parse(
      evidenceDrift.input.operationRow.result_json as string,
    ) as MutableRow;
    const evidence = evidenceResult.evidence as MutableRow[];
    (evidence[0] as MutableRow).resultSha256 = "f".repeat(64);
    replaceTakeoverResult(evidenceDrift, evidenceResult);
    expectInvalid(evidenceDrift.input);

    const digestDrift = settleAsTakeover(makeFixture(1));
    digestDrift.input.operationRow.result_sha256 = "e".repeat(64);
    expectInvalid(digestDrift.input);

    const evidenceOrderDrift = settleAsTakeover(makeFixture(2));
    const orderedResult = JSON.parse(
      evidenceOrderDrift.input.operationRow.result_json as string,
    ) as MutableRow;
    (orderedResult.evidence as MutableRow[]).reverse();
    replaceTakeoverResult(evidenceOrderDrift, orderedResult);
    expectInvalid(evidenceOrderDrift.input);

    const observed = settleAsTakeover(makeFixture(1));
    const observation = operationObservation([succeededResult(0)]);
    const observationJson = canonicalLandingJson(observation);
    observed.input.operationRow.observation_json = observationJson;
    observed.input.operationRow.observation_sha256 = sha256(observationJson);
    expectInvalid(observed.input);

    const eventDigestDrift = settleAsTakeover(makeFixture(1));
    const settlement = operationEventAt(eventDigestDrift, 1);
    const settlementPayload = JSON.parse(settlement.payload_json as string) as MutableRow;
    settlementPayload.resultSha256 = "d".repeat(64);
    settlement.payload_json = canonicalLandingJson(settlementPayload);
    expectInvalid(eventDigestDrift.input);
  });

  it("accepts the canonical three-GET completion only with exact observation/result settlement", () => {
    const fixture = makeFixture(3);
    const projected = validatePersistedGitHubPreflightOperationV1(fixture.input);
    expect(projected.status).toBe("complete");
    if (projected.status !== "complete") throw new Error("expected complete evidence");
    expect(projected.observation.facts.map((fact) => fact.fact)).toEqual([
      "actor",
      "base_ref",
      "head_ref",
    ]);
    expect(projected.result).toEqual(
      completedOperationResult([succeededResult(0), succeededResult(1), succeededResult(2)]),
    );
    expect(projected.resultSha256).toBe(digestLandingRecord(projected.result));
  });

  it.each([
    ["failed", "failed", "GITHUB_PERMISSION_DENIED"],
    ["ambiguous", "interrupted", "GITHUB_OUTCOME_AMBIGUOUS"],
  ] as const)(
    "accepts ordinary %s HTTP termination only as an exact %s operation",
    (httpOutcome, operationOutcome, errorCode) => {
      for (const successes of [0, 1, 2]) {
        const fixture = makeFixture(successes, httpOutcome);
        const projected = validatePersistedGitHubPreflightOperationV1(fixture.input);
        expect(projected.status).toBe("terminal");
        if (projected.status !== "terminal") throw new Error("expected terminal evidence");
        expect(projected.httpOutcome).toBe(httpOutcome);
        expect(projected.operationOutcome).toBe(operationOutcome);
        expect(projected.errorCode).toBe(errorCode);
        expect(projected.result.evidence).toHaveLength(successes + 1);
      }
    },
  );

  it("rejects remote-stage and pull-request-absence preflight operations even when redigested", () => {
    const fixture = makeFixture(0);
    const operation = structuredClone(OPERATION) as unknown as MutableRow;
    operation.expectedState = "remote_ready";
    (operation.input as { includePullRequestAbsence: boolean }).includePullRequestAbsence = true;
    const operationJson = canonicalLandingJson(operation);
    fixture.input.operationRow.request_json = operationJson;
    fixture.input.operationRow.request_sha256 = sha256(operationJson);
    const start = operationEventAt(fixture, 0);
    const payload = JSON.parse(start.payload_json as string) as MutableRow;
    payload.requestSha256 = sha256(operationJson);
    start.payload_json = canonicalLandingJson(payload);
    expectInvalid(fixture.input);
  });

  it("binds the operation to its replay-derived start state and version", () => {
    const wrongState = makeFixture(0);
    (wrongState.input as unknown as MutableRow).operationStartState = "objects_ready";
    expectInvalid(wrongState.input);

    const wrongVersion = makeFixture(0);
    wrongVersion.input.operationStartVersion += 1;
    expectInvalid(wrongVersion.input);
  });

  it("rejects gaps, reordering, duplicate requests, and cross-operation identities", () => {
    const ordinalGap = makeFixture(1);
    ordinalGap.input.previousRequestOrdinal -= 1;
    expectInvalid(ordinalGap.input);

    const reordered = makeFixture(2);
    [reordered.input.httpRows[0], reordered.input.httpRows[1]] = [
      reordered.input.httpRows[1] as MutableRow,
      reordered.input.httpRows[0] as MutableRow,
    ];
    expectInvalid(reordered.input);

    const duplicate = makeFixture(1);
    duplicate.input.httpRows.push(structuredClone(duplicate.input.httpRows[0] as MutableRow));
    duplicate.input.requestEvents.push(...structuredClone(duplicate.input.requestEvents));
    expectInvalid(duplicate.input);

    const crossOperation = makeFixture(1);
    httpRowAt(crossOperation, 0).operation_id = REVIEW_ID;
    expectInvalid(crossOperation.input);

    const multipleAdmitted = makeFixture(0, "admitted");
    const secondAdmission = makeFixture(1, "admitted");
    multipleAdmitted.input.httpRows.push(structuredClone(httpRowAt(secondAdmission, 1)));
    const secondAdmissionEvent = structuredClone(requestEventAt(secondAdmission, 2));
    secondAdmissionEvent.sequence = 22;
    secondAdmissionEvent.id = 102;
    multipleAdmitted.input.requestEvents.push(secondAdmissionEvent);
    expectInvalid(multipleAdmitted.input);
  });

  it("rejects missing, extra, reordered, gapped, and cross-identity request events", () => {
    const missing = makeFixture(1);
    missing.input.requestEvents.pop();
    expectInvalid(missing.input);

    const extra = makeFixture(0, "admitted");
    extra.input.requestEvents.push(structuredClone(extra.input.requestEvents[0] as MutableRow));
    expectInvalid(extra.input);

    const reordered = makeFixture(2);
    [reordered.input.requestEvents[0], reordered.input.requestEvents[1]] = [
      reordered.input.requestEvents[1] as MutableRow,
      reordered.input.requestEvents[0] as MutableRow,
    ];
    expectInvalid(reordered.input);

    const gap = makeFixture(1);
    requestEventAt(gap, 0).sequence = 99;
    expectInvalid(gap.input);

    const crossIdentity = makeFixture(1);
    requestEventAt(crossIdentity, 0).landing_id = PROJECT_ID;
    expectInvalid(crossIdentity.input);

    const noncanonicalTimestamp = makeFixture(1);
    requestEventAt(noncanonicalTimestamp, 0).created_at = "2026-08-08T12:00:00Z";
    expectInvalid(noncanonicalTimestamp.input);
  });

  it("rejects sparse and over-bound HTTP, request-event, and operation-event arrays", () => {
    const sparseHttp = makeFixture(1);
    Reflect.deleteProperty(sparseHttp.input.httpRows, 0);
    expectInvalid(sparseHttp.input);

    const overBoundHttp = makeFixture(3);
    overBoundHttp.input.httpRows.push(structuredClone(httpRowAt(overBoundHttp, 0)));
    expectInvalid(overBoundHttp.input);

    const sparseRequestEvents = makeFixture(1);
    Reflect.deleteProperty(sparseRequestEvents.input.requestEvents, 0);
    expectInvalid(sparseRequestEvents.input);

    const overBoundRequestEvents = makeFixture(3);
    overBoundRequestEvents.input.requestEvents.push(
      structuredClone(requestEventAt(overBoundRequestEvents, 0)),
    );
    expectInvalid(overBoundRequestEvents.input);

    const sparseOperationEvents = makeFixture(0);
    Reflect.deleteProperty(sparseOperationEvents.input.operationEvents, 0);
    expectInvalid(sparseOperationEvents.input);

    const overBoundOperationEvents = makeFixture(3);
    overBoundOperationEvents.input.operationEvents.push(
      structuredClone(operationEventAt(overBoundOperationEvents, 0)),
    );
    expectInvalid(overBoundOperationEvents.input);
  });

  it("rejects complete HTTP evidence under a still-started or inexact operation settlement", () => {
    const started = makeFixture(3);
    started.input.operationRow.status = "started";
    started.input.operationRow.observation_sha256 = null;
    started.input.operationRow.observation_json = null;
    started.input.operationRow.result_sha256 = null;
    started.input.operationRow.result_json = null;
    started.input.operationRow.error_code = null;
    started.input.operationRow.finished_at = null;
    started.input.operationEvents.pop();
    expectInvalid(started.input);

    const alteredObservation = makeFixture(3);
    alteredObservation.input.operationRow.observation_sha256 = "f".repeat(64);
    expectInvalid(alteredObservation.input);

    const missingSettlementEvent = makeFixture(3);
    missingSettlementEvent.input.operationEvents.pop();
    expectInvalid(missingSettlementEvent.input);
  });

  it("strictly decodes operation SQL columns and operation-event timestamps", () => {
    const extraColumn = makeFixture(0);
    extraColumn.input.operationRow.unexpected = true;
    expectInvalid(extraColumn.input);

    const wrongSqlIdentity = makeFixture(0);
    wrongSqlIdentity.input.operationRow.coordinator_attempt = 3;
    expectInvalid(wrongSqlIdentity.input);

    const noncanonicalTimestamp = makeFixture(0);
    operationEventAt(noncanonicalTimestamp, 0).created_at = "2026-08-08T12:00:00Z";
    expectInvalid(noncanonicalTimestamp.input);
  });

  it("rejects ordinary terminal evidence drift", () => {
    const errorDrift = makeFixture(0, "failed");
    errorDrift.input.operationRow.error_code = "GITHUB_RATE_LIMITED";
    expectInvalid(errorDrift.input);

    const observedTerminal = makeFixture(1, "ambiguous");
    const complete = makeFixture(3);
    observedTerminal.input.operationRow.observation_json =
      complete.input.operationRow.observation_json;
    observedTerminal.input.operationRow.observation_sha256 =
      complete.input.operationRow.observation_sha256;
    expectInvalid(observedTerminal.input);
  });

  it("rejects extra aggregate members and a complete history with a noncanonical result digest", () => {
    const extra = makeFixture(0);
    (extra.input as unknown as MutableRow).authority = true;
    expectInvalid(extra.input);

    const wrongDigest = makeFixture(3);
    wrongDigest.input.operationRow.result_sha256 = "e".repeat(64);
    expectInvalid(wrongDigest.input);
  });
});
