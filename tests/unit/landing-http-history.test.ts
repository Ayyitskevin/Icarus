import { describe, expect, it } from "vitest";
import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  type GitHubPreflightHistoryExchangeV1,
  validateGitHubPreflightHttpHistoryV1,
} from "../../packages/core/src/landing-http-history.js";
import {
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  digestLandingRecord,
  type GitHubLandingProfileV1,
  type LandingDigestV1,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
  type LandingOperationRequestV1,
} from "../../packages/core/src/landing-records.js";

const LANDING_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const REVIEW_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_IDS = [
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
  "99999999-9999-4999-8999-999999999999",
] as const;
const BASE_COMMIT = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const CANDIDATE_TREE = "c".repeat(40);
const CANDIDATE_COMMIT = "d".repeat(40);
const COMMIT_EPOCH_SECONDS = 1_700_000_000;
const COMMIT_INSTANT = commitEpochToGitInstant(COMMIT_EPOCH_SECONDS);
const PREVIOUS_REQUEST_ORDINAL = 7;

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
  commitEpochSeconds: COMMIT_EPOCH_SECONDS,
  commitIso8601: COMMIT_INSTANT,
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

function operation(includePullRequestAbsence: boolean): LandingOperationRequestV1 {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    landingId: LANDING_ID,
    coordinatorAttempt: 2,
    kindAttempt: 1,
    kind: "github.preflight",
    expectedState: includePullRequestAbsence ? "remote_ready" : "local_ready",
    expectedVersion: 6,
    input: {
      landingSha256: digestLandingRecord(LANDING),
      profileSha256: LANDING.profileSha256,
      baseRef: LANDING.baseRef,
      expectedRemoteBaseSha1: LANDING.expectedRemoteBaseSha1,
      headRef: LANDING.headRef,
      candidateCommitSha1: LANDING.candidateCommitSha1,
      includePullRequestAbsence,
    },
  };
}

function request(index: number): LandingHttpRequestV1 {
  const common = {
    schemaVersion: 1 as const,
    requestId: REQUEST_IDS[index] ?? REQUEST_IDS[0],
    landingId: LANDING_ID,
    operationId: OPERATION_ID,
    coordinatorAttempt: 2,
    operationKind: "github.preflight" as const,
    requestOrdinal: PREVIOUS_REQUEST_ORDINAL + index + 1,
    method: "GET" as const,
    profileSha256: LANDING.profileSha256,
    bodySha256: null,
  };
  switch (index) {
    case 0:
      return {
        ...common,
        kind: "github.actor.get",
        subject: { expectedActor: PROFILE.expectedActor },
      };
    case 1:
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
    case 2:
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
    case 3:
      return {
        ...common,
        kind: "github.pull_requests.get",
        subject: {
          owner: PROFILE.owner,
          repository: PROFILE.repository,
          headOwner: PROFILE.owner,
          headRef: `icarus/${RUN_ID}`,
          baseBranch: PROFILE.baseBranch,
          state: "all",
          page: 1,
          perPage: 100,
        },
      };
    default:
      throw new Error("fixture request index is out of range");
  }
}

function result(index: number, headState: "absent" | "exact"): LandingHttpResultV1 {
  const requestId = REQUEST_IDS[index] ?? REQUEST_IDS[0];
  switch (index) {
    case 0:
      return {
        schemaVersion: 1,
        requestId,
        kind: "github.actor.get",
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "actor", login: PROFILE.expectedActor },
        errorCode: null,
      };
    case 1:
      return {
        schemaVersion: 1,
        requestId,
        kind: "github.base_ref.get",
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "ref", state: "direct", ref: LANDING.baseRef, sha1: BASE_COMMIT },
        errorCode: null,
      };
    case 2:
      return {
        schemaVersion: 1,
        requestId,
        kind: "github.head_ref.get",
        outcome: "succeeded",
        httpStatus: headState === "absent" ? 404 : 200,
        projection:
          headState === "absent"
            ? { type: "ref", state: "absent", ref: LANDING.headRef, sha1: null }
            : {
                type: "ref",
                state: "direct",
                ref: LANDING.headRef,
                sha1: CANDIDATE_COMMIT,
              },
        errorCode: null,
      };
    case 3:
      return {
        schemaVersion: 1,
        requestId,
        kind: "github.pull_requests.get",
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "pull_request_list", complete: true, count: 0, objects: [] },
        errorCode: null,
      };
    default:
      throw new Error("fixture result index is out of range");
  }
}

