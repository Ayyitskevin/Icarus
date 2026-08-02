import { rmSync } from "node:fs";
import { createRequire } from "node:module";

import { afterEach, describe, expect, test } from "vitest";

import {
  type BrowserActionDescriptor,
  type BrowserActionDescriptorFields,
  type BrowserActionIdentity,
  browserActionDescriptorDigest,
} from "../../packages/core/src/browser-action-state.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { planApprovalDigest } from "../../packages/core/src/policy.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import {
  createUnitStore,
  seedUnitProject,
  UNIT_BASE_COMMIT,
  UNIT_CEILING,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
  UNIT_SANDBOX,
  unitContextDigest,
  unitContextManifest,
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

function seedPreparingRun(
  store: IcarusStore,
  databasePath: string,
  recoveryKind = "context.prepare",
): void {
  const { projectId } = seedUnitProject(store);
  store.createRun({
    id: UNIT_RUN_ID,
    projectId,
    task: "Prepare the browser action ledger",
    targets: UNIT_PLAN.targets,
    provider: UNIT_PROVIDER,
  });
  const database = new Database(databasePath);
  database
    .prepare(
      `INSERT INTO operations
       (id, run_id, kind, status, reserved_cost_usd, reserved_tokens,
        reserved_runtime_ms, result_json, started_at, finished_at)
       VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ?, ?, 'interrupted',
               0, 0, 0, NULL, '2026-07-19T12:00:00.000Z',
               '2026-07-19T12:00:00.000Z')`,
    )
    .run(UNIT_RUN_ID, recoveryKind);
  database.close();
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

function identityFromDescriptor(
  actionId: string,
  descriptor: BrowserActionDescriptor,
): BrowserActionIdentity {
  return {
    actionId,
    version: descriptor.version,
    kind: descriptor.kind,
    runId: descriptor.runId,
    expectedState: descriptor.expectedState,
    eventRevision: descriptor.eventRevision,
    subjectDigest: descriptor.subjectDigest,
    activeActionId: descriptor.activeActionId,
    activeActionDigest: descriptor.activeActionDigest,
    actionDigest: descriptor.actionDigest,
  };
}

function advanceResumableStage(
  store: IcarusStore,
  databasePath: string,
  stage: "planned" | "running" | "verifying",
): void {
  store.pinRunBase(UNIT_RUN_ID, UNIT_BASE_COMMIT);
  const context = unitContextManifest();
  const contextSha256 = unitContextDigest(context);
  store.completePreparation(UNIT_RUN_ID, context, "artifacts/context.json", contextSha256);
  if (stage === "planned") return;
  const planSha256 = planApprovalDigest({
    task: "Prepare the browser action ledger",
    baseCommit: UNIT_BASE_COMMIT,
    contextSha256,
    targets: context.targets,
    provider: UNIT_PROVIDER,
    checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }],
    sandbox: UNIT_SANDBOX,
    ceiling: UNIT_CEILING,
    plan: UNIT_PLAN,
    readableManifest: null,
  });
  store.recordPlanAndAwaitApproval(UNIT_RUN_ID, UNIT_PLAN, planSha256);
  store.approvePlan(UNIT_RUN_ID, planSha256, "unit operator");
  if (stage === "running") return;
  store.recordWorkspace(UNIT_RUN_ID, "/private/cache", "/private/worktree", null);
  const database = new Database(databasePath);
  database
    .prepare(
      `UPDATE runs SET edit_json = '{}', baseline_base64 = 'YmFzZQ==',
       approved_base64 = 'YXBwcm92ZWQ=' WHERE id = ?`,
    )
    .run(UNIT_RUN_ID);
  database.close();
  store.transition(UNIT_RUN_ID, "verifying", "edit.materialized", {
    target: "src/greeting.txt",
  });
}

