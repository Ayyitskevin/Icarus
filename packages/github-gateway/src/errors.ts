export type GithubGatewayErrorDetails = Readonly<Record<string, unknown>>;

/**
 * Structurally compatible with `IcarusError` (`code` plus `details`) so a
 * consumer can map it without this package depending on `@icarus/core`. The
 * dependency direction matters: the landing coordinator lives in core and must
 * be able to import this gateway, so this package imports nothing from core.
 *
 * Messages are host-authored constants. Upstream response bytes never reach a
 * message or a detail value; correlation uses a digest instead.
 */
export class GithubGatewayError extends Error {
  readonly code: string;
  readonly details: GithubGatewayErrorDetails;

  constructor(code: string, message: string, details: GithubGatewayErrorDetails = {}) {
    super(message);
    this.name = "GithubGatewayError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
  details: GithubGatewayErrorDetails = {},
): asserts condition {
  if (!condition) {
    throw new GithubGatewayError(code, message, details);
  }
}
