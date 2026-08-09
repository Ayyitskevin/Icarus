import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import {
  type GitHubObjectsHistoryExchangeV1,
  validateGitHubObjectsUploadHttpHistoryV1,
} from "../../packages/core/src/landing-objects-history.js";
import {
  buildUnsignedCommitPayloadV1,
  canonicalGitHubPostBodyV1,
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  decodeCandidateObjectManifestV1,
  digestLandingRecord,
  type GitHubLandingProfileV1,
  gitObjectSha1,
  type LandingDigestV1,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
  type LandingOperationRequestV1,
  type LandingOperationResultV1,
} from "../../packages/core/src/landing-records.js";

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
  "70000000-0000-4000-8000-000000000005",
  "70000000-0000-4000-8000-000000000006",
] as const;
const BASE_COMMIT = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const CANDIDATE_TREE = "c".repeat(40);
const COMMIT_EPOCH_SECONDS = 1_700_000_000;
const COMMIT_INSTANT = commitEpochToGitInstant(COMMIT_EPOCH_SECONDS);
const COMMIT_MESSAGE = "Upload the reviewed object graph\n";
const TITLE = "Upload reviewed objects";
const BODY_PREFIX = "Durable evidence accompanies this change.";
const PATHS = ["assets/binary.bin", "assets/empty.txt", "docs/old.md", "src/main.ts"];
const BINARY = new Uint8Array([0, 1, 2, 255]);
const EMPTY = new Uint8Array();
const MODIFIED = Buffer.from("export const ready = true;\n", "utf8");

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
      path: PATHS[0],
      op: "create",
      mode: "100644",
      blobSha1: gitObjectSha1("blob", BINARY),
      contentBytes: BINARY.byteLength,
      contentSha256: sha256(BINARY),
    },
    {
      path: PATHS[1],
      op: "create",
      mode: "100644",
      blobSha1: gitObjectSha1("blob", EMPTY),
      contentBytes: 0,
      contentSha256: sha256(EMPTY),
    },
    {
      path: PATHS[2],
      op: "delete",
      mode: "100644",
      blobSha1: null,
      contentBytes: null,
      contentSha256: null,
    },
    {
      path: PATHS[3],
      op: "modify",
      mode: "100644",
      blobSha1: gitObjectSha1("blob", MODIFIED),
      contentBytes: MODIFIED.byteLength,
      contentSha256: sha256(MODIFIED),
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
  changedPaths: PATHS,
  changedPathsSha256: digestLandingRecord({ schemaVersion: 1, paths: PATHS }),
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
  changedBlobs: [
    { path: PATHS[0], content: BINARY },
    { path: PATHS[1], content: EMPTY },
    { path: PATHS[3], content: MODIFIED },
  ],
};

function preflightOperation(): LandingOperationRequestV1 {
  return {
    schemaVersion: 1,
    operationId: PREFLIGHT_ID,
    landingId: LANDING_ID,
    coordinatorAttempt: 2,
    kindAttempt: 1,
    kind: "github.preflight",
    expectedState: "local_ready",
    expectedVersion: 4,
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

function preflightResult(): LandingOperationResultV1 {
  return {
    schemaVersion: 1,
    operationId: PREFLIGHT_ID,
    kind: "github.preflight",
    outcome: "completed",
    boundary: "preflight_exact",
    evidence: [
      { requestId: "80000000-0000-4000-8000-000000000001", resultSha256: sha256("actor") },
      { requestId: "80000000-0000-4000-8000-000000000002", resultSha256: sha256("base") },
      { requestId: "80000000-0000-4000-8000-000000000003", resultSha256: sha256("head") },
    ],
    value: {
      actor: PROFILE.expectedActor,
      baseSha1: BASE_COMMIT,
      headState: "absent",
      pullRequestCount: null,
    },
    errorCode: null,
  };
}

function operation(
  resultSha256 = digestLandingRecord(preflightResult()),
): LandingOperationRequestV1 {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    landingId: LANDING_ID,
    coordinatorAttempt: 2,
    kindAttempt: 1,
    kind: "github.objects.upload",
    expectedState: "local_ready",
    expectedVersion: 4,
    input: {
      landingSha256: digestLandingRecord(LANDING),
      candidateObjectManifestSha256: LANDING.candidateObjectManifestSha256,
      changedPathsSha256: LANDING.changedPathsSha256,
      preflightOperationId: PREFLIGHT_ID,
      preflightResultSha256: resultSha256,
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    },
  };
}

function history(exchanges: readonly GitHubObjectsHistoryExchangeV1[]): Record<string, unknown> {
  const preflight = preflightOperation();
  const completedPreflight = preflightResult();
  const objects = operation(digestLandingRecord(completedPreflight));
  return {
    material: MATERIAL,
    landingSha256: digestLandingRecord(LANDING),
    preflightOperation: preflight,
    preflightOperationRequestSha256: digestLandingRecord(preflight),
    preflightResult: completedPreflight,
    preflightResultSha256: digestLandingRecord(completedPreflight),
    operation: objects,
    operationRequestSha256: digestLandingRecord(objects),
    previousRequestOrdinal: 3,
    exchanges,
  };
}

function resultFor(request: LandingHttpRequestV1): LandingHttpResultV1 {
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
      throw new Error("unexpected object-history request kind");
  }
}

