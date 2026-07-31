import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  assertRegistrationStateSeparation,
  createProviderConfig,
  DEFAULT_CEILING,
  DEFAULT_SANDBOX_LIMITS,
  IcarusError,
  type IcarusRuntime,
  parseProviderBaseUrl,
} from "@icarus/core";

import { ActionCoordinator } from "./action-coordinator.js";
import {
  contextPreviewRequest,
  projectRequest,
  runDraftRequest,
  runEventHistoryQuery,
  runEventsQuery,
  runVerificationAttemptsQuery,
  workspaceProjectPageQuery,
  workspaceRunPageQuery,
} from "./contracts.js";
import {
  presentProject,
  presentRepositoryStatus,
  presentRun,
  presentRunEventHistoryPage,
  presentRunEventPage,
  presentRunVerificationAttempts,
  presentWorkspaceProjectPage,
  presentWorkspaceRunPage,
} from "./present.js";
import { parseStrictJson } from "./strict-json.js";
import {
  createBoundWorkspaceSession,
  createWorkspaceMutationHostname,
  isWorkspaceMutationHostname,
  REVIEW_ONLY_WORKSPACE_HOST,
  type WorkspaceReviewOnlyReason,
  type WorkspaceServerMode,
  type WorkspaceSession,
} from "./workspace-session.js";

const MAX_BODY_BYTES = 64 * 1024;
export const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_MESSAGE_BYTES = 4 * 1024;
const API_PREFIX = "/api/";
const INTERNAL_ERROR_RESPONSE =
  '{"error":{"code":"INTERNAL_ERROR","message":"The local workspace request failed."}}\n';

export interface WorkspaceServerOptions {
  readonly runtime: IcarusRuntime;
  readonly stateRoot: string;
  readonly workspaceDist: string;
}

export interface StartedWorkspaceServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly launchUrl: string;
  readonly mode: WorkspaceServerMode;
  readonly reviewOnlyReason: WorkspaceReviewOnlyReason | null;
  close(): Promise<void>;
}

export interface WorkspaceServerBindingHooks {
  readonly createMutationHostname: () => string;
  readonly listen: (server: Server, port: number, host: string) => Promise<void>;
}

function headers(contentType: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'none'; manifest-src 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

export function serializeJsonResponse(value: unknown): string {
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_JSON_RESPONSE_BYTES) {
    throw new IcarusError(
      "RESPONSE_TOO_LARGE",
      "The local workspace response exceeds the 8 MiB JSON limit",
    );
  }
  return body;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = serializeJsonResponse(value);
  response.writeHead(status, headers("application/json; charset=utf-8"));
  response.end(body);
}

function internalError(response: ServerResponse): void {
  response.writeHead(500, headers("application/json; charset=utf-8"));
  response.end(INTERNAL_ERROR_RESPONSE);
}

function errorStatus(error: IcarusError): number {
  if (error.code === "ACTION_SESSION_REQUIRED") return 401;
  if (error.code === "WORKSPACE_REVIEW_ONLY") return 403;
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "SHUTTING_DOWN") return 503;
  if (error.code === "REQUEST_TOO_LARGE") return 413;
  if (error.code === "RESPONSE_TOO_LARGE") return 500;
  if (error.code === "UNSUPPORTED_MEDIA_TYPE") return 415;
  if (
    error.code.includes("CONFLICT") ||
    error.code === "PROJECT_RUN_CONFLICT" ||
    error.code === "RUN_BUSY"
  ) {
    return 409;
  }
  if (
    error.code.startsWith("INVALID") ||
    error.code.includes("DENIED") ||
    error.code.includes("UNSAFE") ||
    error.code.includes("SECRET") ||
    error.code.includes("OVERLAP") ||
    error.code.includes("UNCONFIGURED") ||
    error.code.includes("UNSUPPORTED") ||
    error.code.includes("REQUIRED")
  ) {
    return 422;
  }
  return 400;
}

function asTrustedIcarusError(error: unknown): IcarusError | null {
  if (error instanceof IcarusError) return error;
  if (!(error instanceof Error)) return null;
  const candidate = error as Error & {
    readonly code?: unknown;
    readonly details?: unknown;
  };
  if (
    candidate.name === "IcarusError" &&
    typeof candidate.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,127}$/.test(candidate.code) &&
    typeof candidate.details === "object" &&
    candidate.details !== null &&
    !Array.isArray(candidate.details)
  ) {
    return candidate as unknown as IcarusError;
  }
  return null;
}

