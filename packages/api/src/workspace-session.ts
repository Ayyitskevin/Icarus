import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { IcarusError } from "@icarus/core";

const FRESH_LOOPBACK_OCTETS = 3;
const BEARER_BYTES = 32;
const CANONICAL_BEARER_LENGTH = 43;
const ACTION_SESSION_FRAGMENT = "icarus-action-session";
export const REVIEW_ONLY_WORKSPACE_HOST = "127.0.0.1";

export const WORKSPACE_MUTATION_ACTION = "workspace.mutate";

export type WorkspaceServerMode = "mutation-capable" | "review-only";
export type WorkspaceReviewOnlyReason = "explicit-port" | "fresh-loopback-unavailable";
export type WorkspaceRandomBytes = (size: number) => Uint8Array;

export interface WorkspaceSession {
  readonly mode: WorkspaceServerMode;
  readonly reviewOnlyReason: WorkspaceReviewOnlyReason | null;
  readonly hostname: string;
  readonly authority: string;
  readonly url: string;
  readonly launchUrl: string;
  assertExactHost(request: IncomingMessage): void;
  assertOptionalExactOrigin(request: IncomingMessage): void;
  assertProtectedMutation(request: IncomingMessage): void;
}

function rawHeaderValues(request: IncomingMessage, expectedName: string): readonly string[] {
  const values: string[] = [];
  const normalizedName = expectedName.toLowerCase();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if ((request.rawHeaders[index] ?? "").toLowerCase() === normalizedName) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function actionSessionRequired(request: IncomingMessage): never {
  request.resume();
  throw new IcarusError(
    "ACTION_SESSION_REQUIRED",
    "A valid workspace action session is required for this mutation",
  );
}

/**
 * Compare one exact canonical Bearer value while keeping the secret comparison
 * fixed-width even when attacker-controlled syntax or encoding is malformed.
 */
export function matchesWorkspaceBearer(expectedBearer: Uint8Array, authorization: string): boolean {
  if (expectedBearer.byteLength !== BEARER_BYTES) {
    throw new IcarusError("INVALID_ACTION_SESSION", "Workspace action session is invalid");
  }

  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  const encoded = match?.[1] ?? "";
  let decoded = Buffer.alloc(0);
  try {
    decoded = Buffer.from(encoded, "base64url");
  } catch {
    decoded = Buffer.alloc(0);
  }

  const candidate = Buffer.alloc(BEARER_BYTES);
  if (decoded.byteLength === BEARER_BYTES) {
    decoded.copy(candidate);
  }
  const equal = timingSafeEqual(Buffer.from(expectedBearer), candidate);
  const canonical =
    match !== null &&
    encoded.length === CANONICAL_BEARER_LENGTH &&
    decoded.byteLength === BEARER_BYTES &&
    decoded.toString("base64url") === encoded;
  return canonical && equal;
}

class BoundWorkspaceSession implements WorkspaceSession {
  readonly #expectedBearer: Buffer | null;
  readonly mode: WorkspaceServerMode;
  readonly reviewOnlyReason: WorkspaceReviewOnlyReason | null;
  readonly hostname: string;
  readonly authority: string;
  readonly url: string;
  readonly launchUrl: string;

  constructor(
    mode: WorkspaceServerMode,
    port: number,
    hostname: string,
    reviewOnlyReason: WorkspaceReviewOnlyReason | null,
    random: WorkspaceRandomBytes,
  ) {
    this.mode = mode;
    this.reviewOnlyReason = reviewOnlyReason;
    this.hostname = hostname;
    this.authority = `${this.hostname}:${port}`;
    this.url = `http://${this.authority}`;
    if (mode === "mutation-capable") {
      const bearer = Buffer.from(random(BEARER_BYTES));
      if (bearer.byteLength !== BEARER_BYTES) {
        throw new IcarusError("INVALID_ACTION_SESSION", "Workspace action session is invalid");
      }
      this.#expectedBearer = bearer;
      this.launchUrl = `${this.url}/#${ACTION_SESSION_FRAGMENT}=${this.#expectedBearer.toString(
        "base64url",
      )}`;
    } else {
      this.#expectedBearer = null;
      this.launchUrl = this.url;
    }
  }

  assertExactHost(request: IncomingMessage): void {
    const values = rawHeaderValues(request, "host");
    if (values.length !== 1 || values[0] !== this.authority) {
      throw new IcarusError("INVALID_HOST", "The workspace Host header is invalid");
    }
  }

  assertOptionalExactOrigin(request: IncomingMessage): void {
    const values = rawHeaderValues(request, "origin");
    if (values.length === 0) return;
    if (values.length !== 1 || values[0] !== this.url) {
      throw new IcarusError("INVALID_ORIGIN", "The request Origin is invalid");
    }
  }

  assertProtectedMutation(request: IncomingMessage): void {
    if (this.mode === "review-only" || this.#expectedBearer === null) {
      request.resume();
      throw new IcarusError("WORKSPACE_REVIEW_ONLY", "This workspace session is review-only");
    }

    const authorizationValues = rawHeaderValues(request, "authorization");
    const authorization = authorizationValues.length === 1 ? (authorizationValues[0] ?? "") : "";
    const authorized = matchesWorkspaceBearer(this.#expectedBearer, authorization);
    if (authorizationValues.length !== 1 || !authorized) {
      actionSessionRequired(request);
    }

    const originValues = rawHeaderValues(request, "origin");
    if (originValues.length !== 1 || originValues[0] !== this.url) {
      request.resume();
      throw new IcarusError(
        "INVALID_ORIGIN",
        "Mutation requests require the exact workspace Origin",
      );
    }

    const contentTypeValues = rawHeaderValues(request, "content-type");
    if (contentTypeValues.length !== 1 || contentTypeValues[0] !== "application/json") {
      request.resume();
      throw new IcarusError("UNSUPPORTED_MEDIA_TYPE", "Mutation requests require application/json");
    }

    const actionValues = rawHeaderValues(request, "x-icarus-action");
    if (actionValues.length !== 1 || actionValues[0] !== WORKSPACE_MUTATION_ACTION) {
      request.resume();
      throw new IcarusError(
        "INVALID_REQUEST",
        "Mutation requests require the workspace.mutate action header",
      );
    }
  }
}

export function createWorkspaceMutationHostname(
  random: WorkspaceRandomBytes = randomBytes,
): string {
  const octets: number[] = [];
  while (octets.length < FRESH_LOOPBACK_OCTETS) {
    const requested = FRESH_LOOPBACK_OCTETS - octets.length;
    const bytes = random(requested);
    if (bytes.byteLength !== requested) {
      throw new IcarusError("INVALID_ORIGIN", "Workspace mutation entropy source is invalid");
    }
    for (const byte of bytes) {
      // Avoid subnet/network edge spellings that platform stacks sometimes
      // special-case while retaining almost the full 127/8 address space.
      if (byte > 0 && byte < 255) octets.push(byte);
    }
  }
  return `127.${octets.join(".")}`;
}

/**
 * Accept only one canonical, non-stable IPv4 address from 127/8. Restricting
 * every random octet to 1..254 avoids alternate numeric spellings and
 * platform-specific network/broadcast edge cases.
 */
export function isFreshWorkspaceLoopbackHostname(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.slice(1).every((octet) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 1 && value <= 254;
  });
}

export function createBoundWorkspaceSession(
  mode: WorkspaceServerMode,
  port: number,
  boundHostname: string,
  reviewOnlyReason: WorkspaceReviewOnlyReason | null = mode === "review-only"
    ? "explicit-port"
    : null,
  random: WorkspaceRandomBytes = randomBytes,
): WorkspaceSession {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new IcarusError("INVALID_PORT", "Workspace session port is invalid");
  }
  if (
    (mode === "mutation-capable" && !isFreshWorkspaceLoopbackHostname(boundHostname)) ||
    (mode === "review-only" && boundHostname !== REVIEW_ONLY_WORKSPACE_HOST) ||
    (mode === "mutation-capable" && reviewOnlyReason !== null) ||
    (mode === "review-only" && reviewOnlyReason === null)
  ) {
    throw new IcarusError("INVALID_ORIGIN", "Workspace mutation origin is invalid");
  }
  return new BoundWorkspaceSession(mode, port, boundHostname, reviewOnlyReason, random);
}
