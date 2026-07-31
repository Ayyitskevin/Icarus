import { rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, test } from "vitest";

import {
  type BrowserActionDescriptorFields,
  type BrowserActionIdentity,
  browserActionDescriptorDigest,
} from "../../packages/core/src/browser-action-state.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import {
  createUnitStore,
  seedUnitProject,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
} from "../support/unit-fixtures.js";

interface TestDatabase {
  prepare(sql: string): {
    run(...parameters: unknown[]): unknown;
    get(...parameters: unknown[]): unknown;
  };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

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

function seedPreparingRun(store: IcarusStore): void {
  const { projectId } = seedUnitProject(store);
  store.createRun({
    id: UNIT_RUN_ID,
    projectId,
    task: "Prepare the browser action ledger",
    targets: UNIT_PLAN.targets,
    provider: UNIT_PROVIDER,
  });
}

function identity(
  actionId = "11111111-1111-4111-8111-111111111111",
  kind: BrowserActionIdentity["kind"] = "run.resume",
  expectedState: BrowserActionIdentity["expectedState"] = "preparing",
  eventRevision = 1,
): BrowserActionIdentity {
  const descriptor = {
    version: 1 as const,
    kind,
    runId: UNIT_RUN_ID,
    expectedState,
    eventRevision,
    subjectDigest: null,
    activeActionId: null,
    activeActionDigest: null,
  };
  return {
    actionId,
    ...descriptor,
    actionDigest: browserActionDescriptorDigest(descriptor),
  };
}

function exactIdentity(
  actionId: string,
  descriptor: BrowserActionDescriptorFields,
): BrowserActionIdentity {
  return {
    actionId,
    ...descriptor,
    actionDigest: browserActionDescriptorDigest(descriptor),
  };
}

describe("browser action ledger", () => {
  test("prepares idempotently and rejects reuse with a different immutable tuple", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const request = identity();

    const prepared = fixture.store.prepareBrowserAction(request, "unit operator");
    expect(prepared).toMatchObject({
      ...request,
      actor: "unit operator",
      status: "prepared",
      outcome: null,
    });
    expect(fixture.store.prepareBrowserAction(request, "unit operator")).toEqual(prepared);

    expectIcarusCode(
      () =>
        fixture.store.prepareBrowserAction(
          identity(request.actionId, "run.cancel"),
          "unit operator",
        ),
      "ACTION_ID_CONFLICT",
    );
    fixture.store.close();
  });

  test("admits intent and its exact event anchor in one transaction", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const request = identity();
    fixture.store.prepareBrowserAction(request, "unit operator");

    const admitted = fixture.store.admitBrowserAction(request.actionId);
    expect(admitted).toMatchObject({
      status: "admitted",
      admissionEventSequence: 2,
    });
    expect(fixture.store.listEvents(UNIT_RUN_ID).at(-1)).toMatchObject({
      sequence: 2,
      type: "browser.action.admitted",
      payload: {
        browserActionId: request.actionId,
        kind: request.kind,
        actionDigest: request.actionDigest,
      },
    });
    expect(fixture.store.admitBrowserAction(request.actionId)).toEqual(admitted);
    fixture.store.close();
  });

