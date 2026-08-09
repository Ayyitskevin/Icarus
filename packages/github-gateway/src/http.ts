import { createHash } from "node:crypto";

import { GithubGatewayError, invariant } from "./errors.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * The only HTTP methods this gateway can emit. `PUT`, `PATCH`, and `DELETE`
 * appear nowhere in this package, so reference updates, force updates, merges,
 * and deletions are not expressible rather than merely unused.
 */
export type GithubHttpMethod = "GET" | "POST";

export interface GithubHttpResponse {
  readonly status: number;
  readonly value: unknown;
  /** SHA-256 of the exact response bytes, for evidence correlation. */
  readonly bodySha256: string;
  /**
   * Whether GitHub signalled a further page via `Link: …rel="next"`. This is
   * the real truncation signal; a full page is only a hint. Reduced to a
   * boolean, so no upstream text is carried.
   */
  readonly hasNextPage: boolean;
  /**
   * GitHub's throttling signals, reduced to bounded non-negative integers. A
   * refusal that is only a rate limit is recoverable by waiting, while an
   * ordinary HTTP failure is not, and the coordinator cannot tell them apart
   * from a status code alone: a secondary limit is reported as 403. Header text
   * is never carried; an unparsable or out-of-range value becomes null.
   */
  readonly throttle: GithubThrottleSignals;
  readonly latencyMs: number;
}

export interface GithubThrottleSignals {
  /** Seconds GitHub asked the caller to wait, from `Retry-After`. */
  readonly retryAfterSeconds: number | null;
  /** Requests left in the current window, from `X-RateLimit-Remaining`. */
  readonly remaining: number | null;
}

const MAX_THROTTLE_SECONDS = 86_400;
const MAX_THROTTLE_REMAINING = 1_000_000;

/**
 * Parses one header into a bounded non-negative integer. Anything else — text,
 * a float, a negative, an out-of-range value, a missing header — is null, so no
 * upstream string can reach an error detail through this path.
 */
function boundedHeaderInteger(value: string | null, ceiling: number): number | null {
  if (value === null || !/^\d{1,9}$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= ceiling ? parsed : null;
}

export interface GithubRequest {
  readonly method: GithubHttpMethod;
  readonly url: URL;
  readonly body: string | undefined;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  /**
   * Whether this request can change remote state. An interruption after a
   * mutating request is dispatched is reported as `GITHUB_OUTCOME_AMBIGUOUS`
   * per ADR 0027: the host cannot know whether GitHub applied the effect, and
   * must never infer failure from an absent response.
   */
  readonly mutating: boolean;
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number.parseInt(declaredLength, 10);
    invariant(
      Number.isSafeInteger(length) && length <= MAX_RESPONSE_BYTES,
      "GITHUB_RESPONSE_TOO_LARGE",
      "GitHub response exceeds the byte ceiling",
    );
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    invariant(
      total <= MAX_RESPONSE_BYTES,
      "GITHUB_RESPONSE_TOO_LARGE",
      "GitHub response exceeds the byte ceiling",
    );
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/**
 * Performs one bounded request. No upstream byte ever reaches an error message
 * or an error detail: failures carry the status, the operation, and a digest of
 * the response body. That keeps a hostile or accidental upstream payload out of
 * logs and evidence without relying on redaction after the fact.
 */
export async function sendGithubRequest(
  request: GithubRequest,
  headers: Readonly<Record<string, string>>,
  fetchImplementation: typeof fetch,
): Promise<GithubHttpResponse> {
  if (request.signal?.aborted === true) {
    throw new GithubGatewayError(
      "GITHUB_CANCELLED",
      "GitHub request was cancelled before it started",
    );
  }
  if (request.body !== undefined) {
    invariant(
      Buffer.byteLength(request.body, "utf8") <= MAX_REQUEST_BYTES,
      "GITHUB_REQUEST_TOO_LARGE",
      "GitHub request body exceeds the byte ceiling",
    );
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("GitHub request timed out"));
  }, request.timeoutMs);
  timeout.unref();
  const startedAt = performance.now();
  try {
    let response: Response;
    try {
      response = await fetchImplementation(request.url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        // A redirect is never followed: it could move a credentialed request to
        // an unpinned origin.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      // Classify before reporting. A dispatched mutating request that was
      // interrupted has an unknown remote outcome; saying "failed" would be a
      // claim the host cannot support.
      throw interrupted(request, timedOut, controller, error);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBody(response);
    } catch (error) {
      if (error instanceof GithubGatewayError) {
        throw error;
      }
      throw interrupted(request, timedOut, controller, error);
    }
    const latencyMs = performance.now() - startedAt;
    const bodySha256 = createHash("sha256").update(bytes).digest("hex");
    invariant(
      response.status !== 0 && (response.status < 300 || response.status >= 400),
      "GITHUB_REDIRECT_DENIED",
      "GitHub returned a redirect or opaque response, which is never followed",
      { status: response.status, bodySha256 },
    );
    const text = new TextDecoder().decode(bytes);
    let value: unknown = null;
    if (text.length > 0) {
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new GithubGatewayError("GITHUB_PROTOCOL_ERROR", "GitHub response is not valid JSON", {
          status: response.status,
          bodySha256,
        });
      }
    }
    const link = response.headers.get("link") ?? "";
    return {
      status: response.status,
      value,
      bodySha256,
      hasNextPage: /\brel="?next"?/.test(link),
      throttle: {
        retryAfterSeconds: boundedHeaderInteger(
          response.headers.get("retry-after"),
          MAX_THROTTLE_SECONDS,
        ),
        remaining: boundedHeaderInteger(
          response.headers.get("x-ratelimit-remaining"),
          MAX_THROTTLE_REMAINING,
        ),
      },
      latencyMs,
    };
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * `Error.prototype.name` is writable, so it is an untrusted string even for a
 * locally constructed error. Only a short bare identifier is reported; anything
 * else becomes a fixed constant, keeping `details.cause` host-authored.
 */
function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(name) ? name : "UnknownError";
}

/**
 * Classifies an interruption. A dispatched mutating request has an unknown
 * remote outcome, and ADR 0027 forbids inferring failure from an absent
 * response, so it is reported as ambiguous rather than failed.
 */
function interrupted(
  request: GithubRequest,
  timedOut: boolean,
  controller: AbortController,
  error: unknown,
): GithubGatewayError {
  const reason = timedOut ? "timeout" : controller.signal.aborted ? "cancelled" : "transport";
  if (request.mutating) {
    return new GithubGatewayError(
      "GITHUB_OUTCOME_AMBIGUOUS",
      "A dispatched GitHub mutation was interrupted and its remote outcome is unknown",
      { reason, cause: errorName(error) },
    );
  }
  return new GithubGatewayError(
    reason === "timeout"
      ? "GITHUB_TIMEOUT"
      : reason === "cancelled"
        ? "GITHUB_CANCELLED"
        : "GITHUB_TRANSPORT_ERROR",
    "A GitHub read did not complete",
    // `cause` carries no upstream bytes: it is the local transport error name.
    { reason, cause: errorName(error) },
  );
}
