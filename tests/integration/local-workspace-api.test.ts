import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { startWorkspaceServer } from "../../packages/api/src/server.js";
import { createIcarusRuntime, type IcarusRuntime } from "../../packages/core/src/index.js";
import {
  createFixtureRepository,
  git,
  planResponse,
  PYTHON_IMAGE,
  repositoryFingerprint,
  startOllamaQueue,
} from "../support/integration-cli.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function postJson(url: string, value: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function rawRequest(
  url: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  },
): Promise<{
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: options.method ?? "GET",
      headers: options.headers,
    });
    const chunks: Buffer[] = [];
    request.on("response", (response) => {
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.once("error", reject);
    request.end(options.body);
  });
}

describe("loopback local workspace API", () => {
  test("persists project, context preview, draft, plan, and evidence without touching source", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    await writeFile(path.join(fixture.repository, ".env.example"), "EXAMPLE_VALUE=placeholder\n");
    await mkdir(path.join(fixture.repository, "generated"));
    await writeFile(
      path.join(fixture.repository, "generated", "client.ts"),
      "export const generated = true;\n",
    );
    await mkdir(path.join(fixture.repository, "assets"));
    await writeFile(
      path.join(fixture.repository, "assets", "binary.dat"),
      Buffer.from([0, 1, 2, 3]),
    );
    await git(fixture.repository, [
      "add",
      "-f",
      ".env.example",
      "generated/client.ts",
      "assets/binary.dat",
    ]);
    await git(fixture.repository, ["commit", "-m", "tracked context exclusions"]);
    const sourceBefore = await repositoryFingerprint(fixture.repository);
    const workspaceDist = path.join(fixture.root, "workspace-dist");
    await mkdir(workspaceDist);
    await writeFile(path.join(workspaceDist, "index.html"), '<!doctype html><div id="root"></div>');
    const provider = await startOllamaQueue([planResponse()]);
    cleanups.push(provider.close);

    let runtime: IcarusRuntime | undefined = await createIcarusRuntime(fixture.stateRoot);
    let server = await startWorkspaceServer(
      { runtime, stateRoot: fixture.stateRoot, workspaceDist },
      0,
    );
    cleanups.push(async () => {
      await server.close();
      runtime?.close();
      runtime = undefined;
    });

    expect(server.host).toBe("127.0.0.1");
    expect(server.server.address()).toMatchObject({ address: "127.0.0.1" });
    const empty = await fetch(`${server.url}/api/workspace`);
    expect(empty.status).toBe(200);
    expect(await responseJson(empty)).toMatchObject({
      capabilities: {
        provider: { status: "unconfigured" },
        planning: { status: "available" },
        execution: { status: "unconfigured" },
      },
      projects: [],
      runs: [],
    });

    const createdResponse = await postJson(`${server.url}/api/projects`, {
      repository: { name: "fixture", path: fixture.repository },
      project: {
        name: "golden",
        baseRef: "main",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify greeting", argv: ["python", "checks/verify.py"] }],
      },
    });
    expect(createdResponse.status).toBe(201);
    const project = await responseJson(createdResponse);
    expect(project).toMatchObject({ name: "golden", repository: { path: fixture.repository } });
    const projectId = String(project.id);

    const firstPreviewResponse = await postJson(
      `${server.url}/api/projects/${projectId}/context-preview`,
      { target: "src/greeting.txt" },
    );
    expect(firstPreviewResponse.status).toBe(200);
    const firstPreview = await responseJson(firstPreviewResponse);
    const secondPreview = await responseJson(
      await postJson(`${server.url}/api/projects/${projectId}/context-preview`, {
        target: "src/greeting.txt",
      }),
    );
    expect(firstPreview).toEqual(secondPreview);
    expect(firstPreview).toMatchObject({ target: "src/greeting.txt" });
    expect(String(firstPreview.digest)).toMatch(/^[a-f0-9]{64}$/);
    expect(provider.requests).toHaveLength(0);

    const draftResponse = await postJson(`${server.url}/api/runs`, {
      projectId,
      task: "Review one exact greeting replacement.",
      target: "src/greeting.txt",
      provider: { model: "contract-model", baseUrl: provider.baseUrl },
    });
    expect(draftResponse.status).toBe(201);
    const draft = await responseJson(draftResponse);
    expect(draft).toMatchObject({ phase: "draft", state: "preparing" });
    expect(JSON.stringify(draft)).not.toContain(fixture.stateRoot);
    expect(provider.requests).toHaveLength(0);
    const runId = String(draft.id);

    const forbiddenApproval = await postJson(`${server.url}/api/runs/${runId}/approve`, {});
    expect(forbiddenApproval.status).toBe(404);
    expect(provider.requests).toHaveLength(0);
    expect(runtime.service.getRun(runId).state).toBe("preparing");

    await server.close();
    runtime.close();
    runtime = undefined;
    runtime = await createIcarusRuntime(fixture.stateRoot);
    server = await startWorkspaceServer(
      { runtime, stateRoot: fixture.stateRoot, workspaceDist },
      0,
    );
    const persistedDraft = await responseJson(await fetch(`${server.url}/api/runs/${runId}`));
    expect(persistedDraft).toMatchObject({
      id: runId,
      projectId,
      phase: "draft",
      state: "preparing",
      plan: null,
      action: null,
      verification: { outcome: "not_run" },
    });
    expect(provider.requests).toHaveLength(0);
    const reopenedWorkspace = await responseJson(await fetch(`${server.url}/api/workspace`));
    expect(reopenedWorkspace.runs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: runId, phase: "draft" })]),
    );

    const plannedResponse = await postJson(`${server.url}/api/runs/${runId}/plan`, {});
    expect(plannedResponse.status).toBe(200);
    const planned = await responseJson(plannedResponse);
    expect(planned).toMatchObject({
      phase: "awaiting_approval",
      state: "awaiting_approval",
      gate: { kind: "plan", status: "awaiting_approval" },
      action: null,
      files: { involved: expect.arrayContaining(["src/greeting.txt"]), changed: [] },
      verification: { outcome: "not_run" },
      approvals: [],
      usage: {
        toolCalls: expect.any(Number),
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      },
      lastError: null,
      outputs: [],
      timestamps: {
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    });
    expect(planned.plan).toMatchObject({ target: "src/greeting.txt" });
    expect(planned.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "verify", outcome: "not_run" })]),
    );
    expect(planned.warnings).toEqual(expect.arrayContaining([expect.stringContaining("not run")]));
    expect(planned.timeline).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "plan created" })]),
    );
    expect(JSON.stringify(planned)).not.toContain(fixture.stateRoot);
    expect(JSON.stringify(planned)).not.toContain("contextArtifactPath");
    expect(provider.requests).toHaveLength(1);
    const providerRequest = JSON.stringify(provider.requests[0]?.body);
    expect(providerRequest).toContain("src/greeting.txt");
    expect(providerRequest).not.toContain(".env.example");
    expect(providerRequest).not.toContain("generated/client.ts");
    expect(providerRequest).not.toContain("assets/binary.dat");
    await expect(readFile(path.join(fixture.repository, "src/greeting.txt"), "utf8")).resolves.toBe(
      "Hello, world!\n",
    );
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);

    provider.enqueue({ status: 503, rawBody: "opaque upstream body must not surface" });
    const failedProjectResponse = await postJson(`${server.url}/api/projects`, {
      repository: { name: "fixture", path: fixture.repository },
      project: {
        name: "provider-failure",
        baseRef: "main",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify greeting", argv: ["python", "checks/verify.py"] }],
      },
    });
    expect(failedProjectResponse.status).toBe(201);
    const failedProject = await responseJson(failedProjectResponse);
    const failedDraftResponse = await postJson(`${server.url}/api/runs`, {
      projectId: String(failedProject.id),
      task: "Preserve a provider failure as an honest run state.",
      target: "src/greeting.txt",
      provider: { model: "contract-model", baseUrl: provider.baseUrl },
    });
    expect(failedDraftResponse.status).toBe(201);
    const failedDraft = await responseJson(failedDraftResponse);
    const failedResponse = await postJson(
      `${server.url}/api/runs/${String(failedDraft.id)}/plan`,
      {},
    );
    expect(failedResponse.ok).toBe(false);
    expect(await failedResponse.text()).not.toContain("opaque upstream body");
    const failedRun = await responseJson(
      await fetch(`${server.url}/api/runs/${String(failedDraft.id)}`),
    );
    expect(failedRun).toMatchObject({
      phase: "failed",
      state: "failed",
      verification: { outcome: "not_run" },
    });
    expect(failedRun.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("PROVIDER_HTTP_ERROR")]),
    );
    expect(provider.requests).toHaveLength(2);
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);

    const excludedProjectResponse = await postJson(`${server.url}/api/projects`, {
      repository: { name: "fixture", path: fixture.repository },
      project: {
        name: "excluded-target",
        baseRef: "main",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify greeting", argv: ["python", "checks/verify.py"] }],
      },
    });
    expect(excludedProjectResponse.status).toBe(201);
    const excludedProject = await responseJson(excludedProjectResponse);
    const excludedDraftResponse = await postJson(`${server.url}/api/runs`, {
      projectId: String(excludedProject.id),
      task: "Reject a generated target inside the guarded lifecycle.",
      target: "generated/client.ts",
      provider: { model: "contract-model", baseUrl: provider.baseUrl },
    });
    expect(excludedDraftResponse.status).toBe(201);
    const excludedDraft = await responseJson(excludedDraftResponse);
    const excludedPlanResponse = await postJson(
      `${server.url}/api/runs/${String(excludedDraft.id)}/plan`,
      {},
    );
    expect(excludedPlanResponse.ok).toBe(false);
    const excludedFailed = await responseJson(
      await fetch(`${server.url}/api/runs/${String(excludedDraft.id)}`),
    );
    expect(excludedFailed).toMatchObject({
      state: "failed",
      resumeState: "preparing",
      action: null,
      lastError: { code: "PROTECTED_PATH" },
    });
    expect(provider.requests).toHaveLength(2);
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
    const replacementDraft = await postJson(`${server.url}/api/runs`, {
      projectId: String(excludedProject.id),
      task: "A failed validation must not block a replacement draft.",
      target: "src/greeting.txt",
      provider: { model: "contract-model", baseUrl: provider.baseUrl },
    });
    expect(replacementDraft.status).toBe(201);

    await server.close();
    runtime.close();
    runtime = undefined;
    runtime = await createIcarusRuntime(fixture.stateRoot);
    server = await startWorkspaceServer(
      { runtime, stateRoot: fixture.stateRoot, workspaceDist },
      0,
    );
    const persisted = await responseJson(await fetch(`${server.url}/api/runs/${runId}`));
    expect(persisted).toMatchObject({ id: runId, state: "awaiting_approval" });
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);

    const index = await fetch(server.url);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('id="root"');
  });

  test("rejects non-loopback browser authority, unsafe bodies, remote providers, and bind fallback", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const workspaceDist = path.join(fixture.root, "workspace-dist");
    await mkdir(workspaceDist);
    await writeFile(path.join(workspaceDist, "index.html"), "<!doctype html>");
    const runtime = await createIcarusRuntime(fixture.stateRoot);
    cleanups.push(async () => runtime.close());
    const server = await startWorkspaceServer(
      { runtime, stateRoot: fixture.stateRoot, workspaceDist },
      0,
    );
    cleanups.push(server.close);

    const badHost = await rawRequest(`${server.url}/api/workspace`, {
      headers: { host: "attacker.example" },
    });
    expect(badHost.status).toBe(422);
    expect(badHost.body).toContain("INVALID_HOST");
    expect(badHost.headers["access-control-allow-origin"]).toBeUndefined();

    const badOrigin = await rawRequest(`${server.url}/api/workspace`, {
      headers: { origin: "https://attacker.example" },
    });
    expect(badOrigin.status).toBe(422);
    expect(badOrigin.body).toContain("INVALID_ORIGIN");

    const crossLoopbackOrigin = await rawRequest(`${server.url}/api/workspace`, {
      headers: { origin: "http://127.0.0.1:1" },
    });
    expect(crossLoopbackOrigin.status).toBe(422);
    expect(crossLoopbackOrigin.body).toContain("INVALID_ORIGIN");

    const wrongType = await rawRequest(`${server.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const oversized = await rawRequest(`${server.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
    });
    expect(oversized.status).toBe(413);

    const malformedJson = await rawRequest(`${server.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformedJson.status).toBe(422);
    expect(malformedJson.body).toContain("INVALID_JSON");

    const unknownField = await postJson(`${server.url}/api/projects`, {
      repository: { name: "unknown-field", path: fixture.repository },
      project: {
        name: "unknown-field",
        baseRef: "main",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify", argv: ["node", "--test"] }],
      },
      unexpected: true,
    });
    expect(unknownField.status).toBe(422);
    expect(runtime.service.listRepositories()).toEqual([]);
    expect(runtime.service.listProjects()).toEqual([]);

    const invalidProject = await postJson(`${server.url}/api/projects`, {
      repository: { name: "orphan-attempt", path: fixture.repository },
      project: {
        name: "orphan-attempt",
        baseRef: "main",
        sandboxImage: PYTHON_IMAGE,
        checks: [
          { id: "duplicate", name: "First", argv: ["node", "--test"] },
          { id: "duplicate", name: "Second", argv: ["node", "--test"] },
        ],
      },
    });
    expect(invalidProject.status).toBe(422);
    expect(runtime.service.listRepositories()).toEqual([]);
    expect(runtime.service.listProjects()).toEqual([]);

    const missingRun = await fetch(`${server.url}/api/runs/missing-run`);
    expect(missingRun.status).toBe(404);
    expect(JSON.stringify(await responseJson(missingRun))).toContain("NOT_FOUND");

    const invalidRepository = await postJson(`${server.url}/api/projects`, {
      repository: { name: "missing-repository", path: path.join(fixture.root, "does-not-exist") },
      project: {
        name: "missing-repository",
        baseRef: "main",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify", argv: ["python", "checks/verify.py"] }],
      },
    });
    expect(invalidRepository.status).toBe(422);
    expect(await responseJson(invalidRepository)).toMatchObject({
      error: { code: "INVALID_REPOSITORY" },
    });
    expect(runtime.service.listRepositories()).toEqual([]);
    expect(runtime.service.listProjects()).toEqual([]);
    expect(runtime.service.listRuns()).toEqual([]);

    const emptyProject = await postJson(`${server.url}/api/projects`, {
      repository: { name: "fixture", path: fixture.repository },
      project: {
        name: "golden",
        baseRef: "main",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify", argv: ["python", "checks/verify.py"] }],
      },
    });
    expect(emptyProject.status).toBe(201);
    const projectId = String((await responseJson(emptyProject)).id);
    const malformedProvider = await postJson(`${server.url}/api/runs`, {
      projectId,
      task: "Reject a malformed provider URL without creating a draft.",
      target: "src/greeting.txt",
      provider: { model: "invalid", baseUrl: "not a URL" },
    });
    expect(malformedProvider.status).toBe(422);
    expect(await responseJson(malformedProvider)).toMatchObject({
      error: { code: "INVALID_PROVIDER_URL" },
    });
    expect(runtime.service.listRuns()).toEqual([]);

    const remoteProvider = await postJson(`${server.url}/api/runs`, {
      projectId,
      task: "Do not send this task remotely.",
      target: "src/greeting.txt",
      provider: { model: "remote", baseUrl: "https://models.example.invalid/" },
    });
    expect(remoteProvider.status).toBe(422);
    expect(JSON.stringify(await responseJson(remoteProvider))).toContain(
      "WORKSPACE_REMOTE_PROVIDER_DENIED",
    );
    expect(runtime.service.listRuns()).toEqual([]);

    await expect(
      startWorkspaceServer({ runtime, stateRoot: fixture.stateRoot, workspaceDist }, server.port),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
