import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type {
  LandingGitHubObjectsSettlementInputV1,
  LandingGitHubPreflightSettlementInputV1,
  LandingStatusV1,
} from "../../packages/core/src/landing-ledger.js";
import {
  digestLandingRecord,
  type LandingHttpRequestV1,
  type LandingHttpResultV1,
} from "../../packages/core/src/landing-records.js";
import type { RunLeaseGuard } from "../../packages/core/src/lease.js";
import { MAX_CHANGED_FILES } from "../../packages/core/src/policy.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import {
  createLandingGitHubMaterialFixture,
  type LandingGitHubMaterialFixture,
  MATERIAL_BINARY_BYTES,
  MATERIAL_PATHS,
  MATERIAL_PROFILE,
} from "../support/landing-github-material-fixture.js";
import { UNIT_RUN_ID } from "../support/unit-fixtures.js";

const fixtures: LandingGitHubMaterialFixture[] = [];
const additionalStores: IcarusStore[] = [];

afterEach(() => {
  for (const store of additionalStores.splice(0)) store.close();
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<LandingGitHubMaterialFixture> {
  const fixture = await createLandingGitHubMaterialFixture();
  fixtures.push(fixture);
  return fixture;
}

function success(status: LandingStatusV1, request: LandingHttpRequestV1): LandingHttpResultV1 {
  switch (request.kind) {
    case "github.actor.get":
      return {
        schemaVersion: 1,
        requestId: request.requestId,
        kind: request.kind,
        outcome: "succeeded",
        httpStatus: 200,
        projection: { type: "actor", login: status.landing.profile.expectedActor },
        errorCode: null,
      };
    case "github.base_ref.get":
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
    case "github.head_ref.get":
      return {
        schemaVersion: 1,
        requestId: request.requestId,
        kind: request.kind,
        outcome: "succeeded",
        httpStatus: 404,
        projection: { type: "ref", state: "absent", ref: status.landing.headRef, sha1: null },
        errorCode: null,
      };
    case "github.blob.post":
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
    case "github.tree.post":
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
    case "github.commit.post":
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
    default:
      throw new Error(`Unexpected request ${request.kind}`);
  }
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

async function startObjects(
  fixture: LandingGitHubMaterialFixture,
  guard: RunLeaseGuard,
): Promise<string> {
  const preflight = await fixture.store.startGitHubPreflight(guard, fixture.landingId);
  for (let index = 0; index < 3; index += 1) {
    const admitted = await fixture.store.admitNextGitHubPreflightRequest(
      guard,
      fixture.landingId,
      preflight.operationId,
    );
    await fixture.store.claimAdmittedGitHubPreflightRequest(guard, admitted.request.requestId);
    const result = success(admitted.status, admitted.request);
    await fixture.store.settleGitHubPreflightRequest(
      guard,
      fixture.landingId,
      preflight.operationId,
      preflightSettlement(admitted.request, result),
    );
  }
  return (await fixture.store.startGitHubObjectsUpload(guard, fixture.landingId)).operationId;
}

describe("guard-bound GitHub object request claims and material cache", () => {
  it("binds one-shot claims and defensive material to the exact store, guard, landing, and operation", async () => {
    const fixture = await createFixture();
    let actorRequestId = "";

    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const operationId = await startObjects(fixture, guard);
      const admitted = await fixture.store.admitNextGitHubObjectsRequest(
        guard,
        fixture.landingId,
        operationId,
      );
      actorRequestId = admitted.request.requestId;
      await expect(
        fixture.store.claimAdmittedGitHubObjectsRequest(guard, "not-a-request-id"),
      ).rejects.toMatchObject({ code: "LANDING_RECORD_INVALID" });
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          guard,
          admitted.request.requestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });

      const claim = await fixture.store.claimAdmittedGitHubObjectsRequestWithMaterial(
        guard,
        admitted.request.requestId,
      );
      expect(claim).toMatchObject({ request: admitted.request });
      await expect(
        fixture.store.claimAdmittedGitHubObjectsRequest(guard, admitted.request.requestId),
      ).rejects.toMatchObject({ code: "GITHUB_REQUEST_ALREADY_CLAIMED" });

      const material = await fixture.store.readClaimedGitHubLandingMaterial(
        guard,
        admitted.request.requestId,
        fixture.landingId,
      );
      material.changedBlobs[0]?.content.fill(42);
      (material.landing.changedPaths as string[])[0] = "mutated/path";
      (material.profile as { owner: string }).owner = "mutated-owner";
      const reread = await fixture.store.readClaimedGitHubLandingMaterial(
        guard,
        admitted.request.requestId,
        fixture.landingId,
      );
      expect(reread.changedBlobs[0]?.content).toEqual(MATERIAL_BINARY_BYTES);
      expect(reread.landing.changedPaths[0]).toBe(MATERIAL_PATHS[0]);
      expect(reread.profile.owner).toBe(MATERIAL_PROFILE.owner);

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
        otherStore.claimAdmittedGitHubObjectsRequest(guard, admitted.request.requestId),
      ).rejects.toMatchObject({ code: "GITHUB_ADMITTED_REQUEST_UNAVAILABLE" });
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
        fixture.store.claimAdmittedGitHubObjectsRequest(freshGuard, actorRequestId),
      ).rejects.toMatchObject({ code: "GITHUB_ADMITTED_REQUEST_UNAVAILABLE" });
      await expect(
        fixture.store.readClaimedGitHubLandingMaterial(
          freshGuard,
          actorRequestId,
          fixture.landingId,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
    });
  });

  it("keeps only the latest defensive material snapshot per object operation", async () => {
    const fixture = await createFixture();
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const operationId = await startObjects(fixture, guard);
      let previousRequestId: string | null = null;
      const requestIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const admitted = await fixture.store.admitNextGitHubObjectsRequest(
          guard,
          fixture.landingId,
          operationId,
        );
        requestIds.push(admitted.request.requestId);
        await fixture.store.claimAdmittedGitHubObjectsRequestWithMaterial(
          guard,
          admitted.request.requestId,
        );
        await expect(
          fixture.store.readClaimedGitHubLandingMaterial(
            guard,
            admitted.request.requestId,
            fixture.landingId,
          ),
        ).resolves.toMatchObject({ landing: { landingId: fixture.landingId } });
        if (previousRequestId !== null) {
          await expect(
            fixture.store.readClaimedGitHubLandingMaterial(
              guard,
              previousRequestId,
              fixture.landingId,
            ),
          ).rejects.toMatchObject({ code: "GITHUB_GATEWAY_MATERIAL_UNAVAILABLE" });
        }
        previousRequestId = admitted.request.requestId;
        const result = success(admitted.status, admitted.request);
        await fixture.store.settleGitHubObjectsRequest(
          guard,
          fixture.landingId,
          operationId,
          objectSettlement(admitted.request, result),
        );
      }
      expect(new Set(requestIds)).toHaveLength(5);
      expect(fixture.store.getLandingStatus(fixture.landingId).landing.state).toBe("objects_ready");
    });
  });

  it("marks failed probes before reads and enforces the hard per-guard claim bound", async () => {
    const fixture = await createFixture();
    await fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const missing = (index: number) =>
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      await expect(
        fixture.store.claimAdmittedGitHubObjectsRequest(guard, missing(1)),
      ).rejects.toMatchObject({ code: "GITHUB_ADMITTED_REQUEST_UNAVAILABLE" });
      await expect(
        fixture.store.claimAdmittedGitHubObjectsRequest(guard, missing(1)),
      ).rejects.toMatchObject({ code: "GITHUB_REQUEST_ALREADY_CLAIMED" });

      const bound = 8 * (MAX_CHANGED_FILES + 6);
      for (let index = 2; index <= bound; index += 1) {
        await expect(
          fixture.store.claimAdmittedGitHubObjectsRequest(guard, missing(index)),
        ).rejects.toMatchObject({ code: "GITHUB_ADMITTED_REQUEST_UNAVAILABLE" });
      }
      await expect(
        fixture.store.claimAdmittedGitHubObjectsRequest(guard, missing(bound + 1)),
      ).rejects.toMatchObject({ code: "GITHUB_REQUEST_CLAIM_LIMIT" });
    });
  });
});
