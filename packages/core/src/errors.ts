export type ErrorDetails = Readonly<Record<string, unknown>>;

export class IcarusError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(code: string, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "IcarusError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
  details: ErrorDetails = {},
): asserts condition {
  if (!condition) {
    throw new IcarusError(code, message, details);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
