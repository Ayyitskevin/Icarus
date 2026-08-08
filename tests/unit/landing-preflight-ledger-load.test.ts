import { rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import type { LandingStatusV1 } from "../../packages/core/src/landing-ledger.js";
import {
  canonicalLandingJson,
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  decodeLandingDigestV1,
  digestLandingRecord,
  GITHUB_API_VERSION,
  type GitHubLandingProfileV1,
  type LandingGitHubRequestAdmittedEventV1,
  type LandingGitHubRequestSettledEventV1,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
  type LandingOperationObservationV1,
  type LandingOperationRequestV1,
  type LandingOperationResultV1,
  type LandingOperationSettledEventV1,
  type LandingOperationStartedEventV1,
  type LocalRefFactV1,
  renderPullRequestBodyV1,
} from "../../packages/core/src/landing-records.js";
import { planApprovalDigest, treeCheckpointDigest } from "../../packages/core/src/policy.js";
import type {
  CheckpointFile,
  PatchSet,
  VerificationEvidence,
} from "../../packages/core/src/types.js";
import {
  createUnitStore,
  seedUnitProject,
  UNIT_BASE_COMMIT,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
  unitContextDigest,
  unitContextManifest,
} from "../support/unit-fixtures.js";

type Row = Record<string, unknown>;

interface TestDatabase {
  prepare(sql: string): {
    run(...parameters: unknown[]): { readonly changes: number };
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
  };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const cleanupRoots: string[] = [];
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const BASE_TREE_SHA1 = "1".repeat(40);
const CANDIDATE_TREE_SHA1 = "2".repeat(40);
const CANDIDATE_COMMIT_SHA1 = "3".repeat(40);
const CANDIDATE_PAYLOAD_SHA256 = "4".repeat(64);
const CANDIDATE_MANIFEST_SHA256 = "5".repeat(64);
const CANDIDATE_AUDIT_SHA256 = "6".repeat(64);
const STARTED_AT = "2026-08-08T12:00:00.000Z";
const FINISHED_AT = "2026-08-08T12:01:00.000Z";
const COMMIT_MESSAGE = "Apply the reviewed greeting change\n";
const PULL_REQUEST_TITLE = "Apply the reviewed greeting change";
const PULL_REQUEST_BODY_PREFIX = "This draft was prepared from an approved Icarus run.";

const PROFILE: GitHubLandingProfileV1 = {
  version: 1,
  provider: "github",
  owner: "icarus-test",
  repository: "landing-ledger",
  baseBranch: "main",
  branchNamespace: "icarus/",
  credentialRef: { kind: "environment", name: "ICARUS_GITHUB_TOKEN_UNIT" },
  expectedActor: "unit-actor",
  commitIdentity: { name: "Icarus Unit", email: "icarus@example.test" },
  derivativeEffects: {
    version: 1,
    disposition: "inert-repository",
    evidenceSha256: "7".repeat(64),
  },
};

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function expectRecordInvalid(action: () => unknown): void {
  try {
    action();
    throw new Error("Expected LANDING_RECORD_INVALID");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe("LANDING_RECORD_INVALID");
  }
}

function seedEligibleRun(): ReturnType<typeof createUnitStore> {
  const fixture = createUnitStore();
  cleanupRoots.push(fixture.root);
  const { projectId } = seedUnitProject(fixture.store);
  fixture.store.createRun({
    id: UNIT_RUN_ID,
    projectId,
    task: "Update the greeting",
    targets: UNIT_PLAN.targets,
    provider: UNIT_PROVIDER,
  });
  fixture.store.pinRunBase(UNIT_RUN_ID, UNIT_BASE_COMMIT);
  const context = unitContextManifest();
  fixture.store.completePreparation(
    UNIT_RUN_ID,
    context,
    "/tmp/unit-context.json",
    unitContextDigest(context),
  );
  const project = fixture.store.getProject(projectId);
  const planSha256 = planApprovalDigest({
    task: "Update the greeting",
    baseCommit: UNIT_BASE_COMMIT,
    contextSha256: unitContextDigest(context),
    targets: context.targets,
    provider: UNIT_PROVIDER,
    checks: project.checks,
    sandbox: project.sandbox,
    ceiling: project.ceiling,
    plan: UNIT_PLAN,
    readableManifest: null,
  });
  fixture.store.recordPlanAndAwaitApproval(UNIT_RUN_ID, UNIT_PLAN, planSha256);
  fixture.store.approvePlan(UNIT_RUN_ID, planSha256, "unit-operator");
  fixture.store.recordWorkspace(UNIT_RUN_ID, "/tmp/unit-cache.git", "/tmp/unit-worktree", null);
  const checkpointFiles: readonly CheckpointFile[] = [
    {
      path: UNIT_PLAN.target,
      op: "modify",
      baselineBase64: Buffer.from("hello\n").toString("base64"),
      approvedBase64: Buffer.from("goodbye\n").toString("base64"),
    },
  ];
  const patchSet: PatchSet = {
    summary: "Update the fixture greeting.",
    edits: [
      {
        op: "modify",
        path: UNIT_PLAN.target,
        expectedPreimageSha256: sha256("hello\n"),
        replacements: [{ findText: "hello", replaceText: "goodbye" }],
        rationale: "Exercise durable GitHub preflight loading.",
      },
    ],
  };
  fixture.store.recordPatchSetIntent(UNIT_RUN_ID, patchSet, checkpointFiles);
  const checkpointSha256 = treeCheckpointDigest({
    runId: UNIT_RUN_ID,
    baseCommit: UNIT_BASE_COMMIT,
    files: checkpointFiles,
  });
  fixture.store.saveTreeCheckpoint(UNIT_RUN_ID, checkpointSha256);
  fixture.store.transition(UNIT_RUN_ID, "verifying", "execution.completed");
  const diff =
    "diff --git a/src/greeting.txt b/src/greeting.txt\n" +
    "--- a/src/greeting.txt\n+++ b/src/greeting.txt\n@@ -1 +1 @@\n-hello\n+goodbye\n";
  const verification: VerificationEvidence = {
    outcome: "passed",
    checks: [
      {
        checkId: "unit",
        argv: ["node", "--test"],
        exitCode: 0,
        signal: null,
        durationMs: 10,
        stdout: "ok\n",
        stderr: "",
        truncated: false,
        outcome: "passed",
      },
    ],
    changedPaths: [UNIT_PLAN.target],
    diffSha256: sha256(diff),
    checkpointSha256,
  };
  fixture.store.recordVerificationAndAwaitReview(UNIT_RUN_ID, diff, verification);

  const database = new Database(fixture.databasePath);
  database
    .prepare(
      "INSERT INTO approvals (id, run_id, kind, digest, actor, decision, created_at) " +
        "VALUES (?, ?, 'review', ?, 'unit-reviewer', 'approve', ?)",
    )
    .run(REVIEW_ID, UNIT_RUN_ID, verification.diffSha256, "2026-07-19T12:00:00.000Z");
  database
    .prepare("UPDATE runs SET state = 'completed', version = version + 1 WHERE id = ?")
    .run(UNIT_RUN_ID);
  database.close();
  fixture.store.setLandingProfile(projectId, PROFILE, new Set([PROFILE.credentialRef.name]));
  return fixture;
}

function candidateAuthority(status: LandingStatusV1) {
  const landing = status.landing;
  return decodeLandingDigestV1({
    schemaVersion: 1,
    policyVersion: 1,
    githubApiVersion: GITHUB_API_VERSION,
    landingId: landing.id,
    runId: landing.runId,
    projectId: landing.projectId,
    baseCommitSha1: landing.baseCommitSha1,
    baseTreeSha1: landing.baseTreeSha1,
    planSha256: landing.planSha256,
    diffSha256: landing.diffSha256,
    checkpointSha256: landing.checkpointSha256,
    verificationSha256: landing.verificationSha256,
    reviewDecisionId: landing.reviewDecisionId,
    reviewDecisionSha256: landing.reviewDecisionSha256,
    changedPaths: landing.changedPaths,
    changedPathsSha256: landing.changedPathsSha256,
    candidateCredentialAuditSha256: CANDIDATE_AUDIT_SHA256,
    profileVersion: 1,
    profileSha256: landing.profileSha256,
    profile: landing.profile,
    objectFormat: "sha1",
    candidateParentSha1: landing.baseCommitSha1,
    candidateTreeSha1: CANDIDATE_TREE_SHA1,
    candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
    candidateCommitPayloadSha256: CANDIDATE_PAYLOAD_SHA256,
    candidateObjectManifestSha256: CANDIDATE_MANIFEST_SHA256,
    commitMessageSha256: landing.commitMessageSha256,
    commitAuthor: landing.profile.commitIdentity,
    commitCommitter: landing.profile.commitIdentity,
    commitEpochSeconds: landing.commitEpochSeconds,
    commitIso8601: landing.commitIso8601,
    baseRef: `refs/heads/${landing.profile.baseBranch}`,
    expectedRemoteBaseSha1: landing.baseCommitSha1,
    headRef: landing.headRef,
    pullRequestTitleSha256: landing.pullRequestTitleSha256,
    pullRequestBodyPrefixSha256: landing.pullRequestBodyPrefixSha256,
    pullRequestMarkerVersion: 1,
    draft: true,
    maintainerCanModify: false,
    directIcarusEffects: DIRECT_ICARUS_EFFECTS,
    derivativeEffectDisclosure: {
      version: 1,
      githubEvents: DERIVATIVE_GITHUB_EVENTS,
      mayTrigger: DERIVATIVE_EFFECTS,
      disposition: landing.profile.derivativeEffects.disposition,
      evidenceSha256: landing.profile.derivativeEffects.evidenceSha256,
    },
  });
}

function createLocalReadyFixture(): ReturnType<typeof createUnitStore> & {
  readonly landingId: string;
} {
  const fixture = seedEligibleRun();
  const created = fixture.store.createLanding(
    {
      runId: UNIT_RUN_ID,
      baseTreeSha1: BASE_TREE_SHA1,
      commitMessage: COMMIT_MESSAGE,
      commitEpochSeconds: 0,
      commitIso8601: commitEpochToGitInstant(0),
      pullRequestTitle: PULL_REQUEST_TITLE,
      pullRequestBodyPrefix: PULL_REQUEST_BODY_PREFIX,
    },
    new Set([PROFILE.credentialRef.name]),
  );
  fixture.store.startCandidatePreparation(created.landing.id);
  const authority = candidateAuthority(created);
  const landingSha256 = digestLandingRecord(authority);
  const pullRequestBody = renderPullRequestBodyV1({
    landing: authority,
    landingSha256,
    bodyPrefix: created.landing.pullRequestBodyPrefix,
  });
  const candidate = fixture.store.settleLandingCandidate(created.landing.id, {
    candidateTreeSha1: CANDIDATE_TREE_SHA1,
    candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
    candidateCommitPayloadSha256: CANDIDATE_PAYLOAD_SHA256,
    candidateObjectManifestSha256: CANDIDATE_MANIFEST_SHA256,
    candidateCredentialAuditSha256: CANDIDATE_AUDIT_SHA256,
    landingDigest: authority,
    pullRequestBodySha256: sha256(pullRequestBody),
  });
  fixture.store.recordLandingDecision(
    candidate.landing.id,
    candidate.landing.landingSha256 ?? "",
    "unit-operator",
    "approve",
  );
  fixture.store.admitLandingResume(candidate.landing.id);
  const local = fixture.store.startLocalRefCreation(candidate.landing.id);
  const absent: LocalRefFactV1 = {
    schemaVersion: 1,
    state: "absent",
    objectSha1: null,
    symbolicTargetSha256: null,
  };
  fixture.store.recordLocalRefObservation(candidate.landing.id, local.operationId, absent);
  fixture.store.settleLocalRefCreation(candidate.landing.id, {
    outcome: "succeeded",
    errorCode: null,
    observedFact: absent,
    postEffectFact: {
      schemaVersion: 1,
      state: "direct",
      objectSha1: CANDIDATE_COMMIT_SHA1,
      symbolicTargetSha256: null,
    },
  });
  expect(fixture.store.getLandingStatus(candidate.landing.id).landing.state).toBe("local_ready");
  return { ...fixture, landingId: candidate.landing.id };
}

type Tail = "admitted" | "failed" | "ambiguous";

interface InjectedPreflight {
  readonly operationId: string;
  readonly requestIds: readonly string[];
  readonly attempt: number;
}

function uuidFor(attempt: number, suffix: number): string {
  return `f${attempt.toString(16).padStart(7, "0")}-0000-4000-8000-${suffix
    .toString(16)
    .padStart(12, "0")}`;
}

function appendEvent(
  database: TestDatabase,
  landingId: string,
  type: string,
  payload: unknown,
): void {
  const prior = database
    .prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM landing_events WHERE landing_id = ?",
    )
    .get(landingId) as { readonly sequence: number };
  database
    .prepare(
      "INSERT INTO landing_events (landing_id, sequence, type, payload_json, created_at) " +
        "VALUES (?, ?, ?, ?, ?)",
    )
    .run(landingId, prior.sequence + 1, type, canonicalLandingJson(payload), STARTED_AT);
}

function admitPreflightAttempt(fixture: ReturnType<typeof createLocalReadyFixture>): {
  readonly status: LandingStatusV1;
  readonly attempt: number;
} {
  let status = fixture.store.getLandingStatus(fixture.landingId);
  const alreadyActive = status.attempts.find((attempt) => attempt.status === "started");
  if (alreadyActive !== undefined) return { status, attempt: alreadyActive.ordinal };
  if (status.landing.state === "failed") {
    const admission = fixture.store.admitLandingResume(fixture.landingId);
    if (admission.attemptOrdinal === null) throw new Error("failed landing did not resume");
    return { status: admission.status, attempt: admission.attemptOrdinal };
  }
  if (status.landing.state !== "local_ready") {
    throw new Error("preflight fixture is not at the local-ready admission boundary");
  }
  const attempt = status.landing.attemptCount + 1;
  const database = new Database(fixture.databasePath);
  database
    .prepare("UPDATE landings SET attempt_count = ?, updated_at = ? WHERE id = ?")
    .run(attempt, STARTED_AT, fixture.landingId);
  database
    .prepare(
      "INSERT INTO landing_attempts " +
        "(landing_id, ordinal, status, started_at, finished_at, error_code) " +
        "VALUES (?, ?, 'started', ?, NULL, NULL)",
    )
    .run(fixture.landingId, attempt, STARTED_AT);
  appendEvent(database, fixture.landingId, "landing.attempt.started", {
    schemaVersion: 1,
    landingId: fixture.landingId,
    coordinatorAttempt: attempt,
  });
  database.close();
  status = fixture.store.getLandingStatus(fixture.landingId);
  return { status, attempt };
}

function requestFor(
  status: LandingStatusV1,
  operationId: string,
  attempt: number,
  index: number,
): LandingHttpRequestV1 {
  const requestId = uuidFor(attempt, index + 2);
  const common = {
    schemaVersion: 1 as const,
    requestId,
    landingId: status.landing.id,
    operationId,
    coordinatorAttempt: attempt,
    operationKind: "github.preflight" as const,
    requestOrdinal: index + 1,
    method: "GET" as const,
    profileSha256: status.landing.profileSha256,
    bodySha256: null,
  };
  if (index === 0) {
    return {
      ...common,
      kind: "github.actor.get",
      subject: { expectedActor: status.landing.profile.expectedActor },
    };
  }
  if (index === 1) {
    return {
      ...common,
      kind: "github.base_ref.get",
      subject: {
        owner: status.landing.profile.owner,
        repository: status.landing.profile.repository,
        baseRef: `refs/heads/${status.landing.profile.baseBranch}`,
        expectedSha1: status.landing.baseCommitSha1,
      },
    };
  }
  return {
    ...common,
    kind: "github.head_ref.get",
    subject: {
      owner: status.landing.profile.owner,
      repository: status.landing.profile.repository,
      headRef: status.landing.headRef,
      expectedSha1: status.landing.candidateCommitSha1 ?? "",
    },
  };
}

function successResult(
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
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    kind: "github.head_ref.get",
    outcome: "succeeded",
    httpStatus: 404,
    projection: { type: "ref", state: "absent", ref: status.landing.headRef, sha1: null },
    errorCode: null,
  };
}

