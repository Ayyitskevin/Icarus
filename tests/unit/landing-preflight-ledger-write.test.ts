import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import type {
  LandingGitHubPreflightSettlementInputV1,
  LandingStatusV1,
} from "../../packages/core/src/landing-ledger.js";
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
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
  type LocalRefFactV1,
  renderPullRequestBodyV1,
} from "../../packages/core/src/landing-records.js";
import { RunLeaseManager } from "../../packages/core/src/lease.js";
import type { IcarusStore } from "../../packages/core/src/store.js";
import { createChangeRoomFixture, driveToCompleted } from "../support/change-room-fixtures.js";
import { UNIT_BASE_COMMIT, UNIT_RUN_ID } from "../support/unit-fixtures.js";

const BASE_TREE_SHA1 = "1".repeat(40);
const CANDIDATE_TREE_SHA1 = "2".repeat(40);
const CANDIDATE_COMMIT_SHA1 = "3".repeat(40);
const CANDIDATE_PAYLOAD_SHA256 = "4".repeat(64);
const CANDIDATE_MANIFEST_SHA256 = "5".repeat(64);
const CANDIDATE_AUDIT_SHA256 = "6".repeat(64);
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
  prepare(sql: string): { run(...parameters: unknown[]): unknown };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const fixtures: Fixture[] = [];

afterEach(() => {
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
  const fresh = fixture.store.admitLandingResume(candidate.landing.id);
  expect(fresh).toMatchObject({
    operationId: null,
    attemptLimitReached: false,
    status: { landing: { state: "local_ready" } },
  });
  const leases = new RunLeaseManager(path.join(fixture.root, "preflight-leases"));
  await leases.initialize();
  const result = { ...fixture, landingId: candidate.landing.id, leases };
  fixtures.push(result);
  return result;
}

function successfulResult(
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
        sha1: UNIT_BASE_COMMIT,
      },
      errorCode: null,
    };
  }
  if (request.kind !== "github.head_ref.get") {
    throw new Error(`Unexpected preflight request ${request.kind}`);
  }
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    kind: request.kind,
    outcome: "succeeded",
    httpStatus: 404,
    projection: { type: "ref", state: "absent", ref: status.landing.headRef, sha1: null },
    errorCode: null,
  };
}

function settlement(
  request: LandingGitHubPreflightSettlementInputV1["request"],
  result: LandingHttpResultV1,
): LandingGitHubPreflightSettlementInputV1 {
  return {
    request,
    requestSha256: digestLandingRecord(request),
    result,
    resultSha256: digestLandingRecord(result),
  };
}

