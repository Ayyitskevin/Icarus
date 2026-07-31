import { IcarusError } from "@icarus/core";

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
