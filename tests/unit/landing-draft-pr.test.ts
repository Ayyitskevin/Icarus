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
  type PullRequestProjectionV1,
  renderPullRequestBodyV1,
} from "../../packages/core/src/landing-records.js";
import { planApprovalDigest, treeCheckpointDigest } from "../../packages/core/src/policy.js";
import type { CheckRunner } from "../../packages/core/src/sandbox.js";
import {
  IcarusService,
  type LandingGithubGateway,
  type LandingGitService,
} from "../../packages/core/src/service.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import type {
  CheckpointFile,
  PatchSet,
  VerificationEvidence,
} from "../../packages/core/src/types.js";
import { GithubGatewayError } from "../../packages/github-gateway/src/errors.js";
import type { GithubPullRequestReceipt } from "../../packages/github-gateway/src/gateway.js";
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
const CREDENTIAL_ENV = "ICARUS_GITHUB_TOKEN_DRAFT_PR";
const TOKEN_SENTINEL = "ghp_DRAFT_PR_SENTINEL_MUST_NOT_LEAK";
const LANDING_HEAD_REF = `refs/heads/icarus/${UNIT_RUN_ID}`;
const LANDING_HEAD_BRANCH = `icarus/${UNIT_RUN_ID}`;
const BASE_REF = "refs/heads/main";
const OPERATOR = "unit-operator";
const NOW = "2026-07-19T12:00:00.000Z";
const PULL_REQUEST_NUMBER = 7;

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
  repository: "landing-draft-pr",
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
const EMPTY_PULL_REQUEST_LIST = {
  type: "pull_request_list",
  complete: true,
  count: 0,
  objects: [],
} as const;

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
        rationale: "Exercise the draft pull-request landing stage.",
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

