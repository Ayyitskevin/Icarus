import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  type BrowserActionIdentity,
  browserActionDescriptorDigest,
} from "../../packages/core/src/browser-action-state.js";
import { createIcarusRuntime } from "../../packages/core/src/runtime.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import {
  seedUnitProject,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
} from "../support/unit-fixtures.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function identity(
  actionId: string,
  kind: "run.resume" | "run.cancel",
  eventRevision: number,
): BrowserActionIdentity {
  const descriptor = {
    version: 1 as const,
    kind,
    runId: UNIT_RUN_ID,
    expectedState: "preparing" as const,
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

describe.runIf(process.platform === "linux")("browser action restart reconciliation", () => {
  test("interrupts started work and settles prepared and admitted requests without replay", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "icarus-browser-reconcile-"));
    cleanupRoots.push(root);
    const stateRoot = path.join(root, "state");
    const runtime = await createIcarusRuntime(stateRoot);
    const writer = new IcarusStore(path.join(stateRoot, "icarus.sqlite3"));
    const { projectId } = seedUnitProject(writer);
    writer.createRun({
      id: UNIT_RUN_ID,
      projectId,
      task: "Reconcile browser actions",
      targets: UNIT_PLAN.targets,
      provider: UNIT_PROVIDER,
    });
    writer.beginOperation(UNIT_RUN_ID, "context.prepare", 0, 0, 1, "preparing");
    writer.markStartedOperationsInterrupted(UNIT_RUN_ID);
    const admitted = identity("11111111-1111-4111-8111-111111111111", "run.resume", 3);
    const prepared = identity("22222222-2222-4222-8222-222222222222", "run.cancel", 5);
    writer.prepareBrowserAction(admitted, "unit operator");
    writer.admitBrowserAction(admitted.actionId);
    writer.beginOperation(UNIT_RUN_ID, "context.prepare", 0, 0, 1, "preparing", admitted.actionId);
    writer.prepareBrowserAction(prepared, "unit operator");
    writer.close();

    await expect(runtime.service.reconcileBrowserActionRequests()).resolves.toEqual({
      settledPrepared: 1,
      settledAdmitted: 1,
      busyRunIds: [],
    });

    const observer = new IcarusStore(path.join(stateRoot, "icarus.sqlite3"));
    expect(observer.getBrowserAction(admitted.actionId)).toMatchObject({
      status: "settled",
      outcome: "reconciliation_required",
      errorCode: "ACTION_RECOVERY_REQUIRED",
    });
    expect(observer.getBrowserAction(prepared.actionId)).toMatchObject({
      status: "settled",
      outcome: "refused",
      errorCode: "ACTION_NOT_ADMITTED",
    });
    expect(observer.listEvents(UNIT_RUN_ID).map((event) => event.type)).toEqual([
      "run.created",
      "operation.started",
      "operation.interrupted",
      "browser.action.admitted",
      "operation.started",
      "operation.interrupted",
    ]);
    observer.close();
    runtime.close();
  });
});
