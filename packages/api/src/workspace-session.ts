import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";

import { IcarusError } from "@icarus/core";

const ORIGIN_NONCE_BYTES = 16;
const BEARER_BYTES = 32;
const CANONICAL_BEARER_LENGTH = 43;
const ACTION_SESSION_FRAGMENT = "icarus-action-session";

export const WORKSPACE_MUTATION_ACTION = "workspace.mutate";

export type WorkspaceServerMode = "mutation-capable" | "review-only";

export interface WorkspaceHostnameAddress {
  readonly address: string;
  readonly family: number;
}

export type WorkspaceHostnameLookup = (
  hostname: string,
) => Promise<readonly WorkspaceHostnameAddress[]>;

export interface WorkspaceSession {
  readonly mode: WorkspaceServerMode;
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
  readonly hostname: string;
  readonly authority: string;
  readonly url: string;
  readonly launchUrl: string;

  constructor(mode: WorkspaceServerMode, port: number, mutationHostname?: string) {
    this.mode = mode;
    this.hostname =
      mode === "mutation-capable"
        ? (mutationHostname ?? createWorkspaceMutationHostname())
        : "127.0.0.1";
    this.authority = `${this.hostname}:${port}`;
    this.url = `http://${this.authority}`;
    if (mode === "mutation-capable") {
      this.#expectedBearer = randomBytes(BEARER_BYTES);
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
      throw new IcarusError("WORKSPACE_REVIEW_ONLY", "This stable-origin workspace is review-only");
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

export function createWorkspaceMutationHostname(): string {
  return `${randomBytes(ORIGIN_NONCE_BYTES).toString("hex")}.localhost`;
}

async function lookupWorkspaceHostname(
  hostname: string,
): Promise<readonly WorkspaceHostnameAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

/**
 * A mutation origin is usable only when every resolved address is loopback and
 * the IPv4 address to which the server is bound is among the answers.
 */
export async function workspaceHostnameResolvesToBoundLoopback(
  hostname: string,
  resolveHostname: WorkspaceHostnameLookup = lookupWorkspaceHostname,
): Promise<boolean> {
  if (!/^[a-f0-9]{32}\.localhost$/.test(hostname)) return false;
  try {
    const addresses = await resolveHostname(hostname);
    return (
      addresses.length > 0 &&
      addresses.some(({ address, family }) => family === 4 && address === "127.0.0.1") &&
      addresses.every(
        ({ address, family }) =>
          (family === 4 && address === "127.0.0.1") ||
          (family === 6 && address.toLowerCase() === "::1"),
      )
    );
  } catch {
    return false;
  }
}

function createWorkspaceSession(
  mode: WorkspaceServerMode,
  port: number,
  mutationHostname?: string,
): WorkspaceSession {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new IcarusError("INVALID_PORT", "Workspace session port is invalid");
  }
  if (
    (mode === "mutation-capable" &&
      (mutationHostname === undefined || !/^[a-f0-9]{32}\.localhost$/.test(mutationHostname))) ||
    (mode === "review-only" && mutationHostname !== undefined)
  ) {
    throw new IcarusError("INVALID_ORIGIN", "Workspace mutation origin is invalid");
  }
  return new BoundWorkspaceSession(mode, port, mutationHostname);
}

export async function createResolvedWorkspaceSession(
  requestedMode: WorkspaceServerMode,
  port: number,
  resolveHostname: WorkspaceHostnameLookup = lookupWorkspaceHostname,
): Promise<WorkspaceSession> {
  if (requestedMode === "review-only") {
    return createWorkspaceSession("review-only", port);
  }
  const hostname = createWorkspaceMutationHostname();
  if (!(await workspaceHostnameResolvesToBoundLoopback(hostname, resolveHostname))) {
    return createWorkspaceSession("review-only", port);
  }
  return createWorkspaceSession("mutation-capable", port, hostname);
}
