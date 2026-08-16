import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

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

const cleanupRoots: string[] = [];
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
const ALLOWED_CREDENTIAL_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "ICARUS_GITHUB_TOKEN_UNIT",
]);

const UNIT_CHECKPOINT_FILES: readonly CheckpointFile[] = [
  {
    path: UNIT_PLAN.target,
    op: "modify",
    baselineBase64: Buffer.from("hello\n").toString("base64"),
    approvedBase64: Buffer.from("goodbye\n").toString("base64"),
  },
];

// The manifest digest is the store-derived one: the ledger re-derives it from
// durable evidence at every load and refuses a drifted constant.
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

const ABSENT_REF: LocalRefFactV1 = {
  schemaVersion: 1,
  state: "absent",
  objectSha1: null,
  symbolicTargetSha256: null,
};

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

function seedEligibleRun(): {
  readonly root: string;
  readonly databasePath: string;
  readonly store: IcarusStore;
  readonly projectId: string;
  readonly diffSha256: string;
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
        rationale: "Exercise durable local landing.",
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
  fixture.store.setLandingProfile(projectId, PROFILE, new Set(["ICARUS_GITHUB_TOKEN_UNIT"]));
  return { ...fixture, projectId, diffSha256: verification.diffSha256 };
}

function createLanding(
  store: IcarusStore,
  allowedCredentialEnvironmentNames = ALLOWED_CREDENTIAL_ENVIRONMENT_NAMES,
): LandingStatusV1 {
  return store.createLanding(
    {
      runId: UNIT_RUN_ID,
      baseTreeSha1: BASE_TREE_SHA1,
      commitMessage: COMMIT_MESSAGE,
      commitEpochSeconds: COMMIT_EPOCH_SECONDS,
      commitIso8601: commitEpochToGitInstant(COMMIT_EPOCH_SECONDS),
      pullRequestTitle: PULL_REQUEST_TITLE,
      pullRequestBodyPrefix: PULL_REQUEST_BODY_PREFIX,
    },
    allowedCredentialEnvironmentNames,
  );
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

function settleCandidate(store: IcarusStore, status: LandingStatusV1): LandingStatusV1 {
  store.startCandidatePreparation(status.landing.id);
  const authority = candidateAuthority(status);
  const landingSha256 = digestLandingRecord(authority);
  const body = renderPullRequestBodyV1({
    landing: authority,
    landingSha256,
    bodyPrefix: status.landing.pullRequestBodyPrefix,
  });
  return store.settleLandingCandidate(status.landing.id, {
    candidateTreeSha1: CANDIDATE_TREE_SHA1,
    candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
    candidateCommitPayloadSha256: CANDIDATE_PAYLOAD_SHA256,
    candidateObjectManifestSha256: CANDIDATE_MANIFEST_SHA256,
    candidateCredentialAuditSha256: CANDIDATE_AUDIT_SHA256,
    landingDigest: authority,
    pullRequestBodySha256: sha256(body),
  });
}

function approveLanding(store: IcarusStore): LandingStatusV1 {
  const candidate = settleCandidate(store, createLanding(store));
  return store.recordLandingDecision(
    candidate.landing.id,
    candidate.landing.landingSha256 ?? "",
    "unit-operator",
    "approve",
  );
}

const LANDING_HEAD_REF = `refs/heads/icarus/${UNIT_RUN_ID}`;

function fakeLandingGit(overrides: Partial<LandingGitService> = {}): LandingGitService {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected landing Git call");
  };
  return {
    inspectBase: unexpected,
    prepareCandidate: unexpected,
    observeLocalRef: unexpected,
    createAbsentLocalRef: unexpected,
    ...overrides,
  };
}

async function landingService(
  fixture: ReturnType<typeof seedEligibleRun>,
  landingGit: LandingGitService,
  platform: NodeJS.Platform = "linux",
  landing?: {
    readonly gateway?: (credential: string) => LandingGithubGateway;
    readonly credentialEnvironment?: (name: string) => string | undefined;
  },
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
    landingGit,
    landingCredentialEnvironmentNames: [...ALLOWED_CREDENTIAL_ENVIRONMENT_NAMES],
    checks,
    ...(landing?.gateway === undefined ? {} : { landingGithubGateway: landing.gateway }),
    ...(landing?.credentialEnvironment === undefined
      ? {}
      : { landingCredentialEnvironment: landing.credentialEnvironment }),
    gatewayFactory: () => {
      throw new Error("Unexpected provider gateway construction");
    },
    platform,
  });
  await service.initialize();
  return service;
}

function absentObservation() {
  return {
    outcome: "definitive" as const,
    headRef: LANDING_HEAD_REF,
    fact: { state: "absent" as const, objectSha1: null, symbolicTargetSha256: null },
  };
}

function candidateObservation() {
  return {
    outcome: "definitive" as const,
    headRef: LANDING_HEAD_REF,
    fact: {
      state: "direct" as const,
      objectSha1: CANDIDATE_COMMIT_SHA1,
      symbolicTargetSha256: null,
    },
  };
}

