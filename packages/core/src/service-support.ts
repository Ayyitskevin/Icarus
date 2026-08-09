import { errorMessage, IcarusError } from "./errors.js";
import { sanitizeText } from "./redaction.js";

/**
 * Small helpers shared by the service and the landing coordinator. They live
 * outside both so that neither has to import the other: the coordinator was
 * extracted from the service, and a helper left behind in `service.ts` would
 * have forced a cycle.
 */

/**
 * Composes a caller's cancellation with a hard runtime ceiling, so a bounded
 * operation cannot outlive its ceiling because the caller never aborted.
 */
export function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * Normalizes an unknown thrown value into an `IcarusError`, redacting the
 * message of anything that was not already one.
 */
export function asIcarusError(error: unknown, fallbackCode: string): IcarusError {
  if (error instanceof IcarusError) {
    return error;
  }
  return new IcarusError(fallbackCode, sanitizeText(errorMessage(error)));
}
