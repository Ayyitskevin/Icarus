import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import type { LandingStatusV1 } from "../../packages/core/src/landing-ledger.js";
import {
  commitEpochToGitInstant,
  DERIVATIVE_EFFECTS,
  DERIVATIVE_GITHUB_EVENTS,
  DIRECT_ICARUS_EFFECTS,
  decodeLandingDigestV1,
  digestLandingRecord,
  GITHUB_API_VERSION,
  type GitHubLandingProfileV1,
  type LandingDigestV1,
  type LocalRefFactV1,
  renderPullRequestBodyV1,
} from "../../packages/core/src/landing-records.js";
import { RunLeaseManager } from "../../packages/core/src/lease.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import { createChangeRoomFixture, driveToCompleted } from "../support/change-room-fixtures.js";
import { UNIT_RUN_ID } from "../support/unit-fixtures.js";

const BASE_TREE_SHA1 = "1".repeat(40);
const CANDIDATE_TREE_SHA1 = "2".repeat(40);
const CANDIDATE_COMMIT_SHA1 = "3".repeat(40);
const CANDIDATE_PAYLOAD_SHA256 = "4".repeat(64);
const CANDIDATE_MANIFEST_SHA256 = "5".repeat(64);
const CANDIDATE_AUDIT_SHA256 = "6".repeat(64);

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

interface Fixture {
  readonly root: string;
  readonly databasePath: string;
  readonly store: IcarusStore;
  readonly landingId: string;
  readonly leases: RunLeaseManager;
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

async function createFixture(): Promise<Fixture> {
  const fixture = createChangeRoomFixture();
  driveToCompleted(fixture.store);
  fixture.store.setLandingProfile(
    fixture.projectId,
    PROFILE,
    new Set([PROFILE.credentialRef.name]),
  );
  const created = fixture.store.createLanding(
    {
      runId: UNIT_RUN_ID,
      baseTreeSha1: BASE_TREE_SHA1,
      commitMessage: "Apply the reviewed greeting change\n",
      commitEpochSeconds: 0,
      commitIso8601: commitEpochToGitInstant(0),
      pullRequestTitle: "Apply the reviewed greeting change",
      pullRequestBodyPrefix: "This draft was prepared from an approved Icarus run.",
    },
    new Set([PROFILE.credentialRef.name]),
  );
  fixture.store.startCandidatePreparation(created.landing.id);
  const authority = candidateAuthority(created);
  const landingSha256 = digestLandingRecord(authority);
  const candidate = fixture.store.settleLandingCandidate(created.landing.id, {
    candidateTreeSha1: CANDIDATE_TREE_SHA1,
    candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
    candidateCommitPayloadSha256: CANDIDATE_PAYLOAD_SHA256,
    candidateObjectManifestSha256: CANDIDATE_MANIFEST_SHA256,
    candidateCredentialAuditSha256: CANDIDATE_AUDIT_SHA256,
    landingDigest: authority,
    pullRequestBodySha256: sha256(
      renderPullRequestBodyV1({
        landing: authority,
        landingSha256,
        bodyPrefix: created.landing.pullRequestBodyPrefix,
      }),
    ),
  });
  fixture.store.recordLandingDecision(
    candidate.landing.id,
    candidate.landing.landingSha256 ?? "",
    "unit-operator",
    "approve",
  );
  fixture.store.admitLandingResume(candidate.landing.id);
  const local = fixture.store.startLocalRefCreation(candidate.landing.id);
  fixture.store.recordLocalRefObservation(candidate.landing.id, local.operationId, ABSENT_REF);
  fixture.store.settleLocalRefCreation(candidate.landing.id, {
    outcome: "succeeded",
    errorCode: null,
    observedFact: ABSENT_REF,
    postEffectFact: {
      schemaVersion: 1,
      state: "direct",
      objectSha1: CANDIDATE_COMMIT_SHA1,
      symbolicTargetSha256: null,
    },
  });
  fixture.store.admitLandingResume(candidate.landing.id);
  const leases = new RunLeaseManager(path.join(fixture.root, "preflight-leases"));
  await leases.initialize();
  const result = { ...fixture, landingId: candidate.landing.id, leases };
  fixtures.push(result);
  return result;
}

describe("GitHub preflight lease claim ownership", () => {
  it("allows only one claim per request for all gateway instances under one guard", async () => {
    const fixture = await createFixture();
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
      const admitted = await fixture.store.admitNextGitHubPreflightRequest(
        guard,
        fixture.landingId,
        started.operationId,
      );
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId),
      ).resolves.toMatchObject({ request: admitted.request });
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId),
      ).rejects.toMatchObject({ code: "GITHUB_REQUEST_ALREADY_CLAIMED" });

