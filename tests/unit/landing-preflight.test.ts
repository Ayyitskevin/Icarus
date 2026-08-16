import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, test, afterEach } from "vitest";

import { GithubGatewayError } from "../../packages/github-gateway/src/errors.js";
import { ArtifactStore } from "../../packages/core/src/artifacts.js";
import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import type { GitController } from "../../packages/core/src/git.js";
import type { LandingStatusV1 } from "../../packages/core/src/landing-ledger.js";
import {
  canonicalLandingJson,
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  decodeLandingDigestV1,
  deriveCandidateObjectManifestV1,
  digestLandingRecord,
  GITHUB_API_VERSION,
  type GitHubLandingProfileV1,
  gitObjectSha1,
  type LandingDigestV1,
  type LocalRefFactV1,
  renderPullRequestBodyV1,
} from "../../packages/core/src/landing-records.js";
import { planApprovalDigest, treeCheckpointDigest } from "../../packages/core/src/policy.js";
import type { CheckRunner } from "../../packages/core/src/sandbox.js";
import {
  IcarusService,
  type LandingGitService,
  type LandingGithubGateway,
} from "../../packages/core/src/service.js";
import type { IcarusStore } from "../../packages/core/src/store.js";
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

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const BASE_TREE_SHA1 = "1".repeat(40);
const CANDIDATE_TREE_SHA1 = "2".repeat(40);
const CANDIDATE_COMMIT_SHA1 = "3".repeat(40);
const CANDIDATE_PAYLOAD_SHA256 = "4".repeat(64);
const CANDIDATE_AUDIT_SHA256 = "6".repeat(64);
const COMMIT_EPOCH_SECONDS = 0;
const COMMIT_MESSAGE = "Apply the reviewed greeting change\n";
const PULL_REQUEST_TITLE = "Apply the reviewed greeting change";
const PULL_REQUEST_BODY_PREFIX = "This draft was prepared from an approved Icarus run.";
const CREDENTIAL_ENV = "ICARUS_GITHUB_TOKEN_PREFLIGHT";
const TOKEN_SENTINEL = "ghp_PREFLIGHT_SENTINEL_MUST_NOT_LEAK";
const LANDING_HEAD_REF = `refs/heads/icarus/${UNIT_RUN_ID}`;
const BASE_REF = "refs/heads/main";

const UNIT_CHECKPOINT_FILES: readonly CheckpointFile[] = [
  {
    path: UNIT_PLAN.target,
    op: "modify",
    baselineBase64: Buffer.from("hello\n").toString("base64"),
    approvedBase64: Buffer.from("goodbye\n").toString("base64"),
  },
];

// The manifest digest the store derives from durable evidence: no longer a
// fixture constant, since the upload admission re-derives and compares it.
const CANDIDATE_MANIFEST_SHA256 = digestLandingRecord(
  deriveCandidateObjectManifestV1({
    baseCommitSha1: UNIT_BASE_COMMIT,
    baseTreeSha1: BASE_TREE_SHA1,
    candidateTreeSha1: CANDIDATE_TREE_SHA1,
    candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
    candidateCommitPayloadSha256: CANDIDATE_PAYLOAD_SHA256,
    changedPaths: [UNIT_PLAN.target],
    checkpointFiles: UNIT_CHECKPOINT_FILES,
  }),
);

const PROFILE: GitHubLandingProfileV1 = {
  version: 1,
  provider: "github",
  owner: "icarus-test",
  repository: "landing-preflight",
  baseBranch: "main",
  branchNamespace: "icarus/",
  credentialRef: { kind: "environment", name: CREDENTIAL_ENV },
  expectedActor: "unit-actor",
  commitIdentity: { name: "Icarus Unit", email: "icarus@example.test" },
  derivativeEffects: {
    version: 1,
    disposition: "inert-repository",
    evidenceSha256: "7".repeat(64),
  },
};

const ABSENT_REF: LocalRefFactV1 = {
  schemaVersion: 1,
  state: "absent",
  objectSha1: null,
  symbolicTargetSha256: null,
};

const DIRECT_CANDIDATE_REF: LocalRefFactV1 = {
  schemaVersion: 1,
  state: "direct",
  objectSha1: CANDIDATE_COMMIT_SHA1,
  symbolicTargetSha256: null,
};

const cleanupRoots: string[] = [];

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function expectIcarusCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

async function expectAsyncIcarusCode(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    expect((error as IcarusError).code).toBe(code);
  }
}

function persistedFiles(root: string): readonly string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    return entry.isDirectory() ? persistedFiles(candidate) : [candidate];
  });
}

function expectNoPersistedToken(root: string): void {
  const sentinel = Buffer.from(TOKEN_SENTINEL);
  for (const file of persistedFiles(root)) {
    expect(readFileSync(file).includes(sentinel), file).toBe(false);
  }
}