describe("durable local landing store", () => {
  test("never persists a credential token value from the process environment", () => {
    const credentialName = PROFILE.credentialRef.name;
    const tokenValueSentinel = "PACKET3_CREDENTIAL_VALUE_SENTINEL_DO_NOT_PERSIST";
    const previous = process.env[credentialName];
    process.env[credentialName] = tokenValueSentinel;
    const fixture = seedEligibleRun();
    try {
      approveLanding(fixture.store);
    } finally {
      fixture.store.close();
      if (previous === undefined) delete process.env[credentialName];
      else process.env[credentialName] = previous;
    }

    for (const file of persistedFiles(fixture.root)) {
      expect(readFileSync(file).includes(Buffer.from(tokenValueSentinel)), file).toBe(false);
    }
  });

  test("revalidates the current profile credential allowlist inside landing creation", () => {
    const fixture = seedEligibleRun();
    const replacementCredential = "ICARUS_GITHUB_TOKEN_REPLACEMENT";
    fixture.store.setLandingProfile(
      fixture.projectId,
      {
        ...PROFILE,
        credentialRef: { kind: "environment", name: replacementCredential },
      },
      new Set([replacementCredential]),
    );

    expectIcarusCode(
      () => createLanding(fixture.store, ALLOWED_CREDENTIAL_ENVIRONMENT_NAMES),
      "LANDING_CREDENTIAL_NOT_ALLOWED",
    );
    const created = createLanding(fixture.store, new Set([replacementCredential]));
    expect(created.landing.profile.credentialRef.name).toBe(replacementCredential);
    fixture.store.close();
  });

  test("revalidates eligibility and completes the local-ref happy path", () => {
    const fixture = seedEligibleRun();
    const eligibility = fixture.store.getLandingEligibility(UNIT_RUN_ID);
    expect(eligibility).toMatchObject({
      projectId: fixture.projectId,
      baseCommitSha1: UNIT_BASE_COMMIT,
      diffSha256: fixture.diffSha256,
      reviewDecisionId: REVIEW_ID,
      changedPaths: [UNIT_PLAN.target],
    });
    expect(fixture.store.getLandingProfile(fixture.projectId)?.profile).toEqual(PROFILE);
    const beforePresentation = fixture.store.getRunPresentationSnapshot(UNIT_RUN_ID);
    expect(beforePresentation).toMatchObject({ landing: null, landingRevision: 0 });

    const created = createLanding(fixture.store);
    expectIcarusCode(
      () => fixture.store.getLandingEligibility(UNIT_RUN_ID),
      "LANDING_ALREADY_EXISTS",
    );
    const candidate = settleCandidate(fixture.store, created);
    expect(candidate.landing.state).toBe("awaiting_approval");
    fixture.store.setLandingProfile(
      fixture.projectId,
      { ...PROFILE, repository: "landing-ledger-next" },
      new Set(["ICARUS_GITHUB_TOKEN_UNIT"]),
    );
    const approved = fixture.store.recordLandingDecision(
      candidate.landing.id,
      candidate.landing.landingSha256 ?? "",
      "unit-operator",
      "approve",
    );
    const replay = fixture.store.recordLandingDecision(
      candidate.landing.id,
      candidate.landing.landingSha256 ?? "",
      "unit-operator",
      "approve",
    );
    expect(replay.decision?.id).toBe(approved.decision?.id);
    expect(approved.landing.profile).toEqual(PROFILE);

    expect(fixture.store.admitLandingResume(candidate.landing.id)).toMatchObject({
      attemptOrdinal: 2,
      operationId: null,
      attemptLimitReached: false,
    });
    const local = fixture.store.startLocalRefCreation(candidate.landing.id);
    fixture.store.recordLocalRefObservation(candidate.landing.id, local.operationId, ABSENT_REF);
    const directRef: LocalRefFactV1 = {
      schemaVersion: 1,
      state: "direct",
      objectSha1: CANDIDATE_COMMIT_SHA1,
      symbolicTargetSha256: null,
    };
    const ready = fixture.store.settleLocalRefCreation(candidate.landing.id, {
      outcome: "succeeded",
      errorCode: null,
      observedFact: ABSENT_REF,
      postEffectFact: directRef,
    });
    expect(ready.landing.state).toBe("local_ready");
    expect(ready.attempts.map((attempt) => attempt.status)).toEqual(["completed", "completed"]);
    expect(fixture.store.getRunLandingProjection(UNIT_RUN_ID)).toMatchObject({
      landing: { state: "local_ready", decision: { decision: "approve" } },
      landingRevision: ready.events.length,
    });
    expect(fixture.store.getRunPresentationSnapshot(UNIT_RUN_ID)).toMatchObject({
      eventCursor: beforePresentation.eventCursor,
      landingRevision: ready.events.length,
      landing: {
        state: "local_ready",
        candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
        pullRequestTitle: PULL_REQUEST_TITLE,
        decision: { decision: "approve" },
      },
    });

    const database = new Database(fixture.databasePath);
    const persisted = database
      .prepare("SELECT observation_json FROM landing_operations WHERE id = ?")
      .get(local.operationId) as { readonly observation_json: string };
    database.close();
    expect(persisted.observation_json).not.toContain("objectSha1");
    expect(persisted.observation_json).not.toContain('"state"');
    fixture.store.close();
  });

  test("takes over an uncertain local-ref effect only through reconciliation", () => {
    const fixture = seedEligibleRun();
    const approved = approveLanding(fixture.store);
    fixture.store.admitLandingResume(approved.landing.id);
    const local = fixture.store.startLocalRefCreation(approved.landing.id);
    fixture.store.recordLocalRefObservation(approved.landing.id, local.operationId, ABSENT_REF);

    const takeover = fixture.store.admitLandingResume(approved.landing.id);
    expect(takeover).toMatchObject({
      attemptOrdinal: 3,
      attemptLimitReached: false,
      status: { landing: { state: "reconciliation_required", resumeState: "approved" } },
    });
    expect(takeover.operationId).not.toBeNull();
    const reconciliationTakeover = fixture.store.admitLandingResume(approved.landing.id);
    expect(reconciliationTakeover).toMatchObject({
      attemptOrdinal: 4,
      attemptLimitReached: false,
      status: { landing: { state: "reconciliation_required", resumeState: "approved" } },
    });
    expect(reconciliationTakeover.operationId).not.toBe(takeover.operationId);
    const directRef: LocalRefFactV1 = {
      schemaVersion: 1,
      state: "direct",
      objectSha1: CANDIDATE_COMMIT_SHA1,
      symbolicTargetSha256: null,
    };
    fixture.store.recordLocalRefObservation(
      approved.landing.id,
      reconciliationTakeover.operationId ?? "",
      directRef,
    );
    const ready = fixture.store.settleLocalRefReconciliation(approved.landing.id, {
      outcome: "local_ready",
      errorCode: null,
      fact: directRef,
    });
    expect(ready.landing.state).toBe("local_ready");
    expect(ready.operations.map((operation) => operation.status)).toEqual([
      "completed",
      "interrupted",
      "interrupted",
      "completed",
    ]);
    fixture.store.close();
  });

  test("does not adopt a pre-existing exact ref without durable prior absence", () => {
    const fixture = seedEligibleRun();
    const approved = approveLanding(fixture.store);
    fixture.store.admitLandingResume(approved.landing.id);
    fixture.store.startLocalRefCreation(approved.landing.id);
    const takeover = fixture.store.admitLandingResume(approved.landing.id);
    const directRef: LocalRefFactV1 = {
      schemaVersion: 1,
      state: "direct",
      objectSha1: CANDIDATE_COMMIT_SHA1,
      symbolicTargetSha256: null,
    };
    fixture.store.recordLocalRefObservation(
      approved.landing.id,
      takeover.operationId ?? "",
      directRef,
    );
    expectIcarusCode(
      () =>
        fixture.store.settleLocalRefReconciliation(approved.landing.id, {
          outcome: "local_ready",
          errorCode: null,
          fact: directRef,
        }),
      "LANDING_RECORD_INVALID",
    );
    const unresolved = fixture.store.settleLocalRefReconciliation(approved.landing.id, {
      outcome: "reconciliation_required",
      errorCode: "LANDING_LOCAL_REF_CONFLICT",
      fact: directRef,
    });
    expect(unresolved.landing.state).toBe("reconciliation_required");
    fixture.store.close();
  });

  test("derives same-operation reconciliation and tracks the newest retry subject", () => {
    const derived = seedEligibleRun();
    const approved = approveLanding(derived.store);
    derived.store.admitLandingResume(approved.landing.id);
    const local = derived.store.startLocalRefCreation(approved.landing.id);
    derived.store.recordLocalRefObservation(approved.landing.id, local.operationId, ABSENT_REF);
    const directRef: LocalRefFactV1 = {
      schemaVersion: 1,
      state: "direct",
      objectSha1: CANDIDATE_COMMIT_SHA1,
      symbolicTargetSha256: null,
    };
    const reconciled = derived.store.settleLocalRefCreation(approved.landing.id, {
      outcome: "ambiguous",
      errorCode: "LANDING_LOCAL_REF_OUTCOME_AMBIGUOUS",
      observedFact: ABSENT_REF,
      postEffectFact: directRef,
    });
    expect(reconciled.operations.at(-1)?.result?.value).toMatchObject({
      localRefOutcome: "reconciled",
      updateRefExitCode: null,
    });
    derived.store.close();

    const failed = seedEligibleRun();
    const failedApproved = approveLanding(failed.store);
    failed.store.admitLandingResume(failedApproved.landing.id);
    const failedLocal = failed.store.startLocalRefCreation(failedApproved.landing.id);
    failed.store.recordLocalRefObservation(
      failedApproved.landing.id,
      failedLocal.operationId,
      ABSENT_REF,
    );
    const definitiveFailure = failed.store.settleLocalRefCreation(failedApproved.landing.id, {
      outcome: "failed",
      errorCode: "LANDING_LOCAL_REF_CONFLICT",
      observedFact: ABSENT_REF,
      postEffectFact: directRef,
    });
    expect(definitiveFailure.landing.state).toBe("failed");
    expect(definitiveFailure.operations.at(-1)?.result).toMatchObject({
      outcome: "failed",
      value: null,
    });
    failed.store.close();

    const retried = seedEligibleRun();
    const retryApproved = approveLanding(retried.store);
    retried.store.admitLandingResume(retryApproved.landing.id);
    const firstSubject = retried.store.startLocalRefCreation(retryApproved.landing.id);
    retried.store.recordLocalRefObservation(
      retryApproved.landing.id,
      firstSubject.operationId,
      ABSENT_REF,
    );
    retried.store.settleLocalRefCreation(retryApproved.landing.id, {
      outcome: "ambiguous",
      errorCode: "LANDING_LOCAL_REF_OUTCOME_AMBIGUOUS",
      observedFact: ABSENT_REF,
      postEffectFact: ABSENT_REF,
    });
    const firstReconciliation = retried.store.admitLandingResume(retryApproved.landing.id);
    retried.store.recordLocalRefObservation(
      retryApproved.landing.id,
      firstReconciliation.operationId ?? "",
      ABSENT_REF,
    );
    retried.store.settleLocalRefReconciliation(retryApproved.landing.id, {
      outcome: "retry_approved",
      errorCode: null,
      fact: ABSENT_REF,
    });
    retried.store.admitLandingResume(retryApproved.landing.id);
    const secondSubject = retried.store.startLocalRefCreation(retryApproved.landing.id);
    retried.store.recordLocalRefObservation(
      retryApproved.landing.id,
      secondSubject.operationId,
      ABSENT_REF,
    );
    retried.store.settleLocalRefCreation(retryApproved.landing.id, {
      outcome: "ambiguous",
      errorCode: "LANDING_LOCAL_REF_OUTCOME_AMBIGUOUS",
      observedFact: ABSENT_REF,
      postEffectFact: null,
    });
    const secondReconciliation = retried.store.admitLandingResume(retryApproved.landing.id);
    const activeReconciliation = secondReconciliation.status.operations.find(
      (operation) => operation.id === secondReconciliation.operationId,
    );
    expect(activeReconciliation?.request.input).toMatchObject({
      subjectOperationId: secondSubject.operationId,
    });
    expect(secondSubject.operationId).not.toBe(firstSubject.operationId);
    retried.store.close();
  });

  test("durably settles an ambiguous reconciliation read without inventing facts", () => {
    const fixture = seedEligibleRun();
    const approved = approveLanding(fixture.store);
    fixture.store.admitLandingResume(approved.landing.id);
    const local = fixture.store.startLocalRefCreation(approved.landing.id);
    fixture.store.recordLocalRefObservation(approved.landing.id, local.operationId, ABSENT_REF);
    fixture.store.settleLocalRefCreation(approved.landing.id, {
      outcome: "ambiguous",
      errorCode: "LANDING_LOCAL_REF_OUTCOME_AMBIGUOUS",
      observedFact: ABSENT_REF,
      postEffectFact: null,
    });
    const reconciliation = fixture.store.admitLandingResume(approved.landing.id);
    const unresolved = fixture.store.settleLocalRefReconciliation(approved.landing.id, {
      outcome: "reconciliation_required",
      errorCode: "LANDING_LOCAL_REF_OBSERVATION_AMBIGUOUS",
      fact: null,
    });
    const operation = unresolved.operations.find(
      (entry) => entry.id === reconciliation.operationId,
    );
    expect(operation).toMatchObject({
      status: "interrupted",
      observation: null,
      result: { outcome: "reconciliation_required", evidence: [] },
    });
    expect(unresolved.attempts.some((attempt) => attempt.status === "started")).toBe(false);
    expect(unresolved.landing.state).toBe("reconciliation_required");
    fixture.store.close();
  });

  test("enforces rollback's landing interlock atomically", () => {
    const preDelivery = seedEligibleRun();
    const created = createLanding(preDelivery.store);
    expect(
      preDelivery.store.approveRollback(UNIT_RUN_ID, preDelivery.diffSha256, "operator").state,
    ).toBe("rolling_back");
    expect(preDelivery.store.getLandingStatus(created.landing.id).landing.state).toBe("abandoned");
    preDelivery.store.close();

    const approvedDelivery = seedEligibleRun();
    const approved = approveLanding(approvedDelivery.store);
    expectIcarusCode(
      () =>
        approvedDelivery.store.approveRollback(
          UNIT_RUN_ID,
          approvedDelivery.diffSha256,
          "operator",
        ),
      "LANDING_ROLLBACK_CONFLICT",
    );
    expect(approvedDelivery.store.getRun(UNIT_RUN_ID).state).toBe("completed");
    expect(approvedDelivery.store.getLandingStatus(approved.landing.id).landing.state).toBe(
      "approved",
    );
    approvedDelivery.store.close();
  });

  test("replays a stored rejection after rollback changes the run state", () => {
    const fixture = seedEligibleRun();
    const candidate = settleCandidate(fixture.store, createLanding(fixture.store));
    const landingSha256 = candidate.landing.landingSha256 ?? "";
    const rejected = fixture.store.recordLandingDecision(
      candidate.landing.id,
      landingSha256,
      "unit-operator",
      "reject",
    );

    expect(fixture.store.approveRollback(UNIT_RUN_ID, fixture.diffSha256, "operator").state).toBe(
      "rolling_back",
    );
    const replay = fixture.store.recordLandingDecision(
      candidate.landing.id,
      landingSha256,
      "unit-operator",
      "reject",
    );
    expect(replay.decision?.id).toBe(rejected.decision?.id);
    expectIcarusCode(
      () =>
        fixture.store.recordLandingDecision(
          candidate.landing.id,
          landingSha256,
          "other-operator",
          "reject",
        ),
      "LANDING_DECISION_CONFLICT",
    );
    fixture.store.close();
  });

  test("refuses effect admission after the authoritative run leaves completed", () => {
    const fixture = seedEligibleRun();
    const approved = approveLanding(fixture.store);
    const database = new Database(fixture.databasePath);
    database.prepare("UPDATE runs SET state = 'rolling_back' WHERE id = ?").run(UNIT_RUN_ID);
    database.close();
    expectIcarusCode(
      () => fixture.store.admitLandingResume(approved.landing.id),
      "LANDING_NOT_ELIGIBLE",
    );
    expect(fixture.store.getLandingStatus(approved.landing.id).landing.state).toBe("approved");
    fixture.store.close();
  });

  test("never admits a ninth coordinator attempt", () => {
    const fixture = seedEligibleRun();
    const created = createLanding(fixture.store);
    for (let ordinal = 1; ordinal <= 8; ordinal += 1) {
      fixture.store.startCandidatePreparation(created.landing.id);
      fixture.store.settleLandingCandidateFailure(
        created.landing.id,
        "CANDIDATE_INTERRUPTED",
        "interrupted",
      );
      if (ordinal < 8) {
        const admission = fixture.store.admitLandingResume(created.landing.id);
        expect(admission.attemptOrdinal).toBe(ordinal + 1);
        expect(admission.attemptLimitReached).toBe(false);
      } else {
        expectIcarusCode(
          () => fixture.store.admitLandingResume(created.landing.id),
          "LANDING_ATTEMPT_LIMIT",
        );
      }
    }
    expect(fixture.store.getLandingStatus(created.landing.id).attempts).toHaveLength(8);
    fixture.store.close();
  });

  test("leaves a failed attempt-eight resume marker untouched", () => {
    const fixture = seedEligibleRun();
    const created = createLanding(fixture.store);
    for (let ordinal = 1; ordinal <= 8; ordinal += 1) {
      fixture.store.startCandidatePreparation(created.landing.id);
      fixture.store.settleLandingCandidateFailure(created.landing.id, "CANDIDATE_FAILED", "failed");
      if (ordinal < 8) {
        fixture.store.admitLandingResume(created.landing.id);
      }
    }
    const before = fixture.store.getLandingStatus(created.landing.id);
    expect(before.landing).toMatchObject({
      state: "failed",
      resumeState: "preparing_candidate",
      attemptCount: 8,
    });
    expectIcarusCode(
      () => fixture.store.admitLandingResume(created.landing.id),
      "LANDING_ATTEMPT_LIMIT",
    );
    const after = fixture.store.getLandingStatus(created.landing.id);
    expect(after.landing.version).toBe(before.landing.version);
    expect(after.landing.resumeState).toBe("preparing_candidate");
    expect(after.events).toHaveLength(before.events.length);
    fixture.store.close();
  });

  test("rejects reordered, misowned, and stale-version event authority", () => {
    const reordered = seedEligibleRun();
    const candidate = settleCandidate(reordered.store, createLanding(reordered.store));
    const reorderedDatabase = new Database(reordered.databasePath);
    const settlementEvents = reorderedDatabase
      .prepare(
        "SELECT sequence, type, payload_json FROM landing_events " +
          "WHERE landing_id = ? AND type IN ('landing.operation.settled', 'landing.attempt.settled') " +
          "ORDER BY sequence LIMIT 2",
      )
      .all(candidate.landing.id) as Array<{
      readonly sequence: number;
      readonly type: string;
      readonly payload_json: string;
    }>;
    const first = settlementEvents[0];
    const second = settlementEvents[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    reorderedDatabase
      .prepare(
        "UPDATE landing_events SET type = ?, payload_json = ? WHERE landing_id = ? AND sequence = ?",
      )
      .run(second?.type, second?.payload_json, candidate.landing.id, first?.sequence);
    reorderedDatabase
      .prepare(
        "UPDATE landing_events SET type = ?, payload_json = ? WHERE landing_id = ? AND sequence = ?",
      )
      .run(first?.type, first?.payload_json, candidate.landing.id, second?.sequence);
    reorderedDatabase.close();
    expectIcarusCode(
      () => reordered.store.getLandingStatus(candidate.landing.id),
      "LANDING_RECORD_INVALID",
    );
    reordered.store.close();

    const staleVersion = seedEligibleRun();
    const created = createLanding(staleVersion.store);
    const admission = staleVersion.store.startCandidatePreparation(created.landing.id);
    const staleDatabase = new Database(staleVersion.databasePath);
    const operationRow = staleDatabase
      .prepare("SELECT request_json FROM landing_operations WHERE id = ?")
      .get(admission.operationId) as { readonly request_json: string };
    const request = JSON.parse(operationRow.request_json) as Record<string, unknown>;
    request.expectedVersion = 1;
    const requestJson = canonicalLandingJson(request);
    const requestSha256 = sha256(requestJson);
    staleDatabase
      .prepare("UPDATE landing_operations SET request_json = ?, request_sha256 = ? WHERE id = ?")
      .run(requestJson, requestSha256, admission.operationId);
    const startEvent = staleDatabase
      .prepare(
        "SELECT sequence, payload_json FROM landing_events " +
          "WHERE landing_id = ? AND type = 'landing.operation.started' AND payload_json LIKE ?",
      )
      .get(created.landing.id, `%${admission.operationId}%`) as {
      readonly sequence: number;
      readonly payload_json: string;
    };
    const startPayload = JSON.parse(startEvent.payload_json) as Record<string, unknown>;
    startPayload.requestSha256 = requestSha256;
    staleDatabase
      .prepare("UPDATE landing_events SET payload_json = ? WHERE landing_id = ? AND sequence = ?")
      .run(canonicalLandingJson(startPayload), created.landing.id, startEvent.sequence);
    staleDatabase.close();
    expectIcarusCode(
      () => staleVersion.store.getLandingStatus(created.landing.id),
      "LANDING_RECORD_INVALID",
    );
    staleVersion.store.close();

    const misowned = seedEligibleRun();
    const approved = approveLanding(misowned.store);
    misowned.store.admitLandingResume(approved.landing.id);
    const local = misowned.store.startLocalRefCreation(approved.landing.id);
    const status = misowned.store.getLandingStatus(approved.landing.id);
    const candidateOperationId = status.operations.find(
      (operation) => operation.kind === "candidate.prepare",
    )?.id;
    expect(candidateOperationId).toBeDefined();
    const stateEvent = status.events.find(
      (event) =>
        event.type === "landing.state.changed" &&
        (event.payload as { readonly to?: unknown }).to === "creating_local_ref",
    );
    expect(stateEvent).toBeDefined();
    const misownedDatabase = new Database(misowned.databasePath);
    const badPayload = {
      ...(stateEvent?.payload as unknown as Record<string, unknown>),
      operationId: candidateOperationId,
    };
    misownedDatabase
      .prepare("UPDATE landing_events SET payload_json = ? WHERE landing_id = ? AND sequence = ?")
      .run(canonicalLandingJson(badPayload), approved.landing.id, stateEvent?.sequence);
    misownedDatabase.close();
    expectIcarusCode(
      () => misowned.store.getLandingStatus(approved.landing.id),
      "LANDING_RECORD_INVALID",
    );
    expect(local.operationId).not.toBe(candidateOperationId);
    misowned.store.close();
  });

  test("rejects divergent settlement and landing transition error codes", () => {
    const settlement = seedEligibleRun();
    const settlementCreated = createLanding(settlement.store);
    settlement.store.startCandidatePreparation(settlementCreated.landing.id);
    settlement.store.settleLandingCandidateFailure(
      settlementCreated.landing.id,
      "CANDIDATE_FAILED",
      "failed",
    );
    const settlementDatabase = new Database(settlement.databasePath);
    const attemptEvent = settlementDatabase
      .prepare(
        "SELECT sequence, payload_json FROM landing_events " +
          "WHERE landing_id = ? AND type = 'landing.attempt.settled'",
      )
      .get(settlementCreated.landing.id) as {
      readonly sequence: number;
      readonly payload_json: string;
    };
    const attemptPayload = JSON.parse(attemptEvent.payload_json) as Record<string, unknown>;
    attemptPayload.errorCode = "ATTEMPT_ERROR_MISMATCH";
    settlementDatabase
      .prepare("UPDATE landing_attempts SET error_code = ? WHERE landing_id = ? AND ordinal = 1")
      .run("ATTEMPT_ERROR_MISMATCH", settlementCreated.landing.id);
    settlementDatabase
      .prepare("UPDATE landing_events SET payload_json = ? WHERE landing_id = ? AND sequence = ?")
      .run(
        canonicalLandingJson(attemptPayload),
        settlementCreated.landing.id,
        attemptEvent.sequence,
      );
    settlementDatabase.close();
    expectIcarusCode(
      () => settlement.store.getLandingStatus(settlementCreated.landing.id),
      "LANDING_RECORD_INVALID",
    );
    settlement.store.close();

    const transition = seedEligibleRun();
    const transitionCreated = createLanding(transition.store);
    transition.store.startCandidatePreparation(transitionCreated.landing.id);
    transition.store.settleLandingCandidateFailure(
      transitionCreated.landing.id,
      "CANDIDATE_FAILED",
      "failed",
    );
    const transitionDatabase = new Database(transition.databasePath);
    transitionDatabase
      .prepare("UPDATE landings SET error_code = ? WHERE id = ?")
      .run("LANDING_ERROR_MISMATCH", transitionCreated.landing.id);
    transitionDatabase.close();
    expectIcarusCode(
      () => transition.store.getLandingStatus(transitionCreated.landing.id),
      "LANDING_RECORD_INVALID",
    );
    transition.store.close();
  });

  test("rejects invalid local-ref state and corrupted event replay", () => {
    const fixture = seedEligibleRun();
    const approved = approveLanding(fixture.store);
    fixture.store.admitLandingResume(approved.landing.id);
    const local = fixture.store.startLocalRefCreation(approved.landing.id);
    expectIcarusCode(
      () =>
        fixture.store.recordLocalRefObservation(approved.landing.id, local.operationId, {
          schemaVersion: 1,
          state: "invalid",
          objectSha1: null,
          symbolicTargetSha256: null,
        } as unknown as LocalRefFactV1),
      "LANDING_RECORD_INVALID",
    );
    const database = new Database(fixture.databasePath);
    expect(
      database
        .prepare("SELECT observation_json FROM landing_operations WHERE id = ?")
        .get(local.operationId),
    ).toMatchObject({ observation_json: null });
    database
      .prepare("UPDATE landing_events SET payload_json = ? WHERE landing_id = ? AND sequence = 1")
      .run(
        JSON.stringify({
          schemaVersion: 1,
          landingId: "22222222-2222-4222-8222-222222222222",
          coordinatorAttempt: 1,
        }),
        approved.landing.id,
      );
    database.close();
    expectIcarusCode(
      () => fixture.store.getLandingStatus(approved.landing.id),
      "LANDING_RECORD_INVALID",
    );
    fixture.store.close();
  });
});
test.runIf(process.platform === "linux")(
  "composes the fixed ten-minute deadline into prepare and resume attempts",
  async () => {
    const timeoutController = new AbortController();
    timeoutController.abort(new Error("landing attempt deadline"));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(600_000);
      return timeoutController.signal;
    });

    const preparing = seedEligibleRun();
    let prepareSignal: AbortSignal | undefined;
    const prepareService = await landingService(
      preparing,
      fakeLandingGit({
        inspectBase: async (_input, signal) => {
          prepareSignal = signal;
          throw new IcarusError("CANCELLED", "Landing attempt timed out");
        },
      }),
    );
    await expect(
      prepareService.prepareLanding({
        runId: UNIT_RUN_ID,
        commitMessage: COMMIT_MESSAGE,
        pullRequestTitle: PULL_REQUEST_TITLE,
        pullRequestBodyPrefix: PULL_REQUEST_BODY_PREFIX,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(prepareSignal).toBe(timeoutController.signal);
    preparing.store.close();

    const approved = seedEligibleRun();
    approveLanding(approved.store);
    let resumeSignal: AbortSignal | undefined;
    const resumeService = await landingService(
      approved,
      fakeLandingGit({
        observeLocalRef: async (_input, signal) => {
          resumeSignal = signal;
          throw new IcarusError("CANCELLED", "Landing attempt timed out");
        },
      }),
    );
    const failed = await resumeService.resumeLanding(UNIT_RUN_ID);
    expect(resumeSignal).toBe(timeoutController.signal);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "approved",
      errorCode: "CANCELLED",
    });
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    approved.store.close();
  },
);
describe.runIf(process.platform === "linux")("landing service coordinator", () => {
  test("rejects an inspected base mismatch before creating durable landing state", async () => {
    const fixture = seedEligibleRun();
    const service = await landingService(
      fixture,
      fakeLandingGit({
        inspectBase: async () => ({
          objectFormat: "sha1",
          baseCommitSha1: "9".repeat(40),
          baseTreeSha1: BASE_TREE_SHA1,
        }),
      }),
    );

    await expect(
      service.prepareLanding({
        runId: UNIT_RUN_ID,
        commitMessage: COMMIT_MESSAGE,
        pullRequestTitle: PULL_REQUEST_TITLE,
        pullRequestBodyPrefix: PULL_REQUEST_BODY_PREFIX,
      }),
    ).rejects.toMatchObject({ code: "LANDING_BASE_CHANGED" });
    expect(service.getLandingStatus(UNIT_RUN_ID)).toBeNull();
    fixture.store.close();
  });

  test("creates the approved local ref only after durable absence and a mandatory post-read", async () => {
    const fixture = seedEligibleRun();
    approveLanding(fixture.store);
    const calls: string[] = [];
    const observations = [absentObservation(), candidateObservation()];
    const service = await landingService(
      fixture,
      fakeLandingGit({
        observeLocalRef: async () => {
          calls.push("observe");
          const observation = observations.shift();
          if (observation === undefined) throw new Error("Unexpected observation");
          return observation;
        },
        createAbsentLocalRef: async () => {
          calls.push("create");
          return {
            outcome: "succeeded",
            headRef: LANDING_HEAD_REF,
            candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
            localRefOutcome: "created",
            updateRefExitCode: 0,
          };
        },
      }),
      "linux",
      { credentialEnvironment: () => undefined },
    );

    const ready = await service.resumeLanding(UNIT_RUN_ID);
    expect(ready.landing.state).toBe("local_ready");
    expect(ready.landing.errorCode).toBeNull();
    expect(calls).toEqual(["observe", "create", "observe"]);
    expect(ready.operations.at(-1)?.result).toMatchObject({
      outcome: "completed",
      boundary: "local_ref_ready",
      value: { localRefOutcome: "created", updateRefExitCode: 0 },
    });
    // A further resume at local_ready runs the read-only GitHub preflight.
    // This service has no credential configured, so the attempt fails before
    // any HTTPS request is admitted and without touching the local ref.
    const replay = await service.resumeLanding(UNIT_RUN_ID);
    expect(replay.landing).toMatchObject({
      state: "failed",
      resumeState: "local_ready",
      errorCode: "LANDING_CREDENTIAL_MISSING",
    });
    expect(replay.operations.at(-1)).toMatchObject({
      kind: "github.preflight",
      status: "failed",
    });
    expect(replay.httpRequests).toEqual([]);
    expect(calls).toEqual(["observe", "create", "observe"]);
    fixture.store.close();
  });

  test("never adopts an exact candidate ref that existed before Icarus recorded absence", async () => {
    const fixture = seedEligibleRun();
    approveLanding(fixture.store);
    const calls: string[] = [];
    const service = await landingService(
      fixture,
      fakeLandingGit({
        observeLocalRef: async () => {
          calls.push("observe");
          return candidateObservation();
        },
        createAbsentLocalRef: async () => {
          calls.push("create");
          throw new Error("CAS must not run");
        },
      }),
    );

    const failed = await service.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "approved",
      errorCode: "LANDING_LOCAL_REF_CONFLICT",
    });
    expect(calls).toEqual(["observe"]);
    fixture.store.close();
  });

  test("takeover reconciles an exact candidate only when the interrupted subject proved absence", async () => {
    const proved = seedEligibleRun();
    const approved = approveLanding(proved.store);
    proved.store.admitLandingResume(approved.landing.id);
    const local = proved.store.startLocalRefCreation(approved.landing.id);
    proved.store.recordLocalRefObservation(approved.landing.id, local.operationId, ABSENT_REF);
    const provedService = await landingService(
      proved,
      fakeLandingGit({ observeLocalRef: async () => candidateObservation() }),
    );
    const ready = await provedService.resumeLanding(UNIT_RUN_ID);
    expect(ready.landing.state).toBe("local_ready");
    expect(
      ready.operations.filter((operation) => operation.kind === "local_ref.create"),
    ).toHaveLength(1);
    proved.store.close();

    const unproved = seedEligibleRun();
    const unprovedApproved = approveLanding(unproved.store);
    unproved.store.admitLandingResume(unprovedApproved.landing.id);
    unproved.store.startLocalRefCreation(unprovedApproved.landing.id);
    const unprovedService = await landingService(
      unproved,
      fakeLandingGit({ observeLocalRef: async () => candidateObservation() }),
    );
    const held = await unprovedService.resumeLanding(UNIT_RUN_ID);
    expect(held.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "approved",
      errorCode: "LANDING_COORDINATOR_TAKEOVER",
    });
    expect(held.operations.at(-1)?.errorCode).toBe("LANDING_LOCAL_REF_CONFLICT");
    unproved.store.close();
  });

  test("reconciles an ambiguous CAS when the mandatory post-read proves the exact candidate", async () => {
    const fixture = seedEligibleRun();
    approveLanding(fixture.store);
    const observations = [absentObservation(), candidateObservation()];
    const service = await landingService(
      fixture,
      fakeLandingGit({
        observeLocalRef: async () => {
          const observation = observations.shift();
          if (observation === undefined) throw new Error("Unexpected observation");
          return observation;
        },
        createAbsentLocalRef: async () => ({
          outcome: "ambiguous",
          headRef: LANDING_HEAD_REF,
          candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
          errorCode: "LANDING_LOCAL_REF_OUTCOME_AMBIGUOUS",
        }),
      }),
    );

    const ready = await service.resumeLanding(UNIT_RUN_ID);
    expect(ready.landing.state).toBe("local_ready");
    expect(ready.operations.at(-1)?.result).toMatchObject({
      value: { localRefOutcome: "reconciled", updateRefExitCode: null },
    });
    fixture.store.close();
  });

  test("does not relabel a definitive CAS failure when the post-read sees the candidate", async () => {
    const fixture = seedEligibleRun();
    approveLanding(fixture.store);
    const observations = [absentObservation(), candidateObservation()];
    const service = await landingService(
      fixture,
      fakeLandingGit({
        observeLocalRef: async () => {
          const observation = observations.shift();
          if (observation === undefined) throw new Error("Unexpected observation");
          return observation;
        },
        createAbsentLocalRef: async () => ({
          outcome: "failed",
          headRef: LANDING_HEAD_REF,
          candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
          errorCode: "LANDING_LOCAL_REF_CONFLICT",
        }),
      }),
    );

    const failed = await service.resumeLanding(UNIT_RUN_ID);
    expect(failed.landing).toMatchObject({
      state: "failed",
      resumeState: "approved",
      errorCode: "LANDING_LOCAL_REF_CONFLICT",
    });
    expect(failed.operations.at(-1)?.result).toMatchObject({
      outcome: "failed",
      boundary: "operation_failed",
    });
    fixture.store.close();
  });

  test("unknown post-effect state requires reconciliation before exact-ref recovery", async () => {
    const fixture = seedEligibleRun();
    approveLanding(fixture.store);
    const observations = [
      absentObservation(),
      {
        outcome: "ambiguous" as const,
        headRef: LANDING_HEAD_REF,
        errorCode: "LANDING_LOCAL_REF_OBSERVATION_AMBIGUOUS" as const,
      },
      candidateObservation(),
    ];
    const service = await landingService(
      fixture,
      fakeLandingGit({
        observeLocalRef: async () => {
          const observation = observations.shift();
          if (observation === undefined) throw new Error("Unexpected observation");
          return observation;
        },
        createAbsentLocalRef: async () => ({
          outcome: "ambiguous",
          headRef: LANDING_HEAD_REF,
          candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
          errorCode: "LANDING_LOCAL_REF_OUTCOME_AMBIGUOUS",
        }),
      }),
    );

    const held = await service.resumeLanding(UNIT_RUN_ID);
    expect(held.landing.state).toBe("reconciliation_required");
    const ready = await service.resumeLanding(UNIT_RUN_ID);
    expect(ready.landing.state).toBe("local_ready");
    fixture.store.close();
  });

  test("an absent reconciliation returns to approved and waits for another explicit resume", async () => {
    const fixture = seedEligibleRun();
    const approved = approveLanding(fixture.store);
    fixture.store.admitLandingResume(approved.landing.id);
    const local = fixture.store.startLocalRefCreation(approved.landing.id);
    fixture.store.recordLocalRefObservation(approved.landing.id, local.operationId, ABSENT_REF);
    const calls: string[] = [];
    const observations = [absentObservation(), absentObservation(), candidateObservation()];
    const service = await landingService(
      fixture,
      fakeLandingGit({
        observeLocalRef: async () => {
          calls.push("observe");
          const observation = observations.shift();
          if (observation === undefined) throw new Error("Unexpected observation");
          return observation;
        },
        createAbsentLocalRef: async () => {
          calls.push("create");
          return {
            outcome: "succeeded",
            headRef: LANDING_HEAD_REF,
            candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
            localRefOutcome: "created",
            updateRefExitCode: 0,
          };
        },
      }),
    );

    const approvedAgain = await service.resumeLanding(UNIT_RUN_ID);
    expect(approvedAgain.landing.state).toBe("approved");
    expect(calls).toEqual(["observe"]);
    const ready = await service.resumeLanding(UNIT_RUN_ID);
    expect(ready.landing.state).toBe("local_ready");
    expect(calls).toEqual(["observe", "observe", "create", "observe"]);
    fixture.store.close();
  });

  test("candidate takeover rebuilds and settles the same durable authority", async () => {
    const fixture = seedEligibleRun();
    const created = createLanding(fixture.store);
    fixture.store.startCandidatePreparation(created.landing.id);
    const calls: string[] = [];
    const manifest = {
      schemaVersion: 1 as const,
      baseCommitSha1: UNIT_BASE_COMMIT,
      baseTreeSha1: BASE_TREE_SHA1,
      candidateTreeSha1: CANDIDATE_TREE_SHA1,
      candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
      candidateCommitPayloadSha256: CANDIDATE_PAYLOAD_SHA256,
      entries: [
        {
          path: UNIT_PLAN.target,
          op: "modify" as const,
          mode: "100644" as const,
          blobSha1: gitObjectSha1("blob", Buffer.from("goodbye\n", "utf8")),
          contentBytes: Buffer.byteLength("goodbye\n"),
          contentSha256: sha256("goodbye\n"),
        },
      ],
    };
    const service = await landingService(
      fixture,
      fakeLandingGit({
        inspectBase: async () => {
          calls.push("inspect");
          return {
            objectFormat: "sha1",
            baseCommitSha1: UNIT_BASE_COMMIT,
            baseTreeSha1: BASE_TREE_SHA1,
          };
        },
        prepareCandidate: async () => {
          calls.push("prepare");
          return {
            objectFormat: "sha1",
            baseCommitSha1: UNIT_BASE_COMMIT,
            baseTreeSha1: BASE_TREE_SHA1,
            candidateTreeSha1: CANDIDATE_TREE_SHA1,
            candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
            candidateCommitPayloadSha256: CANDIDATE_PAYLOAD_SHA256,
            candidateObjectManifest: manifest,
            candidateObjectManifestSha256: digestLandingRecord(manifest),
            diffByteEqual: true,
          };
        },
      }),
    );

    const candidate = await service.resumeLanding(UNIT_RUN_ID);
    expect(candidate.landing.state).toBe("awaiting_approval");
    expect(candidate.landing.candidateCommitSha1).toBe(CANDIDATE_COMMIT_SHA1);
    expect(candidate.attempts.map((attempt) => attempt.status)).toEqual([
      "interrupted",
      "completed",
    ]);
    expect(calls).toEqual(["inspect", "prepare"]);
    fixture.store.close();
  });

  test.each(["darwin", "win32"] as const)(
    "unsupported %s refuses every landing mutation before store or Git access",
    async (platform) => {
      const fixture = seedEligibleRun();
      const approved = approveLanding(fixture.store);
      let gitCalls = 0;
      const service = await landingService(
        fixture,
        fakeLandingGit({
          observeLocalRef: async () => {
            gitCalls += 1;
            return absentObservation();
          },
        }),
        platform,
      );

      expect(() =>
        service.setLandingProfile("unit", {
          ...PROFILE,
          expectedActor: "must-not-persist",
        }),
      ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_PLATFORM" }));
      await expect(
        service.prepareLanding({
          runId: UNIT_RUN_ID,
          commitMessage: "must not prepare",
          pullRequestTitle: "must not prepare",
          pullRequestBodyPrefix: "must not prepare",
        }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
      await expect(
        service.decideLanding(
          UNIT_RUN_ID,
          approved.landing.landingSha256 ?? "0".repeat(64),
          "must-not-decide",
          "reject",
        ),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
      await expect(service.resumeLanding(UNIT_RUN_ID)).rejects.toMatchObject({
        code: "UNSUPPORTED_PLATFORM",
      });
      expect(gitCalls).toBe(0);
      expect(fixture.store.getLandingStatus(approved.landing.id)).toEqual(approved);
      fixture.store.close();
    },
  );
});
test.runIf(process.platform === "linux")(
  "does not run post-CAS Git observation beyond aggregate attempt cancellation",
  async () => {
    const fixture = seedEligibleRun();
    approveLanding(fixture.store);
    const attempt = new AbortController();
    let observations = 0;
    const service = await landingService(
      fixture,
      fakeLandingGit({
        observeLocalRef: async (_input, signal) => {
          observations += 1;
          if (observations === 1) {
            expect(signal?.aborted).toBe(false);
            return absentObservation();
          }
          expect(signal?.aborted).toBe(true);
          throw new IcarusError("CANCELLED", "Landing attempt timed out");
        },
        createAbsentLocalRef: async () => {
          attempt.abort(new Error("landing attempt deadline"));
          return {
            outcome: "ambiguous",
            headRef: LANDING_HEAD_REF,
            candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
            errorCode: "LANDING_LOCAL_REF_OUTCOME_AMBIGUOUS",
          };
        },
      }),
    );

    const held = await service.resumeLanding(UNIT_RUN_ID, attempt.signal);
    expect(observations).toBe(2);
    expect(held.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "approved",
      errorCode: "LANDING_LOCAL_REF_OUTCOME_AMBIGUOUS",
    });
    fixture.store.close();
  },
);
