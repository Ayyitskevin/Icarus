import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

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
  type LandingGithubGateway,
  type LandingGitService,
} from "../../packages/core/src/service.js";
import type { IcarusStore } from "../../packages/core/src/store.js";
import type {
  CheckpointFile,
  PatchSet,
  VerificationEvidence,
} from "../../packages/core/src/types.js";
import { GithubGatewayError } from "../../packages/github-gateway/src/errors.js";
import {
  createUnitStore,
  seedUnitProject,
  UNIT_BASE_COMMIT,
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
const CREDENTIAL_ENV = "ICARUS_GITHUB_TOKEN_REMOTE";
const TOKEN_SENTINEL = "ghp_REMOTE_SENTINEL_MUST_NOT_LEAK";
const LANDING_HEAD_REF = `refs/heads/icarus/${UNIT_RUN_ID}`;
const BASE_REF = "refs/heads/main";
const OPERATOR = "unit-operator";

const CHANGED_PATHS = ["src/greeting.txt", "src/new.txt", "src/old.txt"] as const;
const UNIT_CHECKPOINT_FILES: readonly CheckpointFile[] = [
  {
    path: "src/greeting.txt",
    op: "modify",
    baselineBase64: Buffer.from("hello\n").toString("base64"),
    approvedBase64: Buffer.from("goodbye\n").toString("base64"),
  },
  {
    path: "src/new.txt",
    op: "create",
    baselineBase64: null,
    approvedBase64: Buffer.from("brand new\n").toString("base64"),
  },
  {
    path: "src/old.txt",
    op: "delete",
    baselineBase64: Buffer.from("ancient\n").toString("base64"),
    approvedBase64: null,
  },
];

const UNIT_MANIFEST = deriveCandidateObjectManifestV1({
  baseCommitSha1: UNIT_BASE_COMMIT,
  baseTreeSha1: BASE_TREE_SHA1,
  candidateTreeSha1: CANDIDATE_TREE_SHA1,
  candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
  candidateCommitPayloadSha256: CANDIDATE_PAYLOAD_SHA256,
  changedPaths: CHANGED_PATHS,
  checkpointFiles: UNIT_CHECKPOINT_FILES,
});
const CANDIDATE_MANIFEST_SHA256 = digestLandingRecord(UNIT_MANIFEST);
const GREETING_BLOB_SHA1 = gitObjectSha1("blob", Buffer.from("goodbye\n"));
const NEW_BLOB_SHA1 = gitObjectSha1("blob", Buffer.from("brand new\n"));

const PROFILE: GitHubLandingProfileV1 = {
  version: 1,
  provider: "github",
  owner: "icarus-test",
  repository: "landing-remote",
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

const UNIT_PLAN_MULTI = {
  summary: "Update the greeting.",
  steps: ["Replace one exact string.", "Run the registered check."],
  risks: ["The expected text may have changed."],
  target: "src/greeting.txt",
  targets: [...CHANGED_PATHS],
  iterationCeiling: 0,
  checkIds: ["unit"],
  grants: [],
} as const;

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
    targets: [...CHANGED_PATHS],
    provider: UNIT_PROVIDER,
  });
  fixture.store.pinRunBase(UNIT_RUN_ID, UNIT_BASE_COMMIT);
  const context = {
    ...unitContextManifest(),
    targets: [...CHANGED_PATHS],
    repositoryMap: [...CHANGED_PATHS],
    entries: CHANGED_PATHS.map((entry) => ({
      path: entry,
      reason: "target" as const,
      bytes: 6,
      sha256: "d".repeat(64),
    })),
    totalBytes: 18,
  };
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
    plan: UNIT_PLAN_MULTI,
    readableManifest: null,
  });
  fixture.store.recordPlanAndAwaitApproval(UNIT_RUN_ID, UNIT_PLAN_MULTI, planSha256);
  fixture.store.approvePlan(UNIT_RUN_ID, planSha256, OPERATOR);
  fixture.store.recordWorkspace(UNIT_RUN_ID, "/tmp/unit-cache.git", "/tmp/unit-worktree", null);
  const checkpointFiles = UNIT_CHECKPOINT_FILES;
  const patchSet: PatchSet = {
    summary: "Update the fixture greeting.",
    edits: [
      {
        op: "modify",
        path: "src/greeting.txt",
        expectedPreimageSha256: sha256("hello\n"),
        replacements: [{ findText: "hello", replaceText: "goodbye" }],
        rationale: "Exercise the remote mutation landing stages.",
      },
      {
        op: "create",
        path: "src/new.txt",
        content: "brand new\n",
        rationale: "A created file with a fresh remote blob.",
      },
      {
        op: "delete",
        path: "src/old.txt",
        expectedPreimageSha256: sha256("ancient\n"),
        rationale: "A deleted file with a null tree entry.",
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
    changedPaths: [...CHANGED_PATHS],
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
    OPERATOR,
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
const HEAD_DIRECT_PROJECTION = {
  type: "ref",
  state: "direct",
  ref: LANDING_HEAD_REF,
  sha1: CANDIDATE_COMMIT_SHA1,
} as const;

function settleRead(
  store: IcarusStore,
  landingId: string,
  operationId: string,
  kind: "github.actor.get" | "github.base_ref.get" | "github.head_ref.get",
  projection: unknown,
  httpStatus = 200,
): string {
  const admission = store.admitGithubRequest(landingId, operationId, kind);
  store.settleGithubRequest(landingId, admission.requestId, {
    outcome: "succeeded",
    httpStatus,
    projection: projection as never,
    errorCode: null,
  });
  return admission.requestId;
}

/** Runs the preflight at a stable state and leaves the attempt open for its effect. */
function settlePreflightForChain(store: IcarusStore, landingId: string): string {
  const started = store.startGithubPreflight(landingId);
  settleRead(store, landingId, started.operationId, "github.actor.get", ACTOR_PROJECTION);
  settleRead(store, landingId, started.operationId, "github.base_ref.get", BASE_PROJECTION);
  settleRead(
    store,
    landingId,
    started.operationId,
    "github.head_ref.get",
    HEAD_ABSENT_PROJECTION,
    404,
  );
  store.settleGithubPreflight(landingId, {
    outcome: "completed",
    errorCode: null,
    closeAttempt: false,
  });
  return started.operationId;
}

/** Runs one full object-upload stage against the store. */
function completeStoreUpload(store: IcarusStore, landingId: string): LandingStatusV1 {
  const started = store.startGithubObjectsUpload(landingId);
  settleRead(store, landingId, started.operationId, "github.actor.get", ACTOR_PROJECTION);
  store.recordGithubOperationObservation(landingId, started.operationId);
  for (const [index, sha1] of [GREETING_BLOB_SHA1, NEW_BLOB_SHA1].entries()) {
    void index;
    const admission = store.admitGithubRequest(landingId, started.operationId, "github.blob.post");
    store.settleGithubRequest(landingId, admission.requestId, {
      outcome: "succeeded",
      httpStatus: 201,
      projection: { type: "object", objectKind: "blob", sha1 },
      errorCode: null,
    });
  }
  const tree = store.admitGithubRequest(landingId, started.operationId, "github.tree.post");
  store.settleGithubRequest(landingId, tree.requestId, {
    outcome: "succeeded",
    httpStatus: 201,
    projection: { type: "object", objectKind: "tree", sha1: CANDIDATE_TREE_SHA1 },
    errorCode: null,
  });
  const commit = store.admitGithubRequest(landingId, started.operationId, "github.commit.post");
  store.settleGithubRequest(landingId, commit.requestId, {
    outcome: "succeeded",
    httpStatus: 201,
    projection: { type: "object", objectKind: "commit", sha1: CANDIDATE_COMMIT_SHA1 },
    errorCode: null,
  });
  return store.settleGithubObjectsUpload(landingId, { outcome: "completed", errorCode: null });
}

/** Runs one full absent-only remote-ref stage against the store. */
function completeStoreRemoteRef(store: IcarusStore, landingId: string): LandingStatusV1 {
  const started = store.startGithubRemoteRef(landingId);
  settleRead(store, landingId, started.operationId, "github.actor.get", ACTOR_PROJECTION);
  settleRead(store, landingId, started.operationId, "github.base_ref.get", BASE_PROJECTION);
  settleRead(
    store,
    landingId,
    started.operationId,
    "github.head_ref.get",
    HEAD_ABSENT_PROJECTION,
    404,
  );
  store.recordGithubOperationObservation(landingId, started.operationId);
  const post = store.admitGithubRequest(landingId, started.operationId, "github.ref.post");
  store.settleGithubRequest(landingId, post.requestId, {
    outcome: "succeeded",
    httpStatus: 201,
    projection: { type: "object", objectKind: "ref", sha1: CANDIDATE_COMMIT_SHA1 },
    errorCode: null,
  });
  settleRead(store, landingId, started.operationId, "github.head_ref.get", HEAD_DIRECT_PROJECTION);
  settleRead(store, landingId, started.operationId, "github.base_ref.get", BASE_PROJECTION);
  return store.settleGithubRemoteRef(landingId, { outcome: "completed", errorCode: null });
}

describe("durable remote mutation store slice (object upload + remote ref)", () => {
  test("runs local_ready to remote_ready with exact attempt shapes and bindings", () => {
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);

    // Attempt 3: preflight + object upload.
    fixture.store.admitLandingResume(ready.landing.id);
    const preflightId = settlePreflightForChain(fixture.store, ready.landing.id);
    const uploaded = completeStoreUpload(fixture.store, ready.landing.id);
    expect(uploaded.landing).toMatchObject({ state: "objects_ready", errorCode: null });
    const upload = uploaded.operations.at(-1);
    expect(upload).toMatchObject({
      kind: "github.objects.upload",
      kindAttempt: 1,
      status: "completed",
      coordinatorAttempt: 3,
    });
    const preflight = uploaded.operations.find((operation) => operation.id === preflightId);
    expect(upload?.request.input).toMatchObject({
      landingSha256: uploaded.landing.landingSha256,
      candidateObjectManifestSha256: CANDIDATE_MANIFEST_SHA256,
      changedPathsSha256: uploaded.landing.changedPathsSha256,
      preflightOperationId: preflightId,
      preflightResultSha256: preflight?.resultSha256,
      retrySubjectOperationId: null,
      retrySubjectRequestSha256: null,
    });
    expect(upload?.observation?.facts).toHaveLength(1);
    expect(upload?.result?.evidence).toHaveLength(5);
    expect(uploaded.httpRequests.map((row) => [row.coordinatorAttempt, row.kind])).toEqual([
      [3, "github.actor.get"],
      [3, "github.base_ref.get"],
      [3, "github.head_ref.get"],
      [3, "github.actor.get"],
      [3, "github.blob.post"],
      [3, "github.blob.post"],
      [3, "github.tree.post"],
      [3, "github.commit.post"],
    ]);
    // The tree entry carries the deletion's null sha; the blob digests bind
    // the exact approved bytes.
    const blobRows = uploaded.httpRequests.filter((row) => row.kind === "github.blob.post");
    expect(blobRows.map((row) => row.request.subject.expectedBlobSha1)).toEqual([
      GREETING_BLOB_SHA1,
      NEW_BLOB_SHA1,
    ]);
    const treeRow = uploaded.httpRequests.find((row) => row.kind === "github.tree.post");
    expect(treeRow?.request.subject).toMatchObject({
      baseTreeSha1: BASE_TREE_SHA1,
      expectedTreeSha1: CANDIDATE_TREE_SHA1,
    });
    expect(treeRow?.request.bodySha256).not.toBeNull();

    // Attempt 4: preflight + remote ref.
    fixture.store.admitLandingResume(ready.landing.id);
    settlePreflightForChain(fixture.store, ready.landing.id);
    const remoteReady = completeStoreRemoteRef(fixture.store, ready.landing.id);
    expect(remoteReady.landing).toMatchObject({ state: "remote_ready", errorCode: null });
    const refCreate = remoteReady.operations.at(-1);
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
    expect(refCreate?.result?.evidence).toHaveLength(6);
    // Attempts 3 and 4 each carry the ordered [preflight, effect] pair, and
    // the attempt settlement follows the last operation's settlement.
    expect(
      remoteReady.events
        .filter((event) => event.type === "landing.state.changed")
        .map((event) => {
          const payload = event.payload as { readonly from: string; readonly to: string };
          return `${payload.from}->${payload.to}`;
        }),
    ).toEqual([
      "preparing_candidate->awaiting_approval",
      "awaiting_approval->approved",
      "approved->creating_local_ref",
      "creating_local_ref->local_ready",
      "local_ready->uploading_objects",
      "uploading_objects->objects_ready",
      "objects_ready->creating_remote_ref",
      "creating_remote_ref->remote_ready",
    ]);
    // remote_ready parks: no admission is legal until the draft-PR slice.
    expect(fixture.store.admitLandingResume(ready.landing.id)).toMatchObject({
      attemptOrdinal: null,
      attemptLimitReached: false,
    });
    fixture.store.close();
  });

  test("refuses grammar, kind-attach, and preflight-binding violations", () => {
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);

    // An effect cannot start without its immediately preceding completed
    // preflight in the same attempt.
    fixture.store.admitLandingResume(ready.landing.id);
    expectIcarusCode(
      () => fixture.store.startGithubObjectsUpload(ready.landing.id),
      "LANDING_RECORD_INVALID",
    );
    settlePreflightForChain(fixture.store, ready.landing.id);
    const started = fixture.store.startGithubObjectsUpload(ready.landing.id);

    // Blob before the actor read is out of grammar; a second POST kind cannot
    // attach to the upload; the ref POST cannot cross-attach.
    expectIcarusCode(
      () =>
        fixture.store.admitGithubRequest(ready.landing.id, started.operationId, "github.blob.post"),
      "LANDING_RECORD_INVALID",
    );
    expectIcarusCode(
      () =>
        fixture.store.admitGithubRequest(ready.landing.id, started.operationId, "github.ref.post"),
      "LANDING_RECORD_INVALID",
    );
    settleRead(
      fixture.store,
      ready.landing.id,
      started.operationId,
      "github.actor.get",
      ACTOR_PROJECTION,
    );
    fixture.store.recordGithubOperationObservation(ready.landing.id, started.operationId);
    const blob = fixture.store.admitGithubRequest(
      ready.landing.id,
      started.operationId,
      "github.blob.post",
    );
    // The returned object name must equal the locally computed identity: a
    // mismatched projection cannot settle succeeded at the durable boundary.
    expectIcarusCode(
      () =>
        fixture.store.settleGithubRequest(ready.landing.id, blob.requestId, {
          outcome: "succeeded",
          httpStatus: 201,
          projection: { type: "object", objectKind: "blob", sha1: "9".repeat(40) },
          errorCode: null,
        }),
      "LANDING_RECORD_INVALID",
    );
    fixture.store.settleGithubRequest(ready.landing.id, blob.requestId, {
      outcome: "succeeded",
      httpStatus: 201,
      projection: { type: "object", objectKind: "blob", sha1: GREETING_BLOB_SHA1 },
      errorCode: null,
    });
    // A failed completion proposal never persists: the grammar is incomplete.
    expectIcarusCode(
      () =>
        fixture.store.settleGithubObjectsUpload(ready.landing.id, {
          outcome: "completed",
          errorCode: null,
        }),
      "LANDING_RECORD_INVALID",
    );
    // A failure after the first mutating POST must reconcile, not fail.
    expectIcarusCode(
      () =>
        fixture.store.settleGithubObjectsUpload(ready.landing.id, {
          outcome: "failed",
          errorCode: "GITHUB_HTTP_ERROR",
        }),
      "LANDING_RECORD_INVALID",
    );
    const held = fixture.store.settleGithubObjectsUpload(ready.landing.id, {
      outcome: "reconciliation_required",
      errorCode: "LANDING_GITHUB_POST_FAILED",
    });
    expect(held.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "local_ready",
      errorCode: "LANDING_GITHUB_POST_FAILED",
    });
    fixture.store.close();
  });

  test("remote-ref settlement derives outcome and residue, never caller-chosen", () => {
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);
    fixture.store.admitLandingResume(ready.landing.id);
    settlePreflightForChain(fixture.store, ready.landing.id);
    completeStoreUpload(fixture.store, ready.landing.id);

    fixture.store.admitLandingResume(ready.landing.id);
    settlePreflightForChain(fixture.store, ready.landing.id);
    const started = fixture.store.startGithubRemoteRef(ready.landing.id);
    settleRead(
      fixture.store,
      ready.landing.id,
      started.operationId,
      "github.actor.get",
      ACTOR_PROJECTION,
    );
    settleRead(
      fixture.store,
      ready.landing.id,
      started.operationId,
      "github.base_ref.get",
      BASE_PROJECTION,
    );
    settleRead(
      fixture.store,
      ready.landing.id,
      started.operationId,
      "github.head_ref.get",
      HEAD_ABSENT_PROJECTION,
      404,
    );
    fixture.store.recordGithubOperationObservation(ready.landing.id, started.operationId);
    const post = fixture.store.admitGithubRequest(
      ready.landing.id,
      started.operationId,
      "github.ref.post",
    );
    // The POST is refused; the suffix proves the branch never existed.
    fixture.store.settleGithubRequest(ready.landing.id, post.requestId, {
      outcome: "failed",
      httpStatus: 422,
      projection: null,
      errorCode: "GITHUB_REF_CREATE_REFUSED",
    });
    settleRead(
      fixture.store,
      ready.landing.id,
      started.operationId,
      "github.head_ref.get",
      HEAD_ABSENT_PROJECTION,
      404,
    );
    settleRead(
      fixture.store,
      ready.landing.id,
      started.operationId,
      "github.base_ref.get",
      BASE_PROJECTION,
    );
    const failed = fixture.store.settleGithubRemoteRef(ready.landing.id, {
      outcome: "failed",
      errorCode: "GITHUB_REF_CREATE_REFUSED",
    });
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "objects_ready",
      errorCode: "GITHUB_REF_CREATE_REFUSED",
    });

    // A completion proposed over a failed mutation row is impossible.
    const drifted = seedEligibleRun();
    const driftedReady = localReadyLanding(drifted.store);
    drifted.store.admitLandingResume(driftedReady.landing.id);
    settlePreflightForChain(drifted.store, driftedReady.landing.id);
    completeStoreUpload(drifted.store, driftedReady.landing.id);
    drifted.store.admitLandingResume(driftedReady.landing.id);
    settlePreflightForChain(drifted.store, driftedReady.landing.id);
    const driftedStart = drifted.store.startGithubRemoteRef(driftedReady.landing.id);
    settleRead(
      drifted.store,
      driftedReady.landing.id,
      driftedStart.operationId,
      "github.actor.get",
      ACTOR_PROJECTION,
    );
    settleRead(
      drifted.store,
      driftedReady.landing.id,
      driftedStart.operationId,
      "github.base_ref.get",
      BASE_PROJECTION,
    );
    settleRead(
      drifted.store,
      driftedReady.landing.id,
      driftedStart.operationId,
      "github.head_ref.get",
      HEAD_ABSENT_PROJECTION,
      404,
    );
    drifted.store.recordGithubOperationObservation(
      driftedReady.landing.id,
      driftedStart.operationId,
    );
    const driftedPost = drifted.store.admitGithubRequest(
      driftedReady.landing.id,
      driftedStart.operationId,
      "github.ref.post",
    );
    drifted.store.settleGithubRequest(driftedReady.landing.id, driftedPost.requestId, {
      outcome: "ambiguous",
      httpStatus: null,
      projection: null,
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    // The suffix observes the branch created but the base moved: hold with
    // the branch residue honestly derived.
    settleRead(
      drifted.store,
      driftedReady.landing.id,
      driftedStart.operationId,
      "github.head_ref.get",
      HEAD_DIRECT_PROJECTION,
    );
    settleRead(
      drifted.store,
      driftedReady.landing.id,
      driftedStart.operationId,
      "github.base_ref.get",
      {
        type: "ref",
        state: "direct",
        ref: BASE_REF,
        sha1: "9".repeat(40),
      },
    );
    const held = drifted.store.settleGithubRemoteRef(driftedReady.landing.id, {
      outcome: "reconciliation_required",
      errorCode: "LANDING_REMOTE_BASE_CHANGED",
    });
    expect(held.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "objects_ready",
      errorCode: "LANDING_REMOTE_BASE_CHANGED",
    });
    expect(held.operations.at(-1)?.result).toMatchObject({
      outcome: "reconciliation_required",
      value: { subjectOperationId: driftedStart.operationId, remoteResidue: "branch" },
    });
    drifted.store.close();
    fixture.store.close();
  });

  test("a two-operation attempt settles the attempt after its last operation", () => {
    // The ii-a replay rule assumed every settled operation was immediately
    // followed by the attempt settlement; the [preflight, effect] attempt
    // proves the corrected rule by loading at every boundary.
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);
    fixture.store.admitLandingResume(ready.landing.id);
    settlePreflightForChain(fixture.store, ready.landing.id);
    const mid = fixture.store.getLandingStatus(ready.landing.id);
    expect(mid.attempts.at(-1)).toMatchObject({ status: "started" });
    expect(mid.operations.at(-1)).toMatchObject({
      kind: "github.preflight",
      status: "completed",
    });
    const uploaded = completeStoreUpload(fixture.store, ready.landing.id);
    expect(uploaded.attempts.at(-1)).toMatchObject({ status: "completed" });
    const attemptEvents = uploaded.events.filter(
      (event) =>
        event.type === "landing.attempt.settled" &&
        (event.payload as { readonly coordinatorAttempt?: unknown }).coordinatorAttempt === 3,
    );
    expect(attemptEvents).toHaveLength(1);
    const lastOperationSettled = uploaded.events
      .filter((event) => event.type === "landing.operation.settled")
      .at(-1);
    expect(lastOperationSettled?.sequence).toBe((attemptEvents[0]?.sequence ?? 0) - 1);
    fixture.store.close();
  });

  test("fail-closed load rejects residue and outcome-derivation drift", () => {
    // A remote-ref reconciliation result whose residue contradicts the durable
    // rows cannot load.
    const fixture = seedEligibleRun();
    const ready = localReadyLanding(fixture.store);
    fixture.store.admitLandingResume(ready.landing.id);
    settlePreflightForChain(fixture.store, ready.landing.id);
    completeStoreUpload(fixture.store, ready.landing.id);
    fixture.store.admitLandingResume(ready.landing.id);
    settlePreflightForChain(fixture.store, ready.landing.id);
    const started = fixture.store.startGithubRemoteRef(ready.landing.id);
    settleRead(
      fixture.store,
      ready.landing.id,
      started.operationId,
      "github.actor.get",
      ACTOR_PROJECTION,
    );
    settleRead(
      fixture.store,
      ready.landing.id,
      started.operationId,
      "github.base_ref.get",
      BASE_PROJECTION,
    );
    settleRead(
      fixture.store,
      ready.landing.id,
      started.operationId,
      "github.head_ref.get",
      HEAD_ABSENT_PROJECTION,
      404,
    );
    fixture.store.recordGithubOperationObservation(ready.landing.id, started.operationId);
    const post = fixture.store.admitGithubRequest(
      ready.landing.id,
      started.operationId,
      "github.ref.post",
    );
    fixture.store.settleGithubRequest(ready.landing.id, post.requestId, {
      outcome: "ambiguous",
      httpStatus: null,
      projection: null,
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    settleRead(
      fixture.store,
      ready.landing.id,
      started.operationId,
      "github.head_ref.get",
      HEAD_ABSENT_PROJECTION,
      404,
    );
    settleRead(
      fixture.store,
      ready.landing.id,
      started.operationId,
      "github.base_ref.get",
      BASE_PROJECTION,
    );
    const held = fixture.store.settleGithubRemoteRef(ready.landing.id, {
      outcome: "reconciliation_required",
      errorCode: "LANDING_REMOTE_REF_OUTCOME_AMBIGUOUS",
    });
    expect(held.operations.at(-1)?.result).toMatchObject({
      value: { remoteResidue: "none" },
    });

    const database = new Database(fixture.databasePath);
    const row = database
      .prepare("SELECT result_json FROM landing_operations WHERE id = ?")
      .get(started.operationId) as { readonly result_json: string };
    const result = JSON.parse(row.result_json) as {
      readonly value: Record<string, unknown>;
    };
    const drifted = { ...result, value: { ...result.value, remoteResidue: "branch" } };
    const driftedJson = canonicalLandingJson(drifted);
    database
      .prepare("UPDATE landing_operations SET result_json = ?, result_sha256 = ? WHERE id = ?")
      .run(driftedJson, sha256(driftedJson), started.operationId);
    database.close();
    expectIcarusCode(
      () => fixture.store.getLandingStatus(ready.landing.id),
      "LANDING_RECORD_INVALID",
    );
    fixture.store.close();
  });
});