function preparePlanApprovalGate(store: IcarusStore): string {
  store.pinRunBase(UNIT_RUN_ID, UNIT_BASE_COMMIT);
  const context = unitContextManifest();
  const contextSha256 = unitContextDigest(context);
  store.completePreparation(UNIT_RUN_ID, context, "artifacts/context.json", contextSha256);
  const planSha256 = planApprovalDigest({
    task: "Prepare the browser action ledger",
    baseCommit: UNIT_BASE_COMMIT,
    contextSha256,
    targets: context.targets,
    provider: UNIT_PROVIDER,
    checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }],
    sandbox: UNIT_SANDBOX,
    ceiling: UNIT_CEILING,
    plan: UNIT_PLAN,
    readableManifest: null,
  });
  store.recordPlanAndAwaitApproval(UNIT_RUN_ID, UNIT_PLAN, planSha256);
  return planSha256;
}

describe("browser action ledger", () => {
  test("returns current authority and only a bounded recovery receipt", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store, fixture.databasePath);

    const authority = fixture.store.getBrowserActionAuthoritySnapshot(UNIT_RUN_ID);
    expect(authority).toMatchObject({
      run: { id: UNIT_RUN_ID, state: "preparing" },
      eventRevision: 1,
      readableManifest: null,
      recovery: null,
    });
    expect(authority.actions.map((action) => action.kind)).toEqual(["run.resume", "run.cancel"]);
    for (const action of authority.actions) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.consequence.length).toBeGreaterThan(0);
      expect(action.actionDigest).toBe(
        browserActionDescriptorDigest({
          version: action.version,
          kind: action.kind,
          runId: action.runId,
          expectedState: action.expectedState,
          eventRevision: action.eventRevision,
          subjectDigest: action.subjectDigest,
          activeActionId: action.activeActionId,
          activeActionDigest: action.activeActionDigest,
        }),
      );
    }

    const resume = authority.actions.find((action) => action.kind === "run.resume");
    if (resume === undefined) throw new Error("Expected resume authority");
    const { label: _label, consequence: _consequence, ...descriptor } = resume;
    const request: BrowserActionIdentity = {
      actionId: "99999999-9999-4999-8999-999999999999",
      ...descriptor,
    };
    fixture.store.prepareBrowserAction(request, "unit operator");
    const recovery = fixture.store.getBrowserActionAuthoritySnapshot(UNIT_RUN_ID).recovery;
    expect(recovery).toEqual({
      actionId: request.actionId,
      kind: "run.resume",
      status: "prepared",
      outcome: null,
      errorCode: null,
      updatedAt: "2026-07-19T12:00:00.000Z",
    });
    expect(Object.keys(recovery ?? {}).sort()).toEqual([
      "actionId",
      "errorCode",
      "kind",
      "outcome",
      "status",
      "updatedAt",
    ]);
    expect(fixture.store.getBrowserActionReceipt(UNIT_RUN_ID, request.actionId)).toEqual(recovery);
    fixture.store.close();
  });

  test("prepares idempotently and rejects reuse with a different immutable tuple", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store, fixture.databasePath);
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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

    expectIcarusCode(
      () => fixture.store.admitBrowserAction(cancel.actionId),
      "COORDINATOR_REQUIRED",
    );
    expect(fixture.store.admitInFlightBrowserActionCancellation(cancel.actionId)).toMatchObject({
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
      seedPreparingRun(fixture.store, fixture.databasePath);
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
    seedPreparingRun(fixture.store, fixture.databasePath);
    const nonCancel = identity();
    const cancel = identity("22222222-2222-4222-8222-222222222222", "run.cancel");
    fixture.store.prepareBrowserAction(nonCancel, "unit operator");
    fixture.store.admitBrowserAction(nonCancel.actionId);
    fixture.store.prepareBrowserAction(cancel, "unit operator");

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
    seedPreparingRun(fixture.store, fixture.databasePath);
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

  test("preserves legacy session payloads while action-linked terminals retain exact correlation", () => {
    const legacy = createUnitStore();
    cleanupRoots.push(legacy.root);
    seedPreparingRun(legacy.store, legacy.databasePath);
    const legacyPlanSha256 = preparePlanApprovalGate(legacy.store);
    legacy.store.approvePlan(UNIT_RUN_ID, legacyPlanSha256, "unit operator");
    legacy.store.recordSessionOutcome(UNIT_RUN_ID, "exhausted", null, 0);

    const legacyTerminal = legacy.store
      .listEvents(UNIT_RUN_ID)
      .find((event) => event.type === "session.exhausted");
    expect(legacyTerminal?.payload).toEqual({ iterations: 0 });
    legacy.store.close();

    const linked = createUnitStore();
    cleanupRoots.push(linked.root);
    seedPreparingRun(linked.store, linked.databasePath);
    const linkedPlanSha256 = preparePlanApprovalGate(linked.store);
    const descriptor = linked.store
      .getBrowserActionAuthoritySnapshot(UNIT_RUN_ID)
      .actions.find((action) => action.kind === "plan.approve");
    if (descriptor === undefined) throw new Error("Expected plan approval authority");
    const request = identityFromDescriptor("88888888-8888-4888-8888-888888888888", descriptor);
    linked.store.prepareBrowserAction(request, "unit operator");
    const admitted = linked.store.admitBrowserAction(request.actionId);
    expect(admitted.status).toBe("admitted");
    linked.store.approvePlan(UNIT_RUN_ID, linkedPlanSha256, "unit operator", request.actionId);
    linked.store.recordSessionOutcome(UNIT_RUN_ID, "exhausted", null, 0, request.actionId);

    const linkedTerminal = linked.store
      .listEvents(UNIT_RUN_ID)
      .find((event) => event.type === "session.exhausted");
    expect(linkedTerminal?.payload).toEqual({
      from: "running",
      to: "awaiting_review",
      iterations: 0,
      browserActionId: request.actionId,
    });
    expect(linked.store.getBrowserAction(request.actionId)).toMatchObject({
      status: "settled",
      outcome: "succeeded",
      domainEventSequence: linkedTerminal?.sequence,
      domainOperationId: null,
      errorCode: null,
    });
    linked.store.close();
  });

  test("settles success only at the exact action-linked terminal event and run state", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store, fixture.databasePath);
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
      .run(
        UNIT_RUN_ID,
        JSON.stringify({
          browserActionId: request.actionId,
          from: "preparing",
          to: "awaiting_egress_approval",
        }),
      );
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
    seedPreparingRun(fixture.store, fixture.databasePath);
    const request = identity("11111111-1111-4111-8111-111111111111", "run.resume", "preparing", 2);
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 2, 'egress.requested', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(
        UNIT_RUN_ID,
        JSON.stringify({
          browserActionId: request.actionId,
          from: "preparing",
          to: "awaiting_egress_approval",
        }),
      );
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
      .run(
        UNIT_RUN_ID,
        JSON.stringify({
          browserActionId: request.actionId,
          from: "planned",
          to: "awaiting_approval",
        }),
      );
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
      seedPreparingRun(fixture.store, fixture.databasePath, "checkpoint.restore");
      const request = identity("55555555-5555-4555-8555-555555555555", "run.resume", expectedState);
      const runState = new Database(fixture.databasePath);
      runState
        .prepare(
          `UPDATE runs SET state = ?, resume_state = ?, worktree_path = '/private/worktree',
           edit_json = '{}', baseline_base64 = 'YmFzZQ==', approved_base64 = 'YXBwcm92ZWQ='
           WHERE id = ?`,
        )
        .run(expectedState, resumeState, UNIT_RUN_ID);
      runState
        .prepare(
          `INSERT INTO checkpoints
           (run_id, baseline_base64, approved_base64, checkpoint_sha256, created_at)
           VALUES (?, 'YmFzZQ==', 'YXBwcm92ZWQ=', ?, '2026-07-19T12:00:00.000Z')`,
        )
        .run(UNIT_RUN_ID, "c".repeat(64));
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
        .run(
          UNIT_RUN_ID,
          JSON.stringify({
            browserActionId: request.actionId,
            from: "cancelling",
            to: "cancelled",
          }),
        );
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
      seedPreparingRun(fixture.store, fixture.databasePath, "cancellation.recovery");
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
        .run(
          UNIT_RUN_ID,
          JSON.stringify({
            browserActionId: request.actionId,
            from: "cancelling",
            to: "cancelled",
          }),
        );
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
      .run(
        UNIT_RUN_ID,
        JSON.stringify({
          browserActionId: request.actionId,
          from: "cancelling",
          to: "cancelled",
        }),
      );
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
    seedPreparingRun(fixture.store, fixture.databasePath);
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
      .run(
        UNIT_RUN_ID,
        JSON.stringify({
          browserActionId: request.actionId,
          from: "preparing",
          to: "cancelling",
        }),
      );
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 4, 'run.failed', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(
        UNIT_RUN_ID,
        JSON.stringify({
          browserActionId: request.actionId,
          from: "cancelling",
          to: "failed",
          resumeState: "cancelling",
          errorCode: "RECOVERY_FAILED",
        }),
      );
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
      seedPreparingRun(fixture.store, fixture.databasePath);
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
          JSON.stringify({
            browserActionId: request.actionId,
            from: "planned",
            to: "awaiting_approval",
          }),
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

  test("does not let the current prepared resume shadow earlier reconciliation evidence", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store, fixture.databasePath);
    const first = identity("11111111-1111-4111-8111-111111111111");
    fixture.store.prepareBrowserAction(first, "unit operator");
    fixture.store.admitBrowserAction(first.actionId);
    expect(fixture.store.reconcileAdmittedBrowserAction(first.actionId)).toMatchObject({
      status: "settled",
      outcome: "reconciliation_required",
      errorCode: "ACTION_RECOVERY_REQUIRED",
    });
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `UPDATE operations SET status = 'succeeded', result_json = '{}'
         WHERE run_id = ?`,
      )
      .run(UNIT_RUN_ID);
    database.close();

    const descriptor = fixture.store
      .getBrowserActionAuthoritySnapshot(UNIT_RUN_ID)
      .actions.find((candidate) => candidate.kind === "run.resume");
    if (descriptor === undefined) throw new Error("Expected resume recovery authority");
    const current = identityFromDescriptor("22222222-2222-4222-8222-222222222222", descriptor);
    fixture.store.prepareBrowserAction(current, "unit operator");

    expect(fixture.store.admitBrowserAction(current.actionId)).toMatchObject({
      status: "admitted",
      outcome: null,
    });
    fixture.store.close();
  });

  test("does not reinterpret an old failed verification transition after later state movement", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    seedPreparingRun(fixture.store, fixture.databasePath, "verification.preflight");
    advanceResumableStage(fixture.store, fixture.databasePath, "verifying");
    const descriptor = fixture.store
      .getBrowserActionAuthoritySnapshot(UNIT_RUN_ID)
      .actions.find((candidate) => candidate.kind === "run.resume");
    if (descriptor === undefined) throw new Error("Expected verifying resume authority");
    const request = identityFromDescriptor("33333333-3333-4333-8333-333333333333", descriptor);
    fixture.store.prepareBrowserAction(request, "unit operator");
    fixture.store.admitBrowserAction(request.actionId);
    fixture.store.beginBrowserResume(UNIT_RUN_ID, "unit operator", request.actionId);

    const sequence = fixture.store.listEvents(UNIT_RUN_ID).length + 1;
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, ?, 'verification.completed', ?, '2026-07-19T12:00:00.000Z')`,
      )
      .run(
        UNIT_RUN_ID,
        sequence,
        JSON.stringify({
          browserActionId: request.actionId,
          from: "verifying",
          to: "verifying",
          outcome: "failed",
        }),
      );
    database.prepare("UPDATE runs SET state = 'awaiting_review' WHERE id = ?").run(UNIT_RUN_ID);
    database.close();

    expect(fixture.store.reconcileAdmittedBrowserAction(request.actionId)).toMatchObject({
      status: "settled",
      outcome: "reconciliation_required",
      domainEventSequence: null,
      errorCode: "ACTION_RECOVERY_REQUIRED",
    });
    fixture.store.close();
  });

  test("correlates the actual first resume operation for planned, running, and verifying stages", () => {
    const cases = [
      {
        stage: "planned" as const,
        operationKind: "context.load.plan",
        terminalType: "plan.created",
        terminalFrom: "planned",
        terminalState: "awaiting_approval" as const,
      },
      {
        stage: "running" as const,
        operationKind: "execution.prepare",
        terminalType: "verification.completed",
        terminalFrom: "verifying",
        terminalState: "awaiting_review" as const,
      },
      {
        stage: "verifying" as const,
        operationKind: "verification.preflight",
        terminalType: "verification.completed",
        terminalFrom: "verifying",
        terminalState: "awaiting_review" as const,
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      const fixture = createUnitStore();
      cleanupRoots.push(fixture.root);
      seedPreparingRun(fixture.store, fixture.databasePath, testCase.operationKind);
      advanceResumableStage(fixture.store, fixture.databasePath, testCase.stage);
      const descriptor = fixture.store
        .getBrowserActionAuthoritySnapshot(UNIT_RUN_ID)
        .actions.find((candidate) => candidate.kind === "run.resume");
      if (descriptor === undefined) throw new Error(`Expected ${testCase.stage} resume authority`);
      const request = identityFromDescriptor(
        `77777777-7777-4777-8777-${(index + 1).toString().padStart(12, "0")}`,
        descriptor,
      );
      fixture.store.prepareBrowserAction(request, "unit operator");
      const admitted = fixture.store.admitBrowserAction(request.actionId);
      expect(admitted.status).toBe("admitted");
      if (admitted.status !== "admitted") throw new Error("Expected admitted action");
      fixture.store.beginBrowserResume(UNIT_RUN_ID, "unit operator", request.actionId);
      const operation = fixture.store.beginOperation(
        UNIT_RUN_ID,
        testCase.operationKind,
        0,
        0,
        1,
        testCase.stage,
        request.actionId,
      );
      fixture.store.finishOperation(operation, {
        outcome: "succeeded",
        activeRuntimeMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        detail: {},
      });

      const terminalSequence = fixture.store.listEvents(UNIT_RUN_ID).length + 1;
      const terminalPayload = {
        browserActionId: request.actionId,
        from: testCase.terminalFrom,
        to: testCase.terminalState,
        ...(testCase.terminalType === "verification.completed" ? { outcome: "passed" } : {}),
      };
      const database = new Database(fixture.databasePath);
      database
        .prepare(
          `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, '2026-07-19T12:00:00.000Z')`,
        )
        .run(UNIT_RUN_ID, terminalSequence, testCase.terminalType, JSON.stringify(terminalPayload));
      database
        .prepare("UPDATE runs SET state = ? WHERE id = ?")
        .run(testCase.terminalState, UNIT_RUN_ID);
      database.close();

      expect(
        fixture.store.settleAdmittedBrowserAction(request.actionId, {
          outcome: "succeeded",
          admissionEventSequence: admitted.admissionEventSequence,
          domainEventSequence: terminalSequence,
          domainOperationId: operation.id,
          errorCode: null,
        }),
      ).toMatchObject({
        status: "settled",
        outcome: "succeeded",
        domainEventSequence: terminalSequence,
        domainOperationId: operation.id,
      });
      fixture.store.close();
    }
  });
});