function completeExchanges(): GitHubObjectsHistoryExchangeV1[] {
  const exchanges: GitHubObjectsHistoryExchangeV1[] = [];
  for (let index = 0; index < REQUEST_IDS.length; index += 1) {
    const projected = validateGitHubObjectsUploadHttpHistoryV1(history(exchanges));
    if (projected.status !== "next_request") throw new Error("expected next request");
    const request = {
      ...projected.nextRequest,
      requestId: REQUEST_IDS[index],
    } as LandingHttpRequestV1;
    const result = resultFor(request);
    exchanges.push({
      request,
      requestSha256: digestLandingRecord(request),
      result,
      resultSha256: digestLandingRecord(result),
    });
  }
  return exchanges;
}

function exchangeAt(
  exchanges: readonly GitHubObjectsHistoryExchangeV1[],
  index: number,
): GitHubObjectsHistoryExchangeV1 {
  const exchange = exchanges[index];
  if (exchange === undefined) throw new Error("missing fixture exchange");
  return exchange;
}

function redigestRequest(exchange: GitHubObjectsHistoryExchangeV1): void {
  (exchange as { requestSha256: unknown }).requestSha256 = digestLandingRecord(exchange.request);
}

function redigestResult(exchange: GitHubObjectsHistoryExchangeV1): void {
  (exchange as { resultSha256: unknown }).resultSha256 = digestLandingRecord(exchange.result);
}

