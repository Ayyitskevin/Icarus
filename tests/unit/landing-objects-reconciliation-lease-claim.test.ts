import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { RunLeaseGuard } from "../../packages/core/src/lease.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import { UNIT_RUN_ID } from "../support/unit-fixtures.js";
import {
  createUnresolvedObjectScenario,
  type ObjectReconciliationScenario,
} from "./landing-objects-reconciliation-support.js";

const OTHER_RUN_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const scenarios: ObjectReconciliationScenario[] = [];
const additionalStores: IcarusStore[] = [];

afterEach(() => {
  for (const store of additionalStores.splice(0)) store.close();
  for (const scenario of scenarios.splice(0)) {
    scenario.fixture.store.close();
    rmSync(scenario.fixture.root, { recursive: true, force: true });
  }
});

async function scenario(): Promise<ObjectReconciliationScenario> {
  const created = await createUnresolvedObjectScenario();
  scenarios.push(created);
  return created;
}

describe("object reconciliation run-lease ownership", () => {
  it("keeps the legacy synchronous admission byte-identical at an object boundary", async () => {
    const created = await scenario();
    const before = created.fixture.store.getLandingStatus(created.fixture.landingId);
    let refusal: unknown;

    try {
      created.fixture.store.admitLandingResume(created.fixture.landingId);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toMatchObject({ code: "LANDING_NOT_ADMITTED" });
    expect(created.fixture.store.getLandingStatus(created.fixture.landingId)).toEqual(before);
  });

  it("refuses a wrong-run or revoked guard before durable admission", async () => {
    const created = await scenario();
    const before = created.fixture.store.getLandingStatus(created.fixture.landingId);
    await created.fixture.leases.withLease(OTHER_RUN_ID, async (wrongGuard) => {
      await expect(
        created.fixture.store.admitGuardedLandingResume(wrongGuard, created.fixture.landingId),
      ).rejects.toMatchObject({ code: "RUN_LEASE_MISMATCH" });
    });
    expect(created.fixture.store.getLandingStatus(created.fixture.landingId)).toEqual(before);

    let revoked: RunLeaseGuard | undefined;
    await created.fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      revoked = guard;
    });
    if (revoked === undefined) throw new Error("Lease fixture did not issue a guard");
    await expect(
      created.fixture.store.admitGuardedLandingResume(revoked, created.fixture.landingId),
    ).rejects.toMatchObject({ code: "RUN_LEASE_LOST" });
    expect(created.fixture.store.getLandingStatus(created.fixture.landingId)).toEqual(before);
  });

  it("refuses fresh and cross-store settlement guards that never registered the durable operation", async () => {
    const created = await scenario();
    let operationId = "";
    await created.fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admission = await created.fixture.store.admitGuardedLandingResume(
        guard,
        created.fixture.landingId,
      );
      operationId = admission.operationId ?? "";
      const secondStore = new IcarusStore(created.fixture.databasePath);
      additionalStores.push(secondStore);
      await expect(
        secondStore.settleGitHubObjectsReconciliation(
          guard,
          created.fixture.landingId,
          operationId,
        ),
      ).rejects.toMatchObject({ code: "LANDING_NOT_ADMITTED" });
      expect(secondStore.getLandingStatus(created.fixture.landingId)).toEqual(admission.status);
    });

    await created.fixture.leases.withLease(UNIT_RUN_ID, async (freshGuard) => {
      const before = created.fixture.store.getLandingStatus(created.fixture.landingId);
      await expect(
        created.fixture.store.settleGitHubObjectsReconciliation(
          freshGuard,
          created.fixture.landingId,
          operationId,
        ),
      ).rejects.toMatchObject({ code: "LANDING_NOT_ADMITTED" });
      expect(created.fixture.store.getLandingStatus(created.fixture.landingId)).toEqual(before);

      const takeover = await created.fixture.store.admitGuardedLandingResume(
        freshGuard,
        created.fixture.landingId,
      );
      expect(takeover.operationId).not.toBe(operationId);
      await expect(
        created.fixture.store.settleGitHubObjectsReconciliation(
          freshGuard,
          created.fixture.landingId,
          takeover.operationId ?? "",
        ),
      ).resolves.toMatchObject({ landing: { state: "local_ready" } });
    });
  });

  it("refuses a non-object operation identity under an otherwise valid guard", async () => {
    const first = await scenario();
    await first.fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      await first.fixture.store.admitGuardedLandingResume(guard, first.fixture.landingId);
      const subjectId = first.fixture.store
        .getLandingStatus(first.fixture.landingId)
        .operations.find((operation) => operation.kind === "github.objects.upload")?.id;
      await expect(
        first.fixture.store.settleGitHubObjectsReconciliation(
          guard,
          first.fixture.landingId,
          subjectId ?? "",
        ),
      ).rejects.toMatchObject({ code: "LANDING_NOT_ADMITTED" });
    });
  });
});