function terminalResult(
  request: LandingHttpRequestV1,
  tail: "failed" | "ambiguous",
): LandingHttpResultV1 {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    kind: request.kind,
    outcome: tail,
    httpStatus: tail === "failed" ? 403 : null,
    projection: null,
    errorCode: tail === "failed" ? "GITHUB_PERMISSION_DENIED" : "GITHUB_OUTCOME_AMBIGUOUS",
  };
}

function injectPreflight(
  fixture: ReturnType<typeof createLocalReadyFixture>,
  successCount: number,
  tail?: Tail,
  operationErrorCode?: string,
): InjectedPreflight {
  const admitted = admitPreflightAttempt(fixture);
  const { status, attempt } = admitted;
  const operationId = uuidFor(attempt, 1);
  const authority = candidateAuthority(status);
  const operation: LandingOperationRequestV1 = {
    schemaVersion: 1,
    operationId,
    landingId: fixture.landingId,
    coordinatorAttempt: attempt,
    kindAttempt: status.operations.filter((entry) => entry.kind === "github.preflight").length + 1,
    kind: "github.preflight",
    expectedState: "local_ready",
    expectedVersion: status.landing.version,
    input: {
      landingSha256: digestLandingRecord(authority),
      profileSha256: status.landing.profileSha256,
      baseRef: authority.baseRef,
      expectedRemoteBaseSha1: authority.expectedRemoteBaseSha1,
      headRef: status.landing.headRef,
      candidateCommitSha1: status.landing.candidateCommitSha1 ?? "",
      includePullRequestAbsence: false,
    },
  };
  const operationJson = canonicalLandingJson(operation);
  const operationSha256 = sha256(operationJson);
  const database = new Database(fixture.databasePath);
  database
    .prepare(
      "INSERT INTO landing_operations " +
        "(id, landing_id, coordinator_attempt, kind, kind_attempt, status, request_sha256, " +
        "request_json, observation_sha256, observation_json, result_sha256, result_json, " +
        "error_code, started_at, finished_at) " +
        "VALUES (?, ?, ?, 'github.preflight', ?, 'started', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, NULL)",
    )
    .run(
      operationId,
      fixture.landingId,
      attempt,
      operation.kindAttempt,
      operationSha256,
      operationJson,
      STARTED_AT,
    );
  appendEvent(database, fixture.landingId, "landing.operation.started", {
    schemaVersion: 1,
    landingId: fixture.landingId,
    operationId,
    coordinatorAttempt: attempt,
    kind: "github.preflight",
    kindAttempt: operation.kindAttempt,
    requestSha256: operationSha256,
  } satisfies LandingOperationStartedEventV1);

  const settledResults: LandingHttpResultV1[] = [];
  const requestIds: string[] = [];
  const requestCount = successCount + (tail === undefined ? 0 : 1);
  for (let index = 0; index < requestCount; index += 1) {
    const request = requestFor(status, operationId, attempt, index);
    requestIds.push(request.requestId);
    const requestJson = canonicalLandingJson(request);
    const requestSha256 = sha256(requestJson);
    const isTail = index === successCount && tail !== undefined;
    const result =
      isTail && tail !== "admitted"
        ? terminalResult(request, tail)
        : successResult(status, request);
    const settled = !(isTail && tail === "admitted");
    const resultJson = settled ? canonicalLandingJson(result) : null;
    const resultSha256 = resultJson === null ? null : sha256(resultJson);
    database
      .prepare(
        "INSERT INTO landing_http_requests " +
          "(id, landing_id, operation_id, coordinator_attempt, operation_kind, request_ordinal, " +
          "kind, method, request_sha256, request_json, status, outcome, http_status, result_sha256, " +
          "result_json, error_code, admitted_at, settled_at) " +
          "VALUES (?, ?, ?, ?, 'github.preflight', ?, ?, 'GET', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        request.requestId,
        fixture.landingId,
        operationId,
        attempt,
        request.requestOrdinal,
        request.kind,
        requestSha256,
        requestJson,
        settled ? "settled" : "admitted",
        settled ? result.outcome : null,
        settled ? result.httpStatus : null,
        resultSha256,
        resultJson,
        settled ? result.errorCode : null,
        STARTED_AT,
        settled ? FINISHED_AT : null,
      );
    appendEvent(database, fixture.landingId, "landing.github.request.admitted", {
      schemaVersion: 1,
      landingId: fixture.landingId,
      operationId,
      requestId: request.requestId,
      coordinatorAttempt: attempt,
      operationKind: "github.preflight",
      requestOrdinal: request.requestOrdinal,
      kind: request.kind,
      requestSha256,
    } satisfies LandingGitHubRequestAdmittedEventV1);
    if (settled && resultSha256 !== null) {
      settledResults.push(result);
      appendEvent(database, fixture.landingId, "landing.github.request.settled", {
        schemaVersion: 1,
        landingId: fixture.landingId,
        operationId,
        requestId: request.requestId,
        coordinatorAttempt: attempt,
        operationKind: "github.preflight",
        requestOrdinal: request.requestOrdinal,
        kind: request.kind,
        outcome: result.outcome,
        resultSha256,
        errorCode: result.errorCode,
      } satisfies LandingGitHubRequestSettledEventV1);
    }
  }

  const complete = successCount === 3 && tail === undefined;
  const terminal = tail === "failed" || tail === "ambiguous";
  if (complete || terminal) {
    const finalHttpError = settledResults.at(-1)?.errorCode ?? null;
    const errorCode = operationErrorCode ?? finalHttpError;
    const observation: LandingOperationObservationV1 | null = complete
      ? {
          schemaVersion: 1,
          operationId,
          kind: "github.preflight",
          phase: "pre_effect",
          facts: settledResults.map((result, index) => ({
            fact: (["actor", "base_ref", "head_ref"] as const)[index] ?? "head_ref",
            requestId: result.requestId,
            resultSha256: digestLandingRecord(result),
          })),
        }
      : null;
    const outcome = complete ? "completed" : tail === "failed" ? "failed" : "interrupted";
    const operationResult: LandingOperationResultV1 = {
      schemaVersion: 1,
      operationId,
      kind: "github.preflight",
      outcome,
      boundary:
        outcome === "completed"
          ? "preflight_exact"
          : outcome === "failed"
            ? "operation_failed"
            : "operation_interrupted",
      evidence: settledResults.map((result) => ({
        requestId: result.requestId,
        resultSha256: digestLandingRecord(result),
      })),
      value: complete
        ? {
            actor: status.landing.profile.expectedActor,
            baseSha1: status.landing.baseCommitSha1,
            headState: "absent",
            pullRequestCount: null,
          }
        : null,
      errorCode,
    };
    const observationJson = observation === null ? null : canonicalLandingJson(observation);
    const resultJson = canonicalLandingJson(operationResult);
    const resultSha256 = sha256(resultJson);
    database
      .prepare(
        "UPDATE landing_operations SET status = ?, observation_sha256 = ?, observation_json = ?, " +
          "result_sha256 = ?, result_json = ?, error_code = ?, finished_at = ? WHERE id = ?",
      )
      .run(
        outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "interrupted",
        observationJson === null ? null : sha256(observationJson),
        observationJson,
        resultSha256,
        resultJson,
        errorCode,
        FINISHED_AT,
        operationId,
      );
    appendEvent(database, fixture.landingId, "landing.operation.settled", {
      schemaVersion: 1,
      landingId: fixture.landingId,
      operationId,
      coordinatorAttempt: attempt,
      kind: "github.preflight",
      outcome,
      resultSha256,
      errorCode,
    } satisfies LandingOperationSettledEventV1);
    if (terminal) {
      database
        .prepare(
          "UPDATE landing_attempts SET status = ?, finished_at = ?, error_code = ? " +
            "WHERE landing_id = ? AND ordinal = ?",
        )
        .run(
          outcome === "failed" ? "failed" : "interrupted",
          FINISHED_AT,
          errorCode,
          fixture.landingId,
          attempt,
        );
      appendEvent(database, fixture.landingId, "landing.attempt.settled", {
        schemaVersion: 1,
        landingId: fixture.landingId,
        coordinatorAttempt: attempt,
        outcome,
        errorCode,
      });
      if (outcome === "failed") {
        database
          .prepare(
            "UPDATE landings SET state = 'failed', resume_state = 'local_ready', error_code = ?, " +
              "version = version + 1, updated_at = ? WHERE id = ?",
          )
          .run(errorCode, FINISHED_AT, fixture.landingId);
        appendEvent(database, fixture.landingId, "landing.state.changed", {
          schemaVersion: 1,
          landingId: fixture.landingId,
          from: "local_ready",
          to: "failed",
          version: status.landing.version + 1,
          operationId,
        });
      }
    }
  }
  database.close();
  return { operationId, requestIds, attempt };
}

