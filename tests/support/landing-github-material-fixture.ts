import path from "node:path";

import { expect } from "vitest";

import { containsSecretShapedContent } from "../../packages/core/src/context.js";
import { digestJson, sha256 } from "../../packages/core/src/digest.js";
import {
  buildUnsignedCommitPayloadV1,
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  decodeCandidateCredentialAuditV1,
  decodeCandidateObjectManifestV1,
  decodeLandingDigestV1,
  digestLandingRecord,
  GITHUB_API_VERSION,
  type GitHubLandingProfileV1,
  gitObjectSha1,
  type LandingDigestV1,
  type LocalRefFactV1,
  renderPullRequestBodyV1,
} from "../../packages/core/src/landing-records.js";
import { RunLeaseManager } from "../../packages/core/src/lease.js";
import { planApprovalDigest, treeCheckpointDigest } from "../../packages/core/src/policy.js";
import type { IcarusStore } from "../../packages/core/src/store.js";
import {
  type CheckpointFile,
  CONTEXT_AUDIT_POLICY_VERSION,
  type ContextManifest,
  type JsonValue,
  type PatchSet,
  type PlanProposal,
  type SunCeiling,
  type VerificationEvidence,
} from "../../packages/core/src/types.js";
import {
  createUnitStore,
  seedUnitProject,
  UNIT_BASE_COMMIT,
  UNIT_CEILING,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
} from "./unit-fixtures.js";

export const MATERIAL_BASE_TREE_SHA1 = "1".repeat(40);
export const MATERIAL_CANDIDATE_TREE_SHA1 = "2".repeat(40);
export const MATERIAL_PATHS = ["assets/new.bin", "docs/old.txt", "src/greeting.txt"] as const;
export const MATERIAL_BINARY_BYTES = new Uint8Array([0, 1, 2, 3, 255]);
export const MATERIAL_DELETED_BYTES = Buffer.from("retired documentation\n", "utf8");
export const MATERIAL_MODIFIED_BASELINE = Buffer.from("hello\n", "utf8");
export const MATERIAL_MODIFIED_BYTES = Buffer.from("goodbye\n", "utf8");

