import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import {
  assertRegistrationStateSeparation,
  createProviderConfig,
  DEFAULT_CEILING,
  DEFAULT_SANDBOX_LIMITS,
  IcarusError,
  type IcarusRuntime,
  parseProviderBaseUrl,
} from "@icarus/core";

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
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function headers(contentType: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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
  if (error.code === "NOT_FOUND") return 404;
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

function requestHostname(request: IncomingMessage): string | null {
  const host = request.headers.host;
  if (host === undefined) return null;
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function requestAuthority(request: IncomingMessage): string | null {
  const host = request.headers.host;
  if (host === undefined) return null;
  try {
    const parsed = new URL(`http://${host}`);
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null;
    }
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

function assertLocalBrowserRequest(request: IncomingMessage): void {
  const authority = requestAuthority(request);
  const hostname = requestHostname(request);
  if (
    authority === null ||
    (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1")
  ) {
    throw new IcarusError("INVALID_HOST", "The workspace accepts only loopback Host headers");
  }
  const origin = request.headers.origin;
  if (origin === undefined) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new IcarusError("INVALID_ORIGIN", "The request Origin is invalid");
  }
  const originHostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    parsed.protocol !== "http:" ||
    (originHostname !== "127.0.0.1" && originHostname !== "localhost" && originHostname !== "::1")
  ) {
    throw new IcarusError("INVALID_ORIGIN", "The workspace accepts only loopback Origins");
  }
  if (parsed.host.toLowerCase() !== authority) {
    throw new IcarusError(
      "INVALID_ORIGIN",
      "The workspace accepts only a same-origin browser authority",
    );
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new IcarusError("INVALID_JSON", "Request body must be valid JSON");
  }
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

function workspaceSnapshot(options: WorkspaceServerOptions): Record<string, unknown> {
  return {
    capabilities: {
      server: { status: "available", binding: "loopback" },
      provider: {
        status: "unconfigured",
        reason: "Enter a loopback Ollama model and endpoint for each draft.",
      },
      planning: {
        status: "available",
        reason:
          "Portable loopback planning is available; SQLite operation admission prevents concurrent provider work.",
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
    json(response, 200, workspaceSnapshot(options));
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
      target: input.target,
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

export function createWorkspaceServer(options: WorkspaceServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      assertLocalBrowserRequest(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith(API_PREFIX)) {
        const handled = await routeApi(options, request, response, url.pathname, url.searchParams);
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
  });
}

export async function startWorkspaceServer(
  options: WorkspaceServerOptions,
  port: number,
): Promise<StartedWorkspaceServer> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new IcarusError("INVALID_PORT", "Workspace port is invalid");
  }
  const server = createWorkspaceServer(options);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new IcarusError("UNSAFE_BINDING", "Workspace did not bind to IPv4 loopback");
  }
  let closed = false;
  return {
    server,
    host: "127.0.0.1",
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      });
    },
  };
}