function settleRead(
  store: IcarusStore,
  landingId: string,
  operationId: string,
  kind:
    | "github.actor.get"
    | "github.base_ref.get"
    | "github.head_ref.get"
    | "github.pull_requests.get",
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

/** Runs the three-read preflight at `local_ready`/`objects_ready`, attempt left open. */
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

/**
 * Runs the four-read preflight at `remote_ready`: the exact candidate head and
 * the complete empty pull-request list, attempt left open for the effect.
 */
function settleDraftPrPreflightForChain(store: IcarusStore, landingId: string): string {
  const started = store.startGithubPreflight(landingId);
  settleRead(store, landingId, started.operationId, "github.actor.get", ACTOR_PROJECTION);
  settleRead(store, landingId, started.operationId, "github.base_ref.get", BASE_PROJECTION);
  settleRead(store, landingId, started.operationId, "github.head_ref.get", HEAD_DIRECT_PROJECTION);
  settleRead(
    store,
    landingId,
    started.operationId,
    "github.pull_requests.get",
    EMPTY_PULL_REQUEST_LIST,
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
  for (const sha1 of [GREETING_BLOB_SHA1, NEW_BLOB_SHA1]) {
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

/** Drives the store-level fixture to `remote_ready`. */
function remoteReadyLanding(store: IcarusStore): LandingStatusV1 {
  const ready = localReadyLanding(store);
  store.admitLandingResume(ready.landing.id);
  settlePreflightForChain(store, ready.landing.id);
  completeStoreUpload(store, ready.landing.id);
  store.admitLandingResume(ready.landing.id);
  settlePreflightForChain(store, ready.landing.id);
  return completeStoreRemoteRef(store, ready.landing.id);
}

/** The exact conforming pull-request projection for one landed fixture. */
function pullRequestProjection(
  store: IcarusStore,
  status: LandingStatusV1,
  number = PULL_REQUEST_NUMBER,
): PullRequestProjectionV1 {
  const projection = store.getRunLandingProjection(status.landing.runId).landing;
  const body = projection?.pullRequestBody;
  if (projection === null || typeof body !== "string") {
    throw new Error("Fixture landing lacks its derived pull-request body");
  }
  return {
    type: "pull_request",
    number,
    state: "open",
    draft: true,
    owner: status.landing.profile.owner,
    repository: status.landing.profile.repository,
    headOwner: status.landing.profile.owner,
    headRef: LANDING_HEAD_BRANCH,
    headSha1: CANDIDATE_COMMIT_SHA1,
    baseRef: status.landing.profile.baseBranch,
    baseSha1: UNIT_BASE_COMMIT,
    titleSha256: sha256(PULL_REQUEST_TITLE),
    bodySha256: sha256(body),
    markerCount: 1,
    maintainerCanModify: false,
  };
}

function oneEntryPullRequestList(projection: PullRequestProjectionV1) {
  return {
    type: "pull_request_list",
    complete: true,
    count: 1,
    objects: [projection],
  } as const;
}

/**
 * Admits the draft-PR operation at `remote_ready` and runs its four pre-effect
 * reads (exact head, complete empty list) plus the durable observation. The
 * one POST is left for the caller.
 */
function startStorePullRequest(
  store: IcarusStore,
  landingId: string,
): { readonly operationId: string } {
  store.admitLandingResume(landingId);
  settleDraftPrPreflightForChain(store, landingId);
  const started = store.startGithubPullRequest(landingId);
  settleRead(store, landingId, started.operationId, "github.actor.get", ACTOR_PROJECTION);
  settleRead(store, landingId, started.operationId, "github.base_ref.get", BASE_PROJECTION);
  settleRead(
    store,
    landingId,
    started.operationId,
    "github.head_ref.get",
    HEAD_DIRECT_PROJECTION,
  );
  settleRead(
    store,
    landingId,
    started.operationId,
    "github.pull_requests.get",
    EMPTY_PULL_REQUEST_LIST,
  );
  store.recordGithubOperationObservation(landingId, started.operationId);
  return started;
}

/** Admits and settles the one POST row with the proposed outcome. */
function settleStorePullRequestPost(
  store: IcarusStore,
  landingId: string,
  operationId: string,
  outcome: "succeeded" | "ambiguous",
): string {
  const admission = store.admitGithubRequest(landingId, operationId, "github.pull_request.post");
  const status = store.getLandingStatus(landingId);
  store.settleGithubRequest(landingId, admission.requestId, {
    outcome,
    httpStatus: outcome === "succeeded" ? 201 : null,
    projection:
      outcome === "succeeded" ? pullRequestProjection(store, status) : (null as never),
    errorCode: outcome === "succeeded" ? null : "GITHUB_OUTCOME_AMBIGUOUS",
  });
  return admission.requestId;
}

/** Runs the fixed three-read suffix: unchanged base, exact head, one-entry list. */
function settleStorePullRequestSuffix(
  store: IcarusStore,
  landingId: string,
  operationId: string,
  listProjection: unknown,
): void {
  settleRead(store, landingId, operationId, "github.base_ref.get", BASE_PROJECTION);
  settleRead(store, landingId, operationId, "github.head_ref.get", HEAD_DIRECT_PROJECTION);
  settleRead(store, landingId, operationId, "github.pull_requests.get", listProjection);
}

describe("durable draft pull-request store slice", () => {
  test("creates the draft pull request and commits the immutable receipt in one settlement", () => {
    const fixture = seedEligibleRun();
    const ready = remoteReadyLanding(fixture.store);
    const landingId = ready.landing.id;

    const started = startStorePullRequest(fixture.store, landingId);
    settleStorePullRequestPost(fixture.store, landingId, started.operationId, "succeeded");
    const oneList = oneEntryPullRequestList(
      pullRequestProjection(fixture.store, fixture.store.getLandingStatus(landingId)),
    );
    settleStorePullRequestSuffix(fixture.store, landingId, started.operationId, oneList);
    const landed = fixture.store.settleGithubPullRequest(landingId, {
      outcome: "completed",
      errorCode: null,
    });

    expect(landed.landing).toMatchObject({
      state: "landed",
      resumeState: null,
      errorCode: null,
    });
    const operation = landed.operations.at(-1);
    expect(operation).toMatchObject({
      kind: "github.pull_request.create",
      status: "completed",
      errorCode: null,
    });
    expect(operation?.result).toMatchObject({
      outcome: "completed",
      boundary: "draft_pr_exact",
      value: {
        number: PULL_REQUEST_NUMBER,
        headSha1: CANDIDATE_COMMIT_SHA1,
        baseSha1: UNIT_BASE_COMMIT,
        pullRequestOutcome: "created",
      },
    });
    expect(operation?.result?.evidence).toHaveLength(8);
    // The terminal attempt carries the ordered [preflight, effect] pair.
    expect(
      landed.operations
        .filter((entry) => entry.coordinatorAttempt === operation?.coordinatorAttempt)
        .map((entry) => entry.kind),
    ).toEqual(["github.preflight", "github.pull_request.create"]);

    const receipt = landed.receipt;
    expect(receipt).not.toBeNull();
    expect(Object.keys(receipt ?? {}).sort()).toEqual(
      [
        "version",
        "landingId",
        "runId",
        "projectId",
        "provider",
        "owner",
        "repository",
        "baseRef",
        "baseCommitSha1",
        "headRef",
        "candidateTreeSha1",
        "candidateCommitSha1",
        "pullRequestNumber",
        "reconstructedPullRequestUrl",
        "draft",
        "landingSha256",
        "profileSha256",
        "planSha256",
        "diffSha256",
        "checkpointSha256",
        "verificationSha256",
        "reviewDecisionSha256",
        "changedPathsSha256",
        "localRefOutcome",
        "remoteObjectOutcome",
        "remoteRefOutcome",
        "pullRequestOutcome",
        "completedAt",
      ].sort(),
    );
    expect(receipt).toMatchObject({
      version: 1,
      landingId,
      runId: UNIT_RUN_ID,
      projectId: fixture.projectId,
      provider: "github",
      owner: "icarus-test",
      repository: "landing-draft-pr",
      baseRef: BASE_REF,
      baseCommitSha1: UNIT_BASE_COMMIT,
      headRef: LANDING_HEAD_REF,
      candidateTreeSha1: CANDIDATE_TREE_SHA1,
      candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
      pullRequestNumber: PULL_REQUEST_NUMBER,
      reconstructedPullRequestUrl: `https://github.com/icarus-test/landing-draft-pr/pull/${PULL_REQUEST_NUMBER}`,
      draft: true,
      landingSha256: landed.landing.landingSha256,
      profileSha256: landed.landing.profileSha256,
      localRefOutcome: "created",
      remoteObjectOutcome: "created_or_exact",
      remoteRefOutcome: "created",
      pullRequestOutcome: "created",
      completedAt: NOW,
    });
    // The receipt is metadata and digests only: no text, path, or credential
    // material appears anywhere in its canonical bytes.
    const receiptJson = canonicalLandingJson(receipt);
    expect(receiptJson).not.toContain(PULL_REQUEST_TITLE);
    expect(receiptJson).not.toContain(COMMIT_MESSAGE.trim());
    expect(receiptJson).not.toContain("/tmp/unit-worktree");

    // The raw row digests to its stored value and the unique index refuses a
    // second draft-PR POST row outright.
    const database = new Database(fixture.databasePath);
    const storedRow = database
      .prepare("SELECT receipt_json, receipt_sha256 FROM landing_receipts WHERE landing_id = ?")
      .get(landingId) as { readonly receipt_json: string; readonly receipt_sha256: string };
    expect(sha256(storedRow.receipt_json)).toBe(storedRow.receipt_sha256);
    expect(storedRow.receipt_json).toBe(receiptJson);
    const postRow = landed.httpRequests.find((row) => row.kind === "github.pull_request.post");
    expect(postRow).toBeDefined();
    if (postRow === undefined) throw new Error("Pull-request POST row missing");
    expect(() =>
      database
        .prepare(
          "INSERT INTO landing_http_requests " +
            "(id, landing_id, operation_id, coordinator_attempt, operation_kind, " +
            "request_ordinal, kind, method, request_sha256, request_json, status, outcome, " +
            "http_status, result_sha256, result_json, error_code, admitted_at, settled_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admitted', NULL, NULL, NULL, NULL, NULL, ?, NULL)",
        )
        .run(
          "22222222-2222-4222-8222-222222222222",
          landingId,
          postRow.operationId,
          postRow.coordinatorAttempt,
          postRow.operationKind,
          99,
          "github.pull_request.post",
          "POST",
          postRow.requestSha256,
          canonicalLandingJson(postRow.request),
          NOW,
        ),
    ).toThrowError();
    database.close();

    // The receipt survives a full store reopen byte-identically, and exactly
    // one POST admission exists over the whole landing.
    const reopened = new IcarusStore(fixture.databasePath, { now: () => NOW });
    const reloaded = reopened.getLandingStatus(landingId);
    expect(canonicalLandingJson(reloaded.receipt)).toBe(receiptJson);
    expect(
      reloaded.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(1);
    reopened.close();
    fixture.store.close();
  });

  test("an ambiguous POST with a conforming suffix list completes as reconciled", () => {
    const fixture = seedEligibleRun();
    const ready = remoteReadyLanding(fixture.store);
    const landingId = ready.landing.id;

    const started = startStorePullRequest(fixture.store, landingId);
    settleStorePullRequestPost(fixture.store, landingId, started.operationId, "ambiguous");
    const oneList = oneEntryPullRequestList(
      pullRequestProjection(fixture.store, fixture.store.getLandingStatus(landingId)),
    );
    settleStorePullRequestSuffix(fixture.store, landingId, started.operationId, oneList);
    const landed = fixture.store.settleGithubPullRequest(landingId, {
      outcome: "completed",
      errorCode: null,
    });

    expect(landed.landing.state).toBe("landed");
    expect(landed.operations.at(-1)?.result).toMatchObject({
      boundary: "draft_pr_exact",
      value: { pullRequestOutcome: "reconciled" },
    });
    expect(landed.receipt).toMatchObject({
      pullRequestNumber: PULL_REQUEST_NUMBER,
      pullRequestOutcome: "reconciled",
    });
    fixture.store.close();
  });

  test("a completed settlement without the one-exact-pull-request suffix proof fails closed", () => {
    const fixture = seedEligibleRun();
    const ready = remoteReadyLanding(fixture.store);
    const landingId = ready.landing.id;

    const started = startStorePullRequest(fixture.store, landingId);
    settleStorePullRequestPost(fixture.store, landingId, started.operationId, "succeeded");
    // The suffix list proves absence instead: no completion may be recorded.
    settleStorePullRequestSuffix(
      fixture.store,
      landingId,
      started.operationId,
      EMPTY_PULL_REQUEST_LIST,
    );
    expectIcarusCode(
      () =>
        fixture.store.settleGithubPullRequest(landingId, {
          outcome: "completed",
          errorCode: null,
        }),
      "LANDING_RECORD_INVALID",
    );
    // The failed settlement attempt left no trace: the operation is still active.
    expect(fixture.store.getLandingStatus(landingId).landing.state).toBe("opening_draft_pr");
    fixture.store.close();
  });

  test("a conforming pre-existing pull request refuses before the POST and resumes clean", () => {
    const fixture = seedEligibleRun();
    const ready = remoteReadyLanding(fixture.store);
    const landingId = ready.landing.id;

    fixture.store.admitLandingResume(landingId);
    settleDraftPrPreflightForChain(fixture.store, landingId);
    const started = fixture.store.startGithubPullRequest(landingId);
    settleRead(fixture.store, landingId, started.operationId, "github.actor.get", ACTOR_PROJECTION);
    settleRead(fixture.store, landingId, started.operationId, "github.base_ref.get", BASE_PROJECTION);
    settleRead(
      fixture.store,
      landingId,
      started.operationId,
      "github.head_ref.get",
      HEAD_DIRECT_PROJECTION,
    );
    const conflictList = oneEntryPullRequestList(
      pullRequestProjection(fixture.store, fixture.store.getLandingStatus(landingId)),
    );
    settleRead(
      fixture.store,
      landingId,
      started.operationId,
      "github.pull_requests.get",
      conflictList,
    );
    const failed = fixture.store.settleGithubPullRequest(landingId, {
      outcome: "failed",
      errorCode: "LANDING_PULL_REQUEST_CONFLICT",
    });
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "remote_ready",
      errorCode: "LANDING_PULL_REQUEST_CONFLICT",
    });
    expect(
      failed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(0);

    // The operator cleared the conflict: the retry runs the one POST and lands.
    const retry = startStorePullRequest(fixture.store, landingId);
    settleStorePullRequestPost(fixture.store, landingId, retry.operationId, "succeeded");
    settleStorePullRequestSuffix(
      fixture.store,
      landingId,
      retry.operationId,
      oneEntryPullRequestList(
        pullRequestProjection(fixture.store, fixture.store.getLandingStatus(landingId)),
      ),
    );
    const landed = fixture.store.settleGithubPullRequest(landingId, {
      outcome: "completed",
      errorCode: null,
    });
    expect(landed.landing.state).toBe("landed");
    expect(
      landed.operations
        .filter((operation) => operation.kind === "github.pull_request.create")
        .map((operation) => [operation.kindAttempt, operation.status]),
    ).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
    expect(
      landed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(1);
    expect(landed.receipt?.pullRequestOutcome).toBe("created");
    fixture.store.close();
  });

  test("takeover of an in-flight POST reconciles to landed when the list proves the draft", () => {
    const fixture = seedEligibleRun();
    const ready = remoteReadyLanding(fixture.store);
    const landingId = ready.landing.id;

    const started = startStorePullRequest(fixture.store, landingId);
    // The POST is admitted but never settled: the coordinator died mid-exchange.
    fixture.store.admitGithubRequest(landingId, started.operationId, "github.pull_request.post");
    const admission = fixture.store.admitLandingResume(landingId);
    expect(admission.operationId).not.toBeNull();
    const interrupted = admission.status;
    expect(interrupted.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "remote_ready",
    });
    const subject = interrupted.operations.find(
      (operation) => operation.kind === "github.pull_request.create",
    );
    expect(subject).toMatchObject({ status: "interrupted" });
    if (subject === undefined) throw new Error("Pull-request subject missing");
    expect(subject.result).toMatchObject({
      outcome: "reconciliation_required",
      value: { subjectOperationId: subject.id, remoteResidue: "ambiguous" },
    });
    // Takeover settled the admitted POST row ambiguous first; no projection was
    // ever recorded for it.
    const post = interrupted.httpRequests.find((row) => row.kind === "github.pull_request.post");
    expect(post).toMatchObject({
      status: "settled",
      outcome: "ambiguous",
      errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
    });

    const reconcileId = admission.operationId ?? "";
    settleRead(fixture.store, landingId, reconcileId, "github.actor.get", ACTOR_PROJECTION);
    settleRead(fixture.store, landingId, reconcileId, "github.base_ref.get", BASE_PROJECTION);
    settleRead(
      fixture.store,
      landingId,
      reconcileId,
      "github.head_ref.get",
      HEAD_DIRECT_PROJECTION,
    );
    settleRead(
      fixture.store,
      landingId,
      reconcileId,
      "github.pull_requests.get",
      oneEntryPullRequestList(
        pullRequestProjection(fixture.store, fixture.store.getLandingStatus(landingId)),
      ),
    );
    fixture.store.recordGithubOperationObservation(landingId, reconcileId);
    const landed = fixture.store.settlePullRequestReconciliation(landingId, {
      outcome: "landed",
      errorCode: null,
    });
    expect(landed.landing).toMatchObject({ state: "landed", resumeState: null, errorCode: null });
    const reconcile = landed.operations.at(-1);
    expect(reconcile?.result).toMatchObject({
      boundary: "subject_settled",
      value: {
        nextState: "landed",
        remoteResidue: "pull_request",
        stageValue: { pullRequestOutcome: "reconciled", number: PULL_REQUEST_NUMBER },
      },
    });
    // Never a second POST, and the receipt derives reconciled from the evidence.
    expect(
      landed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(1);
    expect(landed.receipt).toMatchObject({
      pullRequestNumber: PULL_REQUEST_NUMBER,
      pullRequestOutcome: "reconciled",
    });
    fixture.store.close();
  });

  test("takeover of an in-flight POST with a proven empty list holds without a second admission", () => {
    const fixture = seedEligibleRun();
    const ready = remoteReadyLanding(fixture.store);
    const landingId = ready.landing.id;

    const started = startStorePullRequest(fixture.store, landingId);
    fixture.store.admitGithubRequest(landingId, started.operationId, "github.pull_request.post");
    const admission = fixture.store.admitLandingResume(landingId);
    const reconcileId = admission.operationId ?? "";
    settleRead(fixture.store, landingId, reconcileId, "github.actor.get", ACTOR_PROJECTION);
    settleRead(fixture.store, landingId, reconcileId, "github.base_ref.get", BASE_PROJECTION);
    settleRead(
      fixture.store,
      landingId,
      reconcileId,
      "github.head_ref.get",
      HEAD_DIRECT_PROJECTION,
    );
    settleRead(
      fixture.store,
      landingId,
      reconcileId,
      "github.pull_requests.get",
      EMPTY_PULL_REQUEST_LIST,
    );
    fixture.store.recordGithubOperationObservation(landingId, reconcileId);
    // The spent POST admission forbids both closed mappings: the one-POST
    // discipline outranks the fresh absence proof.
    expectIcarusCode(
      () =>
        fixture.store.settlePullRequestReconciliation(landingId, {
          outcome: "retry_remote_ready",
          errorCode: null,
        }),
      "LANDING_RECORD_INVALID",
    );
    expectIcarusCode(
      () =>
        fixture.store.settlePullRequestReconciliation(landingId, {
          outcome: "landed",
          errorCode: null,
        }),
      "LANDING_RECORD_INVALID",
    );
    const held = fixture.store.settlePullRequestReconciliation(landingId, {
      outcome: "reconciliation_required",
      errorCode: "LANDING_PULL_REQUEST_OUTCOME_AMBIGUOUS",
    });
    // The hold does not transition: the landing keeps the takeover's marker,
    // and the reconcile operation carries the derived residue and code.
    expect(held.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "remote_ready",
      errorCode: "LANDING_COORDINATOR_TAKEOVER",
    });
    expect(held.operations.at(-1)?.result).toMatchObject({
      outcome: "reconciliation_required",
      errorCode: "LANDING_PULL_REQUEST_OUTCOME_AMBIGUOUS",
      value: { remoteResidue: "branch" },
    });
    expect(held.receipt).toBeNull();
    expect(
      held.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(1);
    fixture.store.close();
  });

  test("takeover before the POST admission retries from remote_ready and lands once", () => {
    const fixture = seedEligibleRun();
    const ready = remoteReadyLanding(fixture.store);
    const landingId = ready.landing.id;

    // The coordinator died after the observation but before the POST admission.
    const started = startStorePullRequest(fixture.store, landingId);
    void started;
    const admission = fixture.store.admitLandingResume(landingId);
    expect(admission.status.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "remote_ready",
    });
    const subject = admission.status.operations.find(
      (operation) => operation.kind === "github.pull_request.create",
    );
    expect(subject?.result).toMatchObject({
      outcome: "reconciliation_required",
      // Head proven exact, no POST admitted, list proven empty: branch residue.
      value: { remoteResidue: "branch" },
    });

    const reconcileId = admission.operationId ?? "";
    settleRead(fixture.store, landingId, reconcileId, "github.actor.get", ACTOR_PROJECTION);
    settleRead(fixture.store, landingId, reconcileId, "github.base_ref.get", BASE_PROJECTION);
    settleRead(
      fixture.store,
      landingId,
      reconcileId,
      "github.head_ref.get",
      HEAD_DIRECT_PROJECTION,
    );
    settleRead(
      fixture.store,
      landingId,
      reconcileId,
      "github.pull_requests.get",
      EMPTY_PULL_REQUEST_LIST,
    );
    fixture.store.recordGithubOperationObservation(landingId, reconcileId);
    const retried = fixture.store.settlePullRequestReconciliation(landingId, {
      outcome: "retry_remote_ready",
      errorCode: null,
    });
    expect(retried.landing).toMatchObject({ state: "remote_ready", errorCode: null });
    expect(retried.operations.at(-1)?.result).toMatchObject({
      boundary: "retry_stage_proven",
      value: { nextState: "remote_ready", remoteResidue: "branch", stageValue: null },
    });

    const retry = startStorePullRequest(fixture.store, landingId);
    settleStorePullRequestPost(fixture.store, landingId, retry.operationId, "succeeded");
    settleStorePullRequestSuffix(
      fixture.store,
      landingId,
      retry.operationId,
      oneEntryPullRequestList(
        pullRequestProjection(fixture.store, fixture.store.getLandingStatus(landingId)),
      ),
    );
    const landed = fixture.store.settleGithubPullRequest(landingId, {
      outcome: "completed",
      errorCode: null,
    });
    expect(landed.landing.state).toBe("landed");
    expect(
      landed.operations
        .filter((operation) => operation.kind === "github.pull_request.create")
        .map((operation) => [operation.kindAttempt, operation.status]),
    ).toEqual([
      [1, "interrupted"],
      [2, "completed"],
    ]);
    expect(
      landed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(1);
    expect(landed.receipt?.pullRequestOutcome).toBe("created");
    fixture.store.close();
  });

  test("the remote_ready preflight requires the pull-request absence read", () => {
    const fixture = seedEligibleRun();
    const ready = remoteReadyLanding(fixture.store);
    const landingId = ready.landing.id;

    fixture.store.admitLandingResume(landingId);
    const started = fixture.store.startGithubPreflight(landingId);
    settleRead(fixture.store, landingId, started.operationId, "github.actor.get", ACTOR_PROJECTION);
    settleRead(fixture.store, landingId, started.operationId, "github.base_ref.get", BASE_PROJECTION);
    settleRead(
      fixture.store,
      landingId,
      started.operationId,
      "github.head_ref.get",
      HEAD_DIRECT_PROJECTION,
    );
    // The three-read grammar cannot complete the remote_ready preflight.
    expectIcarusCode(
      () =>
        fixture.store.settleGithubPreflight(landingId, {
          outcome: "completed",
          errorCode: null,
          closeAttempt: false,
        }),
      "LANDING_RECORD_INVALID",
    );
    settleRead(
      fixture.store,
      landingId,
      started.operationId,
      "github.pull_requests.get",
      EMPTY_PULL_REQUEST_LIST,
    );
    fixture.store.settleGithubPreflight(landingId, {
      outcome: "completed",
      errorCode: null,
      closeAttempt: false,
    });
    const status = fixture.store.getLandingStatus(landingId);
    const preflight = status.operations.find(
      (operation) => operation.id === started.operationId,
    );
    expect(preflight?.result).toMatchObject({
      outcome: "completed",
      value: { headState: "exact", pullRequestCount: 0 },
    });
    fixture.store.close();
  });

  test("a tampered receipt fails the load closed", () => {
    const fixture = seedEligibleRun();
    const ready = remoteReadyLanding(fixture.store);
    const landingId = ready.landing.id;

    const started = startStorePullRequest(fixture.store, landingId);
    settleStorePullRequestPost(fixture.store, landingId, started.operationId, "succeeded");
    settleStorePullRequestSuffix(
      fixture.store,
      landingId,
      started.operationId,
      oneEntryPullRequestList(
        pullRequestProjection(fixture.store, fixture.store.getLandingStatus(landingId)),
      ),
    );
    const landed = fixture.store.settleGithubPullRequest(landingId, {
      outcome: "completed",
      errorCode: null,
    });
    expect(landed.receipt).not.toBeNull();

    // Rewrite the stored receipt JSON without updating its digest.
    const tamper = new Database(fixture.databasePath);
    const row = tamper
      .prepare("SELECT receipt_json FROM landing_receipts WHERE landing_id = ?")
      .get(landingId) as { readonly receipt_json: string };
    tamper
      .prepare("UPDATE landing_receipts SET receipt_json = ? WHERE landing_id = ?")
      .run(
        row.receipt_json.replace(
          `"pullRequestNumber":${PULL_REQUEST_NUMBER}`,
          '"pullRequestNumber":8',
        ),
        landingId,
      );
    tamper.close();
    expectIcarusCode(() => fixture.store.getLandingStatus(landingId), "LANDING_RECORD_INVALID");
    fixture.store.close();
  });
});

interface StoredPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly headRef: string;
  readonly baseBranch: string;
  readonly headSha1: string;
  readonly baseSha1: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly maintainerCanModify: boolean;
}

interface FakePrRemote {
  /** The remote's refs by full name; mutate between resumes to drive drift. */
  readonly refs: Map<string, string>;
  /** The remote base branch's current object name. */
  baseSha1: string;
  /** The remote's one pull request record, when the POST landed. */
  pr: StoredPullRequest | null;
}

interface PrGatewayBehavior {
  readonly readPullRequestByHead?: LandingGithubGateway["readPullRequestByHead"];
  readonly createDraftPullRequest?: LandingGithubGateway["createDraftPullRequest"];
}

function countLandingMarkers(body: string): number {
  return (body.match(/<!-- icarus-landing:/g) ?? []).length;
}

function prReceiptFromStored(stored: StoredPullRequest): GithubPullRequestReceipt {
  return {
    number: stored.number,
    isDraft: stored.isDraft,
    isMerged: false,
    state: stored.state,
    headRef: stored.headRef,
    baseBranch: stored.baseBranch,
    headSha1: stored.headSha1,
    baseSha1: stored.baseSha1,
    titleSha256: sha256(stored.title),
    bodySha256: sha256(stored.body),
    markerCount: countLandingMarkers(stored.body),
    maintainerCanModify: stored.maintainerCanModify,
    htmlUrl: `https://github.com/icarus-test/landing-draft-pr/pull/${stored.number}`,
    responseSha256: sha256(`pull-request-${stored.number}`),
    latencyMs: 1,
  };
}

function fakePrGateway(behavior: PrGatewayBehavior = {}): {
  readonly factory: (credential: string) => LandingGithubGateway;
  readonly calls: string[];
  readonly credentials: readonly string[];
  readonly remote: FakePrRemote;
} {
  const calls: string[] = [];
  const credentials: string[] = [];
  const remote: FakePrRemote = { refs: new Map(), baseSha1: UNIT_BASE_COMMIT, pr: null };
  const factory = (credential: string): LandingGithubGateway => {
    credentials.push(credential);
    return {
      readActor: async (expectedActor: string) => {
        calls.push("actor");
        return { login: expectedActor, responseSha256: sha256("actor-bytes"), latencyMs: 1 };
      },
      readBaseReference: async (_coordinates, ref) => {
        calls.push("base");
        return {
          ref,
          sha: remote.baseSha1,
          responseSha256: sha256("base-bytes"),
          latencyMs: 1,
        };
      },
      readReference: async (_coordinates, ref) => {
        calls.push("head");
        const sha = remote.refs.get(ref);
        return sha === undefined
          ? null
          : { ref, sha, responseSha256: sha256("head-bytes"), latencyMs: 1 };
      },
      readPullRequestByHead:
        behavior.readPullRequestByHead ??
        (async () => {
          calls.push("pull_requests");
          return remote.pr === null ? null : prReceiptFromStored(remote.pr);
        }),
      createBlob: async (_coordinates, contentBase64) => {
        calls.push("blob");
        return {
          sha: gitObjectSha1("blob", Buffer.from(contentBase64, "base64")),
          responseSha256: sha256("blob-bytes"),
          latencyMs: 1,
        };
      },
      createTree: async () => {
        calls.push("tree");
        return {
          sha: CANDIDATE_TREE_SHA1,
          responseSha256: sha256("tree-bytes"),
          latencyMs: 1,
        };
      },
      createCommit: async () => {
        calls.push("commit");
        return {
          sha: CANDIDATE_COMMIT_SHA1,
          responseSha256: sha256("commit-bytes"),
          latencyMs: 1,
        };
      },
      createAbsentRef: async (_coordinates, ref, sha) => {
        calls.push("ref");
        remote.refs.set(ref, sha);
        return { ref, sha, responseSha256: sha256("ref-bytes"), latencyMs: 1 };
      },
      createDraftPullRequest:
        behavior.createDraftPullRequest ??
        (async (_coordinates, input) => {
          calls.push("pr_post");
          const headSha1 = remote.refs.get(input.headRef);
          if (headSha1 === undefined) {
            throw new Error("The fake remote lost the landing head ref");
          }
          remote.pr = {
            number: PULL_REQUEST_NUMBER,
            title: input.title,
            body: input.body,
            headRef: input.headRef,
            baseBranch: input.baseBranch,
            headSha1,
            baseSha1: remote.baseSha1,
            state: "open",
            isDraft: true,
            maintainerCanModify: false,
          };
          return prReceiptFromStored(remote.pr);
        }),
    };
  };
  return { factory, calls, credentials, remote };
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

let serviceStateNonce = 0;

async function draftPrService(
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

describe("landing service draft pull-request stage", () => {
  test("drives the full chain to landed with the receipt and exactly one POST", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakePrGateway();
    const service = await draftPrService(fixture, { gateway: gateway.factory });

    await service.resumeLanding(UNIT_RUN_ID);
    await service.resumeLanding(UNIT_RUN_ID);
    const landed = await service.resumeLanding(UNIT_RUN_ID);

    expect(landed.landing).toMatchObject({ state: "landed", errorCode: null });
    expect(gateway.calls).toEqual([
      // local_ready: preflight reads, then the object upload.
      "actor",
      "base",
      "head",
      "actor",
      "blob",
      "blob",
      "tree",
      "commit",
      // objects_ready: preflight reads, then the absent-only ref creation.
      "actor",
      "base",
      "head",
      "actor",
      "base",
      "head",
      "ref",
      "head",
      "base",
      // remote_ready: the absence preflight, then the draft-PR grammar.
      "actor",
      "base",
      "head",
      "pull_requests",
      "actor",
      "base",
      "head",
      "pull_requests",
      "pr_post",
      "base",
      "head",
      "pull_requests",
    ]);
    // Every stage resolved the credential at call time and only then.
    expect(gateway.credentials).toHaveLength(6);
    for (const credential of gateway.credentials) {
      expect(credential).toBe(TOKEN_SENTINEL);
    }
    const receipt = landed.receipt;
    expect(receipt).toMatchObject({
      landingId: landed.landing.id,
      runId: UNIT_RUN_ID,
      owner: "icarus-test",
      repository: "landing-draft-pr",
      pullRequestNumber: PULL_REQUEST_NUMBER,
      pullRequestOutcome: "created",
      remoteRefOutcome: "created",
      localRefOutcome: "created",
      remoteObjectOutcome: "created_or_exact",
    });
    expect(
      landed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(1);
    const postRow = landed.httpRequests.find((row) => row.kind === "github.pull_request.post");
    expect(postRow?.outcome).toBe("succeeded");

    // `landed` is terminal: resume refuses with zero new network calls, and
    // the stored receipt reloads byte-identically.
    const receiptJson = canonicalLandingJson(receipt);
    const callsBefore = gateway.calls.length;
    await expect(service.resumeLanding(UNIT_RUN_ID)).rejects.toMatchObject({
      code: "INVALID_LANDING_STATE",
    });
    expect(gateway.calls).toHaveLength(callsBefore);
    const reloaded = service.getLandingStatus(UNIT_RUN_ID);
    expect(canonicalLandingJson(reloaded?.receipt)).toBe(receiptJson);
    expectNoPersistedToken(fixture.root);
    fixture.store.close();
  });

  test("a missing credential at remote_ready fails before any admission, then retries clean", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakePrGateway();
    const withCredential = await draftPrService(fixture, { gateway: gateway.factory });
    await withCredential.resumeLanding(UNIT_RUN_ID);
    const ready = await withCredential.resumeLanding(UNIT_RUN_ID);
    expect(ready.landing.state).toBe("remote_ready");
    const rowsBefore = ready.httpRequests.length;

    const noCredential = await draftPrService(fixture, {
      gateway: gateway.factory,
      credentialEnvironment: () => undefined,
    });
    const failed = await noCredential.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "remote_ready",
      errorCode: "LANDING_CREDENTIAL_MISSING",
    });
    // The credential gate precedes every admission: no new HTTP rows, no calls.
    expect(failed.httpRequests).toHaveLength(rowsBefore);
    expect(
      failed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(0);

    const landed = await withCredential.resumeLanding(UNIT_RUN_ID);
    expect(landed.landing.state).toBe("landed");
    expect(landed.receipt?.pullRequestOutcome).toBe("created");
    expect(
      landed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(1);
    fixture.store.close();
  });

  test("a pre-existing pull request at the remote_ready preflight refuses before any POST", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakePrGateway();
    const service = await draftPrService(fixture, { gateway: gateway.factory });
    await service.resumeLanding(UNIT_RUN_ID);
    await service.resumeLanding(UNIT_RUN_ID);

    // The operator's repository already has a conforming pull request on this
    // head (built from the landing's own derived bytes).
    const projection = fixture.store.getRunLandingProjection(UNIT_RUN_ID).landing;
    const body = projection?.pullRequestBody;
    expect(typeof body).toBe("string");
    const conflicting = await draftPrService(fixture, {
      gateway: fakePrGateway({
        readPullRequestByHead: async () =>
          prReceiptFromStored({
            number: 11,
            title: PULL_REQUEST_TITLE,
            body: body ?? "",
            headRef: LANDING_HEAD_REF,
            baseBranch: "main",
            headSha1: CANDIDATE_COMMIT_SHA1,
            baseSha1: UNIT_BASE_COMMIT,
            state: "open",
            isDraft: true,
            maintainerCanModify: false,
          }),
      }).factory,
    });
    const failed = await conflicting.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "remote_ready",
      errorCode: "LANDING_PULL_REQUEST_CONFLICT",
    });
    expect(
      failed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(0);
    expect(gateway.calls).not.toContain("pr_post");

    // Conflict cleared: the retry admits the one POST and lands.
    const landed = await service.resumeLanding(UNIT_RUN_ID);
    expect(landed.landing.state).toBe("landed");
    expect(
      landed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(1);
    fixture.store.close();
  });

  test("a contradicted POST response is never retried; the suffix list reconciles to landed", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakePrGateway({
      createDraftPullRequest: async (_coordinates, input) => {
        // The remote applies the exact create but answers a contradicting
        // receipt: the POST row goes ambiguous and only the suffix decides.
        gateway.remote.pr = {
          number: PULL_REQUEST_NUMBER,
          title: input.title,
          body: input.body,
          headRef: input.headRef,
          baseBranch: input.baseBranch,
          headSha1: CANDIDATE_COMMIT_SHA1,
          baseSha1: UNIT_BASE_COMMIT,
          state: "open",
          isDraft: true,
          maintainerCanModify: false,
        };
        return prReceiptFromStored({ ...gateway.remote.pr, title: "a contradicting upstream title" });
      },
    });
    const service = await draftPrService(fixture, { gateway: gateway.factory });
    await service.resumeLanding(UNIT_RUN_ID);
    await service.resumeLanding(UNIT_RUN_ID);
    const landed = await service.resumeLanding(UNIT_RUN_ID);

    expect(landed.landing).toMatchObject({ state: "landed", errorCode: null });
    const postRow = landed.httpRequests.find((row) => row.kind === "github.pull_request.post");
    expect(postRow).toMatchObject({ outcome: "ambiguous", errorCode: "GITHUB_OUTCOME_AMBIGUOUS" });
    expect(landed.operations.at(-1)?.result).toMatchObject({
      boundary: "draft_pr_exact",
      value: { pullRequestOutcome: "reconciled" },
    });
    expect(landed.receipt?.pullRequestOutcome).toBe("reconciled");
    expect(
      landed.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(1);
    fixture.store.close();
  });

  test("a refused POST holds reconciliation forever without a second admission", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakePrGateway({
      createDraftPullRequest: async () => {
        throw new GithubGatewayError(
          "GITHUB_PULL_REQUEST_CREATE_REFUSED",
          "GitHub refused to create the pull request; nothing was created",
          { status: 422 },
        );
      },
    });
    const service = await draftPrService(fixture, { gateway: gateway.factory });
    await service.resumeLanding(UNIT_RUN_ID);
    await service.resumeLanding(UNIT_RUN_ID);
    const held = await service.resumeLanding(UNIT_RUN_ID);

    expect(held.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "remote_ready",
      errorCode: "GITHUB_PULL_REQUEST_CREATE_REFUSED",
    });
    const postRows = held.httpRequests.filter((row) => row.kind === "github.pull_request.post");
    expect(postRows).toHaveLength(1);
    expect(postRows[0]).toMatchObject({ outcome: "failed", httpStatus: 422 });

    // The reconciliation re-reads prove absence, but the spent admission
    // forbids the retry mapping: the landing holds for the operator.
    const reconciled = await service.resumeLanding(UNIT_RUN_ID);
    expect(reconciled.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "remote_ready",
    });
    expect(reconciled.receipt).toBeNull();
    expect(
      reconciled.httpRequests.filter((row) => row.kind === "github.pull_request.post"),
    ).toHaveLength(1);
    expect(gateway.calls.filter((call) => call === "pr_post")).toHaveLength(1);
    fixture.store.close();
  });

  test("a hostile provider POST error cannot reflect the credential into durable evidence", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const gateway = fakePrGateway({
      createDraftPullRequest: async () => {
        throw new GithubGatewayError(
          "GITHUB_HTTP_ERROR",
          "GitHub rejected the create_draft_pull_request operation",
          { status: 500, note: TOKEN_SENTINEL },
        );
      },
    });
    const service = await draftPrService(fixture, { gateway: gateway.factory });
    await service.resumeLanding(UNIT_RUN_ID);
    await service.resumeLanding(UNIT_RUN_ID);
    const held = await service.resumeLanding(UNIT_RUN_ID);

    expect(held.landing.state).toBe("reconciliation_required");
    expect(canonicalLandingJson(held)).not.toContain(TOKEN_SENTINEL);
    expectNoPersistedToken(fixture.root);
    fixture.store.close();
  });

  test("non-Linux resume refuses at remote_ready before credential or gateway effects", async () => {
    const fixture = seedEligibleRun();
    localReadyLanding(fixture.store);
    const service = await draftPrService(fixture, { gateway: fakePrGateway().factory });
    await service.resumeLanding(UNIT_RUN_ID);
    const ready = await service.resumeLanding(UNIT_RUN_ID);
    expect(ready.landing.state).toBe("remote_ready");
    const rowsBefore = ready.httpRequests.length;

    const darwin = await draftPrService(fixture, {
      gateway: fakePrGateway().factory,
      platform: "darwin",
    });
    await expect(darwin.resumeLanding(UNIT_RUN_ID)).rejects.toMatchObject({
      code: "UNSUPPORTED_PLATFORM",
    });
    const after = fixture.store.getLandingStatusForRun(UNIT_RUN_ID);
    expect(after?.landing.state).toBe("remote_ready");
    expect(after?.httpRequests).toHaveLength(rowsBefore);
    fixture.store.close();
  });
});
