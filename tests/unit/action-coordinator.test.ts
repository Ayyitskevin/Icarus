import { describe, expect, test } from "vitest";

import { ActionCoordinator } from "../../packages/api/src/action-coordinator.js";

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function createGate(): Gate {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("action shutdown coordination", () => {
  test("moves accepting to draining to closed and memoizes one drain promise", async () => {
    const coordinator = new ActionCoordinator();
    const registration = coordinator.register();

    expect(coordinator.state).toBe("accepting");
    expect(coordinator.activeCount).toBe(1);

    const first = coordinator.drain();
    const second = coordinator.drain();
    expect(first).toBe(second);
    expect(coordinator.state).toBe("draining");

    let drained = false;
    void first.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    registration.finish();
    await expect(registration.settlement).resolves.toEqual({ status: "fulfilled" });
    await expect(first).resolves.toEqual({
      status: "clean",
      clean: true,
      tracked: 1,
      failures: [],
    });
    expect(coordinator.state).toBe("closed");
    expect(coordinator.activeCount).toBe(0);
  });

  test("rejects registration after draining starts with one bounded error", async () => {
    const coordinator = new ActionCoordinator();
    const drain = coordinator.drain();

    expect(() => coordinator.register()).toThrowError(
      expect.objectContaining({
        name: "IcarusError",
        code: "SHUTTING_DOWN",
        message: "The local workspace is shutting down",
        details: {},
      }),
    );
    expect(Buffer.byteLength("The local workspace is shutting down", "utf8")).toBeLessThan(64);
    await drain;
    expect(() => coordinator.register()).toThrowError(
      expect.objectContaining({ code: "SHUTTING_DOWN", details: {} }),
    );
  });

  test("waits for every active settlement and reports rejection identities", async () => {
    const coordinator = new ActionCoordinator();
    const first = coordinator.register();
    const second = coordinator.register();
    const failure = new Error("durable settlement failed");
    const drain = coordinator.drain();

    first.fail(failure);
    await Promise.resolve();
    expect(coordinator.state).toBe("draining");

    second.finish();
    await expect(drain).resolves.toEqual({
      status: "settlement_failed",
      clean: false,
      tracked: 2,
      failures: [{ registrationId: first.id, error: failure }],
    });
    expect(coordinator.state).toBe("closed");
  });

  test("preserves tracked work rejection for both its caller and the drain result", async () => {
    const coordinator = new ActionCoordinator();
    const gate = createGate();
    const failure = new Error("route failed after admission");
    let started = false;
    const work = coordinator.track(async () => {
      started = true;
      await gate.promise;
      throw failure;
    });
    const callerResult = work.catch((error: unknown) => error);

    expect(started).toBe(true);
    const drain = coordinator.drain();
    gate.release();

    await expect(callerResult).resolves.toBe(failure);
    const result = await drain;
    expect(result).toMatchObject({
      status: "settlement_failed",
      clean: false,
      tracked: 1,
    });
    expect(result.failures).toEqual([{ registrationId: 1, error: failure }]);
  });

  test("does not abort tracked work when draining begins", async () => {
    const coordinator = new ActionCoordinator();
    const gate = createGate();
    const controller = new AbortController();
    const work = coordinator.track(async () => {
      await gate.promise;
      return "settled";
    });

    const drain = coordinator.drain();
    expect(controller.signal.aborted).toBe(false);
    expect(coordinator.state).toBe("draining");

    gate.release();
    await expect(work).resolves.toBe("settled");
    await expect(drain).resolves.toMatchObject({ clean: true, tracked: 1 });
    expect(controller.signal.aborted).toBe(false);
  });

  test("uses the first finalizer exactly once", async () => {
    const coordinator = new ActionCoordinator();
    const registration = coordinator.register();
    const ignoredFailure = new Error("must not replace success");
    const drain = coordinator.drain();

    registration.finish();
    registration.fail(ignoredFailure);
    registration.finish();

    await expect(registration.settlement).resolves.toEqual({ status: "fulfilled" });
    await expect(drain).resolves.toMatchObject({ clean: true, tracked: 1 });
  });

  test("does not retain a completed registration in a later drain", async () => {
    const coordinator = new ActionCoordinator();
    const registration = coordinator.register();
    const failure = new Error("already returned to its caller");

    registration.fail(failure);
    await expect(registration.settlement).resolves.toEqual({
      status: "rejected",
      error: failure,
    });
    expect(coordinator.activeCount).toBe(0);
    await expect(coordinator.drain()).resolves.toEqual({
      status: "clean",
      clean: true,
      tracked: 0,
      failures: [],
    });
  });
});