// ---------------------------------------------------------------------------
// Coordinator-level: the two mutation stages driven through the service resume
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

interface FakeRemote {
  /** The remote's refs by full name; mutate between resumes to drive drift. */
  readonly refs: Map<string, string>;
  /** The remote base branch's current object name. */
  baseSha1: string;
}

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

function fakeRemoteGateway(behavior: GatewayBehavior = {}): {
  readonly factory: (credential: string) => LandingGithubGateway;
  readonly calls: string[];
  readonly credentials: readonly string[];
  readonly remote: FakeRemote;
} {
  const calls: string[] = [];
  const credentials: string[] = [];
  const remote: FakeRemote = { refs: new Map(), baseSha1: UNIT_BASE_COMMIT };
  const factory = (credential: string): LandingGithubGateway => {
    credentials.push(credential);
    return {
      readActor:
        behavior.readActor ??
        (async (expectedActor: string) => {
          calls.push("actor");
          return { login: expectedActor, responseSha256: sha256("actor-bytes"), latencyMs: 1 };
        }),
      readBaseReference:
        behavior.readBaseReference ??
        (async (_coordinates, ref) => {
          calls.push("base");
          return {
            ref,
            sha: remote.baseSha1,
            responseSha256: sha256("base-bytes"),
            latencyMs: 1,
          };
        }),
      readReference:
        behavior.readReference ??
        (async (_coordinates, ref) => {
          calls.push("head");
          const sha = remote.refs.get(ref);
          return sha === undefined
            ? null
            : { ref, sha, responseSha256: sha256("head-bytes"), latencyMs: 1 };
        }),
      readPullRequestByHead: async () => {
        throw new Error("Pull-request reads are not part of this slice");
      },
      createBlob:
        behavior.createBlob ??
        (async (_coordinates, contentBase64) => {
          calls.push("blob");
          return {
            sha: gitObjectSha1("blob", Buffer.from(contentBase64, "base64")),
            responseSha256: sha256("blob-bytes"),
            latencyMs: 1,
          };
        }),
      createTree:
        behavior.createTree ??
        (async () => {
          calls.push("tree");
          return {
            sha: CANDIDATE_TREE_SHA1,
            responseSha256: sha256("tree-bytes"),
            latencyMs: 1,
          };
        }),
      createCommit:
        behavior.createCommit ??
        (async () => {
          calls.push("commit");
          return {
            sha: CANDIDATE_COMMIT_SHA1,
            responseSha256: sha256("commit-bytes"),
            latencyMs: 1,
          };
        }),
      createAbsentRef:
        behavior.createAbsentRef ??
        (async (_coordinates, ref, sha) => {
          calls.push("ref");
          remote.refs.set(ref, sha);
          return { ref, sha, responseSha256: sha256("ref-bytes"), latencyMs: 1 };
        }),
    };
  };
  return { factory, calls, credentials, remote };
}