function seedEligibleRun(): {
  readonly root: string;
  readonly databasePath: string;
  readonly store: IcarusStore;
  readonly projectId: string;
} {
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
  const checkpointFiles = UNIT_CHECKPOINT_FILES;
  const patchSet: PatchSet = {
    summary: "Update the fixture greeting.",
    edits: [
      {
        op: "modify",
        path: UNIT_PLAN.target,
        expectedPreimageSha256: sha256("hello\n"),
        replacements: [{ findText: "hello", replaceText: "goodbye" }],
        rationale: "Exercise the read-only GitHub preflight.",
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

  // The ordinary store requires a completed repair-session proof before its
  // public review path. This focused ledger fixture seeds that already-reviewed
  // source row directly; eligibility independently revalidates every byte.
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
  fixture.store.setLandingProfile(projectId, PROFILE, new Set([CREDENTIAL_ENV]));
  return { ...fixture, projectId };
}

function candidateAuthority(status: LandingStatusV1): LandingDigestV1 {
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
    baseRef: BASE_REF,
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

/** Drives the store-level fixture to an approved `local_ready` landing. */
function localReadyLanding(store: IcarusStore): LandingStatusV1 {
  const created = store.createLanding(
    {
      runId: UNIT_RUN_ID,
      baseTreeSha1: BASE_TREE_SHA1,
      commitMessage: COMMIT_MESSAGE,
      commitEpochSeconds: COMMIT_EPOCH_SECONDS,
      commitIso8601: commitEpochToGitInstant(COMMIT_EPOCH_SECONDS),
      pullRequestTitle: PULL_REQUEST_TITLE,
      pullRequestBodyPrefix: PULL_REQUEST_BODY_PREFIX,
    },
    new Set([CREDENTIAL_ENV]),
  );
  store.startCandidatePreparation(created.landing.id);
  const authority = candidateAuthority(created);
  const landingSha256 = digestLandingRecord(authority);
  const body = renderPullRequestBodyV1({
    landing: authority,
    landingSha256,
    bodyPrefix: created.landing.pullRequestBodyPrefix,
  });
  const candidate = store.settleLandingCandidate(created.landing.id, {
    candidateTreeSha1: CANDIDATE_TREE_SHA1,
    candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
    candidateCommitPayloadSha256: CANDIDATE_PAYLOAD_SHA256,
    candidateObjectManifestSha256: CANDIDATE_MANIFEST_SHA256,
    candidateCredentialAuditSha256: CANDIDATE_AUDIT_SHA256,
    landingDigest: authority,
    pullRequestBodySha256: sha256(body),
  });
  const approved = store.recordLandingDecision(
    candidate.landing.id,
    landingSha256,
    "unit-operator",
    "approve",
  );
  store.admitLandingResume(approved.landing.id);
  const local = store.startLocalRefCreation(approved.landing.id);
  store.recordLocalRefObservation(approved.landing.id, local.operationId, ABSENT_REF);
  return store.settleLocalRefCreation(approved.landing.id, {
    outcome: "succeeded",
    errorCode: null,
    observedFact: ABSENT_REF,
    postEffectFact: DIRECT_CANDIDATE_REF,
  });
}

const ACTOR_PROJECTION = { type: "actor", login: "unit-actor" } as const;
const BASE_PROJECTION = {
  type: "ref",
  state: "direct",
  ref: BASE_REF,
  sha1: UNIT_BASE_COMMIT,
} as const;
const HEAD_ABSENT_PROJECTION = {
  type: "ref",
  state: "absent",
  ref: LANDING_HEAD_REF,
  sha1: null,
} as const;

/** Admits and settles the three preflight reads in grammar order. */
function settlePreflightReads(
  store: IcarusStore,
  landingId: string,
  operationId: string,
): { readonly requestIds: readonly string[] } {
  const actor = store.admitGithubRequest(landingId, operationId, "github.actor.get");
  store.settleGithubRequest(landingId, actor.requestId, {
    outcome: "succeeded",
    httpStatus: 200,
    projection: ACTOR_PROJECTION,
    errorCode: null,
  });
  const base = store.admitGithubRequest(landingId, operationId, "github.base_ref.get");
  store.settleGithubRequest(landingId, base.requestId, {
    outcome: "succeeded",
    httpStatus: 200,
    projection: BASE_PROJECTION,
    errorCode: null,
  });
  const head = store.admitGithubRequest(landingId, operationId, "github.head_ref.get");
  store.settleGithubRequest(landingId, head.requestId, {
    outcome: "succeeded",
    httpStatus: 404,
    projection: HEAD_ABSENT_PROJECTION,
    errorCode: null,
  });
  return { requestIds: [actor.requestId, base.requestId, head.requestId] };
}

function completeStorePreflight(store: IcarusStore, landingId: string): LandingStatusV1 {
  store.admitLandingResume(landingId);
  const started = store.startGithubPreflight(landingId);
  settlePreflightReads(store, landingId, started.operationId);
  return store.settleGithubPreflight(landingId, {
    outcome: "completed",
    errorCode: null,
    closeAttempt: true,
  });
}

describe("durable GitHub preflight store slice", () => {
  test("admits every read before its I/O and settles the exact preflight result", () => {
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);
    const versionAtReady = ready.landing.version;

    const admission = fixture.store.admitLandingResume(ready.landing.id);
    expect(admission).toMatchObject({ attemptOrdinal: 3, operationId: null });
    const started = fixture.store.startGithubPreflight(ready.landing.id);
    const operation = started.status.operations.at(-1);
    expect(operation).toMatchObject({
      kind: "github.preflight",
      kindAttempt: 1,
      status: "started",
      observation: null,
    });
    expect(operation?.request.input).toEqual({
      landingSha256: ready.landing.landingSha256,
      profileSha256: ready.landing.profileSha256,
      baseRef: BASE_REF,
      expectedRemoteBaseSha1: UNIT_BASE_COMMIT,
      headRef: LANDING_HEAD_REF,
      candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
      includePullRequestAbsence: false,
    });
    // Preflight maps to no action state: starting it emits no state event.
    expect(started.status.landing.version).toBe(versionAtReady);
    expect(started.status.events.at(-1)?.type).toBe("landing.operation.started");

    const { requestIds } = settlePreflightReads(
      fixture.store,
      ready.landing.id,
      started.operationId,
    );
    const admittedReads = fixture.store.getLandingStatus(ready.landing.id);
    expect(admittedReads.httpRequests.map((row) => [row.kind, row.requestOrdinal])).toEqual([
      ["github.actor.get", 1],
      ["github.base_ref.get", 2],
      ["github.head_ref.get", 3],
    ]);
    expect(
      admittedReads.httpRequests.map((row) => [row.status, row.outcome, row.httpStatus]),
    ).toEqual([
      ["settled", "succeeded", 200],
      ["settled", "succeeded", 200],
      ["settled", "succeeded", 404],
    ]);

    const settled = fixture.store.settleGithubPreflight(ready.landing.id, {
      outcome: "completed",
      errorCode: null,
      closeAttempt: true,
    });
    expect(settled.landing).toMatchObject({
      state: "local_ready",
      errorCode: null,
      version: versionAtReady,
    });
    const preflight = settled.operations.at(-1);
    expect(preflight).toMatchObject({
      kind: "github.preflight",
      status: "completed",
      errorCode: null,
    });
    expect(preflight?.result).toMatchObject({
      outcome: "completed",
      boundary: "preflight_exact",
      value: {
        actor: "unit-actor",
        baseSha1: UNIT_BASE_COMMIT,
        headState: "absent",
        pullRequestCount: null,
      },
      errorCode: null,
    });
    // The result evidence replays the complete observation: each provider fact
    // references its settled request by ID and result digest.
    expect(preflight?.observation?.facts.map((fact) => fact.fact)).toEqual([
      "actor",
      "base_ref",
      "head_ref",
    ]);
    expect(
      preflight?.observation?.facts.map((fact) => [fact.requestId, fact.resultSha256]),
    ).toEqual(settled.httpRequests.map((row) => [row.id, row.resultSha256]));
    expect(preflight?.result?.evidence).toEqual(
      settled.httpRequests.map((row) => ({ requestId: row.id, resultSha256: row.resultSha256 })),
    );
    expect(requestIds).toEqual(settled.httpRequests.map((row) => row.id));
    expect(settled.attempts.at(-1)).toMatchObject({ status: "completed", errorCode: null });
    // No transition occurred, so no state event exists for this attempt.
    expect(settled.events.slice(-10).map((event) => event.type)).toEqual([
      "landing.attempt.started",
      "landing.operation.started",
      "landing.github.request.admitted",
      "landing.github.request.settled",
      "landing.github.request.admitted",
      "landing.github.request.settled",
      "landing.github.request.admitted",
      "landing.github.request.settled",
      "landing.operation.settled",
      "landing.attempt.settled",
    ]);
    fixture.store.close();
  });

  test("reuses the machinery for a fresh preflight without duplicating effects", () => {
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);
    const first = completeStorePreflight(fixture.store, ready.landing.id);
    expect(
      first.operations.filter((operation) => operation.kind === "github.preflight"),
    ).toHaveLength(1);

    const second = completeStorePreflight(fixture.store, ready.landing.id);
    const preflights = second.operations.filter(
      (operation) => operation.kind === "github.preflight",
    );
    expect(preflights.map((operation) => operation.kindAttempt)).toEqual([1, 2]);
    expect(preflights.map((operation) => operation.status)).toEqual(["completed", "completed"]);
    expect(second.landing.state).toBe("local_ready");
    expect(second.attempts).toHaveLength(4);
    // Every read is a fresh durable admission: unique request identities, and
    // per-attempt ordinals restart at one under the conservative charge.
    expect(second.httpRequests).toHaveLength(6);
    expect(new Set(second.httpRequests.map((row) => row.id)).size).toBe(6);
    expect(
      second.httpRequests
        .filter((row) => row.coordinatorAttempt === 4)
        .map((row) => row.requestOrdinal),
    ).toEqual([1, 2, 3]);
    fixture.store.close();
  });

  test("refuses admissions outside the exact grammar and state", () => {
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);

    // The operation kind and the landing state are both admission fences.
    expectIcarusCode(
      () => fixture.store.startGithubPreflight(ready.landing.id),
      "LANDING_NOT_ADMITTED",
    );
    fixture.store.admitLandingResume(ready.landing.id);
    const started = fixture.store.startGithubPreflight(ready.landing.id);
    expectIcarusCode(
      () => fixture.store.startGithubPreflight(ready.landing.id),
      "LANDING_OPERATION_IN_PROGRESS",
    );

    // The grammar order is fixed: base before actor is not admissible.
    expectIcarusCode(
      () =>
        fixture.store.admitGithubRequest(
          ready.landing.id,
          started.operationId,
          "github.base_ref.get",
        ),
      "LANDING_RECORD_INVALID",
    );
    // The pull-request list read is not in this preflight's grammar.
    expectIcarusCode(
      () =>
        fixture.store.admitGithubRequest(
          ready.landing.id,
          started.operationId,
          "github.pull_requests.get",
        ),
      "LANDING_RECORD_INVALID",
    );
    const actor = fixture.store.admitGithubRequest(
      ready.landing.id,
      started.operationId,
      "github.actor.get",
    );
    // Sequential I/O only: a second admission while the first is unsettled.
    expectIcarusCode(
      () =>
        fixture.store.admitGithubRequest(ready.landing.id, started.operationId, "github.actor.get"),
      "LANDING_REQUEST_IN_PROGRESS",
    );
    fixture.store.settleGithubRequest(ready.landing.id, actor.requestId, {
      outcome: "succeeded",
      httpStatus: 200,
      projection: ACTOR_PROJECTION,
      errorCode: null,
    });
    // Settling twice is not an admission.
    expectIcarusCode(
      () =>
        fixture.store.settleGithubRequest(ready.landing.id, actor.requestId, {
          outcome: "succeeded",
          httpStatus: 200,
          projection: ACTOR_PROJECTION,
          errorCode: null,
        }),
      "LANDING_NOT_ADMITTED",
    );
    expectIcarusCode(
      () =>
        fixture.store.settleGithubRequest(ready.landing.id, REVIEW_ID, {
          outcome: "succeeded",
          httpStatus: 200,
          projection: ACTOR_PROJECTION,
          errorCode: null,
        }),
      "NOT_FOUND",
    );
    fixture.store.settleGithubPreflight(ready.landing.id, {
      outcome: "failed",
      errorCode: "LANDING_GITHUB_READ_FAILED",
      closeAttempt: true,
    });
    fixture.store.close();
  });

  test("cannot attach an HTTP row to a candidate or local-ref operation", () => {
    const fixture = seedEligibleRun();
    const created = fixture.store.createLanding(
      {
        runId: UNIT_RUN_ID,
        baseTreeSha1: BASE_TREE_SHA1,
        commitMessage: COMMIT_MESSAGE,
        commitEpochSeconds: COMMIT_EPOCH_SECONDS,
        commitIso8601: commitEpochToGitInstant(COMMIT_EPOCH_SECONDS),
        pullRequestTitle: PULL_REQUEST_TITLE,
        pullRequestBodyPrefix: PULL_REQUEST_BODY_PREFIX,
      },
      new Set([CREDENTIAL_ENV]),
    );
    const candidate = fixture.store.startCandidatePreparation(created.landing.id);
    expectIcarusCode(
      () =>
        fixture.store.admitGithubRequest(
          created.landing.id,
          candidate.operationId,
          "github.actor.get",
        ),
      "LANDING_RECORD_INVALID",
    );
    fixture.store.close();

    // Raw SQL cannot attach one either: the DDL's operation-kind by method by
    // HTTP-kind check is itself a fence, independent of the code.
    const raw = seedEligibleRun();
    const rawCreated = raw.store.createLanding(
      {
        runId: UNIT_RUN_ID,
        baseTreeSha1: BASE_TREE_SHA1,
        commitMessage: COMMIT_MESSAGE,
        commitEpochSeconds: COMMIT_EPOCH_SECONDS,
        commitIso8601: commitEpochToGitInstant(COMMIT_EPOCH_SECONDS),
        pullRequestTitle: PULL_REQUEST_TITLE,
        pullRequestBodyPrefix: PULL_REQUEST_BODY_PREFIX,
      },
      new Set([CREDENTIAL_ENV]),
    );
    const rawCandidate = raw.store.startCandidatePreparation(rawCreated.landing.id);
    const status = raw.store.getLandingStatus(rawCreated.landing.id);
    const operation = status.operations.find((entry) => entry.id === rawCandidate.operationId);
    expect(operation).toBeDefined();
    const database = new Database(raw.databasePath);
    expect(() =>
      database
        .prepare(
          "INSERT INTO landing_http_requests " +
            "(id, landing_id, operation_id, coordinator_attempt, operation_kind, " +
            "request_ordinal, kind, method, request_sha256, request_json, status, outcome, " +
            "http_status, result_sha256, result_json, error_code, admitted_at, settled_at) " +
            "VALUES (?, ?, ?, ?, ?, 1, 'github.actor.get', 'GET', ?, '{}', 'admitted', " +
            "NULL, NULL, NULL, NULL, NULL, ?, NULL)",
        )
        .run(
          "99999999-9999-4999-8999-999999999999",
          rawCreated.landing.id,
          rawCandidate.operationId,
          operation?.coordinatorAttempt ?? 1,
          "candidate.prepare",
          "0".repeat(64),
          "2026-07-19T12:00:00.000Z",
        ),
    ).toThrowError(/CHECK/);
    database.close();
    raw.store.close();
  });

  test("a settled result must restate the admitted subject and the kind's projection", () => {
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);
    fixture.store.admitLandingResume(ready.landing.id);
    const started = fixture.store.startGithubPreflight(ready.landing.id);
    const actor = fixture.store.admitGithubRequest(
      ready.landing.id,
      started.operationId,
      "github.actor.get",
    );
    // A ref projection cannot settle an actor read.
    expectIcarusCode(
      () =>
        fixture.store.settleGithubRequest(ready.landing.id, actor.requestId, {
          outcome: "succeeded",
          httpStatus: 200,
          projection: BASE_PROJECTION,
          errorCode: null,
        }),
      "LANDING_RECORD_INVALID",
    );
    // A truthful-looking read about a different actor cannot restate the
    // admitted subject either.
    expectIcarusCode(
      () =>
        fixture.store.settleGithubRequest(ready.landing.id, actor.requestId, {
          outcome: "succeeded",
          httpStatus: 200,
          projection: { type: "actor", login: "someone-else" },
          errorCode: null,
        }),
      "LANDING_RECORD_INVALID",
    );
    fixture.store.settleGithubRequest(ready.landing.id, actor.requestId, {
      outcome: "succeeded",
      httpStatus: 200,
      projection: ACTOR_PROJECTION,
      errorCode: null,
    });
    fixture.store.settleGithubPreflight(ready.landing.id, {
      outcome: "failed",
      errorCode: "LANDING_GITHUB_READ_FAILED",
      closeAttempt: true,
    });
    fixture.store.close();
  });

  test("a completed settlement is derived from the durable reads, never proposed", () => {
    const drifted = seedEligibleRun();
    const driftedReady = localReadyLanding(drifted.store);
    drifted.store.admitLandingResume(driftedReady.landing.id);
    const driftedStart = drifted.store.startGithubPreflight(driftedReady.landing.id);
    const actor = drifted.store.admitGithubRequest(
      driftedReady.landing.id,
      driftedStart.operationId,
      "github.actor.get",
    );
    drifted.store.settleGithubRequest(driftedReady.landing.id, actor.requestId, {
      outcome: "succeeded",
      httpStatus: 200,
      projection: ACTOR_PROJECTION,
      errorCode: null,
    });
    const base = drifted.store.admitGithubRequest(
      driftedReady.landing.id,
      driftedStart.operationId,
      "github.base_ref.get",
    );
    drifted.store.settleGithubRequest(driftedReady.landing.id, base.requestId, {
      outcome: "succeeded",
      httpStatus: 200,
      projection: { type: "ref", state: "direct", ref: BASE_REF, sha1: "9".repeat(40) },
      errorCode: null,
    });
    // The drifted base is durably truthful, so a completed settlement is
    // impossible to propose.
    expectIcarusCode(
      () =>
        drifted.store.settleGithubPreflight(driftedReady.landing.id, {
          outcome: "completed",
          errorCode: null,
          closeAttempt: true,
        }),
      "LANDING_RECORD_INVALID",
    );
    // An incomplete grammar is likewise not a completed preflight.
    const incomplete = seedEligibleRun();
    const incompleteReady = localReadyLanding(incomplete.store);
    incomplete.store.admitLandingResume(incompleteReady.landing.id);
    const incompleteStart = incomplete.store.startGithubPreflight(incompleteReady.landing.id);
    const onlyActor = incomplete.store.admitGithubRequest(
      incompleteReady.landing.id,
      incompleteStart.operationId,
      "github.actor.get",
    );
    incomplete.store.settleGithubRequest(incompleteReady.landing.id, onlyActor.requestId, {
      outcome: "succeeded",
      httpStatus: 200,
      projection: ACTOR_PROJECTION,
      errorCode: null,
    });
    expectIcarusCode(
      () =>
        incomplete.store.settleGithubPreflight(incompleteReady.landing.id, {
          outcome: "completed",
          errorCode: null,
          closeAttempt: true,
        }),
      "LANDING_RECORD_INVALID",
    );
    drifted.store.settleGithubPreflight(driftedReady.landing.id, {
      outcome: "failed",
      errorCode: "LANDING_REMOTE_BASE_CHANGED",
      closeAttempt: true,
    });
    incomplete.store.settleGithubPreflight(incompleteReady.landing.id, {
      outcome: "failed",
      errorCode: "LANDING_GITHUB_READ_FAILED",
      closeAttempt: true,
    });
    drifted.store.close();
    incomplete.store.close();
  });

  test("failed preflight enters failed with the local_ready marker and resumes exactly", () => {
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);
    fixture.store.admitLandingResume(ready.landing.id);
    const started = fixture.store.startGithubPreflight(ready.landing.id);
    const actor = fixture.store.admitGithubRequest(
      ready.landing.id,
      started.operationId,
      "github.actor.get",
    );
    fixture.store.settleGithubRequest(ready.landing.id, actor.requestId, {
      outcome: "failed",
      httpStatus: 403,
      projection: null,
      errorCode: "GITHUB_HTTP_ERROR",
    });
    const failed = fixture.store.settleGithubPreflight(ready.landing.id, {
      outcome: "failed",
      errorCode: "GITHUB_HTTP_ERROR",
      closeAttempt: true,
    });
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "local_ready",
      errorCode: "GITHUB_HTTP_ERROR",
    });
    expect(failed.operations.at(-1)?.result).toMatchObject({
      outcome: "failed",
      boundary: "operation_failed",
      value: null,
    });
    expect(failed.operations.at(-1)?.result?.evidence).toEqual([
      {
        requestId: actor.requestId,
        resultSha256: failed.httpRequests.at(-1)?.resultSha256,
      },
    ]);
    expect(failed.events.at(-1)?.type).toBe("landing.state.changed");
    expect(failed.events.at(-1)?.payload).toMatchObject({
      from: "local_ready",
      to: "failed",
      operationId: started.operationId,
    });

    // Explicit resume consumes the marker and replays the read-only stage.
    const replayed = completeStorePreflight(fixture.store, ready.landing.id);
    expect(replayed.landing).toMatchObject({ state: "local_ready", errorCode: null });
    expect(
      replayed.operations
        .filter((operation) => operation.kind === "github.preflight")
        .map((operation) => [operation.kindAttempt, operation.status]),
    ).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
    expect(
      replayed.events.some(
        (event) =>
          event.type === "landing.state.changed" &&
          (event.payload as { readonly to?: unknown }).to === "local_ready" &&
          (event.payload as { readonly from?: unknown }).from === "failed",
      ),
    ).toBe(true);
    fixture.store.close();
  });

  test("an interrupted preflight keeps local_ready without a false state event", () => {
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);
    const versionAtReady = ready.landing.version;
    fixture.store.admitLandingResume(ready.landing.id);
    const started = fixture.store.startGithubPreflight(ready.landing.id);
    const actor = fixture.store.admitGithubRequest(
      ready.landing.id,
      started.operationId,
      "github.actor.get",
    );
    fixture.store.settleGithubRequest(ready.landing.id, actor.requestId, {
      outcome: "failed",
      httpStatus: null,
      projection: null,
      errorCode: "GITHUB_TIMEOUT",
    });
    const interrupted = fixture.store.settleGithubPreflight(ready.landing.id, {
      outcome: "interrupted",
      errorCode: "GITHUB_TIMEOUT",
      closeAttempt: true,
    });
    expect(interrupted.landing).toMatchObject({
      state: "local_ready",
      resumeState: null,
      errorCode: null,
      version: versionAtReady,
    });
    expect(interrupted.operations.at(-1)).toMatchObject({
      kind: "github.preflight",
      status: "interrupted",
    });
    expect(
      interrupted.events.filter((event) => event.type === "landing.state.changed"),
    ).toHaveLength(ready.events.filter((event) => event.type === "landing.state.changed").length);

    const replayed = completeStorePreflight(fixture.store, ready.landing.id);
    expect(replayed.landing.state).toBe("local_ready");
    fixture.store.close();
  });

  test("takeover settles an open admission as ambiguous before interrupting the operation", () => {
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);
    fixture.store.admitLandingResume(ready.landing.id);
    const started = fixture.store.startGithubPreflight(ready.landing.id);
    const actor = fixture.store.admitGithubRequest(
      ready.landing.id,
      started.operationId,
      "github.actor.get",
    );
    const versionAtReady = ready.landing.version;

    // The process dies with the read admitted but unsettled. The next explicit
    // resume settles that row ambiguous — never inferring failure from an
    // absent response — and interrupts the retry-safe operation in place.
    const takeover = fixture.store.admitLandingResume(ready.landing.id);
    expect(takeover.attemptOrdinal).toBe(4);
    expect(takeover.status.landing).toMatchObject({
      state: "local_ready",
      resumeState: null,
      errorCode: null,
      version: versionAtReady,
    });
    const crashed = takeover.status.operations.find(
      (operation) => operation.id === started.operationId,
    );
    expect(crashed).toMatchObject({
      status: "interrupted",
      errorCode: "LANDING_COORDINATOR_TAKEOVER",
    });
    const row = takeover.status.httpRequests.find((entry) => entry.id === actor.requestId);
    expect(row).toMatchObject({
      status: "settled",
      outcome: "ambiguous",
      httpStatus: null,
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    expect(crashed?.result?.evidence).toEqual([
      { requestId: actor.requestId, resultSha256: row?.resultSha256 },
    ]);
    // The takeover emits no false state-change event: request settled, then
    // operation settled, then attempt settled, with the landing unmoved.
    expect(takeover.status.events.slice(-4).map((event) => event.type)).toEqual([
      "landing.github.request.settled",
      "landing.operation.settled",
      "landing.attempt.settled",
      "landing.attempt.started",
    ]);
    expect(
      takeover.status.events.filter((event) => event.type === "landing.state.changed"),
    ).toHaveLength(ready.events.filter((event) => event.type === "landing.state.changed").length);

    // The takeover-started attempt 4 runs the replacement preflight directly.
    const restarted = fixture.store.startGithubPreflight(ready.landing.id);
    settlePreflightReads(fixture.store, ready.landing.id, restarted.operationId);
    const replayed = fixture.store.settleGithubPreflight(ready.landing.id, {
      outcome: "completed",
      errorCode: null,
      closeAttempt: true,
    });
    expect(replayed.landing.state).toBe("local_ready");
    expect(replayed.httpRequests).toHaveLength(4);
    expect(new Set(replayed.httpRequests.map((entry) => entry.id)).size).toBe(4);
    expect(
      replayed.httpRequests
        .filter((entry) => entry.coordinatorAttempt === 4)
        .map((entry) => entry.requestOrdinal),
    ).toEqual([1, 2, 3]);
    expect(
      replayed.operations
        .filter((operation) => operation.kind === "github.preflight")
        .map((operation) => [operation.kindAttempt, operation.status]),
    ).toEqual([
      [1, "interrupted"],
      [2, "completed"],
    ]);
    fixture.store.close();
  });

  test("at most one operation per attempt in this slice, and it must precede any effect", () => {
    // The ordered-sequence rule: one preflight, then at most one effect. Only
    // preflight is reachable here, so a second operation in the same attempt is
    // corruption that must fail closed at load.
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);
    completeStorePreflight(fixture.store, ready.landing.id);
    const status = fixture.store.getLandingStatus(ready.landing.id);
    const preflight = status.operations.find((operation) => operation.kind === "github.preflight");
    expect(preflight).toBeDefined();
    const database = new Database(fixture.databasePath);
    const cloneId = "88888888-8888-4888-8888-888888888888";
    const cloneRequest = {
      ...(JSON.parse(canonicalLandingJson(preflight?.request)) as Record<string, unknown>),
      operationId: cloneId,
      kindAttempt: 2,
    };
    const cloneRequestJson = canonicalLandingJson(cloneRequest);
    database
      .prepare(
        "INSERT INTO landing_operations " +
          "(id, landing_id, coordinator_attempt, kind, kind_attempt, status, request_sha256, " +
          "request_json, observation_sha256, observation_json, result_sha256, result_json, " +
          "error_code, started_at, finished_at) " +
          "VALUES (?, ?, ?, 'github.preflight', 2, 'started', ?, ?, NULL, NULL, NULL, NULL, " +
          "NULL, ?, NULL)",
      )
      .run(
        cloneId,
        ready.landing.id,
        preflight?.coordinatorAttempt ?? 0,
        sha256(cloneRequestJson),
        cloneRequestJson,
        "2026-07-19T12:00:00.000Z",
      );
    database.close();
    expectIcarusCode(
      () => fixture.store.getLandingStatus(ready.landing.id),
      "LANDING_RECORD_INVALID",
    );
    fixture.store.close();
  });

  test("fail-closed load rejects corrupted HTTP rows, observations, and event streams", () => {
    // A settled row whose projection does not match its kind cannot load.
    const projectionFixture = seedEligibleRun();
    const projectionReady = localReadyLanding(projectionFixture.store);
    projectionFixture.store.admitLandingResume(projectionReady.landing.id);
    const started = projectionFixture.store.startGithubPreflight(projectionReady.landing.id);
    const actor = projectionFixture.store.admitGithubRequest(
      projectionReady.landing.id,
      started.operationId,
      "github.actor.get",
    );
    projectionFixture.store.settleGithubRequest(projectionReady.landing.id, actor.requestId, {
      outcome: "succeeded",
      httpStatus: 200,
      projection: ACTOR_PROJECTION,
      errorCode: null,
    });
    const projectionDatabase = new Database(projectionFixture.databasePath);
    const row = projectionDatabase
      .prepare("SELECT result_json FROM landing_http_requests WHERE id = ?")
      .get(actor.requestId) as { readonly result_json: string };
    const result = JSON.parse(row.result_json) as Record<string, unknown>;
    result.projection = { type: "ref", state: "direct", ref: BASE_REF, sha1: UNIT_BASE_COMMIT };
    const resultJson = canonicalLandingJson(result);
    projectionDatabase
      .prepare("UPDATE landing_http_requests SET result_json = ?, result_sha256 = ? WHERE id = ?")
      .run(resultJson, sha256(resultJson), actor.requestId);
    projectionDatabase.close();
    expectIcarusCode(
      () => projectionFixture.store.getLandingStatus(projectionReady.landing.id),
      "LANDING_RECORD_INVALID",
    );
    projectionFixture.store.close();

    // An ordinal gap in the per-attempt request sequence cannot load.
    const ordinalFixture = seedEligibleRun();
    const ordinalReady = localReadyLanding(ordinalFixture.store);
    completeStorePreflight(ordinalFixture.store, ordinalReady.landing.id);
    const ordinalDatabase = new Database(ordinalFixture.databasePath);
    const requestRow = ordinalDatabase
      .prepare("SELECT id, request_json FROM landing_http_requests WHERE request_ordinal = 2")
      .get() as { readonly id: string; readonly request_json: string };
    const request = JSON.parse(requestRow.request_json) as Record<string, unknown>;
    request.requestOrdinal = 9;
    const requestJson = canonicalLandingJson(request);
    ordinalDatabase
      .prepare(
        "UPDATE landing_http_requests SET request_ordinal = 9, request_json = ?, " +
          "request_sha256 = ? WHERE id = ?",
      )
      .run(requestJson, sha256(requestJson), requestRow.id);
    ordinalDatabase.close();
    expectIcarusCode(
      () => ordinalFixture.store.getLandingStatus(ordinalReady.landing.id),
      "LANDING_RECORD_INVALID",
    );
    ordinalFixture.store.close();

    // A preflight observation fact with a null request cannot load: provider
    // facts must reference a settled request.
    const observationFixture = seedEligibleRun();
    const observationReady = localReadyLanding(observationFixture.store);
    completeStorePreflight(observationFixture.store, observationReady.landing.id);
    const observationDatabase = new Database(observationFixture.databasePath);
    const operationRow = observationDatabase
      .prepare(
        "SELECT id, observation_json FROM landing_operations WHERE kind = 'github.preflight'",
      )
      .get() as { readonly id: string; readonly observation_json: string };
    const observation = JSON.parse(operationRow.observation_json) as {
      readonly facts: Array<Record<string, unknown>>;
    };
    observation.facts[0] = { ...observation.facts[0], requestId: null };
    const observationJson = canonicalLandingJson(observation);
    observationDatabase
      .prepare(
        "UPDATE landing_operations SET observation_json = ?, observation_sha256 = ? WHERE id = ?",
      )
      .run(observationJson, sha256(observationJson), operationRow.id);
    observationDatabase.close();
    expectIcarusCode(
      () => observationFixture.store.getLandingStatus(observationReady.landing.id),
      "LANDING_RECORD_INVALID",
    );
    observationFixture.store.close();

    // Dropping a request settlement event unbalances the event stream.
    const eventFixture = seedEligibleRun();
    const eventReady = localReadyLanding(eventFixture.store);
    completeStorePreflight(eventFixture.store, eventReady.landing.id);
    const eventDatabase = new Database(eventFixture.databasePath);
    const eventRow = eventDatabase
      .prepare(
        "SELECT sequence FROM landing_events WHERE landing_id = ? " +
          "AND type = 'landing.github.request.settled' ORDER BY sequence LIMIT 1",
      )
      .get(eventReady.landing.id) as { readonly sequence: number };
    eventDatabase
      .prepare("DELETE FROM landing_events WHERE landing_id = ? AND sequence = ?")
      .run(eventReady.landing.id, eventRow.sequence);
    eventDatabase.close();
    expectIcarusCode(
      () => eventFixture.store.getLandingStatus(eventReady.landing.id),
      "LANDING_RECORD_INVALID",
    );
    eventFixture.store.close();
  });
});