function openFixture(): ReturnType<typeof createLocalReadyFixture> {
  return createLocalReadyFixture();
}

describe("landing ledger persisted GitHub preflight loader", () => {
  it("loads the local-ready attempt-start crash boundary without inventing an operation", () => {
    const fixture = openFixture();
    admitPreflightAttempt(fixture);
    const reloaded = fixture.store.getLandingStatus(fixture.landingId);
    expect(reloaded.landing.state).toBe("local_ready");
    expect(reloaded.attempts.at(-1)?.status).toBe("started");
    expect(reloaded.operations.at(-1)?.kind).toBe("local_ref.create");
    fixture.store.close();
  });

  it.each([
    [0, undefined, 0],
    [1, undefined, 1],
    [2, "admitted", 3],
  ] as const)(
    "loads a started preflight with %i successful GETs and tail %s",
    (successCount, tail, requestCount) => {
      const fixture = openFixture();
      injectPreflight(fixture, successCount, tail);
      const reloaded = fixture.store.getLandingStatus(fixture.landingId);
      expect(reloaded.landing.state).toBe("local_ready");
      expect(reloaded.operations.at(-1)).toMatchObject({
        kind: "github.preflight",
        status: "started",
        result: null,
      });
      expect(
        reloaded.events.filter((event) => event.type.startsWith("landing.github.request.")),
      ).toHaveLength(tail === "admitted" ? requestCount * 2 - 1 : requestCount * 2);
      fixture.store.close();
    },
  );

  it("loads exact three-GET completion while retaining the active attempt boundary", () => {
    const fixture = openFixture();
    injectPreflight(fixture, 3);
    const reloaded = fixture.store.getLandingStatus(fixture.landingId);
    expect(reloaded.landing.state).toBe("local_ready");
    expect(reloaded.operations.at(-1)).toMatchObject({
      kind: "github.preflight",
      status: "completed",
      result: { outcome: "completed", boundary: "preflight_exact" },
    });
    expect(reloaded.attempts.at(-1)?.status).toBe("started");
    fixture.store.close();
  });

  it("loads a deterministic GET failure only with the exact state suffix", () => {
    const fixture = openFixture();
    injectPreflight(fixture, 1, "failed");
    const reloaded = fixture.store.getLandingStatus(fixture.landingId);
    expect(reloaded.landing).toMatchObject({
      state: "failed",
      resumeState: "local_ready",
      errorCode: "GITHUB_PERMISSION_DENIED",
    });
    expect(reloaded.attempts.at(-1)?.status).toBe("failed");
    expect(reloaded.events.slice(-3).map((event) => event.type)).toEqual([
      "landing.operation.settled",
      "landing.attempt.settled",
      "landing.state.changed",
    ]);
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        "DELETE FROM landing_events WHERE landing_id = ? AND sequence = " +
          "(SELECT MAX(sequence) FROM landing_events WHERE landing_id = ?)",
      )
      .run(fixture.landingId, fixture.landingId);
    database.close();
    expectRecordInvalid(() => fixture.store.getLandingStatus(fixture.landingId));
    fixture.store.close();
  });

  it("loads an ambiguous GET without manufacturing a landing transition", () => {
    const fixture = openFixture();
    const injected = injectPreflight(fixture, 1, "ambiguous");
    const reloaded = fixture.store.getLandingStatus(fixture.landingId);
    expect(reloaded.landing.state).toBe("local_ready");
    expect(reloaded.attempts.at(-1)?.status).toBe("interrupted");
    expect(
      reloaded.events.some(
        (event) =>
          event.type === "landing.state.changed" &&
          (event.payload as { readonly operationId?: string }).operationId === injected.operationId,
      ),
    ).toBe(false);
    fixture.store.close();
  });

  it("replays a failed historical preflight before a later successful retry", () => {
    const fixture = openFixture();
    injectPreflight(fixture, 0, "failed");
    expect(fixture.store.getLandingStatus(fixture.landingId).landing.state).toBe("failed");
    injectPreflight(fixture, 3);
    const reloaded = fixture.store.getLandingStatus(fixture.landingId);
    expect(reloaded.landing.state).toBe("local_ready");
    expect(
      reloaded.operations
        .filter((operation) => operation.kind === "github.preflight")
        .map((operation) => operation.status),
    ).toEqual(["failed", "completed"]);
    fixture.store.close();
  });

  it.each(["projection", "request", "event", "digest"] as const)(
    "rejects %s corruption in the persisted request evidence",
    (corruption) => {
      const fixture = openFixture();
      const injected = injectPreflight(fixture, 1);
      const database = new Database(fixture.databasePath);
      if (corruption === "projection") {
        const row = database
          .prepare("SELECT result_json FROM landing_http_requests WHERE id = ?")
          .get(injected.requestIds[0]) as { readonly result_json: string };
        const result = JSON.parse(row.result_json) as Row;
        (result.projection as Row).login = "wrong-actor";
        const resultJson = canonicalLandingJson(result);
        const resultSha256 = sha256(resultJson);
        database
          .prepare(
            "UPDATE landing_http_requests SET result_json = ?, result_sha256 = ? WHERE id = ?",
          )
          .run(resultJson, resultSha256, injected.requestIds[0]);
        const event = database
          .prepare(
            "SELECT sequence, payload_json FROM landing_events WHERE landing_id = ? " +
              "AND type = 'landing.github.request.settled' ORDER BY sequence DESC LIMIT 1",
          )
          .get(fixture.landingId) as { readonly sequence: number; readonly payload_json: string };
        const payload = JSON.parse(event.payload_json) as Row;
        payload.resultSha256 = resultSha256;
        database
          .prepare(
            "UPDATE landing_events SET payload_json = ? WHERE landing_id = ? AND sequence = ?",
          )
          .run(canonicalLandingJson(payload), fixture.landingId, event.sequence);
      } else if (corruption === "request") {
        const row = database
          .prepare("SELECT request_json FROM landing_http_requests WHERE id = ?")
          .get(injected.requestIds[0]) as { readonly request_json: string };
        const request = JSON.parse(row.request_json) as Row;
        (request.subject as Row).expectedActor = "wrong-actor";
        const requestJson = canonicalLandingJson(request);
        const requestSha256 = sha256(requestJson);
        database
          .prepare(
            "UPDATE landing_http_requests SET request_json = ?, request_sha256 = ? WHERE id = ?",
          )
          .run(requestJson, requestSha256, injected.requestIds[0]);
        const event = database
          .prepare(
            "SELECT sequence, payload_json FROM landing_events WHERE landing_id = ? " +
              "AND type = 'landing.github.request.admitted' ORDER BY sequence DESC LIMIT 1",
          )
          .get(fixture.landingId) as { readonly sequence: number; readonly payload_json: string };
        const payload = JSON.parse(event.payload_json) as Row;
        payload.requestSha256 = requestSha256;
        database
          .prepare(
            "UPDATE landing_events SET payload_json = ? WHERE landing_id = ? AND sequence = ?",
          )
          .run(canonicalLandingJson(payload), fixture.landingId, event.sequence);
      } else if (corruption === "event") {
        const event = database
          .prepare(
            "SELECT sequence, payload_json FROM landing_events WHERE landing_id = ? " +
              "AND type = 'landing.github.request.admitted' ORDER BY sequence DESC LIMIT 1",
          )
          .get(fixture.landingId) as { readonly sequence: number; readonly payload_json: string };
        const payload = JSON.parse(event.payload_json) as Row;
        payload.requestOrdinal = 2;
        database
          .prepare(
            "UPDATE landing_events SET payload_json = ? WHERE landing_id = ? AND sequence = ?",
          )
          .run(canonicalLandingJson(payload), fixture.landingId, event.sequence);
      } else {
        database
          .prepare("UPDATE landing_http_requests SET request_sha256 = ? WHERE id = ?")
          .run("e".repeat(64), injected.requestIds[0]);
      }
      database.close();
      expectRecordInvalid(() => fixture.store.getLandingStatus(fixture.landingId));
      fixture.store.close();
    },
  );

  it.each(
    [
      ["operation request", "landing_operations", "request_json"],
      ["operation result", "landing_operations", "result_json"],
      ["HTTP request", "landing_http_requests", "request_json"],
      ["HTTP result", "landing_http_requests", "result_json"],
      ["event", "landing_events", "payload_json"],
    ].flatMap(([label, table, column]) => [
      [label, table, column, "oversized TEXT"],
      [label, table, column, "BLOB"],
    ]) as ReadonlyArray<readonly [string, string, string, "oversized TEXT" | "BLOB"]>,
  )("rejects %s JSON corruption in %s.%s (%s)", (_label, table, column, storageClass) => {
    const fixture = openFixture();
    const injected = injectPreflight(fixture, 3);
    const database = new Database(fixture.databasePath);
    const value = storageClass === "oversized TEXT" ? "x".repeat(64 * 1024 + 1) : Buffer.from("{}");
    if (table === "landing_operations") {
      database
        .prepare(`UPDATE landing_operations SET ${column} = ? WHERE id = ?`)
        .run(value, injected.operationId);
    } else if (table === "landing_http_requests") {
      database
        .prepare(`UPDATE landing_http_requests SET ${column} = ? WHERE id = ?`)
        .run(value, injected.requestIds[0]);
    } else {
      const event = database
        .prepare(
          "SELECT sequence FROM landing_events WHERE landing_id = ? " +
            "AND type = 'landing.github.request.settled' ORDER BY sequence LIMIT 1",
        )
        .get(fixture.landingId) as { readonly sequence: number };
      database
        .prepare("UPDATE landing_events SET payload_json = ? WHERE landing_id = ? AND sequence = ?")
        .run(value, fixture.landingId, event.sequence);
    }
    database.close();
    expectRecordInvalid(() => fixture.store.getLandingStatus(fixture.landingId));
    fixture.store.close();
  });

  it("rejects more than three HTTP rows in one preflight", () => {
    const fixture = openFixture();
    const injected = injectPreflight(fixture, 2, "admitted");
    const database = new Database(fixture.databasePath);
    const source = database
      .prepare("SELECT * FROM landing_http_requests WHERE id = ?")
      .get(injected.requestIds[2]) as Row;
    database
      .prepare(
        "INSERT INTO landing_http_requests " +
          "(id, landing_id, operation_id, coordinator_attempt, operation_kind, request_ordinal, " +
          "kind, method, request_sha256, request_json, status, outcome, http_status, result_sha256, " +
          "result_json, error_code, admitted_at, settled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        uuidFor(injected.attempt, 9),
        source.landing_id,
        source.operation_id,
        source.coordinator_attempt,
        source.operation_kind,
        4,
        source.kind,
        source.method,
        source.request_sha256,
        source.request_json,
        source.status,
        source.outcome,
        source.http_status,
        source.result_sha256,
        source.result_json,
        source.error_code,
        source.admitted_at,
        source.settled_at,
      );
    database.close();
    expectRecordInvalid(() => fixture.store.getLandingStatus(fixture.landingId));
    fixture.store.close();
  });

  it("rejects the landing-wide bounded-query sentinel before partial validation", () => {
    const fixture = openFixture();
    const injected = injectPreflight(fixture, 0);
    const status = fixture.store.getLandingStatus(fixture.landingId);
    const database = new Database(fixture.databasePath);
    for (let ordinal = 1; ordinal <= 10; ordinal += 1) {
      const request = requestFor(status, injected.operationId, injected.attempt, (ordinal - 1) % 3);
      const requestId = uuidFor(injected.attempt, 20 + ordinal);
      const requestValue = { ...request, requestId, requestOrdinal: ordinal };
      const requestJson = canonicalLandingJson(requestValue);
      database
        .prepare(
          "INSERT INTO landing_http_requests " +
            "(id, landing_id, operation_id, coordinator_attempt, operation_kind, request_ordinal, " +
            "kind, method, request_sha256, request_json, status, outcome, http_status, result_sha256, " +
            "result_json, error_code, admitted_at, settled_at) " +
            "VALUES (?, ?, ?, ?, 'github.preflight', ?, ?, 'GET', ?, ?, 'admitted', NULL, NULL, NULL, NULL, NULL, ?, NULL)",
        )
        .run(
          requestId,
          fixture.landingId,
          injected.operationId,
          injected.attempt,
          ordinal,
          requestValue.kind,
          sha256(requestJson),
          requestJson,
          STARTED_AT,
        );
    }
    database.close();
    expectRecordInvalid(() => fixture.store.getLandingStatus(fixture.landingId));
    fixture.store.close();
  });

  it("rejects a ninth attempt row before decoding the bounded prefix", () => {
    const fixture = openFixture();
    const database = new Database(fixture.databasePath);
    database.prepare("PRAGMA ignore_check_constraints = ON").run();
    for (let ordinal = 3; ordinal <= 9; ordinal += 1) {
      database
        .prepare(
          "INSERT INTO landing_attempts " +
            "(landing_id, ordinal, status, started_at, finished_at, error_code) " +
            "VALUES (?, ?, 'interrupted', ?, ?, 'ROW_SENTINEL')",
        )
        .run(fixture.landingId, ordinal, STARTED_AT, FINISHED_AT);
    }
    database.close();
    expectRecordInvalid(() => fixture.store.getLandingStatus(fixture.landingId));
    fixture.store.close();
  });

  it("rejects more operation rows than admitted attempts before decoding them", () => {
    const fixture = openFixture();
    const injected = injectPreflight(fixture, 3);
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        "INSERT INTO landing_operations " +
          "(id, landing_id, coordinator_attempt, kind, kind_attempt, status, request_sha256, " +
          "request_json, observation_sha256, observation_json, result_sha256, result_json, " +
          "error_code, started_at, finished_at) " +
          "VALUES (?, ?, ?, 'github.preflight', 2, 'interrupted', ?, '{}', NULL, NULL, ?, '{}', " +
          "'ROW_SENTINEL', ?, ?)",
      )
      .run(
        uuidFor(injected.attempt, 99),
        fixture.landingId,
        injected.attempt,
        "a".repeat(64),
        "b".repeat(64),
        STARTED_AT,
        FINISHED_AT,
      );
    database.close();
    expectRecordInvalid(() => fixture.store.getLandingStatus(fixture.landingId));
    fixture.store.close();
  });

  it("rejects a 129th event row before decoding the bounded prefix", () => {
    const fixture = openFixture();
    const database = new Database(fixture.databasePath);
    const summary = database
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(MAX(sequence), 0) AS maximum " +
          "FROM landing_events WHERE landing_id = ?",
      )
      .get(fixture.landingId) as { readonly count: number; readonly maximum: number };
    for (let index = summary.count; index < 129; index += 1) {
      database
        .prepare(
          "INSERT INTO landing_events (landing_id, sequence, type, payload_json, created_at) " +
            "VALUES (?, ?, 'row.sentinel', '{}', ?)",
        )
        .run(fixture.landingId, summary.maximum + (index - summary.count) + 1, STARTED_AT);
    }
    database.close();
    expectRecordInvalid(() => fixture.store.getLandingStatus(fixture.landingId));
    fixture.store.close();
  });

  it("rejects a local-ready row after its durable stage proof is removed", () => {
    const fixture = openFixture();
    const database = new Database(fixture.databasePath);
    database
      .prepare("DELETE FROM landing_operations WHERE landing_id = ? AND kind = 'local_ref.create'")
      .run(fixture.landingId);
    database.close();
    expectRecordInvalid(() => fixture.store.getLandingStatus(fixture.landingId));
    fixture.store.close();
  });

  it("rejects takeover-specific operation error inference from an ordinary ambiguous GET", () => {
    const fixture = openFixture();
    injectPreflight(fixture, 0, "ambiguous", "LANDING_COORDINATOR_TAKEOVER");
    expectRecordInvalid(() => fixture.store.getLandingStatus(fixture.landingId));
    fixture.store.close();
  });
});