describe("GitHub preflight ledger writer", () => {
  it("writes and replays the exact bounded three-GET preflight", async () => {
    const fixture = await createFixture();

    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
      const replay = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
      expect(replay.operationId).toBe(started.operationId);
      expect(replay.status.operations.at(-1)?.request.input).toMatchObject({
        includePullRequestAbsence: false,
        candidateCommitSha1: CANDIDATE_COMMIT_SHA1,
      });

      const requests: LandingHttpRequestV1[] = [];
      for (let index = 0; index < 3; index += 1) {
        const admitted = await fixture.store.admitNextGitHubPreflightRequest(
          guard,
          fixture.landingId,
          started.operationId,
        );
        const admittedReplay = await fixture.store.admitNextGitHubPreflightRequest(
          guard,
          fixture.landingId,
          started.operationId,
        );
        expect(admittedReplay.request).toEqual(admitted.request);
        expect(admitted.requestSha256).toBe(digestLandingRecord(admitted.request));
        expect(admitted.request.requestOrdinal).toBe(index + 1);
        requests.push(admitted.request);

        const claim = await fixture.store.claimAdmittedGitHubPreflightRequest(
          guard,
          admitted.request.requestId,
        );
        expect(claim).toEqual({
          request: admitted.request,
          landingSha256: admitted.status.landing.landingSha256,
        });
        const result = successfulResult(admitted.status, admitted.request);
        const settled = await fixture.store.settleGitHubPreflightRequest(
          guard,
          fixture.landingId,
          started.operationId,
          settlement(admitted.request, result),
        );
        const settledReplay = await fixture.store.settleGitHubPreflightRequest(
          guard,
          fixture.landingId,
          started.operationId,
          settlement(admitted.request, result),
        );
        expect(settledReplay).toEqual(settled);
      }

      expect(requests.map((request) => request.kind)).toEqual([
        "github.actor.get",
        "github.base_ref.get",
        "github.head_ref.get",
      ]);
      const completed = fixture.store.getLandingStatus(fixture.landingId);
      expect(completed.landing.state).toBe("local_ready");
      expect(
        completed.operations.find((operation) => operation.id === started.operationId),
      ).toMatchObject({
        id: started.operationId,
        kind: "github.preflight",
        status: "completed",
        result: { outcome: "completed", boundary: "preflight_exact" },
      });
      expect(completed.attempts.at(-1)?.status).toBe("started");
      expect(completed.events.slice(-2).map((event) => event.type)).toEqual([
        "landing.github.request.settled",
        "landing.operation.settled",
      ]);
      await expect(
        fixture.store.admitNextGitHubPreflightRequest(
          guard,
          fixture.landingId,
          started.operationId,
        ),
      ).rejects.toMatchObject({ code: "LANDING_NOT_ADMITTED" });
    });
  });

  it.each(["failed", "ambiguous"] as const)(
    "settles a %s request with only its allowed terminal suffix",
    async (outcome) => {
      const fixture = await createFixture();
      await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
        const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
        const admitted = await fixture.store.admitNextGitHubPreflightRequest(
          guard,
          fixture.landingId,
          started.operationId,
        );
        await fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId);
        const result: LandingHttpResultV1 = {
          schemaVersion: 1,
          requestId: admitted.request.requestId,
          kind: admitted.request.kind,
          outcome,
          httpStatus: outcome === "failed" ? 403 : null,
          projection: null,
          errorCode: outcome === "failed" ? "GITHUB_PERMISSION_DENIED" : "GITHUB_OUTCOME_AMBIGUOUS",
        };
        const settled = await fixture.store.settleGitHubPreflightRequest(
          guard,
          fixture.landingId,
          started.operationId,
          settlement(admitted.request, result),
        );
        await expect(
          fixture.store.settleGitHubPreflightRequest(
            guard,
            fixture.landingId,
            started.operationId,
            settlement(admitted.request, result),
          ),
        ).resolves.toEqual(settled);

        expect(settled.attempts.at(-1)?.status).toBe(
          outcome === "failed" ? "failed" : "interrupted",
        );
        expect(settled.landing).toMatchObject(
          outcome === "failed"
            ? {
                state: "failed",
                resumeState: "local_ready",
                errorCode: "GITHUB_PERMISSION_DENIED",
              }
            : { state: "local_ready", resumeState: null, errorCode: null },
        );
        expect(
          settled.events.slice(outcome === "failed" ? -4 : -3).map((event) => event.type),
        ).toEqual(
          outcome === "failed"
            ? [
                "landing.github.request.settled",
                "landing.operation.settled",
                "landing.attempt.settled",
                "landing.state.changed",
              ]
            : [
                "landing.github.request.settled",
                "landing.operation.settled",
                "landing.attempt.settled",
              ],
        );
      });
    },
  );

  it("rejects settlement before the admitted request is claimed", async () => {
    const fixture = await createFixture();
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
      const admitted = await fixture.store.admitNextGitHubPreflightRequest(
        guard,
        fixture.landingId,
        started.operationId,
      );
      const before = fixture.store.getLandingStatus(fixture.landingId);
      const result = successfulResult(before, admitted.request);
      await expect(
        fixture.store.settleGitHubPreflightRequest(
          guard,
          fixture.landingId,
          started.operationId,
          settlement(admitted.request, result),
        ),
      ).rejects.toMatchObject({ code: "GITHUB_ADMITTED_REQUEST_UNAVAILABLE" });
      expect(fixture.store.getLandingStatus(fixture.landingId)).toEqual(before);
    });
  });

  it("rolls back request settlement when full-history validation fails before commit", async () => {
    const fixture = await createFixture();
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
      const admitted = await fixture.store.admitNextGitHubPreflightRequest(
        guard,
        fixture.landingId,
        started.operationId,
      );
      await fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId);
      const before = fixture.store.getLandingStatus(fixture.landingId);
      const database = new Database(fixture.databasePath);
      database
        .prepare(
          "CREATE TRIGGER corrupt_preflight_settlement AFTER UPDATE OF status " +
            "ON landing_http_requests WHEN NEW.status = 'settled' BEGIN " +
            "INSERT INTO landing_events (landing_id, sequence, type, payload_json, created_at) " +
            "VALUES (NEW.landing_id, " +
            "(SELECT COALESCE(MAX(sequence), 0) + 1 FROM landing_events WHERE landing_id = NEW.landing_id), " +
            "'landing.github.request.settled', '{}', '2026-07-19T12:00:00.000Z'); END",
        )
        .run();
      database.close();

      const result = successfulResult(before, admitted.request);
      await expect(
        fixture.store.settleGitHubPreflightRequest(
          guard,
          fixture.landingId,
          started.operationId,
          settlement(admitted.request, result),
        ),
      ).rejects.toMatchObject({ code: "LANDING_RECORD_INVALID" });
      expect(fixture.store.getLandingStatus(fixture.landingId)).toEqual(before);

      const recoveryDatabase = new Database(fixture.databasePath);
      recoveryDatabase.prepare("DROP TRIGGER corrupt_preflight_settlement").run();
      recoveryDatabase.close();
      await expect(
        fixture.store.settleGitHubPreflightRequest(
          guard,
          fixture.landingId,
          started.operationId,
          settlement(admitted.request, result),
        ),
      ).resolves.toMatchObject({ landing: { state: "local_ready" } });
    });
  });
});