function exchanges(
  count: number,
  headState: "absent" | "exact" = "absent",
): GitHubPreflightHistoryExchangeV1[] {
  return Array.from({ length: count }, (_, index) => {
    const httpRequest = request(index);
    const httpResult = result(index, headState);
    return {
      request: httpRequest,
      requestSha256: digestLandingRecord(httpRequest),
      result: httpResult,
      resultSha256: digestLandingRecord(httpResult),
    };
  });
}

function history(
  includePullRequestAbsence: boolean,
  settled: readonly GitHubPreflightHistoryExchangeV1[],
): Record<string, unknown> {
  const operationRecord = operation(includePullRequestAbsence);
  return {
    landing: LANDING,
    landingSha256: digestLandingRecord(LANDING),
    operation: operationRecord,
    operationRequestSha256: digestLandingRecord(operationRecord),
    previousRequestOrdinal: PREVIOUS_REQUEST_ORDINAL,
    exchanges: settled,
  };
}

function redigestRequest(exchange: GitHubPreflightHistoryExchangeV1): void {
  (exchange as { requestSha256: unknown }).requestSha256 = digestLandingRecord(exchange.request);
}

function redigestResult(exchange: GitHubPreflightHistoryExchangeV1): void {
  (exchange as { resultSha256: unknown }).resultSha256 = digestLandingRecord(exchange.result);
}

function exchangeAt(
  values: readonly GitHubPreflightHistoryExchangeV1[],
  index: number,
): GitHubPreflightHistoryExchangeV1 {
  const exchange = values[index];
  if (exchange === undefined) throw new Error("fixture exchange index is out of range");
  return exchange;
}