function safeError(error: unknown): { readonly status: number; readonly body: unknown } {
  const trusted = asTrustedIcarusError(error);
  if (trusted === null) {
    return {
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "The local workspace request failed." } },
    };
  }
  const runId = trusted.details.runId;
  const safeRunId =
    typeof runId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId)
      ? runId
      : undefined;
  const message =
    Buffer.byteLength(trusted.message, "utf8") <= MAX_ERROR_MESSAGE_BYTES
      ? trusted.message
      : "The local workspace request failed with an oversized error message.";
  return {
    status: errorStatus(trusted),
    body: {
      error: {
        code: trusted.code,
        message,
        ...(safeRunId === undefined ? {} : { runId: safeRunId }),
      },
    },
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") {
    throw new IcarusError("UNSUPPORTED_MEDIA_TYPE", "Mutation requests require application/json");
  }
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_BODY_BYTES) {
      request.resume();
      throw new IcarusError("REQUEST_TOO_LARGE", "Request body exceeds 64 KiB");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) {
      request.resume();
      throw new IcarusError("REQUEST_TOO_LARGE", "Request body exceeds 64 KiB");
    }
    chunks.push(bytes);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new IcarusError("INVALID_JSON", "Request body must be valid UTF-8 JSON");
  }
  return parseStrictJson(source);
}

function decodedRouteId(value: string, name: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new IcarusError("INVALID_REQUEST", `${name} is not valid URL encoding`);
  }
  if (
    decoded.length === 0 ||
    Buffer.byteLength(decoded, "utf8") > 100 ||
    decoded.includes("/") ||
    decoded.includes("\0")
  ) {
    throw new IcarusError("INVALID_REQUEST", `${name} is invalid`);
  }
  return decoded;
}

function disconnectSignal(
  request: IncomingMessage,
  response: ServerResponse,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.once("aborted", abort);
  response.once("close", abort);
  if (request.aborted || response.destroyed) {
    abort();
  }
  return {
    signal: controller.signal,
    dispose: () => {
      request.off("aborted", abort);
      response.off("close", abort);
    },
  };
}

function presentRunById(options: WorkspaceServerOptions, runId: string): Record<string, unknown> {
  const snapshot = options.runtime.service.presentationSnapshot(runId);
  const project = options.runtime.service.getProject(snapshot.run.projectId);
  return presentRun(project, snapshot);
}

function workspaceSnapshot(
  options: WorkspaceServerOptions,
  session: WorkspaceSession,
): Record<string, unknown> {
  const mutationAvailable = session.mode === "mutation-capable";
  const reviewOnlyReason =
    "This stable-origin workspace is review-only. Relaunch without an explicit port to make bounded changes.";
  return {
    capabilities: {
      server: { status: "available", binding: "loopback" },
      mutation: {
        status: mutationAvailable ? "available" : "review_only",
        reason: mutationAvailable
          ? "This fresh-origin workspace has a session-scoped browser mutation transport."
          : reviewOnlyReason,
      },
      provider: {
        status: "unconfigured",
        reason: "Enter a loopback Ollama model and endpoint for each draft.",
      },
      planning: {
        status: mutationAvailable ? "available" : "review_only",
        reason: mutationAvailable
          ? "Portable loopback planning is available; SQLite operation admission prevents concurrent provider work."
          : `Planning is disabled. ${reviewOnlyReason}`,
      },
      execution: {
        status: "unconfigured",
        reason:
          "Browser approval and command execution are intentionally unavailable in this review-only workspace slice.",
        inheritedRuntimePlatform: process.platform === "linux" ? "linux_supported" : "unsupported",
      },
    },
    projectPage: presentWorkspaceProjectPage(options.runtime.service.openWorkspaceProjectPage()),
    runPage: presentWorkspaceRunPage(options.runtime.service.openWorkspaceRunPage()),
  };
}

