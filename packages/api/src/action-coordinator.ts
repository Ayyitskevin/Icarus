import {
  type ActiveBrowserActionBinding,
  type BrowserActionAbortReason,
  type BrowserActionCancellationTarget,
  type BrowserActionIdentity,
  IcarusError,
} from "@icarus/core";

export type ActionCoordinatorState = "accepting" | "draining" | "closed";

export type ActionSettlement =
  | { readonly status: "fulfilled" }
  | { readonly status: "rejected"; readonly error: unknown };

export interface ActionRegistration {
  readonly id: number;
  readonly settlement: Promise<ActionSettlement>;
  finish(): void;
  fail(error: unknown): void;
}

export interface ActionSettlementFailure {
  readonly registrationId: number;
  readonly error: unknown;
}

export type ActionDrainResult =
  | {
      readonly status: "clean";
      readonly clean: true;
      readonly tracked: number;
      readonly failures: readonly [];
    }
  | {
      readonly status: "settlement_failed";
      readonly clean: false;
      readonly tracked: number;
      readonly failures: readonly ActionSettlementFailure[];
    };

interface ActiveSettlement {
  readonly id: number;
  readonly settlement: Promise<ActionSettlement>;
}

const SHUTTING_DOWN_MESSAGE = "The local workspace is shutting down";

/**
 * Process-local admission and drain coordination.
 *
 * Registration is synchronous, so a request either becomes part of the drain
 * set before its first asynchronous effect or fails before that effect starts.
 * Draining never aborts registered work: deliberate cancellation belongs to
 * the action authority layer, not process shutdown.
 */
export class ActionCoordinator {
  #state: ActionCoordinatorState = "accepting";
  #nextRegistrationId = 1;
  readonly #active = new Map<number, ActiveSettlement>();
  #drainPromise: Promise<ActionDrainResult> | undefined;

  get state(): ActionCoordinatorState {
    return this.#state;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  register(): ActionRegistration {
    if (this.#state !== "accepting") {
      throw new IcarusError("SHUTTING_DOWN", SHUTTING_DOWN_MESSAGE);
    }

    const id = this.#nextRegistrationId;
    this.#nextRegistrationId += 1;
    let resolveSettlement: (settlement: ActionSettlement) => void = () => undefined;
    const settlement = new Promise<ActionSettlement>((resolve) => {
      resolveSettlement = resolve;
    });
    this.#active.set(id, { id, settlement });

    let finalized = false;
    const finalize = (result: ActionSettlement): void => {
      if (finalized) return;
      finalized = true;
      this.#active.delete(id);
      resolveSettlement(result);
    };

    return {
      id,
      settlement,
      finish: () => finalize({ status: "fulfilled" }),
      fail: (error) => finalize({ status: "rejected", error }),
    };
  }

  /**
   * Registers before invoking `work`, preserves the work promise's value or
   * rejection for its caller, and separately records settlement for shutdown.
   */
  track<T>(work: () => T | PromiseLike<T>): Promise<T> {
    const registration = this.register();
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(work());
    } catch (error) {
      registration.fail(error);
      return Promise.reject(error);
    }
    return promise.then(
      (value) => {
        registration.finish();
        return value;
      },
      (error: unknown) => {
        registration.fail(error);
        throw error;
      },
    );
  }

  /**
   * Closes admission synchronously and returns one memoized promise for the
   * exact set that was active at that boundary.
   */
  drain(): Promise<ActionDrainResult> {
    if (this.#drainPromise !== undefined) return this.#drainPromise;

    this.#state = "draining";
    const active = [...this.#active.values()];
    this.#drainPromise = Promise.all(active.map(({ settlement }) => settlement)).then(
      (settlements) => {
        const failures: ActionSettlementFailure[] = [];
        for (const [index, settlement] of settlements.entries()) {
          if (settlement.status === "rejected") {
            failures.push({
              registrationId: active[index]?.id ?? 0,
              error: settlement.error,
            });
          }
        }
        this.#state = "closed";
        if (failures.length === 0) {
          return Object.freeze({
            status: "clean",
            clean: true,
            tracked: active.length,
            failures: Object.freeze([]),
          }) as ActionDrainResult;
        }
        return Object.freeze({
          status: "settlement_failed",
          clean: false,
          tracked: active.length,
          failures: Object.freeze(failures),
        }) as ActionDrainResult;
      },
    );
    return this.#drainPromise;
  }
}

export type BrowserActionCoordinatorState = "accepting" | "draining" | "closed";