function expectInvalid(value: unknown): void {
  try {
    validateGitHubPreflightHttpHistoryV1(value);
    throw new Error("expected history validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe("LANDING_RECORD_INVALID");
  }
}

describe("ADR 0027 GitHub preflight HTTP history", () => {
  it("projects each bounded successful prefix into the exact next request", () => {
    const complete = exchanges(4, "exact");
    const expectedKinds = [
      "github.actor.get",
      "github.base_ref.get",
      "github.head_ref.get",
      "github.pull_requests.get",
    ];
    for (let length = 0; length < complete.length; length += 1) {
      const projected = validateGitHubPreflightHttpHistoryV1(
        history(true, complete.slice(0, length)),
      );
      expect(projected.status).toBe("next_request");
      if (projected.status !== "next_request") throw new Error("expected next request");
      expect(projected.facts).toHaveLength(length);
      expect(projected.nextRequest.kind).toBe(expectedKinds[length]);
      expect(projected.nextRequest.requestOrdinal).toBe(PREVIOUS_REQUEST_ORDINAL + length + 1);
      expect(projected.nextRequest.operationId).toBe(OPERATION_ID);
      expect(projected.nextRequest.profileSha256).toBe(LANDING.profileSha256);
      expect(projected.nextRequest.method).toBe("GET");
      expect(projected.nextRequest.bodySha256).toBeNull();
    }
  });

  it("completes an absent-head preflight without a pull-request query", () => {
    const projected = validateGitHubPreflightHttpHistoryV1(history(false, exchanges(3)));
    expect(projected.status).toBe("complete");
    if (projected.status !== "complete") throw new Error("expected complete history");
    expect(projected.value).toEqual({
      actor: PROFILE.expectedActor,
      baseSha1: BASE_COMMIT,
      headState: "absent",
      pullRequestCount: null,
    });
    expect(projected.facts.map((fact) => fact.fact)).toEqual(["actor", "base_ref", "head_ref"]);
    expect(projected.observation.facts).toEqual(projected.facts);
    expect(projected.operationResult.evidence).toEqual(
      projected.facts.map(({ requestId, resultSha256 }) => ({ requestId, resultSha256 })),
    );
    expect(projected.observationSha256).toBe(digestLandingRecord(projected.observation));
    expect(projected.operationResultSha256).toBe(digestLandingRecord(projected.operationResult));
  });

  it("completes an exact-head preflight only with a complete zero-PR list", () => {
    const projected = validateGitHubPreflightHttpHistoryV1(history(true, exchanges(4, "exact")));
    expect(projected.status).toBe("complete");
    if (projected.status !== "complete") throw new Error("expected complete history");
    expect(projected.value).toEqual({
      actor: PROFILE.expectedActor,
      baseSha1: BASE_COMMIT,
      headState: "exact",
      pullRequestCount: 0,
    });
    expect(projected.facts.map((fact) => fact.fact)).toEqual([
      "actor",
      "base_ref",
      "head_ref",
      "pull_requests",
    ]);
  });

  it("rejects unbound landing, operation, profile, and HTTP identities", () => {
    const wrongLandingDigest = history(false, exchanges(3));
    wrongLandingDigest.landingSha256 = "f".repeat(64);
    expectInvalid(wrongLandingDigest);

    const wrongProfile = history(false, exchanges(3));
    const wrongProfileOperation = structuredClone(
      wrongProfile.operation,
    ) as LandingOperationRequestV1;
    (wrongProfileOperation.input as { profileSha256: string }).profileSha256 =
      sha256("wrong-profile");
    wrongProfile.operation = wrongProfileOperation;
    wrongProfile.operationRequestSha256 = digestLandingRecord(wrongProfileOperation);
    expectInvalid(wrongProfile);

    const wrongOperationDigest = history(false, exchanges(3));
    wrongOperationDigest.operationRequestSha256 = "f".repeat(64);
    expectInvalid(wrongOperationDigest);

    const wrongStage = history(false, exchanges(3));
    const wrongStageOperation = {
      ...(structuredClone(wrongStage.operation) as LandingOperationRequestV1),
      expectedState: "remote_ready" as const,
    };
    wrongStage.operation = wrongStageOperation;
    wrongStage.operationRequestSha256 = digestLandingRecord(wrongStageOperation);
    expectInvalid(wrongStage);

    const wrongOperation = exchanges(3);
    (exchangeAt(wrongOperation, 0).request as { operationId: string }).operationId =
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    redigestRequest(exchangeAt(wrongOperation, 0));
    expectInvalid(history(false, wrongOperation));

    const identityMutations: ReadonlyArray<(request: LandingHttpRequestV1) => void> = [
      (httpRequest) => {
        (httpRequest as { landingId: string }).landingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      },
      (httpRequest) => {
        (httpRequest as { coordinatorAttempt: number }).coordinatorAttempt = 3;
      },
      (httpRequest) => {
        (httpRequest as { operationKind: string }).operationKind = "github.ref.create";
      },
      (httpRequest) => {
        (httpRequest as { profileSha256: string }).profileSha256 = sha256("wrong-profile");
      },
    ];
    for (const mutate of identityMutations) {
      const mutated = exchanges(1);
      mutate(exchangeAt(mutated, 0).request as LandingHttpRequestV1);
      redigestRequest(exchangeAt(mutated, 0));
      expectInvalid(history(false, mutated));
    }
  });

  it("rejects wrong subjects, ordinals, canonical digests, and request order", () => {
    const wrongSubject = exchanges(3);
    (
      exchangeAt(wrongSubject, 1).request as { subject: { repository: string } }
    ).subject.repository = "other";
    redigestRequest(exchangeAt(wrongSubject, 1));
    expectInvalid(history(false, wrongSubject));

    const ordinalGap = exchanges(3);
    (exchangeAt(ordinalGap, 1).request as { requestOrdinal: number }).requestOrdinal += 1;
    redigestRequest(exchangeAt(ordinalGap, 1));
    expectInvalid(history(false, ordinalGap));

    const wrongRequestDigest = exchanges(3);
    (exchangeAt(wrongRequestDigest, 0) as { requestSha256: unknown }).requestSha256 = "f".repeat(
      64,
    );
    expectInvalid(history(false, wrongRequestDigest));

    const wrongResultDigest = exchanges(3);
    (exchangeAt(wrongResultDigest, 0) as { resultSha256: unknown }).resultSha256 = "f".repeat(64);
    expectInvalid(history(false, wrongResultDigest));

    const wrongResultIdentity = exchanges(3);
    (exchangeAt(wrongResultIdentity, 1).result as { requestId: string }).requestId = REQUEST_IDS[0];
    redigestResult(exchangeAt(wrongResultIdentity, 1));
    expectInvalid(history(false, wrongResultIdentity));

    const duplicateRequestIdentity = exchanges(3);
    (exchangeAt(duplicateRequestIdentity, 1).request as { requestId: string }).requestId =
      REQUEST_IDS[0];
    (exchangeAt(duplicateRequestIdentity, 1).result as { requestId: string }).requestId =
      REQUEST_IDS[0];
    redigestRequest(exchangeAt(duplicateRequestIdentity, 1));
    redigestResult(exchangeAt(duplicateRequestIdentity, 1));
    expectInvalid(history(false, duplicateRequestIdentity));

    const reordered = exchanges(3);
    [reordered[0], reordered[1]] = [exchangeAt(reordered, 1), exchangeAt(reordered, 0)];
    expectInvalid(history(false, reordered));

    const missingMiddle = exchanges(3);
    missingMiddle.splice(1, 1);
    expectInvalid(history(false, missingMiddle));
  });

  it("rejects non-success outcomes and inexact actor, ref, and list projections", () => {
    const failed = exchanges(3);
    failed[1] = {
      ...exchangeAt(failed, 1),
      result: {
        schemaVersion: 1,
        requestId: REQUEST_IDS[1],
        kind: "github.base_ref.get",
        outcome: "failed",
        httpStatus: 403,
        projection: null,
        errorCode: "GITHUB_PERMISSION_DENIED",
      },
    };
    redigestResult(exchangeAt(failed, 1));
    expectInvalid(history(false, failed));

    const wrongActor = exchanges(3);
    (exchangeAt(wrongActor, 0).result as { projection: { login: string } }).projection.login =
      "someone-else";
    redigestResult(exchangeAt(wrongActor, 0));
    expectInvalid(history(false, wrongActor));

    const wrongBase = exchanges(3);
    (exchangeAt(wrongBase, 1).result as { projection: { sha1: string } }).projection.sha1 =
      "e".repeat(40);
    redigestResult(exchangeAt(wrongBase, 1));
    expectInvalid(history(false, wrongBase));

    expectInvalid(history(false, exchanges(3, "exact")));
    expectInvalid(history(true, exchanges(4, "absent")));

    const incompleteList = exchanges(4, "exact");
    (
      exchangeAt(incompleteList, 3).result as { projection: { complete: boolean } }
    ).projection.complete = false;
    redigestResult(exchangeAt(incompleteList, 3));
    expectInvalid(history(true, incompleteList));

    const wrongCount = exchanges(4, "exact");
    (exchangeAt(wrongCount, 3).result as { projection: { count: number } }).projection.count = 1;
    redigestResult(exchangeAt(wrongCount, 3));
    expectInvalid(history(true, wrongCount));
  });

  it("rejects extra rows and treats a missing trailing row only as the next request", () => {
    const missingTrailing = validateGitHubPreflightHttpHistoryV1(
      history(true, exchanges(3, "exact")),
    );
    expect(missingTrailing.status).toBe("next_request");
    if (missingTrailing.status !== "next_request") throw new Error("expected next request");
    expect(missingTrailing.nextRequest.kind).toBe("github.pull_requests.get");

    const extra = exchanges(4, "exact");
    extra.push(structuredClone(exchangeAt(extra, 3)));
    expectInvalid(history(true, extra));

    expectInvalid(history(false, exchanges(4, "exact")));

    const exactOrdinalCeiling = history(false, []);
    exactOrdinalCeiling.previousRequestOrdinal = 33;
    const atCeiling = validateGitHubPreflightHttpHistoryV1(exactOrdinalCeiling);
    expect(atCeiling.status).toBe("next_request");
    if (atCeiling.status !== "next_request") throw new Error("expected next request");
    expect(atCeiling.nextRequest.requestOrdinal).toBe(34);

    const exhaustedOrdinals = history(false, []);
    exhaustedOrdinals.previousRequestOrdinal = 34;
    expectInvalid(exhaustedOrdinals);
  });

  it("rejects symbol and non-enumerable own members at the component boundary", () => {
    const symbolMember = history(false, []);
    Object.defineProperty(symbolMember, Symbol("hidden"), { value: true, enumerable: true });
    expectInvalid(symbolMember);

    const nonEnumerableMember = history(false, []);
    Object.defineProperty(nonEnumerableMember, "hidden", { value: true, enumerable: false });
    expectInvalid(nonEnumerableMember);
  });
});