async function routeApi(
  options: WorkspaceServerOptions,
  session: WorkspaceSession,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  const method = request.method ?? "GET";
  if (method === "GET" && pathname === "/api/health") {
    json(response, 200, { ok: true, binding: "loopback", persistence: "sqlite" });
    return true;
  }
  if (method === "GET" && pathname === "/api/workspace") {
    json(response, 200, workspaceSnapshot(options, session));
    return true;
  }
  if (method === "GET" && pathname === "/api/projects") {
    const query = workspaceProjectPageQuery(searchParams);
    const page =
      query.kind === "new"
        ? options.runtime.service.openWorkspaceProjectPage()
        : options.runtime.service.listWorkspaceProjectPage(query.before, query.snapshot);
    json(response, 200, presentWorkspaceProjectPage(page));
    return true;
  }
  if (method === "POST" && pathname === "/api/projects") {
    const input = projectRequest(await readJson(request));
    if (options.runtime.service.findProjectByName(input.project.name) !== null) {
      throw new IcarusError("PROJECT_NAME_CONFLICT", "The project name is already registered");
    }
    const projectDefinition = {
      name: input.project.name,
      baseRef: input.project.baseRef,
      checks: input.project.checks,
      sandbox: { image: input.project.sandboxImage, ...DEFAULT_SANDBOX_LIMITS },
      ceiling: DEFAULT_CEILING,
    };
    const existingRepository = options.runtime.service.findRepositoryByName(input.repository.name);
    if (existingRepository === null) {
      await assertRegistrationStateSeparation(options.stateRoot, input.repository.path);
      const created = await options.runtime.service.registerRepositoryProject({
        repository: input.repository,
        project: projectDefinition,
      });
      json(response, 201, presentProject(created.project, created.repository));
      return true;
    }
    if (path.resolve(input.repository.path) !== existingRepository.path) {
      throw new IcarusError(
        "REPOSITORY_NAME_CONFLICT",
        "The repository name is already registered to another canonical path",
      );
    }
    const project = options.runtime.service.createProject({
      ...projectDefinition,
      repositoryName: existingRepository.name,
    });
    json(response, 201, presentProject(project, existingRepository));
    return true;
  }
  const projectContext = /^\/api\/projects\/([^/]+)\/context-preview$/.exec(pathname);
  if (method === "POST" && projectContext !== null) {
    const projectId = decodedRouteId(projectContext[1] ?? "", "project id");
    const input = contextPreviewRequest(await readJson(request));
    const preview = await options.runtime.service.previewProjectContext(projectId, input.target);
    json(response, 200, preview);
    return true;
  }
  const projectRepositoryStatus = /^\/api\/projects\/([^/]+)\/repository-status$/.exec(pathname);
  if (method === "GET" && projectRepositoryStatus !== null) {
    const projectId = decodedRouteId(projectRepositoryStatus[1] ?? "", "project id");
    const disconnect = disconnectSignal(request, response);
    try {
      const status = await options.runtime.service.getProjectRepositoryStatus(
        projectId,
        disconnect.signal,
      );
      if (!disconnect.signal.aborted && !response.destroyed) {
        json(response, 200, presentRepositoryStatus(status));
      }
    } finally {
      disconnect.dispose();
    }
    return true;
  }
  if (method === "GET" && pathname === "/api/runs") {
    const query = workspaceRunPageQuery(searchParams);
    const page =
      query.kind === "new"
        ? options.runtime.service.openWorkspaceRunPage()
        : options.runtime.service.listWorkspaceRunPage(query.before, query.snapshot);
    json(response, 200, presentWorkspaceRunPage(page));
    return true;
  }
  if (method === "POST" && pathname === "/api/runs") {
    const input = runDraftRequest(await readJson(request));
    const providerEndpoint = parseProviderBaseUrl(input.provider.baseUrl);
    if (providerEndpoint.locality !== "loopback") {
      throw new IcarusError(
        "WORKSPACE_REMOTE_PROVIDER_DENIED",
        "The local workspace slice accepts only loopback Ollama providers",
      );
    }
    const provider = createProviderConfig({
      kind: "ollama",
      model: input.provider.model,
      baseUrl: input.provider.baseUrl,
    });
    const run = options.runtime.service.createRunDraft({
      projectId: input.projectId,
      task: input.task,
      targets: input.targets,
      provider,
    });
    json(response, 201, presentRunById(options, run.id));
    return true;
  }
  const runPlan = /^\/api\/runs\/([^/]+)\/plan$/.exec(pathname);
  if (method === "POST" && runPlan !== null) {
    const runId = decodedRouteId(runPlan[1] ?? "", "run id");
    const body = await readJson(request);
    const bodyObject =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    if (bodyObject === null || Object.keys(bodyObject).length !== 0) {
      throw new IcarusError("INVALID_REQUEST", "Plan request body must be an empty object");
    }
    await options.runtime.service.planDraftRun(runId);
    json(response, 200, presentRunById(options, runId));
    return true;
  }
  const runVerificationAttempts = /^\/api\/runs\/([^/]+)\/verification-attempts$/.exec(pathname);
  const runEventHistory = /^\/api\/runs\/([^/]+)\/events\/history$/.exec(pathname);
  const runEvents = /^\/api\/runs\/([^/]+)\/events$/.exec(pathname);
  const runDetail = /^\/api\/runs\/([^/]+)$/.exec(pathname);
  if (method === "GET" && runVerificationAttempts !== null) {
    const runId = decodedRouteId(runVerificationAttempts[1] ?? "", "run id");
    const { snapshot } = runVerificationAttemptsQuery(searchParams);
    json(
      response,
      200,
      presentRunVerificationAttempts(
        options.runtime.service.getRunVerificationAttempts(runId, snapshot),
      ),
    );
    return true;
  }
  if (method === "GET" && runEventHistory !== null) {
    const runId = decodedRouteId(runEventHistory[1] ?? "", "run id");
    const { before, snapshot } = runEventHistoryQuery(searchParams);
    json(
      response,
      200,
      presentRunEventHistoryPage(
        options.runtime.service.listRunEventHistory(runId, before, snapshot),
      ),
    );
    return true;
  }
  if (method === "GET" && runEvents !== null) {
    const runId = decodedRouteId(runEvents[1] ?? "", "run id");
    const { after } = runEventsQuery(searchParams);
    json(response, 200, presentRunEventPage(options.runtime.service.listRunEvents(runId, after)));
    return true;
  }
  if (method === "GET" && runDetail !== null) {
    json(response, 200, presentRunById(options, decodedRouteId(runDetail[1] ?? "", "run id")));
    return true;
  }
  return false;
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function serveWorkspace(
  options: WorkspaceServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    json(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } });
    return;
  }
  const relative = pathname.startsWith("/assets/") ? pathname.slice(1) : "index.html";
  const root = path.resolve(options.workspaceDist);
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    json(response, 404, { error: { code: "NOT_FOUND", message: "Asset was not found" } });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    json(response, 503, {
      error: {
        code: "WORKSPACE_BUILD_MISSING",
        message: "The React workspace has not been built. Run pnpm build.",
      },
    });
    return;
  }
  response.writeHead(200, {
    ...headers(contentType(filePath)),
    ...(relative.startsWith("assets/")
      ? { "cache-control": "public, max-age=31536000, immutable" }
      : {}),
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

async function handleWorkspaceRequest(
  options: WorkspaceServerOptions,
  session: WorkspaceSession,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    session.assertExactHost(request);
    const url = new URL(request.url ?? "/", session.url);
    if (request.method === "GET" || request.method === "HEAD") {
      session.assertOptionalExactOrigin(request);
    } else {
      session.assertProtectedMutation(request);
    }
    if (url.pathname.startsWith(API_PREFIX)) {
      const handled = await routeApi(
        options,
        session,
        request,
        response,
        url.pathname,
        url.searchParams,
      );
      if (!handled) {
        json(response, 404, { error: { code: "NOT_FOUND", message: "API route was not found" } });
      }
      return;
    }
    await serveWorkspace(options, request, response, url.pathname);
  } catch (error) {
    if (response.destroyed || response.headersSent) {
      if (!response.destroyed) {
        response.end();
      }
      return;
    }
    const safe = safeError(error);
    try {
      json(response, safe.status, safe.body);
    } catch {
      if (!response.headersSent) internalError(response);
    }
  }
}

function trackShutdownResponse(
  response: ServerResponse,
  shutdownResponses: Set<Promise<void>>,
): void {
  let responseSettlement: Promise<void>;
  responseSettlement = new Promise<void>((resolve) => {
    const settle = (): void => {
      response.off("finish", settle);
      response.off("close", settle);
      resolve();
    };
    response.once("finish", settle);
    response.once("close", settle);
    if (response.writableFinished || response.destroyed) settle();
  }).finally(() => {
    shutdownResponses.delete(responseSettlement);
  });
  shutdownResponses.add(responseSettlement);
}

function workspaceRequestListener(
  options: WorkspaceServerOptions,
  session: WorkspaceSession,
  coordinator: ActionCoordinator,
  shutdownResponses: Set<Promise<void>>,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    // Track transport settlement for every accepted socket before action
    // admission. Handler completion alone does not prove that response bytes
    // reached Node's finished/closed boundary.
    trackShutdownResponse(response, shutdownResponses);
    let work: Promise<void>;
    try {
      // `track` registers synchronously before the async handler reaches its
      // first await. A request is therefore either in the fixed drain set or
      // rejected before it can read a body or call the service.
      work = coordinator.track(() => handleWorkspaceRequest(options, session, request, response));
    } catch (error) {
      const safe = safeError(error);
      try {
        json(response, safe.status, safe.body);
      } catch {
        if (!response.destroyed) response.destroy();
      }
      return;
    }
    // Node's request event does not observe returned promises. The coordinator
    // retains the rejection for shutdown; this handler only prevents an
    // unhandled rejection and closes a response whose fallback also failed.
    void work.catch(() => {
      if (!response.destroyed) response.destroy();
    });
  };
}

