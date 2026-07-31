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

function identity(actionId: string, kind: "run.resume" | "run.cancel"): BrowserActionIdentity {
  const descriptor = {
    version: 1 as const,
    kind,
    runId: UNIT_RUN_ID,
    expectedState: "preparing" as const,
    eventRevision: 1,
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
  test("refuses only prepared intent and holds admitted work for exact boundary reconciliation", async () => {
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
    const admitted = identity("11111111-1111-4111-8111-111111111111", "run.resume");
    const prepared = identity("22222222-2222-4222-8222-222222222222", "run.cancel");
    writer.prepareBrowserAction(admitted, "unit operator");
    writer.admitBrowserAction(admitted.actionId);
    writer.prepareBrowserAction(prepared, "unit operator");
    writer.close();

    await expect(runtime.service.reconcilePreparedBrowserActionRequests()).resolves.toEqual({
      settledPrepared: 1,
      busyRunIds: [],
      unresolvedAdmittedRunIds: [UNIT_RUN_ID],
    });

    const observer = new IcarusStore(path.join(stateRoot, "icarus.sqlite3"));
    expect(observer.getBrowserAction(admitted.actionId)).toMatchObject({
      status: "admitted",
      outcome: null,
      errorCode: null,
    });
    expect(observer.getBrowserAction(prepared.actionId)).toMatchObject({
      status: "settled",
      outcome: "refused",
      errorCode: "ACTION_NOT_ADMITTED",
    });
    expect(observer.listEvents(UNIT_RUN_ID).map((event) => event.type)).toEqual([
      "run.created",
      "browser.action.admitted",
    ]);
    observer.close();
    runtime.close();
  });
});
