import { describe, expect, test } from "vitest";

import { BrowserActionCoordinator } from "../../packages/api/src/action-coordinator.js";
import { browserActionRequest } from "../../packages/api/src/contracts.js";
import {
  type BrowserActionIdentity,
  browserActionDescriptorDigest,
} from "../../packages/core/src/index.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ACTION_ID = "22222222-2222-4222-8222-222222222222";
const ACTION_DIGEST = "a".repeat(64);

function identity(overrides: Partial<BrowserActionIdentity> = {}): BrowserActionIdentity {
  const candidate: BrowserActionIdentity = {
    actionId: ACTION_ID,
    version: 1,
    kind: "run.cancel",
    runId: RUN_ID,
    expectedState: "preparing",
    eventRevision: 1,
    subjectDigest: null,
    activeActionId: null,
    activeActionDigest: null,
    actionDigest: ACTION_DIGEST,
    ...overrides,
  };
  return {
    ...candidate,
    actionDigest: overrides.actionDigest ?? browserActionDescriptorDigest(candidate),
  };
}

function gate(): { readonly promise: Promise<void>; release(): void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("browser action API contract", () => {
  test("accepts only the exact ten-field closed identity", () => {
    expect(browserActionRequest(identity())).toEqual(identity());

    for (const invalid of [
      { ...identity(), actor: "browser supplied" },
      { ...identity(), version: 2 },
      { ...identity(), kind: "landing.approve" },
      { ...identity(), expectedState: "completed" },
      { ...identity(), eventRevision: 0 },
      { ...identity(), subjectDigest: "b".repeat(64) },
      { ...identity(), activeActionId: ACTION_ID },
      { ...identity(), actionDigest: "A".repeat(64) },
    ]) {
      expect(() => browserActionRequest(invalid)).toThrowError(
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
  });

  test("requires subject digests only for subject-bound actions and parent pairs only for cancel", () => {
    const plan = identity({
      kind: "plan.approve",
      expectedState: "awaiting_approval",
      subjectDigest: "b".repeat(64),
    });
    expect(browserActionRequest(plan)).toMatchObject({
      kind: "plan.approve",
      subjectDigest: "b".repeat(64),
    });

    expect(() => browserActionRequest({ ...plan, subjectDigest: null })).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    const resume = identity({
      kind: "run.resume",
      expectedState: "failed",
    });
    expect(() =>
      browserActionRequest({
        ...resume,
        activeActionId: ACTION_ID,
        activeActionDigest: ACTION_DIGEST,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});

describe("browser action run coordinator", () => {
  test("excludes same-run work, increments generations, and aborts only an exact bound parent", async () => {
    const coordinator = new BrowserActionCoordinator();
    const firstGate = gate();
    let firstSignal: AbortSignal | undefined;
    const parent = identity({
      kind: "plan.approve",
      expectedState: "awaiting_approval",
      subjectDigest: "b".repeat(64),
    });
    const first = coordinator.execute(parent, async ({ binding, signal }) => {
      expect(binding).toMatchObject({
        actionId: parent.actionId,
        actionDigest: parent.actionDigest,
        generation: 1,
        cancellable: true,
      });
      firstSignal = signal;
      await firstGate.promise;
      return "done";
    });

    expect(coordinator.activeBinding(RUN_ID)).toMatchObject({ generation: 1 });
    expect(() => coordinator.execute(identity(), () => undefined)).toThrowError(
      expect.objectContaining({ code: "RUN_BUSY" }),
    );
    expect(
      coordinator.inFlightCancellation(
        identity({
          activeActionId: parent.actionId,
          activeActionDigest: "c".repeat(64),
        }),
      ),
    ).toBeUndefined();

    const cancellation = coordinator.inFlightCancellation(
      identity({
        activeActionId: parent.actionId,
        activeActionDigest: parent.actionDigest,
      }),
    );
    expect(cancellation).toBeDefined();
    const reason = {
      code: "ICARUS_BROWSER_ACTION_CANCEL" as const,
      actionId: "33333333-3333-4333-8333-333333333333",
      actor: "fixed operator",
    };
    cancellation?.abort(reason);
    expect(firstSignal?.aborted).toBe(true);
    expect(firstSignal?.reason).toEqual(reason);

    firstGate.release();
    await expect(first).resolves.toBe("done");
    expect(coordinator.activeBinding(RUN_ID)).toBeNull();

    const second = coordinator.execute(identity(), ({ binding }) => binding.generation);
    await expect(second).resolves.toBe(2);
  });

  test("marks resumptions as candidates while recovery actions remain non-cancellable", async () => {
    const coordinator = new BrowserActionCoordinator();
    const resume = coordinator.execute(
      identity({ kind: "run.resume", expectedState: "failed" }),
      ({ binding }) => binding.cancellable,
    );
    await expect(resume).resolves.toBe(true);

    const reviewReject = coordinator.execute(
      identity({
        actionId: "33333333-3333-4333-8333-333333333333",
        kind: "review.reject",
        expectedState: "awaiting_review",
        subjectDigest: "b".repeat(64),
      }),
      ({ binding }) => binding.cancellable,
    );
    await expect(reviewReject).resolves.toBe(false);
  });

  test("closes admission synchronously and drains exact active promises without aborting", async () => {
    const coordinator = new BrowserActionCoordinator();
    const workGate = gate();
    let signal: AbortSignal | undefined;
    const work = coordinator.execute(identity(), async (registration) => {
      signal = registration.signal;
      await workGate.promise;
    });
    const drain = coordinator.drain();

    expect(coordinator.state).toBe("draining");
    expect(signal?.aborted).toBe(false);
    expect(() => coordinator.track(() => undefined)).toThrowError(
      expect.objectContaining({ code: "SHUTTING_DOWN" }),
    );
    workGate.release();
    await work;
    await expect(drain).resolves.toBeUndefined();
    expect(coordinator.state).toBe("closed");
    expect(signal?.aborted).toBe(false);
  });

  test("uses one bounded process generation without retaining completed run identities", async () => {
    const coordinator = new BrowserActionCoordinator();
    const runIds = [
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
      "55555555-5555-4555-8555-555555555555",
    ] as const;
    const actionIds = [
      "22222222-2222-4222-8222-222222222222",
      "44444444-4444-4444-8444-444444444444",
      "66666666-6666-4666-8666-666666666666",
    ] as const;
    const generations: number[] = [];

    for (const [index, runId] of runIds.entries()) {
      generations.push(
        await coordinator.execute(
          identity({ runId, actionId: actionIds[index] as string }),
          ({ binding }) => binding.generation,
        ),
      );
      expect(coordinator.activeCount).toBe(0);
      expect(coordinator.activeBinding(runId)).toBeNull();
    }

    expect(generations).toEqual([1, 2, 3]);
    for (const runId of runIds) expect(coordinator.activeBinding(runId)).toBeNull();
  });
});