// ---------------------------------------------------------------------------
// Coordinator-level: the read-only stage driven through the service resume
// path against a deterministic fake gateway (never a live GitHub call).
// ---------------------------------------------------------------------------

type GatewayBehavior = {
  readonly readActor?: LandingGithubGateway["readActor"];
  readonly readBaseReference?: LandingGithubGateway["readBaseReference"];
  readonly readReference?: LandingGithubGateway["readReference"];
  readonly createBlob?: LandingGithubGateway["createBlob"];
  readonly createTree?: LandingGithubGateway["createTree"];
  readonly createCommit?: LandingGithubGateway["createCommit"];
  readonly createAbsentRef?: LandingGithubGateway["createAbsentRef"];
};

function fakeLandingGit(): LandingGitService {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected landing Git call");
  };
  return {
    inspectBase: unexpected,
    prepareCandidate: unexpected,
    observeLocalRef: unexpected,
    createAbsentLocalRef: unexpected,
  };
}

function fakeGithubGateway(
  behavior: GatewayBehavior = {},
  onCall?: (kind: string) => void,
): {
  readonly factory: (credential: string) => LandingGithubGateway;
  readonly calls: string[];
  readonly credentials: readonly string[];
} {
  const calls: string[] = [];
  const credentials: string[] = [];
  const actor =
    behavior.readActor ??
    (async (expectedActor: string) => ({
      login: expectedActor,
      responseSha256: sha256("actor-bytes"),
      latencyMs: 1,
    }));
  const base =
    behavior.readBaseReference ??
    (async (_coordinates, ref) => ({
      ref,
      sha: UNIT_BASE_COMMIT,
      responseSha256: sha256("base-bytes"),
      latencyMs: 1,
    }));
  const head = behavior.readReference ?? undefined;
  const blob =
    behavior.createBlob ??
    (async (_coordinates, contentBase64) => ({
      // The faithful content-addressed answer: the object name of the bytes.
      sha: gitObjectSha1("blob", Buffer.from(contentBase64, "base64")),
      responseSha256: sha256("blob-bytes"),
      latencyMs: 1,
    }));
  const tree =
    behavior.createTree ??
    (async () => ({
      sha: CANDIDATE_TREE_SHA1,
      responseSha256: sha256("tree-bytes"),
      latencyMs: 1,
    }));
  const commit =
    behavior.createCommit ??
    (async () => ({
      sha: CANDIDATE_COMMIT_SHA1,
      responseSha256: sha256("commit-bytes"),
      latencyMs: 1,
    }));
  const createRef =
    behavior.createAbsentRef ??
    (async (_coordinates, ref, sha) => ({
      ref,
      sha,
      responseSha256: sha256("ref-bytes"),
      latencyMs: 1,
    }));
  // The fake remote's refs: a created head is visible to later head reads.
  const remoteRefs = new Map<string, string>();
  const factory = (credential: string): LandingGithubGateway => {
    credentials.push(credential);
    return {
      readActor: async (...args) => {
        calls.push("actor");
        onCall?.("actor");
        return actor(...args);
      },
      readBaseReference: async (...args) => {
        calls.push("base");
        onCall?.("base");
        return base(...args);
      },
      readReference: async (...args) => {
        calls.push("head");
        onCall?.("head");
        if (head !== undefined) return head(...args);
        const [, ref] = args;
        const sha = remoteRefs.get(ref);
        return sha === undefined
          ? null
          : { ref, sha, responseSha256: sha256("head-bytes"), latencyMs: 1 };
      },
      readPullRequestByHead: async () => {
        throw new Error("Pull-request reads are not part of this slice");
      },
      createBlob: async (...args) => {
        calls.push("blob");
        onCall?.("blob");
        return blob(...args);
      },
      createTree: async (...args) => {
        calls.push("tree");
        onCall?.("tree");
        return tree(...args);
      },
      createCommit: async (...args) => {
        calls.push("commit");
        onCall?.("commit");
        return commit(...args);
      },
      createAbsentRef: async (...args) => {
        calls.push("ref");
        onCall?.("ref");
        const receipt = await createRef(...args);
        if (receipt.ref !== undefined) remoteRefs.set(receipt.ref, receipt.sha);
        return receipt;
      },
    };
  };
  return { factory, calls, credentials };
}