export const MATERIAL_PROFILE: GitHubLandingProfileV1 = {
  version: 1,
  provider: "github",
  owner: "icarus-test",
  repository: "landing-material",
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

const PLAN: PlanProposal = {
  summary: "Exercise immutable GitHub landing material.",
  steps: ["Apply three approved operations.", "Run the registered check."],
  risks: ["Binary bytes must remain byte-exact."],
  target: MATERIAL_PATHS[0],
  targets: MATERIAL_PATHS,
  iterationCeiling: 0,
  checkIds: ["unit"],
  grants: [],
};

const ABSENT_REF: LocalRefFactV1 = {
  schemaVersion: 1,
  state: "absent",
  objectSha1: null,
  symbolicTargetSha256: null,
};

export interface LandingGitHubMaterialFixture {
  readonly root: string;
  readonly databasePath: string;
  readonly store: IcarusStore;
  readonly projectId: string;
  readonly landingId: string;
  readonly leases: RunLeaseManager;
  readonly checkpointFiles: readonly CheckpointFile[];
  readonly candidateManifestSha256: string;
  readonly cachePath: string;
  readonly worktreePath: string;
}

function contextManifest(): ContextManifest {
  const entries = MATERIAL_PATHS.map((entryPath) => ({
    path: entryPath,
    reason: "target" as const,
    bytes: 1,
    sha256: sha256(entryPath),
  }));
  return {
    auditPolicyVersion: CONTEXT_AUDIT_POLICY_VERSION,
    baseCommit: UNIT_BASE_COMMIT,
    targets: MATERIAL_PATHS,
    repositoryMap: MATERIAL_PATHS,
    entries,
    totalBytes: entries.length,
  };
}

function checkpointFiles(
  createdBytes: Uint8Array = MATERIAL_BINARY_BYTES,
): readonly CheckpointFile[] {
  return [
    {
      path: MATERIAL_PATHS[0],
      op: "create",
      baselineBase64: null,
      approvedBase64: Buffer.from(createdBytes).toString("base64"),
    },
    {
      path: MATERIAL_PATHS[1],
      op: "delete",
      baselineBase64: MATERIAL_DELETED_BYTES.toString("base64"),
      approvedBase64: null,
    },
    {
      path: MATERIAL_PATHS[2],
      op: "modify",
      baselineBase64: MATERIAL_MODIFIED_BASELINE.toString("base64"),
      approvedBase64: MATERIAL_MODIFIED_BYTES.toString("base64"),
    },
  ];
}

function patchSet(): PatchSet {
  return {
    summary: "Exercise create, delete, modify, and binary material.",
    edits: [
      {
        op: "create",
        path: MATERIAL_PATHS[0],
        content: "binary fixture",
        rationale: "Exercise binary checkpoint reconstruction.",
      },
      {
        op: "delete",
        path: MATERIAL_PATHS[1],
        expectedPreimageSha256: sha256(MATERIAL_DELETED_BYTES),
        rationale: "Exercise delete material.",
      },
      {
        op: "modify",
        path: MATERIAL_PATHS[2],
        expectedPreimageSha256: sha256(MATERIAL_MODIFIED_BASELINE),
        replacements: [{ findText: "hello", replaceText: "goodbye" }],
        rationale: "Exercise modify material.",
      },
    ],
  };
}

function credentialAudit(
  files: readonly CheckpointFile[],
  text: {
    readonly commitMessage: string;
    readonly pullRequestTitle: string;
    readonly pullRequestBodyPrefix: string;
  },
  requireSafe = true,
) {
  const changed = files.flatMap((file) => {
    if (file.approvedBase64 === null) return [];
    const bytes = Buffer.from(file.approvedBase64, "base64");
    if (requireSafe) expect(containsSecretShapedContent(bytes)).toBe(false);
    return [
      {
        kind: "changed_blob" as const,
        path: file.path,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      },
    ];
  });
  const textSubjects = (
    [
      ["commit_message", text.commitMessage],
      ["pull_request_title", text.pullRequestTitle],
      ["pull_request_body_prefix", text.pullRequestBodyPrefix],
    ] as const
  ).map(([kind, value]) => {
    const bytes = Buffer.from(value, "utf8");
    if (requireSafe) expect(containsSecretShapedContent(bytes)).toBe(false);
    return { kind, path: null, bytes: bytes.byteLength, sha256: sha256(bytes) };
  });
  return decodeCandidateCredentialAuditV1({
    schemaVersion: 1,
    policyVersion: "landing-outgoing-v1",
    outcome: "passed",
    subjects: [...changed, ...textSubjects],
  });
}

export async function createLandingGitHubMaterialFixture(
  ceiling: SunCeiling = UNIT_CEILING,
  createdBytes: Uint8Array = MATERIAL_BINARY_BYTES,
  commitMessage = "Apply the reviewed material fixture\n",
  requireSafeAudit = true,
): Promise<LandingGitHubMaterialFixture> {
  const seeded = createUnitStore();
  const { projectId } = seedUnitProject(seeded.store, ceiling);
  const context = contextManifest();
  seeded.store.createRun({
    id: UNIT_RUN_ID,
    projectId,
    task: "Exercise immutable GitHub landing material",
    targets: MATERIAL_PATHS,
    provider: UNIT_PROVIDER,
  });
  seeded.store.pinRunBase(UNIT_RUN_ID, UNIT_BASE_COMMIT);
  seeded.store.completePreparation(
    UNIT_RUN_ID,
    context,
    path.join(seeded.root, "absent-context.json"),
    digestJson(context as unknown as JsonValue),
  );
  const project = seeded.store.getProject(projectId);
  const planSha256 = planApprovalDigest({
    task: "Exercise immutable GitHub landing material",
    baseCommit: UNIT_BASE_COMMIT,
    contextSha256: digestJson(context as unknown as JsonValue),
    targets: context.targets,
    provider: UNIT_PROVIDER,
    checks: project.checks,
    sandbox: project.sandbox,
    ceiling: project.ceiling,
    plan: PLAN,
    readableManifest: null,
  });
  seeded.store.recordPlanAndAwaitApproval(UNIT_RUN_ID, PLAN, planSha256);
  seeded.store.approvePlan(UNIT_RUN_ID, planSha256, "unit-operator");
  const cachePath = path.join(seeded.root, "absent-cache.git");
  const worktreePath = path.join(seeded.root, "absent-worktree");
  seeded.store.recordWorkspace(UNIT_RUN_ID, cachePath, worktreePath, null);
  const files = checkpointFiles(createdBytes);
  seeded.store.recordPatchSetIntent(UNIT_RUN_ID, patchSet(), files);
  const checkpointSha256 = treeCheckpointDigest({
    runId: UNIT_RUN_ID,
    baseCommit: UNIT_BASE_COMMIT,
    files,
  });
  seeded.store.saveTreeCheckpoint(UNIT_RUN_ID, checkpointSha256);
  seeded.store.transition(UNIT_RUN_ID, "verifying", "execution.completed");
  const diff = "binary-safe reviewed fixture diff\n";
  const verification: VerificationEvidence = {
    outcome: "passed",
    checks: [
      {
        checkId: "unit",
        argv: ["node", "--test"],
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdout: "ok\n",
        stderr: "",
        truncated: false,
        outcome: "passed",
      },
    ],
    changedPaths: MATERIAL_PATHS,
    diffSha256: sha256(diff),
    checkpointSha256,
  };
  seeded.store.recordVerificationAndAwaitReview(UNIT_RUN_ID, diff, verification);
  seeded.store.decideReview(UNIT_RUN_ID, verification.diffSha256, "unit-operator", "approve");
  seeded.store.setLandingProfile(
    projectId,
    MATERIAL_PROFILE,
    new Set([MATERIAL_PROFILE.credentialRef.name]),
  );
  const created = seeded.store.createLanding(
    {
      runId: UNIT_RUN_ID,
      baseTreeSha1: MATERIAL_BASE_TREE_SHA1,
      commitMessage,
      commitEpochSeconds: 0,
      commitIso8601: commitEpochToGitInstant(0),
      pullRequestTitle: "Apply the reviewed material fixture",
      pullRequestBodyPrefix: "Prepared from durable approved bytes.",
    },
    new Set([MATERIAL_PROFILE.credentialRef.name]),
  );
  seeded.store.startCandidatePreparation(created.landing.id);

  const commitPayload = buildUnsignedCommitPayloadV1({
    candidateTreeSha1: MATERIAL_CANDIDATE_TREE_SHA1,
    baseCommitSha1: UNIT_BASE_COMMIT,
    commitIdentity: MATERIAL_PROFILE.commitIdentity,
    commitEpochSeconds: 0,
    commitMessage: created.landing.commitMessage,
  });
  const candidateCommitSha1 = gitObjectSha1("commit", commitPayload);
  const manifest = decodeCandidateObjectManifestV1({
    schemaVersion: 1,
    baseCommitSha1: UNIT_BASE_COMMIT,
    baseTreeSha1: MATERIAL_BASE_TREE_SHA1,
    candidateTreeSha1: MATERIAL_CANDIDATE_TREE_SHA1,
    candidateCommitSha1,
    candidateCommitPayloadSha256: sha256(commitPayload),
    entries: files.map((file) => {
      if (file.approvedBase64 === null) {
        return {
          path: file.path,
          op: file.op,
          mode: "100644",
          blobSha1: null,
          contentBytes: null,
          contentSha256: null,
        };
      }
      const bytes = Buffer.from(file.approvedBase64, "base64");
      return {
        path: file.path,
        op: file.op,
        mode: "100644",
        blobSha1: gitObjectSha1("blob", bytes),
        contentBytes: bytes.byteLength,
        contentSha256: sha256(bytes),
      };
    }),
  });
  const audit = credentialAudit(
    files,
    {
      commitMessage: created.landing.commitMessage,
      pullRequestTitle: created.landing.pullRequestTitle,
      pullRequestBodyPrefix: created.landing.pullRequestBodyPrefix,
    },
    requireSafeAudit,
  );
  const authority: LandingDigestV1 = decodeLandingDigestV1({
    schemaVersion: 1,
    policyVersion: 1,
    githubApiVersion: GITHUB_API_VERSION,
    landingId: created.landing.id,
    runId: created.landing.runId,
    projectId: created.landing.projectId,
    baseCommitSha1: created.landing.baseCommitSha1,
    baseTreeSha1: created.landing.baseTreeSha1,
    planSha256: created.landing.planSha256,
    diffSha256: created.landing.diffSha256,
    checkpointSha256: created.landing.checkpointSha256,
    verificationSha256: created.landing.verificationSha256,
    reviewDecisionId: created.landing.reviewDecisionId,
    reviewDecisionSha256: created.landing.reviewDecisionSha256,
    changedPaths: created.landing.changedPaths,
    changedPathsSha256: created.landing.changedPathsSha256,
    candidateCredentialAuditSha256: digestLandingRecord(audit),
    profileVersion: 1,
    profileSha256: created.landing.profileSha256,
    profile: created.landing.profile,
    objectFormat: "sha1",
    candidateParentSha1: created.landing.baseCommitSha1,
    candidateTreeSha1: MATERIAL_CANDIDATE_TREE_SHA1,
    candidateCommitSha1,
    candidateCommitPayloadSha256: sha256(commitPayload),
    candidateObjectManifestSha256: digestLandingRecord(manifest),
    commitMessageSha256: created.landing.commitMessageSha256,
    commitAuthor: created.landing.profile.commitIdentity,
    commitCommitter: created.landing.profile.commitIdentity,
    commitEpochSeconds: created.landing.commitEpochSeconds,
    commitIso8601: created.landing.commitIso8601,
    baseRef: `refs/heads/${created.landing.profile.baseBranch}`,
    expectedRemoteBaseSha1: created.landing.baseCommitSha1,
    headRef: created.landing.headRef,
    pullRequestTitleSha256: created.landing.pullRequestTitleSha256,
    pullRequestBodyPrefixSha256: created.landing.pullRequestBodyPrefixSha256,
    pullRequestMarkerVersion: 1,
    draft: true,
    maintainerCanModify: false,
    directIcarusEffects: DIRECT_ICARUS_EFFECTS,
    derivativeEffectDisclosure: {
      version: 1,
      githubEvents: DERIVATIVE_GITHUB_EVENTS,
      mayTrigger: DERIVATIVE_EFFECTS,
      disposition: MATERIAL_PROFILE.derivativeEffects.disposition,
      evidenceSha256: MATERIAL_PROFILE.derivativeEffects.evidenceSha256,
    },
  });
  const landingSha256 = digestLandingRecord(authority);
  const candidate = seeded.store.settleLandingCandidate(created.landing.id, {
    candidateTreeSha1: MATERIAL_CANDIDATE_TREE_SHA1,
    candidateCommitSha1,
    candidateCommitPayloadSha256: sha256(commitPayload),
    candidateObjectManifestSha256: digestLandingRecord(manifest),
    candidateCredentialAuditSha256: digestLandingRecord(audit),
    landingDigest: authority,
    pullRequestBodySha256: sha256(
      renderPullRequestBodyV1({
        landing: authority,
        landingSha256,
        bodyPrefix: created.landing.pullRequestBodyPrefix,
      }),
    ),
  });
  seeded.store.recordLandingDecision(
    candidate.landing.id,
    candidate.landing.landingSha256 ?? "",
    "unit-operator",
    "approve",
  );
  seeded.store.admitLandingResume(candidate.landing.id);
  const local = seeded.store.startLocalRefCreation(candidate.landing.id);
  seeded.store.recordLocalRefObservation(candidate.landing.id, local.operationId, ABSENT_REF);
  seeded.store.settleLocalRefCreation(candidate.landing.id, {
    outcome: "succeeded",
    errorCode: null,
    observedFact: ABSENT_REF,
    postEffectFact: {
      schemaVersion: 1,
      state: "direct",
      objectSha1: candidateCommitSha1,
      symbolicTargetSha256: null,
    },
  });
  seeded.store.admitLandingResume(candidate.landing.id);
  const leases = new RunLeaseManager(path.join(seeded.root, "landing-leases"));
  await leases.initialize();
  return {
    ...seeded,
    projectId,
    landingId: candidate.landing.id,
    leases,
    checkpointFiles: files,
    candidateManifestSha256: digestLandingRecord(manifest),
    cachePath,
    worktreePath,
  };
}