let serviceStateNonce = 0;

async function remoteService(
  fixture: ReturnType<typeof seedEligibleRun>,
  options: {
    readonly gateway?: (credential: string) => LandingGithubGateway;
    readonly credentialEnvironment?: (name: string) => string | undefined;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<IcarusService> {
  serviceStateNonce += 1;
  const stateRoot = path.join(fixture.root, `landing-service-state-${serviceStateNonce}`);
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

describe("landing service remote mutation stages", () => {
  test("drives the full chain to remote_ready with per-stage scoped credentials", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakeRemoteGateway();
    const service = await remoteService(fixture, { gateway: gateway.factory });

    const uploaded = await service.resumeLanding(UNIT_RUN_ID);
    expect(uploaded.landing).toMatchObject({ state: "objects_ready", errorCode: null });
    expect(gateway.calls).toEqual([
      "actor",
      "base",
      "head",
      "actor",
      "blob",
      "blob",
      "tree",
      "commit",
    ]);
    const landed = await service.resumeLanding(UNIT_RUN_ID);
    expect(landed.landing).toMatchObject({ state: "remote_ready", errorCode: null });
    expect(gateway.calls).toEqual([
      "actor",
      "base",
      "head",
      "actor",
      "blob",
      "blob",
      "tree",
      "commit",
      "actor",
      "base",
      "head",
      "actor",
      "base",
      "head",
      "ref",
      "head",
      "base",
    ]);
    // Each stage resolves the credential into its own scoped gateway; the
    // value is never persisted.
    expect(gateway.credentials).toEqual([
      TOKEN_SENTINEL,
      TOKEN_SENTINEL,
      TOKEN_SENTINEL,
      TOKEN_SENTINEL,
    ]);
    expect(landed.operations.at(-1)?.result).toMatchObject({
      boundary: "remote_ref_ready",
      value: { remoteRefOutcome: "created" },
    });
    expectNoPersistedToken(fixture.root);
    fixture.store.close();
  });

  test("a contradicting blob response reconciles, then replays byte-identically", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    let contradict = true;
    const gateway = fakeRemoteGateway({
      createBlob: async (_coordinates, contentBase64) => {
        if (contradict) {
          return {
            sha: "9".repeat(40),
            responseSha256: sha256("blob-bytes"),
            latencyMs: 1,
          };
        }
        return {
          sha: gitObjectSha1("blob", Buffer.from(contentBase64, "base64")),
          responseSha256: sha256("blob-bytes"),
          latencyMs: 1,
        };
      },
    });
    const service = await remoteService(fixture, { gateway: gateway.factory });

    const held = await service.resumeLanding(UNIT_RUN_ID);
    expect(held.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "local_ready",
      errorCode: "GITHUB_PROTOCOL_ERROR",
    });
    expect(held.httpRequests.at(-1)).toMatchObject({
      kind: "github.blob.post",
      outcome: "ambiguous",
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });

    // The reconciliation performs no fresh reads and authorizes the retry.
    const retry = await service.resumeLanding(UNIT_RUN_ID);
    expect(retry.landing).toMatchObject({ state: "local_ready", errorCode: null });
    contradict = false;
    const completed = await service.resumeLanding(UNIT_RUN_ID);
    expect(completed.landing).toMatchObject({ state: "objects_ready", errorCode: null });
    const uploads = completed.operations.filter(
      (operation) => operation.kind === "github.objects.upload",
    );
    expect(uploads.map((operation) => [operation.kindAttempt, operation.status])).toEqual([
      [1, "interrupted"],
      [2, "completed"],
    ]);
    // The retry binds the interrupted subject and its reconciliation grant.
    expect(uploads[1]?.request.input).toMatchObject({
      retrySubjectOperationId: uploads[0]?.id,
      retrySubjectRequestSha256: uploads[0]?.requestSha256,
    });
    const firstBlob = completed.httpRequests.find(
      (row) => row.operationId === uploads[0]?.id && row.kind === "github.blob.post",
    );
    const secondBlobs = completed.httpRequests.filter(
      (row) => row.operationId === uploads[1]?.id && row.kind === "github.blob.post",
    );
    expect(secondBlobs.map((row) => row.request.bodySha256)).toEqual([
      firstBlob?.request.bodySha256,
      expect.any(String),
    ]);
    fixture.store.close();
  });

  test("a definitive blob refusal reconciles and retries", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    let refuse = true;
    const gateway = fakeRemoteGateway({
      createBlob: async (_coordinates, contentBase64) => {
        if (refuse) {
          throw new GithubGatewayError(
            "GITHUB_HTTP_ERROR",
            "GitHub rejected the create_blob operation",
            {
              status: 403,
              responseSha256: sha256("refusal"),
              retryAfterSeconds: null,
              rateLimitRemaining: null,
            },
          );
        }
        return {
          sha: gitObjectSha1("blob", Buffer.from(contentBase64, "base64")),
          responseSha256: sha256("blob-bytes"),
          latencyMs: 1,
        };
      },
    });
    const service = await remoteService(fixture, { gateway: gateway.factory });

    const held = await service.resumeLanding(UNIT_RUN_ID);
    expect(held.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "local_ready",
      errorCode: "GITHUB_HTTP_ERROR",
    });
    expect(held.httpRequests.at(-1)).toMatchObject({
      kind: "github.blob.post",
      outcome: "failed",
      httpStatus: 403,
    });

    refuse = false;
    const retry = await service.resumeLanding(UNIT_RUN_ID);
    expect(retry.landing).toMatchObject({ state: "local_ready", errorCode: null });
    const completed = await service.resumeLanding(UNIT_RUN_ID);
    expect(completed.landing).toMatchObject({ state: "objects_ready", errorCode: null });
    fixture.store.close();
  });

  test("a pre-existing remote head is a conflict the ref stage never adopts", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    // The head appears between the preflight's absence read and the ref
    // stage's own head read: the ref stage must refuse rather than adopt it.
    let headCalls = 0;
    let injectOnThirdRead = true;
    const gateway = fakeRemoteGateway({
      readReference: async (_coordinates, ref) => {
        headCalls += 1;
        // Resume one reads the head once (preflight); resume two reads it at
        // the preflight and then at the ref stage's own pre-POST read — the
        // third call — where the phantom branch must be refused.
        if (injectOnThirdRead && headCalls === 3) {
          return {
            ref,
            sha: CANDIDATE_COMMIT_SHA1,
            responseSha256: sha256("head-bytes"),
            latencyMs: 1,
          };
        }
        const sha = gateway.remote.refs.get(ref);
        return sha === undefined
          ? null
          : { ref, sha, responseSha256: sha256("head-bytes"), latencyMs: 1 };
      },
    });
    const service = await remoteService(fixture, { gateway: gateway.factory });

    await service.resumeLanding(UNIT_RUN_ID);
    const failed = await service.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "objects_ready",
      errorCode: "LANDING_REMOTE_HEAD_CONFLICT",
    });
    const refCreate = failed.operations.at(-1);
    expect(refCreate?.kind).toBe("github.ref.create");
    // No mutation was admitted for this operation: the head existed before
    // Icarus recorded absence, so the POST never ran.
    expect(
      failed.httpRequests.some(
        (row) => row.operationId === refCreate?.id && row.kind === "github.ref.post",
      ),
    ).toBe(false);

    injectOnThirdRead = false;
    const completed = await service.resumeLanding(UNIT_RUN_ID);
    expect(completed.landing).toMatchObject({ state: "remote_ready", errorCode: null });
    fixture.store.close();
  });

  test("a refused remote-ref POST with an absent head fails back to objects_ready for retry", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    let refuse = true;
    const gateway = fakeRemoteGateway({
      createAbsentRef: async (_coordinates, ref, sha) => {
        if (refuse) {
          throw new GithubGatewayError(
            "GITHUB_REF_CREATE_REFUSED",
            "GitHub refused to create the Icarus reference; nothing was modified",
            { status: 422, responseSha256: sha256("refusal") },
          );
        }
        gateway.remote.refs.set(ref, sha);
        return { ref, sha, responseSha256: sha256("ref-bytes"), latencyMs: 1 };
      },
    });
    const service = await remoteService(fixture, { gateway: gateway.factory });

    await service.resumeLanding(UNIT_RUN_ID);
    const failed = await service.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "objects_ready",
      errorCode: "GITHUB_REF_CREATE_REFUSED",
    });
    expect(failed.httpRequests.at(-1)).toMatchObject({
      kind: "github.base_ref.get",
      outcome: "succeeded",
    });

    // The retry re-runs the whole stage with a fresh operation and one new
    // absent-only POST whose body is byte-identical.
    refuse = false;
    const completed = await service.resumeLanding(UNIT_RUN_ID);
    expect(completed.landing).toMatchObject({ state: "remote_ready", errorCode: null });
    const refPosts = completed.httpRequests.filter((row) => row.kind === "github.ref.post");
    expect(refPosts).toHaveLength(2);
    expect(refPosts[1]?.request.bodySha256).toBe(refPosts[0]?.request.bodySha256);
    fixture.store.close();
  });

  test("an ambiguous remote-ref POST with an exact suffix reconciles as reconciled", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakeRemoteGateway({
      createAbsentRef: async (_coordinates, ref, sha) => {
        // The effect landed but the response is lost: the gateway reports the
        // ambiguity, and the fake remote now holds the ref.
        gateway.remote.refs.set(ref, sha);
        throw new GithubGatewayError(
          "GITHUB_OUTCOME_AMBIGUOUS",
          "A dispatched GitHub mutation was interrupted and its remote outcome is unknown",
          { reason: "timeout", cause: "TimeoutError" },
        );
      },
    });
    const service = await remoteService(fixture, { gateway: gateway.factory });

    await service.resumeLanding(UNIT_RUN_ID);
    const landed = await service.resumeLanding(UNIT_RUN_ID);
    expect(landed.landing).toMatchObject({ state: "remote_ready", errorCode: null });
    expect(landed.httpRequests.find((row) => row.kind === "github.ref.post")).toMatchObject({
      outcome: "ambiguous",
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    expect(landed.operations.at(-1)?.result).toMatchObject({
      boundary: "remote_ref_ready",
      value: { remoteRefOutcome: "reconciled" },
    });
    fixture.store.close();
  });

  test("an ambiguous remote-ref POST with an absent suffix fails back for retry", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakeRemoteGateway({
      createAbsentRef: async () => {
        throw new GithubGatewayError(
          "GITHUB_OUTCOME_AMBIGUOUS",
          "A dispatched GitHub mutation was interrupted and its remote outcome is unknown",
          { reason: "transport", cause: "SocketError" },
        );
      },
    });
    const service = await remoteService(fixture, { gateway: gateway.factory });

    await service.resumeLanding(UNIT_RUN_ID);
    const failed = await service.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "objects_ready",
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    fixture.store.close();
  });

  test("an ambiguous remote-ref POST with a drifted base holds with branch residue", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakeRemoteGateway({
      createAbsentRef: async (_coordinates, ref, sha) => {
        // The branch was created, but the response is lost and the base moved
        // before the post-reads could confirm: preserve the residue and hold.
        gateway.remote.refs.set(ref, sha);
        gateway.remote.baseSha1 = "9".repeat(40);
        throw new GithubGatewayError(
          "GITHUB_OUTCOME_AMBIGUOUS",
          "A dispatched GitHub mutation was interrupted and its remote outcome is unknown",
          { reason: "timeout", cause: "TimeoutError" },
        );
      },
    });
    const service = await remoteService(fixture, { gateway: gateway.factory });

    await service.resumeLanding(UNIT_RUN_ID);
    const held = await service.resumeLanding(UNIT_RUN_ID);
    expect(held.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "objects_ready",
      errorCode: "LANDING_REMOTE_BASE_CHANGED",
    });
    expect(held.operations.at(-1)?.result).toMatchObject({
      outcome: "reconciliation_required",
      value: { remoteResidue: "branch" },
    });
    fixture.store.close();
  });

  test("a missing credential at the ref stage fails before any HTTPS admission", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    // Upload completes with a credential; the ref stage then finds none.
    const withCredential = await remoteService(fixture, {
      gateway: fakeRemoteGateway().factory,
    });
    await withCredential.resumeLanding(UNIT_RUN_ID);
    let constructions = 0;
    const noCredential = await remoteService(fixture, {
      credentialEnvironment: () => undefined,
      gateway: () => {
        constructions += 1;
        throw new Error("Gateway construction must not be reached");
      },
    });
    const failed = await noCredential.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "objects_ready",
      errorCode: "LANDING_CREDENTIAL_MISSING",
    });
    expect(constructions).toBe(0);
    expect(
      failed.httpRequests.filter(
        (row) => row.coordinatorAttempt === failed.attempts.at(-1)?.ordinal,
      ),
    ).toEqual([]);
    fixture.store.close();
  });

  test("a hostile provider POST error cannot reflect the credential into durable evidence", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakeRemoteGateway({
      createBlob: async () => {
        throw new GithubGatewayError(
          "GITHUB_HTTP_ERROR",
          "GitHub rejected the create_blob operation",
          {
            status: 500,
            note: TOKEN_SENTINEL,
          },
        );
      },
    });
    const service = await remoteService(fixture, { gateway: gateway.factory });

    const held = await service.resumeLanding(UNIT_RUN_ID);
    expect(held.landing.state).toBe("reconciliation_required");
    expect(canonicalLandingJson(held)).not.toContain(TOKEN_SENTINEL);
    expectNoPersistedToken(fixture.root);
    fixture.store.close();
  });

  test("non-Linux resume refuses at objects_ready before credential or gateway effects", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const service = await remoteService(fixture, {
      gateway: fakeRemoteGateway().factory,
    });
    await service.resumeLanding(UNIT_RUN_ID);
    const darwin = await remoteService(fixture, {
      gateway: fakeRemoteGateway().factory,
      platform: "darwin",
    });
    await expect(darwin.resumeLanding(UNIT_RUN_ID)).rejects.toMatchObject({
      code: "UNSUPPORTED_PLATFORM",
    });
    expect(fixture.store.getLandingStatusForRun(UNIT_RUN_ID)?.landing.state).toBe("objects_ready");
    fixture.store.close();
  });
});