  test("enforces separate one-active cancel and non-cancel slots per run", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    fixture.store.prepareBrowserAction(identity(), "unit operator");
    fixture.store.prepareBrowserAction(
      identity("22222222-2222-4222-8222-222222222222", "run.cancel"),
      "unit operator",
    );

    expectIcarusCode(
      () =>
        fixture.store.prepareBrowserAction(
          identity("33333333-3333-4333-8333-333333333333"),
          "unit operator",
        ),
      "ACTION_IN_PROGRESS",
    );
    expectIcarusCode(
      () =>
        fixture.store.prepareBrowserAction(
          identity("44444444-4444-4444-8444-444444444444", "run.cancel"),
          "unit operator",
        ),
      "ACTION_IN_PROGRESS",
    );
    fixture.store.close();
  });

  test("does not admit an unbound ordinary cancellation beside an active action", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const active = identity();
    const cancel = identity("22222222-2222-4222-8222-222222222222", "run.cancel");
    fixture.store.prepareBrowserAction(active, "unit operator");
    fixture.store.prepareBrowserAction(cancel, "unit operator");

    expect(fixture.store.admitBrowserAction(cancel.actionId)).toMatchObject({
      status: "settled",
      outcome: "refused",
      errorCode: "STALE_ACTION",
      admissionEventSequence: null,
    });
    fixture.store.close();
  });

  test("admits a cancellation only when it binds the exact admitted active action", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const active = identity();
    fixture.store.prepareBrowserAction(active, "unit operator");
    expect(fixture.store.admitBrowserAction(active.actionId)).toMatchObject({
      status: "admitted",
      admissionEventSequence: 2,
    });
    const cancel = exactIdentity("22222222-2222-4222-8222-222222222222", {
      version: 1,
      kind: "run.cancel",
      runId: UNIT_RUN_ID,
      expectedState: "preparing",
      eventRevision: 2,
      subjectDigest: null,
      activeActionId: active.actionId,
      activeActionDigest: active.actionDigest,
    });
    fixture.store.prepareBrowserAction(cancel, "unit operator");

    expect(fixture.store.admitBrowserAction(cancel.actionId)).toMatchObject({
      status: "admitted",
      admissionEventSequence: 3,
    });
    fixture.store.close();
  });

  test("atomically refuses stale state, event revision, and subject descriptors", () => {
    const cases: readonly {
      readonly actionId: string;
      readonly prepare: (store: IcarusStore, database: TestDatabase) => BrowserActionIdentity;
      readonly stale: (database: TestDatabase) => void;
    }[] = [
      {
        actionId: "33333333-3333-4333-8333-333333333333",
        prepare: () => identity("33333333-3333-4333-8333-333333333333"),
        stale: (database) => {
          database.prepare("UPDATE runs SET state = 'planned' WHERE id = ?").run(UNIT_RUN_ID);
        },
      },
      {
        actionId: "44444444-4444-4444-8444-444444444444",
        prepare: () => identity("44444444-4444-4444-8444-444444444444"),
        stale: (database) => {
          database
            .prepare(
              `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
               VALUES (?, 2, 'run.resumed', '{}', '2026-07-19T12:00:00.000Z')`,
            )
            .run(UNIT_RUN_ID);
        },
      },
      {
        actionId: "55555555-5555-4555-8555-555555555555",
        prepare: (_store, database) => {
          database
            .prepare("UPDATE runs SET state = 'awaiting_approval', plan_sha256 = ? WHERE id = ?")
            .run("a".repeat(64), UNIT_RUN_ID);
          return exactIdentity("55555555-5555-4555-8555-555555555555", {
            version: 1,
            kind: "plan.approve",
            runId: UNIT_RUN_ID,
            expectedState: "awaiting_approval",
            eventRevision: 1,
            subjectDigest: "a".repeat(64),
            activeActionId: null,
            activeActionDigest: null,
          });
        },
        stale: (database) => {
          database
            .prepare("UPDATE runs SET plan_sha256 = ? WHERE id = ?")
            .run("b".repeat(64), UNIT_RUN_ID);
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = createUnitStore();
      cleanupRoots.push(fixture.root);
      seedPreparingRun(fixture.store);
      const database = new Database(fixture.databasePath);
      const request = testCase.prepare(fixture.store, database);
      database.close();
      fixture.store.prepareBrowserAction(request, "unit operator");
      const stale = new Database(fixture.databasePath);
      testCase.stale(stale);
      stale.close();

      expect(fixture.store.admitBrowserAction(testCase.actionId)).toMatchObject({
        status: "settled",
        outcome: "refused",
        errorCode: "STALE_ACTION",
        admissionEventSequence: null,
      });
      expect(
        fixture.store
          .listEvents(UNIT_RUN_ID)
          .some((event) => event.type === "browser.action.admitted"),
      ).toBe(false);
      fixture.store.close();
    }
  });

  test("settles only orphaned prepared requests and preserves admitted rows for exact reconciliation", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const nonCancel = identity();
    const cancel = identity("22222222-2222-4222-8222-222222222222", "run.cancel");
    fixture.store.prepareBrowserAction(nonCancel, "unit operator");
    fixture.store.prepareBrowserAction(cancel, "unit operator");
    fixture.store.admitBrowserAction(nonCancel.actionId);

    const settlements = fixture.store.settleOrphanedPreparedBrowserActions(UNIT_RUN_ID);
    expect(settlements).toHaveLength(1);
    expect(fixture.store.getBrowserAction(nonCancel.actionId)).toMatchObject({
      status: "admitted",
      outcome: null,
      errorCode: null,
    });
    expect(fixture.store.getBrowserAction(cancel.actionId)).toMatchObject({
      status: "settled",
      outcome: "refused",
      errorCode: "ACTION_NOT_ADMITTED",
    });
    expect(fixture.store.listActiveBrowserActions(UNIT_RUN_ID)).toEqual([
      expect.objectContaining({ actionId: nonCancel.actionId, status: "admitted" }),
    ]);
    fixture.store.close();
  });

  test("fails closed when a persisted actor passes SQL checks but violates host policy", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const request = identity();
    fixture.store.prepareBrowserAction(request, "unit operator");
    const database = new Database(fixture.databasePath);
    database
      .prepare("UPDATE browser_action_requests SET actor = ? WHERE action_id = ?")
      .run("hidden\u200bactor", request.actionId);
    database.close();

    expectIcarusCode(() => fixture.store.getBrowserAction(request.actionId), "DATABASE_ERROR");
    fixture.store.close();
  });

  test("settles success only at the exact action-linked terminal event and run state", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const request = identity();
    fixture.store.prepareBrowserAction(request, "unit operator");
    const admitted = fixture.store.admitBrowserAction(request.actionId);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("Expected admitted action");

    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 3, 'resume.requested', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(
        UNIT_RUN_ID,
        JSON.stringify({
          browserActionId: request.actionId,
          state: "preparing",
          resumeState: null,
        }),
      );
    database.close();

    expectIcarusCode(
      () =>
        fixture.store.settleAdmittedBrowserAction(request.actionId, {
          outcome: "succeeded",
          admissionEventSequence: admitted.admissionEventSequence,
          domainEventSequence: 3,
          domainOperationId: null,
          errorCode: null,
        }),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );

    const terminal = new Database(fixture.databasePath);
    terminal
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 4, 'egress.requested', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
    terminal
      .prepare("UPDATE runs SET state = 'awaiting_egress_approval' WHERE id = ?")
      .run(UNIT_RUN_ID);
    terminal.close();

    expect(
      fixture.store.settleAdmittedBrowserAction(request.actionId, {
        outcome: "succeeded",
        admissionEventSequence: admitted.admissionEventSequence,
        domainEventSequence: 4,
        domainOperationId: null,
        errorCode: null,
      }),
    ).toMatchObject({ status: "settled", outcome: "succeeded", domainEventSequence: 4 });
    fixture.store.close();
  });

  test("rejects an action-linked terminal event that predates admission", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const request = identity("11111111-1111-4111-8111-111111111111", "run.resume", "preparing", 2);
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 2, 'egress.requested', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
    database.close();
    fixture.store.prepareBrowserAction(request, "unit operator");
    const admitted = fixture.store.admitBrowserAction(request.actionId);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("Expected admitted action");
    const terminalState = new Database(fixture.databasePath);
    terminalState
      .prepare("UPDATE runs SET state = 'awaiting_egress_approval' WHERE id = ?")
      .run(UNIT_RUN_ID);
    terminalState.close();

    expectIcarusCode(
      () =>
        fixture.store.settleAdmittedBrowserAction(request.actionId, {
          outcome: "succeeded",
          admissionEventSequence: admitted.admissionEventSequence,
          domainEventSequence: 2,
          domainOperationId: null,
          errorCode: null,
        }),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );
    expect(fixture.store.getBrowserAction(request.actionId)).toMatchObject({
      status: "admitted",
      outcome: null,
    });
    fixture.store.close();
  });

  test("rejects an unanchored failure after an action-linked domain effect", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const request = identity();
    fixture.store.prepareBrowserAction(request, "unit operator");
    const admitted = fixture.store.admitBrowserAction(request.actionId);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("Expected admitted action");
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 3, 'resume.requested', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
    database.close();

    expectIcarusCode(
      () =>
        fixture.store.settleAdmittedBrowserAction(request.actionId, {
          outcome: "failed",
          admissionEventSequence: admitted.admissionEventSequence,
          domainEventSequence: null,
          domainOperationId: null,
          errorCode: "RESUME_FAILED",
        }),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );
    expect(fixture.store.getBrowserAction(request.actionId)).toMatchObject({
      status: "admitted",
      outcome: null,
    });
    fixture.store.close();
  });

  test.each([
    {
      label: "permitted domain event has no action identity",
      type: "resume.requested",
      payload: {},
    },
    {
      label: "permitted domain event names a different action",
      type: "resume.requested",
      payload: { browserActionId: "22222222-2222-4222-8222-222222222222" },
    },
    {
      label: "permitted operation start has no action identity",
      type: "operation.started",
      payload: {
        operationId: "33333333-3333-4333-8333-333333333333",
        kind: "context.prepare",
      },
    },
    {
      label: "unexpected effect names the admitted action",
      type: "unexpected.domain.effect",
      payload: { browserActionId: "11111111-1111-4111-8111-111111111111" },
    },
  ])("rejects an unanchored failure when $label", ({ type, payload }) => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const request = identity();
    fixture.store.prepareBrowserAction(request, "unit operator");
    const admitted = fixture.store.admitBrowserAction(request.actionId);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("Expected admitted action");
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 3, ?, ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(UNIT_RUN_ID, type, JSON.stringify(payload));
    database.close();

    expectIcarusCode(
      () =>
        fixture.store.settleAdmittedBrowserAction(request.actionId, {
          outcome: "failed",
          admissionEventSequence: admitted.admissionEventSequence,
          domainEventSequence: null,
          domainOperationId: null,
          errorCode: "RESUME_FAILED",
        }),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );
    expect(fixture.store.getBrowserAction(request.actionId)).toMatchObject({
      status: "admitted",
      outcome: null,
    });
    fixture.store.close();
  });

  test("rejects an unanchored failure after an unexpected action-linked operation result", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const request = identity();
    fixture.store.prepareBrowserAction(request, "unit operator");
    const admitted = fixture.store.admitBrowserAction(request.actionId);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("Expected admitted action");
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO operations
         (id, run_id, kind, status, reserved_cost_usd, reserved_tokens,
          reserved_runtime_ms, result_json, started_at, finished_at)
         VALUES ('33333333-3333-4333-8333-333333333333', ?, 'unexpected.effect', 'failed',
                 0, 0, 0, ?, '2026-07-19T12:00:00.000Z', '2026-07-19T12:00:00.000Z')`,
      )
      .run(UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
    database.close();

    expectIcarusCode(
      () =>
        fixture.store.settleAdmittedBrowserAction(request.actionId, {
          outcome: "failed",
          admissionEventSequence: admitted.admissionEventSequence,
          domainEventSequence: null,
          domainOperationId: null,
          errorCode: "RESUME_FAILED",
        }),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );
    expect(fixture.store.getBrowserAction(request.actionId)).toMatchObject({
      status: "admitted",
      outcome: null,
    });
    fixture.store.close();
  });

  test("accepts a failed operation anchor only after its direct detail is durably settled", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const subjectDigest = "a".repeat(64);
    const request = exactIdentity("11111111-1111-4111-8111-111111111111", {
      version: 1,
      kind: "egress.approve",
      runId: UNIT_RUN_ID,
      expectedState: "awaiting_egress_approval",
      eventRevision: 1,
      subjectDigest,
      activeActionId: null,
      activeActionDigest: null,
    });
    const gate = new Database(fixture.databasePath);
    gate
      .prepare(
        "UPDATE runs SET state = 'awaiting_egress_approval', context_sha256 = ? WHERE id = ?",
      )
      .run(subjectDigest, UNIT_RUN_ID);
    gate.close();
    fixture.store.prepareBrowserAction(request, "unit operator");
    const admitted = fixture.store.admitBrowserAction(request.actionId);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("Expected admitted action");
    const operationId = "33333333-3333-4333-8333-333333333333";
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 3, 'operation.started', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(
        UNIT_RUN_ID,
        JSON.stringify({
          operationId,
          kind: "egress.validate",
          browserActionId: request.actionId,
          reservedCostUsd: 0,
        }),
      );
    database
      .prepare(
        `INSERT INTO operations
         (id, run_id, kind, status, reserved_cost_usd, reserved_tokens,
          reserved_runtime_ms, result_json, started_at, finished_at)
         VALUES (?, ?, 'egress.validate', 'started', 0, 0, 0, NULL,
                 '2026-07-19T12:00:00.000Z', NULL)`,
      )
      .run(operationId, UNIT_RUN_ID);
    database.close();

    const settlement = {
      outcome: "failed" as const,
      admissionEventSequence: admitted.admissionEventSequence,
      domainEventSequence: null,
      domainOperationId: operationId,
      errorCode: "CONTEXT_FAILED",
    };
    expectIcarusCode(
      () => fixture.store.settleAdmittedBrowserAction(request.actionId, settlement),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );

    const settledOperation = new Database(fixture.databasePath);
    settledOperation
      .prepare(
        `UPDATE operations
         SET status = 'bogus', result_json = ?, finished_at = '2026-07-19T12:00:00.000Z'
         WHERE id = ?`,
      )
      .run(JSON.stringify({ browserActionId: request.actionId }), operationId);
    settledOperation.close();

    expectIcarusCode(
      () => fixture.store.settleAdmittedBrowserAction(request.actionId, settlement),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );
    const unfinishedOperation = new Database(fixture.databasePath);
    unfinishedOperation
      .prepare("UPDATE operations SET status = 'failed', finished_at = NULL WHERE id = ?")
      .run(operationId);
    unfinishedOperation.close();
    expectIcarusCode(
      () => fixture.store.settleAdmittedBrowserAction(request.actionId, settlement),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );
    const validOperation = new Database(fixture.databasePath);
    validOperation
      .prepare(
        `UPDATE operations
         SET finished_at = '2026-07-19T12:00:00.000Z'
         WHERE id = ?`,
      )
      .run(operationId);
    validOperation.close();

    expect(fixture.store.settleAdmittedBrowserAction(request.actionId, settlement)).toMatchObject({
      status: "settled",
      outcome: "failed",
      domainOperationId: operationId,
      errorCode: "CONTEXT_FAILED",
    });
    fixture.store.close();
  });

  test("rejects an operation-only failure after an earlier domain effect", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const subjectDigest = "a".repeat(64);
    const request = exactIdentity("11111111-1111-4111-8111-111111111111", {
      version: 1,
      kind: "egress.approve",
      runId: UNIT_RUN_ID,
      expectedState: "awaiting_egress_approval",
      eventRevision: 1,
      subjectDigest,
      activeActionId: null,
      activeActionDigest: null,
    });
    const gate = new Database(fixture.databasePath);
    gate
      .prepare(
        "UPDATE runs SET state = 'awaiting_egress_approval', context_sha256 = ? WHERE id = ?",
      )
      .run(subjectDigest, UNIT_RUN_ID);
    gate.close();
    fixture.store.prepareBrowserAction(request, "unit operator");
    const admitted = fixture.store.admitBrowserAction(request.actionId);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("Expected admitted action");

    const operationId = "33333333-3333-4333-8333-333333333333";
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 3, 'plan.created', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 4, 'operation.started', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(
        UNIT_RUN_ID,
        JSON.stringify({
          operationId,
          kind: "egress.validate",
          browserActionId: request.actionId,
        }),
      );
    database
      .prepare(
        `INSERT INTO operations
         (id, run_id, kind, status, reserved_cost_usd, reserved_tokens,
          reserved_runtime_ms, result_json, started_at, finished_at)
         VALUES (?, ?, 'egress.validate', 'failed', 0, 0, 0, ?,
                 '2026-07-19T12:00:00.000Z', '2026-07-19T12:00:00.000Z')`,
      )
      .run(operationId, UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
    database.prepare("UPDATE runs SET state = 'awaiting_approval' WHERE id = ?").run(UNIT_RUN_ID);
    database.close();

    expectIcarusCode(
      () =>
        fixture.store.settleAdmittedBrowserAction(request.actionId, {
          outcome: "failed",
          admissionEventSequence: admitted.admissionEventSequence,
          domainEventSequence: null,
          domainOperationId: operationId,
          errorCode: "CONTEXT_FAILED",
        }),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );
    expect(fixture.store.getBrowserAction(request.actionId)).toMatchObject({
      status: "admitted",
      outcome: null,
      domainEventSequence: null,
      domainOperationId: null,
    });
    fixture.store.close();
  });

  test("does not reinterpret a resumed-stage operation failure as a terminal resume boundary", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const request = identity();
    fixture.store.prepareBrowserAction(request, "unit operator");
    const admitted = fixture.store.admitBrowserAction(request.actionId);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("Expected admitted action");
    const operationId = "44444444-4444-4444-8444-444444444444";
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 3, 'operation.started', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(
        UNIT_RUN_ID,
        JSON.stringify({
          operationId,
          kind: "context.prepare",
          browserActionId: request.actionId,
        }),
      );
    database
      .prepare(
        `INSERT INTO operations
         (id, run_id, kind, status, reserved_cost_usd, reserved_tokens,
          reserved_runtime_ms, result_json, started_at, finished_at)
         VALUES (?, ?, 'context.prepare', 'failed', 0, 0, 0, ?,
                 '2026-07-19T12:00:00.000Z', '2026-07-19T12:00:00.000Z')`,
      )
      .run(operationId, UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
    database.close();

    expectIcarusCode(
      () =>
        fixture.store.settleAdmittedBrowserAction(request.actionId, {
          outcome: "failed",
          admissionEventSequence: admitted.admissionEventSequence,
          domainEventSequence: null,
          domainOperationId: operationId,
          errorCode: "CONTEXT_FAILED",
        }),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );
    fixture.store.close();
  });

  test("rejects a domain operation whose start event predates browser admission", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const subjectDigest = "a".repeat(64);
    const request = exactIdentity("11111111-1111-4111-8111-111111111111", {
      version: 1,
      kind: "egress.approve",
      runId: UNIT_RUN_ID,
      expectedState: "awaiting_egress_approval",
      eventRevision: 2,
      subjectDigest,
      activeActionId: null,
      activeActionDigest: null,
    });
    const operationId = "66666666-6666-4666-8666-666666666666";
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        "UPDATE runs SET state = 'awaiting_egress_approval', context_sha256 = ? WHERE id = ?",
      )
      .run(subjectDigest, UNIT_RUN_ID);
    database
      .prepare(
        `INSERT INTO operations
         (id, run_id, kind, status, reserved_cost_usd, reserved_tokens,
          reserved_runtime_ms, result_json, started_at, finished_at)
         VALUES (?, ?, 'egress.validate', 'failed', 0, 0, 0, ?,
                 '2026-07-19T12:00:00.000Z', '2026-07-19T12:00:00.000Z')`,
      )
      .run(operationId, UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 2, 'operation.started', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(
        UNIT_RUN_ID,
        JSON.stringify({
          operationId,
          kind: "egress.validate",
          browserActionId: request.actionId,
        }),
      );
    database.close();
    fixture.store.prepareBrowserAction(request, "unit operator");
    const admitted = fixture.store.admitBrowserAction(request.actionId);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("Expected admitted action");

    expectIcarusCode(
      () =>
        fixture.store.settleAdmittedBrowserAction(request.actionId, {
          outcome: "failed",
          admissionEventSequence: admitted.admissionEventSequence,
          domainEventSequence: null,
          domainOperationId: operationId,
          errorCode: "CONTEXT_FAILED",
        }),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );
    fixture.store.close();
  });

  test("translates SQLite admission contention into a bounded RUN_BUSY error", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    fixture.store.close();
    const store = new IcarusStore(fixture.databasePath, { busyTimeoutMs: 1 });
    const lock = new Database(fixture.databasePath);
    lock.prepare("BEGIN IMMEDIATE").run();
    try {
      expectIcarusCode(() => store.prepareBrowserAction(identity(), "unit operator"), "RUN_BUSY");
    } finally {
      lock.prepare("ROLLBACK").run();
      lock.close();
      store.close();
    }
  });

  test.each([
    { expectedState: "restoring" as const, resumeState: null },
    { expectedState: "failed" as const, resumeState: "restoring" as const },
  ])(
    "refuses run.resume cancellation settlement from a $expectedState action resuming restoring",
    ({ expectedState, resumeState }) => {
      const fixture = createUnitStore();
      cleanupRoots.push(fixture.root);
      seedPreparingRun(fixture.store);
      const request = identity("55555555-5555-4555-8555-555555555555", "run.resume", expectedState);
      const runState = new Database(fixture.databasePath);
      runState
        .prepare("UPDATE runs SET state = ?, resume_state = ? WHERE id = ?")
        .run(expectedState, resumeState, UNIT_RUN_ID);
      runState.close();
      fixture.store.prepareBrowserAction(request, "unit operator");
      const admitted = fixture.store.admitBrowserAction(request.actionId);
      expect(admitted.status).toBe("admitted");
      if (admitted.status !== "admitted") throw new Error("Expected admitted action");

      const database = new Database(fixture.databasePath);
      database
        .prepare(
          `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
           VALUES (?, 3, 'resume.requested', ?, '2026-07-19T12:00:00.000Z')`,
        )
        .run(
          UNIT_RUN_ID,
          JSON.stringify({
            browserActionId: request.actionId,
            state: expectedState,
            resumeState,
          }),
        );
      database
        .prepare(
          `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
           VALUES (?, 4, 'cancellation.completed', ?, '2026-07-19T12:00:00.000Z')`,
        )
        .run(UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
      database.prepare("UPDATE runs SET state = 'cancelled' WHERE id = ?").run(UNIT_RUN_ID);
      database.close();

      expectIcarusCode(
        () =>
          fixture.store.settleAdmittedBrowserAction(request.actionId, {
            outcome: "cancelled",
            admissionEventSequence: admitted.admissionEventSequence,
            domainEventSequence: 4,
            domainOperationId: null,
            errorCode: null,
          }),
        "INVALID_BROWSER_ACTION_SETTLEMENT",
      );
      fixture.store.close();
    },
  );

  test.each([
    { expectedState: "cancelling" as const, resumeState: null },
    { expectedState: "failed" as const, resumeState: "cancelling" as const },
  ])(
    "settles run.resume cancellation recovery from $expectedState as success",
    ({ expectedState, resumeState }) => {
      const fixture = createUnitStore();
      cleanupRoots.push(fixture.root);
      seedPreparingRun(fixture.store);
      const request = identity("55555555-5555-4555-8555-555555555555", "run.resume", expectedState);
      const runState = new Database(fixture.databasePath);
      runState
        .prepare("UPDATE runs SET state = ?, resume_state = ? WHERE id = ?")
        .run(expectedState, resumeState, UNIT_RUN_ID);
      runState.close();
      fixture.store.prepareBrowserAction(request, "unit operator");
      const admitted = fixture.store.admitBrowserAction(request.actionId);
      expect(admitted.status).toBe("admitted");
      if (admitted.status !== "admitted") throw new Error("Expected admitted action");

      const database = new Database(fixture.databasePath);
      database
        .prepare(
          `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
           VALUES (?, 3, 'resume.requested', ?, '2026-07-19T12:00:00.000Z')`,
        )
        .run(
          UNIT_RUN_ID,
          JSON.stringify({
            browserActionId: request.actionId,
            state: expectedState,
            resumeState,
          }),
        );
      database
        .prepare(
          `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
           VALUES (?, 4, 'cancellation.completed', ?, '2026-07-19T12:00:00.000Z')`,
        )
        .run(UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
      database.prepare("UPDATE runs SET state = 'cancelled' WHERE id = ?").run(UNIT_RUN_ID);
      database.close();

      expectIcarusCode(
        () =>
          fixture.store.settleAdmittedBrowserAction(request.actionId, {
            outcome: "cancelled",
            admissionEventSequence: admitted.admissionEventSequence,
            domainEventSequence: 4,
            domainOperationId: null,
            errorCode: null,
          }),
        "INVALID_BROWSER_ACTION_SETTLEMENT",
      );
      expect(fixture.store.getBrowserAction(request.actionId)).toMatchObject({
        status: "admitted",
        outcome: null,
      });
      expect(
        fixture.store.settleAdmittedBrowserAction(request.actionId, {
          outcome: "succeeded",
          admissionEventSequence: admitted.admissionEventSequence,
          domainEventSequence: 4,
          domainOperationId: null,
          errorCode: null,
        }),
      ).toMatchObject({
        status: "settled",
        outcome: "succeeded",
        domainEventSequence: 4,
      });
      fixture.store.close();
    },
  );

  test("cannot label an allowed resume cancellation as success", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const request = identity();
    fixture.store.prepareBrowserAction(request, "unit operator");
    const admitted = fixture.store.admitBrowserAction(request.actionId);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("Expected admitted action");
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 3, 'resume.requested', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(
        UNIT_RUN_ID,
        JSON.stringify({
          browserActionId: request.actionId,
          state: "preparing",
          resumeState: null,
        }),
      );
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 4, 'cancellation.completed', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
    database.prepare("UPDATE runs SET state = 'cancelled' WHERE id = ?").run(UNIT_RUN_ID);
    database.close();

    expectIcarusCode(
      () =>
        fixture.store.settleAdmittedBrowserAction(request.actionId, {
          outcome: "succeeded",
          admissionEventSequence: admitted.admissionEventSequence,
          domainEventSequence: 4,
          domainOperationId: null,
          errorCode: null,
        }),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );
    expect(
      fixture.store.settleAdmittedBrowserAction(request.actionId, {
        outcome: "cancelled",
        admissionEventSequence: admitted.admissionEventSequence,
        domainEventSequence: 4,
        domainOperationId: null,
        errorCode: null,
      }),
    ).toMatchObject({ status: "settled", outcome: "cancelled" });
    fixture.store.close();
  });

  test("settles run.cancel at its request and never reinterprets later run failure", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store);
    const request = identity("77777777-7777-4777-8777-777777777777", "run.cancel", "preparing");
    fixture.store.prepareBrowserAction(request, "unit operator");
    const admitted = fixture.store.admitBrowserAction(request.actionId);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("Expected admitted action");
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 3, 'cancellation.requested', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 4, 'run.failed', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(UNIT_RUN_ID, JSON.stringify({ browserActionId: request.actionId }));
    database.prepare("UPDATE runs SET state = 'failed' WHERE id = ?").run(UNIT_RUN_ID);
    database.close();

    expectIcarusCode(
      () =>
        fixture.store.settleAdmittedBrowserAction(request.actionId, {
          outcome: "failed",
          admissionEventSequence: admitted.admissionEventSequence,
          domainEventSequence: 4,
          domainOperationId: null,
          errorCode: "RECOVERY_FAILED",
        }),
      "INVALID_BROWSER_ACTION_SETTLEMENT",
    );
    expect(
      fixture.store.settleAdmittedBrowserAction(request.actionId, {
        outcome: "succeeded",
        admissionEventSequence: admitted.admissionEventSequence,
        domainEventSequence: 3,
        domainOperationId: null,
        errorCode: null,
      }),
    ).toMatchObject({
      status: "settled",
      outcome: "succeeded",
      domainEventSequence: 3,
    });
    fixture.store.close();
  });

  test("binds a named resume operation to the admitted stage and before the terminal event", () => {
    const cases = [
      { operationKind: "provider.plan", operationSequence: 3, terminalSequence: 4 },
      { operationKind: "context.prepare", operationSequence: 5, terminalSequence: 4 },
    ] as const;
    for (const testCase of cases) {
      const fixture = createUnitStore();
      cleanupRoots.push(fixture.root);
      seedPreparingRun(fixture.store);
      const request = identity();
      fixture.store.prepareBrowserAction(request, "unit operator");
      const admitted = fixture.store.admitBrowserAction(request.actionId);
      expect(admitted.status).toBe("admitted");
      if (admitted.status !== "admitted") throw new Error("Expected admitted action");
      const operationId = "88888888-8888-4888-8888-888888888888";
      const database = new Database(fixture.databasePath);
      database
        .prepare(
          `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
           VALUES (?, ?, 'operation.started', ?, '2026-07-19T12:00:00.000Z')`,
        )
        .run(
          UNIT_RUN_ID,
          testCase.operationSequence,
          JSON.stringify({
            operationId,
            kind: testCase.operationKind,
            browserActionId: request.actionId,
          }),
        );
      database
        .prepare(
          `INSERT INTO operations
           (id, run_id, kind, status, reserved_cost_usd, reserved_tokens,
            reserved_runtime_ms, result_json, started_at, finished_at)
           VALUES (?, ?, ?, 'succeeded', 0, 0, 0, ?,
                   '2026-07-19T12:00:00.000Z', '2026-07-19T12:00:00.000Z')`,
        )
        .run(
          operationId,
          UNIT_RUN_ID,
          testCase.operationKind,
          JSON.stringify({ browserActionId: request.actionId }),
        );
      database
        .prepare(
          `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
           VALUES (?, ?, 'plan.created', ?, '2026-07-19T12:00:00.000Z')`,
        )
        .run(
          UNIT_RUN_ID,
          testCase.terminalSequence,
          JSON.stringify({ browserActionId: request.actionId }),
        );
      database.prepare("UPDATE runs SET state = 'awaiting_approval' WHERE id = ?").run(UNIT_RUN_ID);
      database.close();

      expectIcarusCode(
        () =>
          fixture.store.settleAdmittedBrowserAction(request.actionId, {
            outcome: "succeeded",
            admissionEventSequence: admitted.admissionEventSequence,
            domainEventSequence: testCase.terminalSequence,
            domainOperationId: operationId,
            errorCode: null,
          }),
        "INVALID_BROWSER_ACTION_SETTLEMENT",
      );
      fixture.store.close();
    }
  });
});