export interface BrowserActionExecutionRegistration {
  readonly binding: ActiveBrowserActionBinding;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

interface ActiveBrowserAction {
  readonly binding: ActiveBrowserActionBinding;
  readonly controller: AbortController;
}

function isCancellableBrowserAction(identity: BrowserActionIdentity): boolean {
  return (
    identity.kind === "egress.approve" ||
    identity.kind === "plan.approve" ||
    identity.kind === "review.approve" ||
    identity.kind === "run.resume"
  );
}

/**
 * Process-local coordination for the one browser action that may own a run.
 *
 * This map is deliberately not recovery evidence. Durable admission and every
 * descriptor comparison remain in core; the coordinator only prevents a
 * same-process lease wait and carries the deliberate cancel signal.
 */
export class BrowserActionCoordinator {
  #state: BrowserActionCoordinatorState = "accepting";
  readonly #active = new Map<string, ActiveBrowserAction>();
  #nextGeneration = 1;
  readonly #settlements = new Set<Promise<void>>();
  #drainPromise: Promise<void> | undefined;

  get state(): BrowserActionCoordinatorState {
    return this.#state;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  activeBinding(runId: string): ActiveBrowserActionBinding | null {
    return this.#active.get(runId)?.binding ?? null;
  }

  execute<T>(
    identity: BrowserActionIdentity,
    work: (registration: BrowserActionExecutionRegistration) => T | PromiseLike<T>,
  ): Promise<T> {
    if (this.#state !== "accepting") {
      throw new IcarusError("SHUTTING_DOWN", SHUTTING_DOWN_MESSAGE);
    }
    if (this.#active.has(identity.runId)) {
      throw new IcarusError("RUN_BUSY", "Another browser action is already executing this run");
    }

    const generation = this.#nextGeneration;
    this.#nextGeneration = generation === Number.MAX_SAFE_INTEGER ? 1 : generation + 1;
    const entry: ActiveBrowserAction = {
      binding: Object.freeze({
        actionId: identity.actionId,
        actionDigest: identity.actionDigest,
        kind: identity.kind,
        generation,
        cancellable: isCancellableBrowserAction(identity),
      }),
      controller: new AbortController(),
    };
    this.#active.set(identity.runId, entry);
    const registration: BrowserActionExecutionRegistration = {
      binding: entry.binding,
      signal: entry.controller.signal,
      isCurrent: () => this.#active.get(identity.runId) === entry,
    };

    let workPromise: Promise<T>;
    try {
      workPromise = Promise.resolve(work(registration));
    } catch (error) {
      this.#active.delete(identity.runId);
      return Promise.reject(error);
    }
    const settlement = workPromise.then(
      () => undefined,
      () => undefined,
    );
    this.#settlements.add(settlement);
    void settlement.finally(() => this.#settlements.delete(settlement));
    return workPromise.finally(() => {
      if (this.#active.get(identity.runId) === entry) {
        this.#active.delete(identity.runId);
      }
    });
  }

  track<T>(work: () => T | PromiseLike<T>): Promise<T> {
    if (this.#state !== "accepting") {
      throw new IcarusError("SHUTTING_DOWN", SHUTTING_DOWN_MESSAGE);
    }
    let workPromise: Promise<T>;
    try {
      workPromise = Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error);
    }
    const settlement = workPromise.then(
      () => undefined,
      () => undefined,
    );
    this.#settlements.add(settlement);
    void settlement.finally(() => this.#settlements.delete(settlement));
    return workPromise;
  }

  inFlightCancellation(
    identity: BrowserActionIdentity,
  ): BrowserActionCancellationTarget | undefined {
    if (
      identity.kind !== "run.cancel" ||
      identity.activeActionId === null ||
      identity.activeActionDigest === null
    ) {
      return undefined;
    }
    const entry = this.#active.get(identity.runId);
    if (
      entry === undefined ||
      !entry.binding.cancellable ||
      entry.binding.actionId !== identity.activeActionId ||
      entry.binding.actionDigest !== identity.activeActionDigest
    ) {
      return undefined;
    }
    return {
      binding: entry.binding,
      isCurrent: () => this.#active.get(identity.runId) === entry,
      abort: (reason: BrowserActionAbortReason): void => {
        if (this.#active.get(identity.runId) !== entry) {
          throw new IcarusError("COORDINATOR_CHANGED", "Browser action coordinator changed");
        }
        entry.controller.abort(reason);
      },
    };
  }

  drain(): Promise<void> {
    if (this.#drainPromise !== undefined) return this.#drainPromise;
    this.#state = "draining";
    const active = [...this.#settlements];
    this.#drainPromise = Promise.all(active).then(() => {
      this.#state = "closed";
    });
    return this.#drainPromise;
  }
}
