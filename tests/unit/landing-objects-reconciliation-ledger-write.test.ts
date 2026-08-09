import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { IcarusError } from "../../packages/core/src/errors.js";
import {
  canonicalLandingJson,
  digestLandingRecord,
} from "../../packages/core/src/landing-records.js";
import type { IcarusStore } from "../../packages/core/src/store.js";
import { UNIT_RUN_ID } from "../support/unit-fixtures.js";
import {
  createCompletedObjectScenario,
  createCompletedObjectScenarioAtAttemptEight,
  createStartedObjectScenario,
  createStartedObjectScenarioAtAttemptEight,
  createUnresolvedObjectScenario,
  type ObjectReconciliationScenario,
  ReconciliationDatabase,
  reopenReconciliationStore,
} from "./landing-objects-reconciliation-support.js";

const scenarios: ObjectReconciliationScenario[] = [];
const reopenedStores: IcarusStore[] = [];

afterEach(() => {
  for (const store of reopenedStores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may have already closed its explicit restart handle.
    }
  }
  for (const scenario of scenarios.splice(0)) {
    try {
      scenario.fixture.store.close();
    } catch {
      // Restart tests close the original handle before reopening.
    }
    rmSync(scenario.fixture.root, { recursive: true, force: true });
  }
});

function track<T extends ObjectReconciliationScenario>(scenario: T): T {
  scenarios.push(scenario);
  return scenario;
}

function rowCount(databasePath: string, table: string, landingId: string): number {
  const database = new ReconciliationDatabase(databasePath);
  try {
    const row = database
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE landing_id = ?`)
      .get(landingId) as { readonly count: number };
    return row.count;
  } finally {
    database.close();
  }
}

function operationRowCount(databasePath: string, table: string, operationId: string): number {
  const database = new ReconciliationDatabase(databasePath);
  try {
    const row = database
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE operation_id = ?`)
      .get(operationId) as { readonly count: number };
    return row.count;
  } finally {
    database.close();
  }
}

function persistedRow(
  databasePath: string,
  table: "landing_operations" | "landing_http_requests",
  id: string,
): unknown {
  const database = new ReconciliationDatabase(databasePath);
  try {
    return database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  } finally {
    database.close();
  }
}