export async function startWorkspaceServer(
  options: WorkspaceServerOptions,
  port: number,
): Promise<StartedWorkspaceServer> {
  return startWorkspaceServerWithBindingHooks(options, port, {
    createMutationHostname: createWorkspaceMutationHostname,
    listen: listenOnExactHost,
  });
}

/** @internal Deterministic seam for exact bind and post-bind origin tests. */
export async function startWorkspaceServerWithBindingHooks(
  options: WorkspaceServerOptions,
  port: number,
  binding: WorkspaceServerBindingHooks,
): Promise<StartedWorkspaceServer> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new IcarusError("INVALID_PORT", "Workspace port is invalid");
  }
  const mode: WorkspaceServerMode = port === 0 ? "mutation-capable" : "review-only";
  const reviewOnlyReason: WorkspaceReviewOnlyReason | null =
    mode === "review-only" ? "explicit-port" : null;
  const server = createServer();
  const coordinator = new ActionCoordinator();
  const shutdownResponses = new Set<Promise<void>>();
  try {
    await binding.listen(server, port, REVIEW_ONLY_WORKSPACE_HOST);
  } catch (error) {
    if (server.listening) await closeListeningServer(server);
    throw error;
  }
  const address = server.address();
  if (
    address === null ||
    typeof address === "string" ||
    address.family !== "IPv4" ||
    address.address !== REVIEW_ONLY_WORKSPACE_HOST
  ) {
    await closeListeningServer(server);
    throw new IcarusError("UNSAFE_BINDING", "Workspace did not bind to the exact IPv4 loopback");
  }
  let session: WorkspaceSession;
  try {
    const originHostname =
      mode === "mutation-capable" ? binding.createMutationHostname() : REVIEW_ONLY_WORKSPACE_HOST;
    if (mode === "mutation-capable" && !isWorkspaceMutationHostname(originHostname)) {
      throw new IcarusError("INVALID_ORIGIN", "Workspace mutation origin is invalid");
    }
    session = createBoundWorkspaceSession(mode, address.port, originHostname, reviewOnlyReason);
    server.on(
      "request",
      workspaceRequestListener(options, session, coordinator, shutdownResponses),
    );
  } catch (error) {
    await closeListeningServer(server);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    server,
    host: REVIEW_ONLY_WORKSPACE_HOST,
    port: address.port,
    url: session.url,
    launchUrl: session.launchUrl,
    mode: session.mode,
    reviewOnlyReason: session.reviewOnlyReason,
    close: () => {
      if (closePromise !== undefined) return closePromise;

      // Close admission before any asynchronous shutdown step. Existing
      // handlers remain live and are never aborted by this first close.
      const drainPromise = coordinator.drain();
      const listenerClosePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      server.closeIdleConnections();

      closePromise = (async () => {
        const drain = await drainPromise;
        const failures: unknown[] = drain.failures.map((failure) => failure.error);
        while (shutdownResponses.size > 0) {
          await Promise.all([...shutdownResponses]);
        }
        try {
          // Every tracked handler has settled, so residual sockets can no
          // longer own service or store work.
          server.closeAllConnections();
        } catch (error) {
          failures.push(error);
        }
        try {
          await listenerClosePromise;
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "Workspace shutdown did not settle all active requests cleanly",
          );
        }
      })();
      return closePromise;
    },
  };
}

async function listenOnExactHost(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeListeningServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}