async function preflightService(
  fixture: ReturnType<typeof seedEligibleRun>,
  options: {
    readonly gateway?: (credential: string) => LandingGithubGateway;
    readonly credentialEnvironment?: (name: string) => string | undefined;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<IcarusService> {
  const stateRoot = path.join(fixture.root, "landing-service-state");
  mkdirSync(stateRoot, { mode: 0o700 });
  const git = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        throw new Error(`Unexpected ordinary Git call: ${String(property)}`);
      },
    },
  ) as unknown as GitController;
  const checks: CheckRunner = {
    reconcile: async () => {
      throw new Error("Unexpected check reconciliation");
    },
    runChecks: async () => {
      throw new Error("Unexpected check execution");
    },
  };
  const service = new IcarusService({
    stateRoot,
    store: fixture.store,
    artifacts: new ArtifactStore(stateRoot),
    git,
    landingGit: fakeLandingGit(),
    landingCredentialEnvironmentNames: [CREDENTIAL_ENV],
    checks,
    ...(options.gateway === undefined ? {} : { landingGithubGateway: options.gateway }),
    landingCredentialEnvironment:
      options.credentialEnvironment ??
      ((name) => (name === CREDENTIAL_ENV ? TOKEN_SENTINEL : undefined)),
    gatewayFactory: () => {
      throw new Error("Unexpected provider gateway construction");
    },
    platform: options.platform ?? "linux",
  });
  await service.initialize();
  return service;
}