      const missingId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequest(guard, missingId),
      ).rejects.toMatchObject({ code: "GITHUB_ADMITTED_REQUEST_UNAVAILABLE" });
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequest(guard, missingId),
      ).rejects.toMatchObject({ code: "GITHUB_REQUEST_ALREADY_CLAIMED" });
    });
  });

  it("forces a fresh guard through takeover before it can own a preflight", async () => {
    const fixture = await createFixture();
    let staleOperationId = "";
    let staleRequestId = "";
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
      const admitted = await fixture.store.admitNextGitHubPreflightRequest(
        guard,
        fixture.landingId,
        started.operationId,
      );
      staleOperationId = started.operationId;
      staleRequestId = admitted.request.requestId;
    });

    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      await expect(
        fixture.store.startGitHubPreflight(guard, fixture.landingId),
      ).rejects.toMatchObject({ code: "LANDING_COORDINATOR_TAKEOVER_REQUIRED" });
      await expect(
        fixture.store.admitNextGitHubPreflightRequest(guard, fixture.landingId, staleOperationId),
      ).rejects.toMatchObject({ code: "GITHUB_ADMITTED_REQUEST_UNAVAILABLE" });
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequest(guard, staleRequestId),
      ).rejects.toMatchObject({ code: "GITHUB_ADMITTED_REQUEST_UNAVAILABLE" });

      const takeover = fixture.store.admitLandingResume(fixture.landingId);
      expect(takeover.status.attempts.slice(-2)).toMatchObject([
        { status: "interrupted", errorCode: "LANDING_COORDINATOR_TAKEOVER" },
        { status: "started", errorCode: null },
      ]);
      expect(
        takeover.status.operations.find((operation) => operation.id === staleOperationId),
      ).toMatchObject({ status: "interrupted", errorCode: "LANDING_COORDINATOR_TAKEOVER" });

      const fresh = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
      expect(fresh.operationId).not.toBe(staleOperationId);
      const admitted = await fixture.store.admitNextGitHubPreflightRequest(
        guard,
        fixture.landingId,
        fresh.operationId,
      );
      await expect(
        fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId),
      ).resolves.toMatchObject({ request: admitted.request });
    });
  });

  it.each([
    ["oversized text", "x".repeat(65)],
    ["oversized BLOB", Buffer.alloc(1024 * 1024, 0x78)],
  ] as const)(
    "rejects a corrupt %s landing identity before bounded materialization",
    async (_name, value) => {
      const fixture = await createFixture();
      await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
        const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
        const admitted = await fixture.store.admitNextGitHubPreflightRequest(
          guard,
          fixture.landingId,
          started.operationId,
        );
        const database = new Database(fixture.databasePath);
        database.prepare("PRAGMA foreign_keys = OFF").run();
        expect(
          database
            .prepare("UPDATE landing_http_requests SET landing_id = ? WHERE id = ?")
            .run(value, admitted.request.requestId).changes,
        ).toBe(1);
        database.close();

        await expect(
          fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId),
        ).rejects.toMatchObject({ code: "LANDING_RECORD_INVALID" });
      });
    },
  );

  it("does not share operation ownership across stores even under the same valid guard", async () => {
    const fixture = await createFixture();
    const otherStore = new IcarusStore(fixture.databasePath);
    additionalStores.push(otherStore);
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
      const admitted = await fixture.store.admitNextGitHubPreflightRequest(
        guard,
        fixture.landingId,
        started.operationId,
      );
      await fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId);

      await expect(otherStore.startGitHubPreflight(guard, fixture.landingId)).rejects.toMatchObject(
        { code: "LANDING_COORDINATOR_TAKEOVER_REQUIRED" },
      );
      await expect(
        otherStore.admitNextGitHubPreflightRequest(guard, fixture.landingId, started.operationId),
      ).rejects.toMatchObject({ code: "GITHUB_ADMITTED_REQUEST_UNAVAILABLE" });
      await expect(
        otherStore.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId),
      ).rejects.toMatchObject({ code: "GITHUB_ADMITTED_REQUEST_UNAVAILABLE" });
    });
  });
});
