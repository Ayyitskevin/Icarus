import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import type {
  LandingGitHubMaterialSnapshotV1,
  LandingGitHubObjectsSettlementInputV1,
  LandingGitHubPreflightSettlementInputV1,
  LandingStatusV1,
} from "../../packages/core/src/landing-ledger.js";
import {
  canonicalGitHubPostBodyV1,
  digestLandingRecord,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
} from "../../packages/core/src/landing-records.js";
import type { RunLeaseGuard } from "../../packages/core/src/lease.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import {
  createLandingGitHubMaterialFixture,
  type LandingGitHubMaterialFixture,
} from "../support/landing-github-material-fixture.js";
import { UNIT_RUN_ID } from "../support/unit-fixtures.js";

interface TestDatabase {
  prepare(sql: string): {
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): { readonly changes: number };
  };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

const fixtures: LandingGitHubMaterialFixture[] = [];
const additionalStores: IcarusStore[] = [];

afterEach(() => {
  for (const store of additionalStores.splice(0)) store.close();
  for (const fixture of fixtures.splice(0)) {
    try {
      fixture.store.close();
    } catch {
      // Restart tests may close the original handle before cleanup.
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<LandingGitHubMaterialFixture> {
  const fixture = await createLandingGitHubMaterialFixture();
  fixtures.push(fixture);
  return fixture;
}

function preflightSuccess(
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

function objectSuccess(
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
  if (request.kind === "github.blob.post") {
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
  }
  if (request.kind === "github.tree.post") {
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
  }
  if (request.kind !== "github.commit.post") {
    throw new Error(`Unexpected object request ${request.kind}`);
  }
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
}

function preflightSettlement(
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

function objectSettlement(
  request: LandingGitHubObjectsSettlementInputV1["request"],
  result: LandingHttpResultV1,
): LandingGitHubObjectsSettlementInputV1 {
  return {
    request,
    requestSha256: digestLandingRecord(request),
    result,
    resultSha256: digestLandingRecord(result),
  };
}

async function completePreflight(
  fixture: LandingGitHubMaterialFixture,
  guard: RunLeaseGuard,
): Promise<{
  readonly status: LandingStatusV1;
  readonly operationId: string;
  readonly material: LandingGitHubMaterialSnapshotV1;
}> {
  const started = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
  let material: LandingGitHubMaterialSnapshotV1 | null = null;
  for (let index = 0; index < 3; index += 1) {
    const admitted = await fixture.store.admitNextGitHubPreflightRequest(
      guard,
      fixture.landingId,
      started.operationId,
    );
    if (index === 0) {
      await fixture.store.claimAdmittedGitHubPreflightRequestWithMaterial(
        guard,
        admitted.request.requestId,
      );
      material = await fixture.store.readClaimedGitHubLandingMaterial(
        guard,
        admitted.request.requestId,
        fixture.landingId,
      );
    } else {
      await fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId);
    }
    const result = preflightSuccess(admitted.status, admitted.request);
    await fixture.store.settleGitHubPreflightRequest(
      guard,
      fixture.landingId,
      started.operationId,
      preflightSettlement(admitted.request, result),
    );
  }
  if (material === null) throw new Error("Preflight did not expose immutable material");
  return {
    status: fixture.store.getLandingStatus(fixture.landingId),
    operationId: started.operationId,
    material,
  };
}

async function startObjects(
  fixture: LandingGitHubMaterialFixture,
  guard: RunLeaseGuard,
): Promise<{
  readonly preflight: Awaited<ReturnType<typeof completePreflight>>;
  readonly operationId: string;
  readonly status: LandingStatusV1;
}> {
  const preflight = await completePreflight(fixture, guard);
  const started = await fixture.store.startGitHubObjectsUpload(guard, fixture.landingId);
  return { preflight, operationId: started.operationId, status: started.status };
}

function terminalResult(
  request: LandingHttpRequestV1,
  outcome: "failed" | "ambiguous",
): LandingHttpResultV1 {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    kind: request.kind,
    outcome,
    httpStatus: outcome === "failed" ? 403 : null,
    projection: null,
    errorCode: outcome === "failed" ? "GITHUB_PERMISSION_DENIED" : "GITHUB_OUTCOME_AMBIGUOUS",
  };
}

describe("guarded GitHub object-upload ledger writer", () => {
  it("writes, replays, and completes the exact actor/blob/tree/commit sequence", async () => {
    const fixture = await createFixture();
    expect(existsSync(fixture.cachePath)).toBe(false);
    expect(existsSync(fixture.worktreePath)).toBe(false);

    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const started = await startObjects(fixture, guard);
      const startEventCount = started.status.events.length;
      const replay = await fixture.store.startGitHubObjectsUpload(guard, fixture.landingId);
      expect(replay).toEqual({ status: started.status, operationId: started.operationId });
      expect(replay.status.events).toHaveLength(startEventCount);
      expect(replay.status.operations.at(-1)?.request.input).toMatchObject({
        preflightOperationId: started.preflight.operationId,
        retrySubjectOperationId: null,
        retrySubjectRequestSha256: null,
      });

      const requests: LandingHttpRequestV1[] = [];
      for (let index = 0; index < 5; index += 1) {
        const admitted = await fixture.store.admitNextGitHubObjectsRequest(
          guard,
          fixture.landingId,
          started.operationId,
        );
        const admissionReplay = await fixture.store.admitNextGitHubObjectsRequest(
          guard,
          fixture.landingId,
          started.operationId,
        );
        expect(admissionReplay).toEqual(admitted);
        expect(admitted.requestSha256).toBe(digestLandingRecord(admitted.request));
        expect(admitted.request.requestOrdinal).toBe(index + 4);
        requests.push(admitted.request);

        const result = objectSuccess(admitted.status, admitted.request);
        if (index === 0) {
          await expect(
            fixture.store.settleGitHubObjectsRequest(
              guard,
              fixture.landingId,
              started.operationId,
              objectSettlement(admitted.request, result),
            ),
          ).rejects.toMatchObject({ code: "GITHUB_ADMITTED_REQUEST_UNAVAILABLE" });
          await fixture.store.claimAdmittedGitHubObjectsRequestWithMaterial(
            guard,
            admitted.request.requestId,
          );
          const claimedMaterial = await fixture.store.readClaimedGitHubLandingMaterial(
            guard,
            admitted.request.requestId,
            fixture.landingId,
          );
          expect(claimedMaterial).toEqual(started.preflight.material);
        } else {
          await fixture.store.claimAdmittedGitHubObjectsRequest(guard, admitted.request.requestId);
        }
        const settled = await fixture.store.settleGitHubObjectsRequest(
          guard,
          fixture.landingId,
          started.operationId,
          objectSettlement(admitted.request, result),
        );
        await expect(
          fixture.store.settleGitHubObjectsRequest(
            guard,
            fixture.landingId,
            started.operationId,
            objectSettlement(admitted.request, result),
          ),
        ).resolves.toEqual(settled);
        await expect(
          fixture.store.settleGitHubObjectsRequest(
            guard,
            fixture.landingId,
            started.operationId,
            objectSettlement(admitted.request, terminalResult(admitted.request, "failed")),
          ),
        ).rejects.toMatchObject({ code: "LANDING_CONFLICT" });
      }

      expect(requests.map((request) => request.kind)).toEqual([
        "github.actor.get",
        "github.blob.post",
        "github.blob.post",
        "github.tree.post",
        "github.commit.post",
      ]);
      expect(requests.map((request) => request.method)).toEqual([
        "GET",
        "POST",
        "POST",
        "POST",
        "POST",
      ]);
      const material = started.preflight.material;
      expect(requests.slice(1, 3).map((request) => request.bodySha256)).toEqual(
        material.changedBlobs.map(
          (blob) =>
            canonicalGitHubPostBodyV1("github.blob.post", {
              content: Buffer.from(blob.content).toString("base64"),
              encoding: "base64",
            }).sha256,
        ),
      );
      expect(requests[3]?.bodySha256).toBe(
        canonicalGitHubPostBodyV1("github.tree.post", {
          base_tree: material.landing.baseTreeSha1,
          tree: material.objectManifest.entries.map((entry) => ({
            path: entry.path,
            mode: entry.mode,
            type: "blob",
            sha: entry.blobSha1,
          })),
        }).sha256,
      );
      expect(requests[4]?.bodySha256).toBe(
        canonicalGitHubPostBodyV1("github.commit.post", {
          message: material.text.commitMessage,
          tree: material.landing.candidateTreeSha1,
          parents: [material.landing.baseCommitSha1],
          author: {
            ...material.landing.commitAuthor,
            date: material.landing.commitIso8601,
          },
          committer: {
            ...material.landing.commitCommitter,
            date: material.landing.commitIso8601,
          },
        }).sha256,
      );

      const completed = fixture.store.getLandingStatus(fixture.landingId);
      expect(completed.landing).toMatchObject({
        state: "objects_ready",
        resumeState: null,
        errorCode: null,
      });
      expect(completed.attempts.at(-1)).toMatchObject({ status: "started" });
      expect(completed.operations.at(-1)).toMatchObject({
        id: started.operationId,
        kind: "github.objects.upload",
        status: "completed",
        observation: {
          phase: "pre_effect",
          facts: [{ fact: "actor", requestId: requests[0]?.requestId }],
        },
        result: { outcome: "completed", boundary: "objects_exact" },
      });
      expect(completed.events.slice(-3).map((event) => event.type)).toEqual([
        "landing.github.request.settled",
        "landing.operation.settled",
        "landing.state.changed",
      ]);
      expect(existsSync(fixture.cachePath)).toBe(false);
      expect(existsSync(fixture.worktreePath)).toBe(false);
    });
  });

  it.each([
    ["actor", "failed", "failed", "failed"],
    ["actor", "ambiguous", "reconciliation_required", "interrupted"],
    ["post", "failed", "reconciliation_required", "interrupted"],
    ["post", "ambiguous", "reconciliation_required", "interrupted"],
  ] as const)(
    "settles a %s %s result at the required recovery boundary",
    async (stage, outcome, expectedState, expectedAttempt) => {
      const fixture = await createFixture();
      await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
        const started = await startObjects(fixture, guard);
        const actor = await fixture.store.admitNextGitHubObjectsRequest(
          guard,
          fixture.landingId,
          started.operationId,
        );
        await fixture.store.claimAdmittedGitHubObjectsRequest(guard, actor.request.requestId);
        if (stage === "post") {
          await fixture.store.settleGitHubObjectsRequest(
            guard,
            fixture.landingId,
            started.operationId,
            objectSettlement(actor.request, objectSuccess(actor.status, actor.request)),
          );
        }
        const admitted =
          stage === "actor"
            ? actor
            : await fixture.store.admitNextGitHubObjectsRequest(
                guard,
                fixture.landingId,
                started.operationId,
              );
        if (stage === "post") {
          await fixture.store.claimAdmittedGitHubObjectsRequest(guard, admitted.request.requestId);
        }
        const terminal = terminalResult(admitted.request, outcome);
        const settled = await fixture.store.settleGitHubObjectsRequest(
          guard,
          fixture.landingId,
          started.operationId,
          objectSettlement(admitted.request, terminal),
        );
        expect(settled.landing).toMatchObject({
          state: expectedState,
          resumeState: "local_ready",
          errorCode: terminal.errorCode,
        });
        expect(settled.attempts.at(-1)).toMatchObject({
          status: expectedAttempt,
          errorCode: terminal.errorCode,
        });
        expect(settled.operations.at(-1)).toMatchObject({
          id: started.operationId,
          status: expectedAttempt === "failed" ? "failed" : "interrupted",
          result: {
            outcome: expectedAttempt === "failed" ? "failed" : "reconciliation_required",
          },
        });
        expect(settled.events.slice(-4).map((event) => event.type)).toEqual([
          "landing.github.request.settled",
          "landing.operation.settled",
          "landing.attempt.settled",
          "landing.state.changed",
        ]);
      });
    },
  );

  it("rolls back HTTP, actor observation, events, and state on a transaction fault", async () => {
    const fixture = await createFixture();
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const started = await startObjects(fixture, guard);
      const admitted = await fixture.store.admitNextGitHubObjectsRequest(
        guard,
        fixture.landingId,
        started.operationId,
      );
      await fixture.store.claimAdmittedGitHubObjectsRequest(guard, admitted.request.requestId);
      const before = fixture.store.getLandingStatus(fixture.landingId);
      const database = new Database(fixture.databasePath);
      database
        .prepare(
          "CREATE TRIGGER object_observation_fault BEFORE UPDATE OF observation_json " +
            "ON landing_operations WHEN OLD.id = '" +
            started.operationId +
            "' BEGIN SELECT RAISE(ABORT, 'injected object observation fault'); END",
        )
        .run();
      database.close();

      const input = objectSettlement(
        admitted.request,
        objectSuccess(admitted.status, admitted.request),
      );
      await expect(
        fixture.store.settleGitHubObjectsRequest(
          guard,
          fixture.landingId,
          started.operationId,
          input,
        ),
      ).rejects.toThrow("injected object observation fault");
      expect(fixture.store.getLandingStatus(fixture.landingId)).toEqual(before);

      const recovery = new Database(fixture.databasePath);
      recovery.prepare("DROP TRIGGER object_observation_fault").run();
      recovery.close();
      await expect(
        fixture.store.settleGitHubObjectsRequest(
          guard,
          fixture.landingId,
          started.operationId,
          input,
        ),
      ).resolves.toMatchObject({
        landing: { state: "uploading_objects" },
        operations: expect.arrayContaining([
          expect.objectContaining({
            id: started.operationId,
            observation: expect.objectContaining({ phase: "pre_effect" }),
          }),
        ]),
      });
    });
  });

  it("derives effectful retry ancestry, inherits it through zero-POST proof and actor failures, and stops at attempt eight", async () => {
    const fixture = await createFixture();
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const effectful = await startObjects(fixture, guard);
      const actor = await fixture.store.admitNextGitHubObjectsRequest(
        guard,
        fixture.landingId,
        effectful.operationId,
      );
      await fixture.store.claimAdmittedGitHubObjectsRequest(guard, actor.request.requestId);
      await fixture.store.settleGitHubObjectsRequest(
        guard,
        fixture.landingId,
        effectful.operationId,
        objectSettlement(actor.request, objectSuccess(actor.status, actor.request)),
      );
      const post = await fixture.store.admitNextGitHubObjectsRequest(
        guard,
        fixture.landingId,
        effectful.operationId,
      );
      await fixture.store.claimAdmittedGitHubObjectsRequest(guard, post.request.requestId);
      const interruptedA = await fixture.store.settleGitHubObjectsRequest(
        guard,
        fixture.landingId,
        effectful.operationId,
        objectSettlement(post.request, terminalResult(post.request, "ambiguous")),
      );
      const subjectA = interruptedA.operations.find(
        (operation) => operation.id === effectful.operationId,
      );
      if (subjectA === undefined) throw new Error("Effectful retry subject disappeared");

      const reconcileA = await fixture.store.admitGuardedLandingResume(guard, fixture.landingId);
      if (reconcileA.operationId === null) throw new Error("Effectful retry lacked reconciliation");
      await fixture.store.settleGitHubObjectsReconciliation(
        guard,
        fixture.landingId,
        reconcileA.operationId,
      );
      await fixture.store.admitGuardedLandingResume(guard, fixture.landingId);
      const inherited = await startObjects(fixture, guard);
      expect(inherited.status.operations.at(-1)?.request.input).toMatchObject({
        retrySubjectOperationId: subjectA.id,
        retrySubjectRequestSha256: subjectA.requestSha256,
      });

      const inheritedActor = await fixture.store.admitNextGitHubObjectsRequest(
        guard,
        fixture.landingId,
        inherited.operationId,
      );
      await fixture.store.claimAdmittedGitHubObjectsRequest(
        guard,
        inheritedActor.request.requestId,
      );
      await fixture.store.settleGitHubObjectsRequest(
        guard,
        fixture.landingId,
        inherited.operationId,
        objectSettlement(
          inheritedActor.request,
          terminalResult(inheritedActor.request, "ambiguous"),
        ),
      );
      const reconcileZeroPost = await fixture.store.admitGuardedLandingResume(
        guard,
        fixture.landingId,
      );
      if (reconcileZeroPost.operationId === null) {
        throw new Error("Zero-POST subject lacked reconciliation");
      }
      await fixture.store.settleGitHubObjectsReconciliation(
        guard,
        fixture.landingId,
        reconcileZeroPost.operationId,
      );
      await fixture.store.admitGuardedLandingResume(guard, fixture.landingId);
      let failedActorStage = await startObjects(fixture, guard);
      expect(failedActorStage.status.operations.at(-1)?.request.input).toMatchObject({
        retrySubjectOperationId: subjectA.id,
        retrySubjectRequestSha256: subjectA.requestSha256,
      });

      for (const expectedAttempt of [7, 8]) {
        expect(failedActorStage.status.attempts.at(-1)?.ordinal).toBe(expectedAttempt);
        const failedActor = await fixture.store.admitNextGitHubObjectsRequest(
          guard,
          fixture.landingId,
          failedActorStage.operationId,
        );
        await fixture.store.claimAdmittedGitHubObjectsRequest(guard, failedActor.request.requestId);
        await fixture.store.settleGitHubObjectsRequest(
          guard,
          fixture.landingId,
          failedActorStage.operationId,
          objectSettlement(failedActor.request, terminalResult(failedActor.request, "failed")),
        );
        if (expectedAttempt === 8) break;
        await fixture.store.admitGuardedLandingResume(guard, fixture.landingId);
        failedActorStage = await startObjects(fixture, guard);
        expect(failedActorStage.status.operations.at(-1)?.request.input).toMatchObject({
          retrySubjectOperationId: subjectA.id,
          retrySubjectRequestSha256: subjectA.requestSha256,
        });
      }
      await expect(
        fixture.store.admitGuardedLandingResume(guard, fixture.landingId),
      ).rejects.toMatchObject({ code: "LANDING_ATTEMPT_LIMIT" });
      const exhausted = fixture.store.getLandingStatus(fixture.landingId);
      expect(exhausted.attempts).toHaveLength(8);
      expect(exhausted.attempts.some((attempt) => attempt.ordinal === 9)).toBe(false);
    });
  });

  it("requires same-guard preflight authority and takes over an orphan without redispatch", async () => {
    const fixture = await createFixture();
    let objectOperationId = "";
    let admittedRequestId = "";
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const preflight = await completePreflight(fixture, guard);
      const otherStore = new IcarusStore(fixture.databasePath);
      try {
        await expect(
          otherStore.startGitHubObjectsUpload(guard, fixture.landingId),
        ).rejects.toMatchObject({ code: "LANDING_COORDINATOR_TAKEOVER_REQUIRED" });
      } finally {
        otherStore.close();
      }

      const started = await fixture.store.startGitHubObjectsUpload(guard, fixture.landingId);
      objectOperationId = started.operationId;
      const operationInput = started.status.operations.at(-1)?.request.input;
      if (operationInput === undefined)
        throw new Error("Object upload operation input disappeared");
      expect((operationInput as { preflightOperationId?: string }).preflightOperationId).toBe(
        preflight.operationId,
      );
      const admitted = await fixture.store.admitNextGitHubObjectsRequest(
        guard,
        fixture.landingId,
        started.operationId,
      );
      admittedRequestId = admitted.request.requestId;
    });

    fixture.store.close();
    const restarted = new IcarusStore(fixture.databasePath);
    additionalStores.push(restarted);
    await fixture.leases.withLease(UNIT_RUN_ID, async (freshGuard) => {
      await expect(
        restarted.startGitHubObjectsUpload(freshGuard, fixture.landingId),
      ).rejects.toMatchObject({ code: "LANDING_COORDINATOR_TAKEOVER_REQUIRED" });
      const before = restarted.getLandingStatus(fixture.landingId);
      const admittedEvents = before.events.filter(
        (event) => event.type === "landing.github.request.admitted",
      ).length;
      const takeover = await restarted.admitGuardedLandingResume(freshGuard, fixture.landingId);
      expect(takeover.status.operations.slice(-2)).toMatchObject([
        {
          id: objectOperationId,
          kind: "github.objects.upload",
          status: "interrupted",
          result: { outcome: "reconciliation_required" },
        },
        { id: takeover.operationId, kind: "landing.reconcile", status: "started" },
      ]);
      expect(
        takeover.status.events.filter((event) => event.type === "landing.github.request.admitted"),
      ).toHaveLength(admittedEvents);
      expect(
        takeover.status.events.findLast(
          (event) =>
            event.type === "landing.github.request.settled" &&
            (event.payload as { requestId?: string }).requestId === admittedRequestId,
        )?.payload,
      ).toMatchObject({ outcome: "ambiguous", errorCode: "GITHUB_OUTCOME_AMBIGUOUS" });
    });
  });

  it("rejects a historical completed preflight after a fresh-guard takeover", async () => {
    const fixture = await createFixture();
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      await completePreflight(fixture, guard);
    });
    await fixture.leases.withLease(UNIT_RUN_ID, async (freshGuard) => {
      await expect(
        fixture.store.startGitHubObjectsUpload(freshGuard, fixture.landingId),
      ).rejects.toMatchObject({ code: "LANDING_COORDINATOR_TAKEOVER_REQUIRED" });
      const resumed = await fixture.store.admitGuardedLandingResume(freshGuard, fixture.landingId);
      expect(resumed.status.attempts.slice(-2)).toMatchObject([
        { status: "interrupted" },
        { status: "started" },
      ]);
      await expect(
        fixture.store.startGitHubObjectsUpload(freshGuard, fixture.landingId),
      ).rejects.toMatchObject({ code: "LANDING_COORDINATOR_TAKEOVER_REQUIRED" });
    });
  });
});