describe("landing service GitHub preflight stage", () => {
  test("runs the exact read sequence with every admission committed before its I/O", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const admissionProofs: string[] = [];
    const gateway = fakeGithubGateway({}, (kind) => {
      // Intent-before-effect: when the gateway is invoked, the request row and
      // its admitted event are already durable.
      const current = fixture.store.getLandingStatusForRun(UNIT_RUN_ID);
      const rows = current?.httpRequests ?? [];
      const last = rows.at(-1);
      const lastEvent = current?.events.at(-1);
      admissionProofs.push(
        `${kind}:${rows.length}:${last?.status ?? "none"}:${lastEvent?.type ?? "none"}`,
      );
    });
    const service = await preflightService(fixture, { gateway: gateway.factory });

    // The whole attempt: preflight, then the object upload it authorizes.
    const status = await service.resumeLanding(UNIT_RUN_ID);
    expect(status.landing).toMatchObject({
      state: "objects_ready",
      errorCode: null,
    });
    expect(gateway.calls).toEqual(["actor", "base", "head", "actor", "blob", "tree", "commit"]);
    expect(admissionProofs).toEqual([
      "actor:1:admitted:landing.github.request.admitted",
      "base:2:admitted:landing.github.request.admitted",
      "head:3:admitted:landing.github.request.admitted",
      "actor:4:admitted:landing.github.request.admitted",
      "blob:5:admitted:landing.github.request.admitted",
      "tree:6:admitted:landing.github.request.admitted",
      "commit:7:admitted:landing.github.request.admitted",
    ]);
    expect(gateway.credentials).toEqual([TOKEN_SENTINEL, TOKEN_SENTINEL]);
    const preflight = status.operations.find((operation) => operation.kind === "github.preflight");
    expect(preflight?.result).toMatchObject({
      outcome: "completed",
      boundary: "preflight_exact",
      value: {
        actor: "unit-actor",
        baseSha1: UNIT_BASE_COMMIT,
        headState: "absent",
        pullRequestCount: null,
      },
    });
    const upload = status.operations.at(-1);
    expect(upload).toMatchObject({
      kind: "github.objects.upload",
      status: "completed",
    });
    expect(upload?.result).toMatchObject({
      outcome: "completed",
      boundary: "objects_exact",
      value: {
        candidateObjectManifestSha256: CANDIDATE_MANIFEST_SHA256,
        remoteObjectOutcome: "created_or_exact",
      },
    });
    // The upload binds the immediately preceding completed preflight exactly.
    expect(upload?.request.input).toMatchObject({
      preflightOperationId: preflight?.id,
      preflightResultSha256: preflight?.resultSha256,
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    });
    expect(status.httpRequests.map((row) => row.outcome)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expectNoPersistedToken(fixture.root);
    fixture.store.close();
  });

  test("a further explicit resume performs the ref stage with fresh request identities", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakeGithubGateway();
    const service = await preflightService(fixture, { gateway: gateway.factory });

    const first = await service.resumeLanding(UNIT_RUN_ID);
    expect(first.landing.state).toBe("objects_ready");
    const second = await service.resumeLanding(UNIT_RUN_ID);
    expect(second.landing.state).toBe("remote_ready");
    expect(
      second.operations
        .filter((operation) => operation.kind === "github.preflight")
        .map((operation) => [operation.kindAttempt, operation.status]),
    ).toEqual([
      [1, "completed"],
      [2, "completed"],
    ]);
    const refCreate = second.operations.at(-1);
    expect(refCreate).toMatchObject({ kind: "github.ref.create", status: "completed" });
    expect(refCreate?.result).toMatchObject({
      outcome: "completed",
      boundary: "remote_ref_ready",
      value: {
        baseSha1: UNIT_BASE_COMMIT,
        headSha1: CANDIDATE_COMMIT_SHA1,
        remoteRefOutcome: "created",
      },
    });
    expect(second.httpRequests).toHaveLength(16);
    expect(new Set(second.httpRequests.map((row) => row.id)).size).toBe(16);
    expect(
      second.httpRequests
        .filter((row) => row.coordinatorAttempt === second.attempts.at(-1)?.ordinal)
        .map((row) => row.requestOrdinal),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(gateway.calls).toHaveLength(16);
    expectNoPersistedToken(fixture.root);
    fixture.store.close();
  });

  test("an actor mismatch performs no further read and resumes after refusal", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    let failActor = true;
    const gateway = fakeGithubGateway({
      readActor: async () => {
        if (failActor) {
          throw new GithubGatewayError(
            "GITHUB_ACTOR_MISMATCH",
            "The GitHub credential does not belong to the expected actor",
            { status: 200, responseSha256: sha256("actor-bytes") },
          );
        }
        return { login: "unit-actor", responseSha256: sha256("actor-bytes"), latencyMs: 1 };
      },
    });
    const service = await preflightService(fixture, { gateway: gateway.factory });

    const failed = await service.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "local_ready",
      errorCode: "GITHUB_ACTOR_MISMATCH",
    });
    expect(failed.httpRequests).toHaveLength(1);
    expect(failed.httpRequests[0]).toMatchObject({
      kind: "github.actor.get",
      outcome: "failed",
      httpStatus: 200,
      errorCode: "GITHUB_ACTOR_MISMATCH",
    });
    expectNoPersistedToken(fixture.root);

    failActor = false;
    const replayed = await service.resumeLanding(UNIT_RUN_ID);
    expect(replayed.landing).toMatchObject({ state: "objects_ready", errorCode: null });
    expect(replayed.httpRequests).toHaveLength(8);
    fixture.store.close();
  });

  test("a missing base ref is a failure, never a provable absence", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakeGithubGateway({
      readBaseReference: async () => null,
    });
    const service = await preflightService(fixture, { gateway: gateway.factory });

    const failed = await service.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "local_ready",
      errorCode: "LANDING_REMOTE_BASE_MISSING",
    });
    expect(gateway.calls).toEqual(["actor", "base"]);
    expect(failed.httpRequests.at(-1)).toMatchObject({
      kind: "github.base_ref.get",
      outcome: "failed",
      httpStatus: 404,
      errorCode: "LANDING_REMOTE_BASE_MISSING",
    });
    fixture.store.close();
  });

  test("a drifted base is recorded truthfully and refuses completion", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const driftedSha = "9".repeat(40);
    const gateway = fakeGithubGateway({
      readBaseReference: async (_coordinates, ref) => ({
        ref,
        sha: driftedSha,
        responseSha256: sha256("base-bytes"),
        latencyMs: 1,
      }),
    });
    const service = await preflightService(fixture, { gateway: gateway.factory });

    const failed = await service.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "local_ready",
      errorCode: "LANDING_REMOTE_BASE_CHANGED",
    });
    expect(gateway.calls).toEqual(["actor", "base"]);
    // The settled read records what the provider actually said — the drift —
    // while the operation refuses. Nothing is rewritten to look consistent.
    expect(failed.httpRequests.at(-1)).toMatchObject({
      kind: "github.base_ref.get",
      outcome: "succeeded",
      httpStatus: 200,
      result: { projection: { state: "direct", sha1: driftedSha } },
    });
    fixture.store.close();
  });

  test("a pre-existing head is a conflict even when it points at the candidate", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakeGithubGateway({
      readReference: async (_coordinates, ref) => ({
        ref,
        sha: CANDIDATE_COMMIT_SHA1,
        responseSha256: sha256("head-bytes"),
        latencyMs: 1,
      }),
    });
    const service = await preflightService(fixture, { gateway: gateway.factory });

    const failed = await service.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "local_ready",
      errorCode: "LANDING_REMOTE_HEAD_CONFLICT",
    });
    expect(gateway.calls).toEqual(["actor", "base", "head"]);
    expect(failed.httpRequests.at(-1)).toMatchObject({
      kind: "github.head_ref.get",
      outcome: "succeeded",
      httpStatus: 200,
      result: { projection: { state: "direct", sha1: CANDIDATE_COMMIT_SHA1 } },
    });
    fixture.store.close();
  });

  test("a transport refusal settles the read without a status and stays retryable", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    let failTransport = true;
    const gateway = fakeGithubGateway({
      readActor: async () => {
        if (failTransport) {
          throw new GithubGatewayError("GITHUB_TRANSPORT_ERROR", "A GitHub read did not complete", {
            reason: "transport",
            cause: "SocketError",
          });
        }
        return { login: "unit-actor", responseSha256: sha256("actor-bytes"), latencyMs: 1 };
      },
    });
    const service = await preflightService(fixture, { gateway: gateway.factory });

    const failed = await service.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "local_ready",
      errorCode: "GITHUB_TRANSPORT_ERROR",
    });
    expect(failed.httpRequests[0]).toMatchObject({
      outcome: "failed",
      httpStatus: null,
      errorCode: "GITHUB_TRANSPORT_ERROR",
    });

    failTransport = false;
    const replayed = await service.resumeLanding(UNIT_RUN_ID);
    expect(replayed.landing).toMatchObject({ state: "objects_ready", errorCode: null });
    fixture.store.close();
  });

  test("cancellation interrupts the attempt in place without a state transition", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const before = fixture.store.getLandingStatusForRun(UNIT_RUN_ID);
    const attempt = new AbortController();
    let cancelled = false;
    const gateway = fakeGithubGateway({
      readActor: async (expectedActor: string) => {
        if (!cancelled) {
          cancelled = true;
          attempt.abort(new Error("operator cancelled"));
          throw new GithubGatewayError("GITHUB_CANCELLED", "A GitHub read did not complete", {
            reason: "cancelled",
            cause: "AbortError",
          });
        }
        return { login: expectedActor, responseSha256: sha256("actor-bytes"), latencyMs: 1 };
      },
    });
    const service = await preflightService(fixture, { gateway: gateway.factory });

    const interrupted = await service.resumeLanding(UNIT_RUN_ID, attempt.signal);
    expect(interrupted.landing).toMatchObject({
      state: "local_ready",
      resumeState: null,
      errorCode: null,
      version: before?.landing.version,
    });
    expect(interrupted.attempts.at(-1)).toMatchObject({
      status: "interrupted",
      errorCode: "GITHUB_CANCELLED",
    });
    expect(interrupted.operations.at(-1)).toMatchObject({
      kind: "github.preflight",
      status: "interrupted",
    });
    expect(
      interrupted.events.filter((event) => event.type === "landing.state.changed"),
    ).toHaveLength(
      (before?.events ?? []).filter((event) => event.type === "landing.state.changed").length,
    );

    const replayed = await service.resumeLanding(UNIT_RUN_ID);
    expect(replayed.landing).toMatchObject({ state: "objects_ready", errorCode: null });
    fixture.store.close();
  });

  test("a missing credential fails before any HTTPS admission or gateway construction", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    let constructions = 0;
    const service = await preflightService(fixture, {
      credentialEnvironment: () => undefined,
      gateway: () => {
        constructions += 1;
        throw new Error("Gateway construction must not be reached");
      },
    });

    const failed = await service.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "local_ready",
      errorCode: "LANDING_CREDENTIAL_MISSING",
    });
    expect(constructions).toBe(0);
    expect(failed.httpRequests).toEqual([]);
    expect(failed.events.some((event) => event.type === "landing.github.request.admitted")).toBe(
      false,
    );
    fixture.store.close();
  });

  test("a hostile provider error cannot reflect the credential into durable evidence", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakeGithubGateway({
      readActor: async () => {
        throw new GithubGatewayError(
          "GITHUB_HTTP_ERROR",
          `GitHub rejected the read_actor operation`,
          { status: 500, note: TOKEN_SENTINEL },
        );
      },
    });
    const service = await preflightService(fixture, { gateway: gateway.factory });

    const failed = await service.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      errorCode: "GITHUB_HTTP_ERROR",
    });
    expect(canonicalLandingJson(failed)).not.toContain(TOKEN_SENTINEL);
    expectNoPersistedToken(fixture.root);
    fixture.store.close();
  });

  test("non-Linux resume refuses at local_ready before credential or gateway effects", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    let constructions = 0;
    const service = await preflightService(fixture, {
      platform: "darwin",
      gateway: () => {
        constructions += 1;
        throw new Error("Gateway construction must not be reached");
      },
    });

    await expectAsyncIcarusCode(() => service.resumeLanding(UNIT_RUN_ID), "UNSUPPORTED_PLATFORM");
    expect(constructions).toBe(0);
    expect(fixture.store.getLandingStatusForRun(UNIT_RUN_ID)?.landing.state).toBe("local_ready");
    fixture.store.close();
  });
});
