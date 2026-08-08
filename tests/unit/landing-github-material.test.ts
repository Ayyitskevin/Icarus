import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
import { type RunLeaseGuard, RunLeaseManager } from "../../packages/core/src/lease.js";
import { planApprovalDigest, treeCheckpointDigest } from "../../packages/core/src/policy.js";
import { checkpointReadBoundsV1, IcarusStore } from "../../packages/core/src/store.js";
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
} from "../support/unit-fixtures.js";

const BASE_TREE_SHA1 = "1".repeat(40);
const CANDIDATE_TREE_SHA1 = "2".repeat(40);
const PATHS = ["assets/new.bin", "docs/old.txt", "src/greeting.txt"] as const;
const BINARY_BYTES = new Uint8Array([0, 1, 2, 3, 255]);
const DELETED_BYTES = Buffer.from("retired documentation\n", "utf8");
const MODIFIED_BASELINE = Buffer.from("hello\n", "utf8");
const MODIFIED_BYTES = Buffer.from("goodbye\n", "utf8");

const PROFILE: GitHubLandingProfileV1 = {
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
  target: PATHS[0],
  targets: PATHS,
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

interface Fixture {
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

interface TestDatabase {
  prepare(sql: string): {
    run(...parameters: unknown[]): { readonly changes: number };
  };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const fixtures: Fixture[] = [];
const additionalStores: IcarusStore[] = [];

afterEach(() => {
  for (const store of additionalStores.splice(0)) store.close();
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function contextManifest(): ContextManifest {
  const entries = PATHS.map((entryPath) => ({
    path: entryPath,
    reason: "target" as const,
    bytes: 1,
    sha256: sha256(entryPath),
  }));
  return {
    auditPolicyVersion: CONTEXT_AUDIT_POLICY_VERSION,
    baseCommit: UNIT_BASE_COMMIT,
    targets: PATHS,
    repositoryMap: PATHS,
    entries,
    totalBytes: entries.length,
  };
}

function checkpointFiles(createdBytes: Uint8Array = BINARY_BYTES): readonly CheckpointFile[] {
  return [
    {
      path: PATHS[0],
      op: "create",
      baselineBase64: null,
      approvedBase64: Buffer.from(createdBytes).toString("base64"),
    },
    {
      path: PATHS[1],
      op: "delete",
      baselineBase64: DELETED_BYTES.toString("base64"),
      approvedBase64: null,
    },
    {
      path: PATHS[2],
      op: "modify",
      baselineBase64: MODIFIED_BASELINE.toString("base64"),
      approvedBase64: MODIFIED_BYTES.toString("base64"),
    },
  ];
}

function patchSet(): PatchSet {
  return {
    summary: "Exercise create, delete, modify, and binary material.",
    edits: [
      {
        op: "create",
        path: PATHS[0],
        content: "binary fixture",
        rationale: "Exercise binary checkpoint reconstruction.",
      },
      {
        op: "delete",
        path: PATHS[1],
        expectedPreimageSha256: sha256(DELETED_BYTES),
        rationale: "Exercise delete material.",
      },
      {
        op: "modify",
        path: PATHS[2],
        expectedPreimageSha256: sha256(MODIFIED_BASELINE),
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

async function createFixture(
  ceiling: SunCeiling = UNIT_CEILING,
  createdBytes: Uint8Array = BINARY_BYTES,
  commitMessage = "Apply the reviewed material fixture\n",
  requireSafeAudit = true,
): Promise<Fixture> {
  const seeded = createUnitStore();
  const { projectId } = seedUnitProject(seeded.store, ceiling);
  const context = contextManifest();
  seeded.store.createRun({
    id: UNIT_RUN_ID,
    projectId,
    task: "Exercise immutable GitHub landing material",
    targets: PATHS,
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
    changedPaths: PATHS,
    diffSha256: sha256(diff),
    checkpointSha256,
  };
  seeded.store.recordVerificationAndAwaitReview(UNIT_RUN_ID, diff, verification);
  seeded.store.decideReview(UNIT_RUN_ID, verification.diffSha256, "unit-operator", "approve");
  seeded.store.setLandingProfile(projectId, PROFILE, new Set([PROFILE.credentialRef.name]));
  const created = seeded.store.createLanding(
    {
      runId: UNIT_RUN_ID,
      baseTreeSha1: BASE_TREE_SHA1,
      commitMessage,
      commitEpochSeconds: 0,
      commitIso8601: commitEpochToGitInstant(0),
      pullRequestTitle: "Apply the reviewed material fixture",
      pullRequestBodyPrefix: "Prepared from durable approved bytes.",
    },
    new Set([PROFILE.credentialRef.name]),
  );
  seeded.store.startCandidatePreparation(created.landing.id);

  const commitPayload = buildUnsignedCommitPayloadV1({
    candidateTreeSha1: CANDIDATE_TREE_SHA1,
    baseCommitSha1: UNIT_BASE_COMMIT,
    commitIdentity: PROFILE.commitIdentity,
    commitEpochSeconds: 0,
    commitMessage: created.landing.commitMessage,
  });
  const candidateCommitSha1 = gitObjectSha1("commit", commitPayload);
  const manifest = decodeCandidateObjectManifestV1({
    schemaVersion: 1,
    baseCommitSha1: UNIT_BASE_COMMIT,
    baseTreeSha1: BASE_TREE_SHA1,
    candidateTreeSha1: CANDIDATE_TREE_SHA1,
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
    candidateTreeSha1: CANDIDATE_TREE_SHA1,
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
      disposition: PROFILE.derivativeEffects.disposition,
      evidenceSha256: PROFILE.derivativeEffects.evidenceSha256,
    },
  });
  const landingSha256 = digestLandingRecord(authority);
  const candidate = seeded.store.settleLandingCandidate(created.landing.id, {
    candidateTreeSha1: CANDIDATE_TREE_SHA1,
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
  const fixture = {
    ...seeded,
    projectId,
    landingId: candidate.landing.id,
    leases,
    checkpointFiles: files,
    candidateManifestSha256: digestLandingRecord(manifest),
    cachePath,
    worktreePath,
  };
  fixtures.push(fixture);
  return fixture;
}

async function admitRequest(fixture: Fixture, guard: RunLeaseGuard) {
  const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
  return fixture.store.admitNextGitHubPreflightRequest(
    guard,
    fixture.landingId,
    started.operationId,
  );
}

function mutate(databasePath: string, sql: string, ...parameters: unknown[]): void {
  const database = new Database(databasePath);
  try {
    expect(database.prepare(sql).run(...parameters).changes).toBe(1);
  } finally {
    database.close();
  }
}

function mutateIgnoringChecks(databasePath: string, sql: string, ...parameters: unknown[]): void {
  const database = new Database(databasePath);
  try {
    database.prepare("PRAGMA ignore_check_constraints = ON").run();
    expect(database.prepare(sql).run(...parameters).changes).toBe(1);
  } finally {
    database.close();
  }
}

describe("guard-bound immutable GitHub landing material", () => {
  it("reconstructs create, delete, modify, and binary material without source paths", async () => {
    const fixture = await createFixture();
    expect(existsSync(fixture.cachePath)).toBe(false);
    expect(existsSync(fixture.worktreePath)).toBe(false);
    let requestId = "";

    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      requestId = admitted.request.requestId;
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });

      const claim = await fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
        guard,
        admitted.request.requestId,
      );
      expect(Object.keys(claim).sort()).toEqual(["landingSha256", "request"]);
      expect(claim.request).toEqual(admitted.request);
      const database = new Database(fixture.databasePath);
      try {
        expect(
          database
            .prepare(
              "UPDATE checkpoint_files SET approved_base64 = ? WHERE run_id = ? AND path = ?",
            )
            .run(Buffer.from("tampered\n").toString("base64"), UNIT_RUN_ID, PATHS[2]).changes,
        ).toBe(1);
        expect(
          database
            .prepare(
              "UPDATE landings SET commit_message = ?, " +
                "profile_json = replace(profile_json, ?, ?) WHERE id = ?",
            )
            .run(
              "Tampered after claim\n",
              `"owner":"${PROFILE.owner}"`,
              '"owner":"tampered-owner"',
              fixture.landingId,
            ).changes,
        ).toBe(1);
      } finally {
        database.close();
      }
      const material = await fixture.store.readClaimedGitHubLandingMaterial(
        guard,
        admitted.request.requestId,
        fixture.landingId,
      );
      expect(material.objectManifest.entries.map((entry) => entry.op)).toEqual([
        "create",
        "delete",
        "modify",
      ]);
      expect(material.changedBlobs.map((entry) => entry.path)).toEqual([PATHS[0], PATHS[2]]);
      expect(material.changedBlobs[0]?.content).toEqual(BINARY_BYTES);
      expect(material.changedBlobs[1]?.content).toEqual(new Uint8Array(MODIFIED_BYTES));
      expect(digestLandingRecord(material.objectManifest)).toBe(fixture.candidateManifestSha256);
      expect(JSON.stringify(material)).not.toContain(fixture.cachePath);
      expect(JSON.stringify(material)).not.toContain(fixture.worktreePath);

      material.changedBlobs[0]?.content.fill(42);
      (material.landing.changedPaths as string[])[0] = "mutated/path";
      (material.profile as { owner: string }).owner = "mutated-owner";
      const mutableManifestEntry = (
        material.objectManifest.entries as unknown as { path: string }[]
      )[0];
      expect(mutableManifestEntry).toBeDefined();
      if (mutableManifestEntry !== undefined) mutableManifestEntry.path = "mutated/object";
      const reread = await fixture.store.readClaimedGitHubLandingMaterial(
        guard,
        admitted.request.requestId,
        fixture.landingId,
      );
      expect(reread.changedBlobs[0]?.content).toEqual(BINARY_BYTES);
      expect(reread.landing.changedPaths[0]).toBe(PATHS[0]);
      expect(reread.profile.owner).toBe(PROFILE.owner);
      expect(reread.objectManifest.entries[0]?.path).toBe(PATHS[0]);

      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          "ffffffff-ffff-4fff-8fff-ffffffffffff",
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });

      const otherStore = new IcarusStore(fixture.databasePath);
      additionalStores.push(otherStore);
      await expect(
        otherStore.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });

    await fixture.leases.withLease(UNIT_RUN_ID, async (freshGuard) => {
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(freshGuard, requestId, fixture.landingId),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });
  });

  it("does not promote a legacy claim into material authority", async () => {
    const fixture = await createFixture();
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId),
      ).resolves.toMatchObject({ request: admitted.request });
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });
  });

  it("keeps an existing landing bound to its original profile after a project profile update", async () => {
    const fixture = await createFixture();
    const updatedProfile: GitHubLandingProfileV1 = {
      ...PROFILE,
      owner: "updated-owner",
      repository: "updated-repository",
      expectedActor: "updated-actor",
    };
    fixture.store.setLandingProfile(
      fixture.projectId,
      updatedProfile,
      new Set([updatedProfile.credentialRef.name]),
    );
    expect(fixture.store.getLandingProfile(fixture.projectId)?.profile).toEqual(updatedProfile);

    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      const claim = await fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
        guard,
        admitted.request.requestId,
      );
      const material = await fixture.store.readClaimedGitHubLandingMaterial(
        guard,
        admitted.request.requestId,
        fixture.landingId,
      );
      expect(claim.request).toMatchObject({
        kind: "github.actor.get",
        profileSha256: digestLandingRecord(PROFILE),
        subject: { expectedActor: PROFILE.expectedActor },
      });
      expect(material.profile).toEqual(PROFILE);
      expect(material.landing.profile).toEqual(PROFILE);
    });
  });

  it("reconstructs an approved empty file as the exact empty Git blob", async () => {
    const fixture = await createFixture(UNIT_CEILING, new Uint8Array());
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      await fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
        guard,
        admitted.request.requestId,
      );
      const material = await fixture.store.readClaimedGitHubLandingMaterial(
        guard,
        admitted.request.requestId,
        fixture.landingId,
      );
      expect(material.changedBlobs[0]).toMatchObject({ path: PATHS[0] });
      expect(material.changedBlobs[0]?.content).toEqual(new Uint8Array());
      expect(material.objectManifest.entries[0]).toMatchObject({
        path: PATHS[0],
        contentBytes: 0,
        contentSha256: sha256(new Uint8Array()),
        blobSha1: gitObjectSha1("blob", new Uint8Array()),
      });
    });
  });

  it("re-scans a digest-consistent secret-shaped changed blob before caching", async () => {
    const secretBytes = Buffer.from(`ghp_${"a".repeat(20)}`, "utf8");
    const fixture = await createFixture(UNIT_CEILING, secretBytes, undefined, false);
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
          guard,
          admitted.request.requestId,
        ),
      ).rejects.toMatchObject({ code: "LANDING_CREDENTIAL_AUDIT_FAILED" });
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });
  });

  it("re-scans digest-consistent secret-shaped landing text before caching", async () => {
    const secretMessage = `ghp_${"a".repeat(20)}\n`;
    const fixture = await createFixture(UNIT_CEILING, BINARY_BYTES, secretMessage, false);
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
          guard,
          admitted.request.requestId,
        ),
      ).rejects.toMatchObject({ code: "LANDING_CREDENTIAL_AUDIT_FAILED" });
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });
  });

  const corruptions: readonly {
    readonly name: string;
    readonly apply: (fixture: Fixture) => void;
  }[] = [
    {
      name: "checkpoint",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET approved_base64 = ? WHERE run_id = ? AND path = ?",
          Buffer.from("tampered\n").toString("base64"),
          UNIT_RUN_ID,
          PATHS[2],
        ),
    },
    {
      name: "noncanonical baseline",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET baseline_base64 = baseline_base64 || ' ' " +
            "WHERE run_id = ? AND path = ?",
          UNIT_RUN_ID,
          PATHS[1],
        ),
    },
    {
      name: "oversized baseline text",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET baseline_base64 = CAST(zeroblob(?) AS TEXT) " +
            "WHERE run_id = ? AND path = ?",
          1024 * 1024,
          UNIT_RUN_ID,
          PATHS[1],
        ),
    },
    {
      name: "oversized approved text",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET approved_base64 = CAST(zeroblob(?) AS TEXT) " +
            "WHERE run_id = ? AND path = ?",
          1024 * 1024,
          UNIT_RUN_ID,
          PATHS[0],
        ),
    },
    {
      name: "baseline blob",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET baseline_base64 = zeroblob(?) " +
            "WHERE run_id = ? AND path = ?",
          1024 * 1024,
          UNIT_RUN_ID,
          PATHS[1],
        ),
    },
    {
      name: "approved blob",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET approved_base64 = zeroblob(?) " +
            "WHERE run_id = ? AND path = ?",
          1024 * 1024,
          UNIT_RUN_ID,
          PATHS[0],
        ),
    },
    {
      name: "oversized checkpoint path",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE checkpoint_files SET path = ? WHERE run_id = ? AND path = ?",
          `z/${"x".repeat(4 * 1024)}`,
          UNIT_RUN_ID,
          PATHS[0],
        ),
    },
    {
      name: "checkpoint operation blob",
      apply: (fixture) =>
        mutateIgnoringChecks(
          fixture.databasePath,
          "UPDATE checkpoint_files SET op = CAST('modify' AS BLOB) " +
            "WHERE run_id = ? AND path = ?",
          UNIT_RUN_ID,
          PATHS[2],
        ),
    },
    {
      name: "text",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE landings SET commit_message = ? WHERE id = ?",
          "Tampered commit message\n",
          fixture.landingId,
        ),
    },
    {
      name: "profile",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE landings SET profile_json = replace(profile_json, ?, ?) WHERE id = ?",
          `"owner":"${PROFILE.owner}"`,
          '"owner":"different-owner"',
          fixture.landingId,
        ),
    },
    {
      name: "manifest",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE landing_operations SET result_json = replace(result_json, ?, ?) " +
            "WHERE landing_id = ? AND kind = 'candidate.prepare'",
          fixture.candidateManifestSha256,
          "8".repeat(64),
          fixture.landingId,
        ),
    },
    {
      name: "commit payload",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE landings SET candidate_commit_payload_sha256 = ? WHERE id = ?",
          "9".repeat(64),
          fixture.landingId,
        ),
    },
    {
      name: "landing digest",
      apply: (fixture) =>
        mutate(
          fixture.databasePath,
          "UPDATE landings SET landing_sha256 = ? WHERE id = ?",
          "a".repeat(64),
          fixture.landingId,
        ),
    },
  ];

  for (const corruption of corruptions) {
    it(`rejects ${corruption.name} corruption while claiming material`, async () => {
      const fixture = await createFixture();
      await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
        const admitted = await admitRequest(fixture, guard);
        corruption.apply(fixture);
        await expect(
          fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
            guard,
            admitted.request.requestId,
          ),
        ).rejects.toMatchObject({ code: expect.any(String) });
        await expect(
          fixture.store.readClaimedGitHubLandingMaterial(
            guard,
            admitted.request.requestId,
            fixture.landingId,
          ),
        ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
      });
    });
  }

  it("preserves the accepted 64-file by 8 MiB checkpoint authority above 32 MiB", () => {
    const bounds = checkpointReadBoundsV1(64, 8 * 1024 * 1024);
    expect(bounds).toEqual({
      maxFiles: 64,
      maxEncodedFileBytes: 4 * Math.ceil((8 * 1024 * 1024) / 3),
      maxSelectedBytes: 64 * (4 * 1024 + 8 + 2 * (4 * Math.ceil((8 * 1024 * 1024) / 3))),
    });
    expect(bounds.maxSelectedBytes).toBeGreaterThan(32 * 1024 * 1024);
  });

  it("rejects a checkpoint row sentinel before mapping an over-bound array", async () => {
    const fixture = await createFixture();
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admitted = await admitRequest(fixture, guard);
      const database = new Database(fixture.databasePath);
      try {
        const insert = database.prepare(
          "INSERT INTO checkpoint_files " +
            "(run_id, path, op, baseline_base64, approved_base64) VALUES (?, ?, 'create', NULL, ?)",
        );
        for (let index = 0; index < 62; index += 1) {
          expect(
            insert.run(
              UNIT_RUN_ID,
              `zz/extra-${index.toString().padStart(2, "0")}.txt`,
              Buffer.from("x").toString("base64"),
            ).changes,
          ).toBe(1);
        }
      } finally {
        database.close();
      }
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
          guard,
          admitted.request.requestId,
        ),
      ).rejects.toMatchObject({ code: "DATABASE_ERROR" });
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });
  });
});