function expectInvalid(value: unknown): void {
  try {
    validateGitHubObjectsUploadHttpHistoryV1(value);
    throw new Error("expected object history validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe("LANDING_RECORD_INVALID");
  }
}

describe("ADR 0027 GitHub object-upload HTTP history", () => {
  it("projects every successful prefix in canonical create/delete/modify order", () => {
    const complete = completeExchanges();
    expect(complete.map((entry) => (entry.request as LandingHttpRequestV1).kind)).toEqual([
      "github.actor.get",
      "github.blob.post",
      "github.blob.post",
      "github.blob.post",
      "github.tree.post",
      "github.commit.post",
    ]);
    for (let length = 0; length < complete.length; length += 1) {
      const projected = validateGitHubObjectsUploadHttpHistoryV1(
        history(complete.slice(0, length)),
      );
      expect(projected.status).toBe("next_request");
      if (projected.status !== "next_request") throw new Error("expected next request");
      expect(projected.nextRequest.requestOrdinal).toBe(4 + length);
      expect(projected.nextRequest.operationKind).toBe("github.objects.upload");
      expect(projected.nextRequest.profileSha256).toBe(LANDING.profileSha256);
    }
    const emptyBlob = validateGitHubObjectsUploadHttpHistoryV1(history(complete.slice(0, 2)));
    if (emptyBlob.status !== "next_request") throw new Error("expected empty blob request");
    expect(emptyBlob.nextRequest.bodySha256).toBe(
      canonicalGitHubPostBodyV1("github.blob.post", {
        content: "",
        encoding: "base64",
      }).sha256,
    );
  });

  it("derives the exact actor observation and completed object result", () => {
    const complete = completeExchanges();
    const projected = validateGitHubObjectsUploadHttpHistoryV1(history(complete));
    expect(projected.status).toBe("complete");
    if (projected.status !== "complete") throw new Error("expected complete history");
    expect(projected.facts).toEqual([
      {
        fact: "actor",
        requestId: REQUEST_IDS[0],
        resultSha256: complete[0]?.resultSha256,
      },
    ]);
    expect(projected.observation.facts).toEqual(projected.facts);
    expect(projected.value).toEqual({
      candidateObjectManifestSha256: LANDING.candidateObjectManifestSha256,
      remoteObjectOutcome: "created_or_exact",
    });
    expect(projected.operationResult.evidence).toEqual(
      complete.map((entry) => ({
        requestId: (entry.request as LandingHttpRequestV1).requestId,
        resultSha256: entry.resultSha256,
      })),
    );
    expect(projected.observationSha256).toBe(digestLandingRecord(projected.observation));
    expect(projected.operationResultSha256).toBe(digestLandingRecord(projected.operationResult));
  });

  it("rejects request order, body, subject, identity, ordinal, and projection drift", () => {
    const mutations: Array<(exchanges: GitHubObjectsHistoryExchangeV1[]) => void> = [
      (exchanges) => {
        [exchanges[1], exchanges[2]] = [
          exchanges[2] as GitHubObjectsHistoryExchangeV1,
          exchanges[1] as GitHubObjectsHistoryExchangeV1,
        ];
      },
      (exchanges) => {
        const exchange = exchangeAt(exchanges, 1);
        (exchange.request as { bodySha256: string }).bodySha256 = sha256("different body");
        redigestRequest(exchange);
      },
      (exchanges) => {
        const exchange = exchangeAt(exchanges, 1);
        (exchange.request as { subject: { contentBytes: number } }).subject.contentBytes += 1;
        redigestRequest(exchange);
      },
      (exchanges) => {
        const exchange = exchangeAt(exchanges, 1);
        (exchange.request as { requestId: string }).requestId = REQUEST_IDS[0];
        (exchange.result as { requestId: string }).requestId = REQUEST_IDS[0];
        redigestRequest(exchange);
        redigestResult(exchange);
      },
      (exchanges) => {
        const exchange = exchangeAt(exchanges, 1);
        (exchange.request as { requestOrdinal: number }).requestOrdinal += 1;
        redigestRequest(exchange);
      },
      (exchanges) => {
        const exchange = exchangeAt(exchanges, 1);
        (exchange.result as { projection: { sha1: string } }).projection.sha1 = "f".repeat(40);
        redigestResult(exchange);
      },
      (exchanges) => {
        const exchange = exchangeAt(exchanges, 0);
        (exchange.result as { httpStatus: number }).httpStatus = 201;
        redigestResult(exchange);
      },
      (exchanges) => {
        const exchange = exchangeAt(exchanges, 0);
        (exchange.result as { httpStatus: number }).httpStatus = 202;
        redigestResult(exchange);
      },
      (exchanges) => {
        const exchange = exchangeAt(exchanges, 1);
        (exchange.result as { httpStatus: number }).httpStatus = 200;
        redigestResult(exchange);
      },
      (exchanges) => {
        const exchange = exchangeAt(exchanges, 1);
        (exchange.result as { httpStatus: number }).httpStatus = 202;
        redigestResult(exchange);
      },
    ];
    for (const mutate of mutations) {
      const exchanges = structuredClone(completeExchanges());
      mutate(exchanges);
      expectInvalid(history(exchanges));
    }
  });

  it("rejects failure, ambiguity, preflight drift, and immutable material drift", () => {
    const failed = structuredClone(completeExchanges().slice(0, 2));
    const failedTail = exchangeAt(failed, 1);
    (failedTail as { result: unknown }).result = {
      schemaVersion: 1,
      requestId: (failedTail.request as LandingHttpRequestV1).requestId,
      kind: "github.blob.post",
      outcome: "ambiguous",
      httpStatus: null,
      projection: null,
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    };
    redigestResult(failedTail);
    expectInvalid(history(failed));

    const crossAttempt = history([]);
    (crossAttempt.preflightOperation as { coordinatorAttempt: number }).coordinatorAttempt = 3;
    crossAttempt.preflightOperationRequestSha256 = digestLandingRecord(
      crossAttempt.preflightOperation,
    );
    expectInvalid(crossAttempt);

    const changedPreflight = history([]);
    (changedPreflight.preflightResult as { value: { headState: string } }).value.headState =
      "exact";
    changedPreflight.preflightResultSha256 = digestLandingRecord(changedPreflight.preflightResult);
    const changedOperation = operation(changedPreflight.preflightResultSha256 as string);
    changedPreflight.operation = changedOperation;
    changedPreflight.operationRequestSha256 = digestLandingRecord(changedOperation);
    expectInvalid(changedPreflight);

    const changedMaterial = history([]);
    const material = structuredClone(changedMaterial.material) as {
      changedBlobs: Array<{ path: string; content: Uint8Array }>;
    };
    material.changedBlobs[0] = { path: PATHS[0] as string, content: new Uint8Array([9]) };
    changedMaterial.material = material;
    expectInvalid(changedMaterial);
  });

  it("fails closed on sparse, over-bound, and noncanonical aggregate containers", () => {
    const sparse = history([]);
    const sparseExchanges = new Array(1);
    sparse.exchanges = sparseExchanges;
    expectInvalid(sparse);

    const overBound = history([]);
    overBound.exchanges = Array.from({ length: 7 }, () => ({}));
    expectInvalid(overBound);

    const extra = history([]);
    (extra as Record<string, unknown>).unexpected = true;
    expectInvalid(extra);

    const unboundedPreflight = history([]);
    (unboundedPreflight.preflightResult as { evidence: unknown[] }).evidence = Array.from(
      { length: 10_000 },
      () => ({ requestId: REQUEST_IDS[0], resultSha256: sha256("unbounded") }),
    );
    expectInvalid(unboundedPreflight);

    const fourFactPreflight = history([]);
    const fourFactResult = fourFactPreflight.preflightResult as LandingOperationResultV1 & {
      evidence: Array<{ requestId: string | null; resultSha256: string }>;
    };
    fourFactResult.evidence.push({
      requestId: "80000000-0000-4000-8000-000000000004",
      resultSha256: sha256("not-requested"),
    });
    fourFactPreflight.preflightResultSha256 = digestLandingRecord(fourFactResult);
    const reboundOperation = operation(fourFactPreflight.preflightResultSha256 as string);
    fourFactPreflight.operation = reboundOperation;
    fourFactPreflight.operationRequestSha256 = digestLandingRecord(reboundOperation);
    expectInvalid(fourFactPreflight);

    const wrongKind = completeExchanges().slice(0, 1);
    const nestedObjects: unknown[] = new Array(10_000);
    Object.defineProperty(nestedObjects, "0", {
      enumerable: true,
      get() {
        throw new Error("nested provider objects must not be decoded");
      },
    });
    const wrongKindResult = {
      schemaVersion: 1,
      requestId: REQUEST_IDS[0],
      kind: "github.pull_requests.get",
      outcome: "succeeded",
      httpStatus: 200,
      projection: {
        type: "pull_request_list",
        complete: false,
        count: 10_000,
        objects: nestedObjects,
      },
      errorCode: null,
    };
    (wrongKind[0] as { result: unknown; resultSha256: unknown }).result = wrongKindResult;
    (wrongKind[0] as { resultSha256: unknown }).resultSha256 = digestLandingRecord({
      ...wrongKindResult,
      projection: { ...wrongKindResult.projection, objects: [] },
    });
    expectInvalid(history(wrongKind));
  });
});