describe("guarded zero-HTTP GitHub object reconciliation ledger writer", () => {
  it("derives, commits, replays, and reopens one exact retry-stage proof", async () => {
    const scenario = track(await createUnresolvedObjectScenario(true));
    let settledStatus!: ReturnType<IcarusStore["getLandingStatus"]>;

    await scenario.fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const before = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
      const admission = await scenario.fixture.store.admitGuardedLandingResume(
        guard,
        scenario.fixture.landingId,
      );
      expect(admission).toMatchObject({ attemptOrdinal: 4, attemptLimitReached: false });
      expect(admission.operationId).not.toBeNull();
      const operationId = admission.operationId ?? "";
      const operation = admission.status.operations.find((entry) => entry.id === operationId);
      if (operation === undefined) throw new Error("Admission lost its reconciliation operation");
      const subjectOperationId = (
        operation.request.input as { readonly subjectOperationId?: string }
      ).subjectOperationId;
      const subject = admission.status.operations.find((entry) => entry.id === subjectOperationId);
      expect(operation).toMatchObject({
        kind: "landing.reconcile",
        status: "started",
        observation: null,
        result: null,
        request: {
          expectedState: "reconciliation_required",
          input: { resumeState: "local_ready" },
        },
      });
      expect(subject).toMatchObject({
        kind: "github.objects.upload",
        status: "interrupted",
        result: { outcome: "reconciliation_required" },
      });
      expect(
        operationRowCount(scenario.fixture.databasePath, "landing_http_requests", operationId),
      ).toBe(0);

      const eventCountAfterAdmission = admission.status.events.length;
      const replay = await scenario.fixture.store.admitGuardedLandingResume(
        guard,
        scenario.fixture.landingId,
      );
      expect(replay).toEqual(admission);
      expect(replay.status.events).toHaveLength(eventCountAfterAdmission);

      const httpCount = rowCount(
        scenario.fixture.databasePath,
        "landing_http_requests",
        scenario.fixture.landingId,
      );
      settledStatus = await scenario.fixture.store.settleGitHubObjectsReconciliation(
        guard,
        scenario.fixture.landingId,
        operationId,
      );
      expect(
        rowCount(
          scenario.fixture.databasePath,
          "landing_http_requests",
          scenario.fixture.landingId,
        ),
      ).toBe(httpCount);
      expect(settledStatus.landing).toMatchObject({
        state: "local_ready",
        resumeState: null,
        errorCode: null,
        version: before.landing.version + 1,
      });
      expect(settledStatus.attempts.at(-1)).toMatchObject({
        ordinal: 4,
        status: "completed",
        errorCode: null,
      });
      const settled = settledStatus.operations.at(-1);
      expect(settled).toMatchObject({
        id: operationId,
        kind: "landing.reconcile",
        status: "completed",
        result: {
          outcome: "completed",
          boundary: "retry_stage_proven",
          value: {
            subjectOperationId: subject?.id,
            nextState: "local_ready",
            remoteResidue: "none",
            stageValue: null,
          },
        },
      });
      expect(settled?.observation?.facts).toEqual([
        {
          fact: "subject_operation",
          requestId: null,
          resultSha256: digestLandingRecord({
            schemaVersion: 1,
            operationId: subject?.id,
            landingId: subject?.landingId,
            coordinatorAttempt: subject?.coordinatorAttempt,
            kind: "github.objects.upload",
            kindAttempt: subject?.kindAttempt,
            status: "interrupted",
            requestSha256: subject?.requestSha256,
            observationSha256: subject?.observationSha256,
            resultSha256: subject?.resultSha256,
            errorCode: subject?.errorCode,
          }),
        },
      ]);
      expect(settledStatus.events.slice(-3).map((event) => event.type)).toEqual([
        "landing.operation.settled",
        "landing.attempt.settled",
        "landing.state.changed",
      ]);

      const settledEventCount = settledStatus.events.length;
      await expect(
        scenario.fixture.store.settleGitHubObjectsReconciliation(
          guard,
          scenario.fixture.landingId,
          operationId,
        ),
      ).resolves.toEqual(settledStatus);
      expect(
        scenario.fixture.store.getLandingStatus(scenario.fixture.landingId).events,
      ).toHaveLength(settledEventCount);
    });

    const reopened = reopenReconciliationStore(scenario);
    reopenedStores.push(reopened);
    expect(reopened.getLandingStatus(scenario.fixture.landingId)).toEqual(settledStatus);
  });

  it("rolls back observation, settlements, events, and state when the final transition aborts", async () => {
    const scenario = track(await createUnresolvedObjectScenario());
    await scenario.fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const admission = await scenario.fixture.store.admitGuardedLandingResume(
        guard,
        scenario.fixture.landingId,
      );
      const operationId = admission.operationId ?? "";
      const eventCount = admission.status.events.length;
      const database = new ReconciliationDatabase(scenario.fixture.databasePath);
      try {
        database
          .prepare(
            "CREATE TRIGGER object_reconciliation_transition_fault " +
              "BEFORE UPDATE OF state ON landings " +
              "WHEN OLD.id = '" +
              scenario.fixture.landingId +
              "' AND NEW.state = 'local_ready' " +
              "BEGIN SELECT RAISE(ABORT, 'injected object reconciliation fault'); END",
          )
          .run();
      } finally {
        database.close();
      }

      await expect(
        scenario.fixture.store.settleGitHubObjectsReconciliation(
          guard,
          scenario.fixture.landingId,
          operationId,
        ),
      ).rejects.toThrow("injected object reconciliation fault");
      const afterFailure = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
      expect(afterFailure.events).toHaveLength(eventCount);
      expect(afterFailure.landing.state).toBe("reconciliation_required");
      expect(afterFailure.attempts.at(-1)?.status).toBe("started");
      expect(afterFailure.operations.at(-1)).toMatchObject({
        id: operationId,
        status: "started",
        observation: null,
        result: null,
      });

      const cleanup = new ReconciliationDatabase(scenario.fixture.databasePath);
      try {
        cleanup.prepare("DROP TRIGGER object_reconciliation_transition_fault").run();
      } finally {
        cleanup.close();
      }
      await expect(
        scenario.fixture.store.settleGitHubObjectsReconciliation(
          guard,
          scenario.fixture.landingId,
          operationId,
        ),
      ).resolves.toMatchObject({ landing: { state: "local_ready" } });
    });
  });

  it.each(["none", "actor", "blob"] as const)(
    "takes over a started object upload with a trailing %s admission and starts one bound reconciliation",
    async (admitted) => {
      const scenario = track(await createStartedObjectScenario(admitted));
      const before = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
      const admittedRowsBefore = before.events.filter(
        (event) => event.type === "landing.github.request.admitted",
      ).length;

      await scenario.fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
        const takeover = await scenario.fixture.store.admitGuardedLandingResume(
          guard,
          scenario.fixture.landingId,
        );
        expect(takeover).toMatchObject({ attemptOrdinal: 4 });
        expect(takeover.status.landing).toMatchObject({
          state: "reconciliation_required",
          resumeState: "local_ready",
          errorCode: "LANDING_COORDINATOR_TAKEOVER",
          version: before.landing.version + 1,
        });
        expect(takeover.status.attempts.slice(-2)).toMatchObject([
          { ordinal: 3, status: "interrupted", errorCode: "LANDING_COORDINATOR_TAKEOVER" },
          { ordinal: 4, status: "started", errorCode: null },
        ]);
        expect(takeover.status.operations.slice(-2)).toMatchObject([
          {
            kind: "github.objects.upload",
            status: "interrupted",
            result: {
              outcome: "reconciliation_required",
              value: { subjectOperationId: scenario.operation.operationId },
            },
          },
          {
            id: takeover.operationId,
            kind: "landing.reconcile",
            status: "started",
            request: { input: { subjectOperationId: scenario.operation.operationId } },
          },
        ]);
        const admittedRowsAfter = takeover.status.events.filter(
          (event) => event.type === "landing.github.request.admitted",
        ).length;
        expect(admittedRowsAfter).toBe(admittedRowsBefore);
        const settledRows = takeover.status.events.filter(
          (event) => event.type === "landing.github.request.settled",
        ).length;
        expect(settledRows).toBe(admittedRowsAfter);
      });
    },
  );

  it("takes over an active object reconciliation without changing state or subject", async () => {
    const scenario = track(await createUnresolvedObjectScenario());
    let firstAdmission!: Awaited<ReturnType<IcarusStore["admitGuardedLandingResume"]>>;
    await scenario.fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      firstAdmission = await scenario.fixture.store.admitGuardedLandingResume(
        guard,
        scenario.fixture.landingId,
      );
    });
    const originalSubject = firstAdmission.status.operations.find(
      (operation) => operation.id === scenario.operation.operationId,
    );
    const beforeTakeover = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);

    await scenario.fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const takeover = await scenario.fixture.store.admitGuardedLandingResume(
        guard,
        scenario.fixture.landingId,
      );

      expect(takeover).toMatchObject({ attemptOrdinal: 5 });
      expect(takeover.operationId).not.toBe(firstAdmission.operationId);
      expect(takeover.status.landing).toMatchObject({
        state: "reconciliation_required",
        resumeState: "local_ready",
        version: beforeTakeover.landing.version,
      });
      expect(
        takeover.status.operations.find(
          (operation) => operation.id === scenario.operation.operationId,
        ),
      ).toEqual(originalSubject);
      expect(takeover.status.operations.slice(-2)).toMatchObject([
        {
          id: firstAdmission.operationId,
          kind: "landing.reconcile",
          status: "interrupted",
          result: {
            outcome: "reconciliation_required",
            value: { subjectOperationId: scenario.operation.operationId },
          },
        },
        {
          id: takeover.operationId,
          kind: "landing.reconcile",
          status: "started",
          request: { input: { subjectOperationId: scenario.operation.operationId } },
        },
      ]);
      expect(
        takeover.status.events.slice(beforeTakeover.events.length).map((event) => event.type),
      ).toEqual([
        "landing.operation.settled",
        "landing.attempt.settled",
        "landing.attempt.started",
        "landing.operation.started",
      ]);
    });
  });

  it("preserves a completed object operation byte-for-byte and starts only an objects-ready successor attempt", async () => {
    const scenario = track(await createCompletedObjectScenario());
    const before = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    const completedObject = before.operations.at(-1);
    await scenario.fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
      const takeover = await scenario.fixture.store.admitGuardedLandingResume(
        guard,
        scenario.fixture.landingId,
      );
      expect(takeover).toMatchObject({ attemptOrdinal: 4, operationId: null });
      expect(takeover.status.landing).toMatchObject({
        state: "objects_ready",
        version: before.landing.version,
      });
      expect(takeover.status.operations.at(-1)).toEqual(completedObject);
      expect(takeover.status.attempts.slice(-2)).toMatchObject([
        { ordinal: 3, status: "interrupted", errorCode: "LANDING_COORDINATOR_TAKEOVER" },
        { ordinal: 4, status: "started", errorCode: null },
      ]);
      expect(takeover.status.events.slice(-2).map((event) => event.type)).toEqual([
        "landing.attempt.settled",
        "landing.attempt.started",
      ]);
    });
  });

  it("settles an attempt-eight admitted POST and object takeover without a successor", async () => {
    const scenario = track(await createStartedObjectScenarioAtAttemptEight("blob"));
    const before = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    const admittedEvent = before.events.findLast(
      (event) => event.type === "landing.github.request.admitted",
    );
    if (admittedEvent === undefined) {
      throw new Error("Attempt-eight fixture lost its admitted POST event");
    }
    const admittedRequestId = (admittedEvent.payload as { readonly requestId?: string }).requestId;
    if (admittedRequestId === undefined) {
      throw new Error("Attempt-eight fixture lost its admitted POST request");
    }

    await expect(
      scenario.fixture.leases.withLease(UNIT_RUN_ID, async (guard) =>
        scenario.fixture.store.admitGuardedLandingResume(guard, scenario.fixture.landingId),
      ),
    ).rejects.toMatchObject({ code: "LANDING_ATTEMPT_LIMIT" } satisfies Partial<IcarusError>);

    const exhausted = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(exhausted.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "local_ready",
      errorCode: "LANDING_COORDINATOR_TAKEOVER",
      attemptCount: 8,
      version: before.landing.version + 1,
    });
    expect(exhausted.attempts).toHaveLength(8);
    expect(exhausted.attempts.at(-1)).toMatchObject({
      ordinal: 8,
      status: "interrupted",
      errorCode: "LANDING_COORDINATOR_TAKEOVER",
    });
    expect(exhausted.operations).toHaveLength(before.operations.length);
    expect(exhausted.operations.at(-1)).toMatchObject({
      id: scenario.operation.operationId,
      kind: "github.objects.upload",
      status: "interrupted",
      result: { outcome: "reconciliation_required" },
    });
    expect(
      exhausted.operations.some(
        (operation) => operation.coordinatorAttempt === 9 || operation.kind === "landing.reconcile",
      ),
    ).toBe(false);
    expect(exhausted.events.slice(before.events.length).map((event) => event.type)).toEqual([
      "landing.github.request.settled",
      "landing.operation.settled",
      "landing.attempt.settled",
      "landing.state.changed",
    ]);
    expect(
      persistedRow(scenario.fixture.databasePath, "landing_http_requests", admittedRequestId),
    ).toMatchObject({
      status: "settled",
      outcome: "ambiguous",
      error_code: "GITHUB_OUTCOME_AMBIGUOUS",
    });
  });

  it("preserves an attempt-eight completed object byte-for-byte without a successor", async () => {
    const scenario = track(await createCompletedObjectScenarioAtAttemptEight());
    const before = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    const completedObject = before.operations.at(-1);
    const rawObject = persistedRow(
      scenario.fixture.databasePath,
      "landing_operations",
      scenario.operation.operationId,
    );

    await expect(
      scenario.fixture.leases.withLease(UNIT_RUN_ID, async (guard) =>
        scenario.fixture.store.admitGuardedLandingResume(guard, scenario.fixture.landingId),
      ),
    ).rejects.toMatchObject({ code: "LANDING_ATTEMPT_LIMIT" } satisfies Partial<IcarusError>);

    const exhausted = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(exhausted.landing).toMatchObject({
      state: "objects_ready",
      resumeState: null,
      errorCode: null,
      attemptCount: 8,
      version: before.landing.version,
    });
    expect(exhausted.attempts).toHaveLength(8);
    expect(exhausted.attempts.at(-1)).toMatchObject({
      ordinal: 8,
      status: "interrupted",
      errorCode: "LANDING_COORDINATOR_TAKEOVER",
    });
    expect(exhausted.operations).toEqual(before.operations);
    expect(exhausted.operations.at(-1)).toEqual(completedObject);
    expect(exhausted.events.slice(before.events.length).map((event) => event.type)).toEqual([
      "landing.attempt.settled",
    ]);
    expect(
      persistedRow(
        scenario.fixture.databasePath,
        "landing_operations",
        scenario.operation.operationId,
      ),
    ).toEqual(rawObject);
    expect(
      exhausted.events.some(
        (event) =>
          event.type === "landing.attempt.started" &&
          (event.payload as { readonly coordinatorAttempt?: number }).coordinatorAttempt === 9,
      ),
    ).toBe(false);
  });

  it("truthfully settles an attempt-eight active reconciliation without a successor", async () => {
    const scenario = track(await createUnresolvedObjectScenario());
    for (let expectedAttempt = 4; expectedAttempt <= 8; expectedAttempt += 1) {
      await scenario.fixture.leases.withLease(UNIT_RUN_ID, async (guard) => {
        const admission = await scenario.fixture.store.admitGuardedLandingResume(
          guard,
          scenario.fixture.landingId,
        );
        expect(admission.attemptOrdinal).toBe(expectedAttempt);
        expect(admission.operationId).not.toBeNull();
      });
    }
    const beforeLimit = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(beforeLimit.attempts.at(-1)).toMatchObject({ ordinal: 8, status: "started" });

    await expect(
      scenario.fixture.leases.withLease(UNIT_RUN_ID, async (guard) =>
        scenario.fixture.store.admitGuardedLandingResume(guard, scenario.fixture.landingId),
      ),
    ).rejects.toMatchObject({ code: "LANDING_ATTEMPT_LIMIT" } satisfies Partial<IcarusError>);

    const exhausted = scenario.fixture.store.getLandingStatus(scenario.fixture.landingId);
    expect(exhausted.landing).toMatchObject({
      state: "reconciliation_required",
      resumeState: "local_ready",
      attemptCount: 8,
    });
    expect(exhausted.attempts).toHaveLength(8);
    expect(exhausted.attempts.at(-1)).toMatchObject({
      ordinal: 8,
      status: "interrupted",
      errorCode: "LANDING_COORDINATOR_TAKEOVER",
    });
    expect(exhausted.operations.at(-1)).toMatchObject({
      kind: "landing.reconcile",
      status: "interrupted",
      result: { outcome: "reconciliation_required" },
    });
    expect(
      exhausted.events.filter(
        (event) =>
          event.type === "landing.attempt.started" &&
          (event.payload as { coordinatorAttempt?: number }).coordinatorAttempt === 9,
      ),
    ).toHaveLength(0);
    expect(canonicalLandingJson(exhausted.operations.at(-1)?.result)).toContain(
      "LANDING_COORDINATOR_TAKEOVER",
    );
  });
});
