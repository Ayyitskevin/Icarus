import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { startWorkspaceServer } from "../../packages/api/src/server.js";
import {
  createIcarusRuntime,
  IcarusError,
  type IcarusRuntime,
} from "../../packages/core/src/index.js";
import {
  createFixtureRepository,
  git,
  PYTHON_IMAGE,
  planResponse,
  repositoryFingerprint,
  startOllamaQueue,
} from "../support/integration-cli.js";

const cleanups: Array<() => Promise<void>> = [];

interface TestDatabase {
  prepare(sql: string): {
    run(...parameters: unknown[]): unknown;
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
  };
  close(): void;
}

const Database = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
) as new (
  filename: string,
) => TestDatabase;

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

function persistenceSnapshot(database: TestDatabase): Record<string, readonly unknown[]> {
  return {
    repositories: database.prepare("SELECT * FROM repositories ORDER BY id").all(),
    projects: database.prepare("SELECT * FROM projects ORDER BY id").all(),
    runs: database.prepare("SELECT * FROM runs ORDER BY id").all(),
    events: database.prepare("SELECT * FROM run_events ORDER BY id").all(),
    approvals: database.prepare("SELECT * FROM approvals ORDER BY id").all(),
    operations: database.prepare("SELECT * FROM operations ORDER BY id").all(),
    checkpoints: database.prepare("SELECT * FROM checkpoints ORDER BY run_id").all(),
    sequences: database.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(),
  };
}

function workspaceRunId(index: number): string {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function insertWorkspaceRun(database: TestDatabase, projectId: string, index: number): void {
  database
    .prepare(
      `INSERT INTO runs
        (id, project_id, task, target, provider_json, state, base_commit, context_json,
         context_artifact_path, context_sha256, diff, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'completed', '', ?, ?, '', ?, ?, ?, ?)`,
    )
    .run(
      workspaceRunId(index),
      projectId,
      `Workspace task ${index}`,
      `src/run-${index}.txt`,
      "not-json:private-provider-sentinel",
      "not-json:private-context-sentinel",
      "/private/runtime/context-sentinel",
      "+private diff sentinel",
      "private error sentinel",
      "2026-07-20T12:00:00.000Z",
      "2026-07-20T12:01:00.000Z",
    );
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
      runPage: { before: 1, snapshot: 0, nextBefore: 1, hasMore: false, runs: [] },
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
    expect(draft).toMatchObject({
      phase: "draft",
      state: "preparing",
      eventCursor: 1,
      timelineTotal: 1,
      timelineTruncated: false,
    });
    expect(JSON.stringify(draft)).not.toContain(fixture.stateRoot);
    expect(provider.requests).toHaveLength(0);
    const runId = String(draft.id);

    const initialEventsResponse = await fetch(`${server.url}/api/runs/${runId}/events?after=0`);
    expect(initialEventsResponse.status).toBe(200);
    const initialEvents = await responseJson(initialEventsResponse);
    expect(initialEvents).toMatchObject({
      runId,
      revision: 1,
      nextAfter: 1,
      hasMore: false,
      events: [
        {
          sequence: 1,
          type: "run.created",
          evidenceSection: "summary",
          timestamp: expect.any(String),
        },
      ],
    });
    expect(JSON.stringify(initialEvents)).not.toContain("payload");
    expect(JSON.stringify(initialEvents)).not.toContain("createdAt");
    for (const query of [
      "",
      "?after=-1",
      "?after=0.5",
      "?after=01",
      "?after=2",
      "?after=9007199254740992",
      "?after=0&after=0",
      "?after=0&extra=1",
    ]) {
      const invalidEvents = await fetch(`${server.url}/api/runs/${runId}/events${query}`);
      expect(invalidEvents.status).toBe(422);
    }
    const forbiddenEventPost = await postJson(`${server.url}/api/runs/${runId}/events?after=0`, {});
    expect(forbiddenEventPost.status).toBe(404);
    expect(
      await responseJson(await fetch(`${server.url}/api/runs/${runId}/events?after=0`)),
    ).toEqual(initialEvents);

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
    expect((reopenedWorkspace.runPage as Record<string, unknown>).runs).toEqual(
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
      approvalCoverage: {
        limit: 12,
        loaded: 0,
        earlierApprovalsExcluded: false,
      },
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

    const provenanceDatabase = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    const insertApproval = provenanceDatabase.prepare(
      `INSERT INTO approvals (id, run_id, kind, digest, actor, decision, created_at)
       VALUES (?, ?, 'plan', ?, ?, 'approve', ?)`,
    );
    for (let index = 1; index <= 13; index += 1) {
      insertApproval.run(
        `api-approval-${(14 - index).toString().padStart(2, "0")}`,
        runId,
        index.toString(16).padStart(64, "0"),
        `api-operator-${index}`,
        "2026-07-22T12:00:00.000Z",
      );
    }
    provenanceDatabase.close();

    const boundedProvenance = await responseJson(await fetch(`${server.url}/api/runs/${runId}`));
    expect(boundedProvenance.approvalCoverage).toEqual({
      limit: 12,
      loaded: 12,
      earlierApprovalsExcluded: true,
    });
    const retainedApprovals = boundedProvenance.approvals as Array<Record<string, unknown>>;
    expect(retainedApprovals).toHaveLength(12);
    expect(retainedApprovals.map((approval) => approval.actor)).toEqual(
      Array.from({ length: 12 }, (_, index) => `api-operator-${index + 2}`),
    );
    expect(JSON.stringify(boundedProvenance)).not.toContain("api-approval-");
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

  test("serves strict pinned workspace run pages with fixed work and no full-run hydration", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const sourceBefore = await repositoryFingerprint(fixture.repository);
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

    const projectResponse = await postJson(`${server.url}/api/projects`, {
      repository: { name: "run-page-fixture", path: fixture.repository },
      project: {
        name: "run-page-project",
        baseRef: "main",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify", argv: ["python", "checks/verify.py"] }],
      },
    });
    expect(projectResponse.status).toBe(201);
    const projectId = String((await responseJson(projectResponse)).id);
    const database = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    for (let index = 1; index <= 205; index += 1) {
      insertWorkspaceRun(database, projectId, index);
    }
    database.prepare("DELETE FROM runs WHERE rowid = ?").run(100);
    const persistenceBefore = persistenceSnapshot(database);
    database.close();

    const firstResponse = await fetch(`${server.url}/api/runs`);
    expect(firstResponse.status).toBe(200);
    const first = await responseJson(firstResponse);
    expect(Object.keys(first).sort()).toEqual(
      ["before", "snapshot", "nextBefore", "hasMore", "runs"].sort(),
    );
    expect(first).toMatchObject({ before: 206, snapshot: 205, nextBefore: 194, hasMore: true });
    const firstRuns = first.runs as Array<Record<string, unknown>>;
    expect(firstRuns).toHaveLength(12);
    expect(firstRuns.map((run) => run.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => workspaceRunId(205 - index)),
    );
    expect(Object.keys(firstRuns[0] ?? {}).sort()).toEqual(
      ["id", "projectId", "task", "target", "state", "phase", "createdAt", "updatedAt"].sort(),
    );
    expect(firstRuns[0]).toMatchObject({
      task: "Workspace task 205",
      state: "completed",
      phase: "completed",
    });
    expect(JSON.stringify(first)).not.toMatch(
      /private-provider|private-context|\/private\/runtime|private diff|private error/,
    );

    const second = await responseJson(
      await fetch(`${server.url}/api/runs?before=${String(first.nextBefore)}&snapshot=205`),
    );
    expect(second).toMatchObject({ before: 194, snapshot: 205, nextBefore: 182, hasMore: true });
    expect((second.runs as Array<Record<string, unknown>>).map((run) => run.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => workspaceRunId(193 - index)),
    );
    const acrossGap = await responseJson(
      await fetch(`${server.url}/api/runs?before=105&snapshot=205`),
    );
    expect((acrossGap.runs as Array<Record<string, unknown>>).map((run) => run.id)).toEqual(
      [104, 103, 102, 101, 99, 98, 97, 96, 95, 94, 93, 92].map(workspaceRunId),
    );
    const emptyPinned = await responseJson(
      await fetch(`${server.url}/api/runs?before=1&snapshot=0`),
    );
    expect(emptyPinned).toEqual({
      before: 1,
      snapshot: 0,
      nextBefore: 1,
      hasMore: false,
      runs: [],
    });

    const workspace = await responseJson(await fetch(`${server.url}/api/workspace`));
    expect(Object.keys(workspace).sort()).toEqual(["capabilities", "projects", "runPage"].sort());
    expect(workspace).not.toHaveProperty("runs");
    expect(workspace.runPage).toEqual(first);

    for (const query of [
      "?before=206",
      "?snapshot=205",
      "?before=&snapshot=205",
      "?before=0&snapshot=205",
      "?before=-1&snapshot=205",
      "?before=0.5&snapshot=205",
      "?before=0206&snapshot=205",
      "?before=2e2&snapshot=205",
      "?before=9007199254740992&snapshot=205",
      "?before=206&snapshot=9007199254740991",
      "?before=206&before=206&snapshot=205",
      "?before=206&snapshot=205&snapshot=205",
      "?before=206&snapshot=205&extra=1",
      "?before=207&snapshot=205",
      "?before=100&snapshot=205",
      "?before=208&snapshot=207",
    ]) {
      const invalidPage = await fetch(`${server.url}/api/runs${query}`);
      expect(invalidPage.status).toBe(422);
      expect(await responseJson(invalidPage)).toMatchObject({
        error: { code: expect.any(String) },
      });
    }
    const forbiddenPut = await fetch(`${server.url}/api/runs`, { method: "PUT" });
    expect(forbiddenPut.status).toBe(404);

    const afterInitialReads = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    expect(persistenceSnapshot(afterInitialReads)).toEqual(persistenceBefore);
    afterInitialReads.close();

    const createdResponse = await postJson(`${server.url}/api/runs`, {
      projectId,
      task: "Open a newer workspace page session.",
      target: "src/greeting.txt",
      provider: { model: "unused", baseUrl: "http://127.0.0.1:11434" },
    });
    expect(createdResponse.status).toBe(201);
    const createdRunId = String((await responseJson(createdResponse)).id);
    expect(
      await responseJson(await fetch(`${server.url}/api/runs?before=206&snapshot=205`)),
    ).toEqual(first);
    const newest = await responseJson(await fetch(`${server.url}/api/runs`));
    expect(newest).toMatchObject({ before: 207, snapshot: 206, hasMore: true });
    expect((newest.runs as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: createdRunId,
      phase: "draft",
    });

    const persistedAfterCreation = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    const afterCreation = persistenceSnapshot(persistedAfterCreation);
    persistedAfterCreation.close();
    await fetch(`${server.url}/api/runs`);
    await fetch(`${server.url}/api/workspace`);
    const finalObserver = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    expect(persistenceSnapshot(finalObserver)).toEqual(afterCreation);
    finalObserver.close();
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
  });

  test("serves bounded coherent run snapshots without decoding private event payloads", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const sourceBefore = await repositoryFingerprint(fixture.repository);
    const workspaceDist = path.join(fixture.root, "workspace-dist");
    await mkdir(workspaceDist);
    await writeFile(path.join(workspaceDist, "index.html"), "<!doctype html>");
    let runtime = await createIcarusRuntime(fixture.stateRoot);
    cleanups.push(async () => runtime.close());
    let server = await startWorkspaceServer(
      { runtime, stateRoot: fixture.stateRoot, workspaceDist },
      0,
    );
    cleanups.push(server.close);

    const projectResponse = await postJson(`${server.url}/api/projects`, {
      repository: { name: "bounded-fixture", path: fixture.repository },
      project: {
        name: "bounded-project",
        baseRef: "main",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify", argv: ["python", "checks/verify.py"] }],
      },
    });
    const projectId = String((await responseJson(projectResponse)).id);
    const draftResponse = await postJson(`${server.url}/api/runs`, {
      projectId,
      task: "Keep persisted event payloads private.",
      target: "src/greeting.txt",
      provider: { model: "unused", baseUrl: "http://127.0.0.1:11434" },
    });
    const runId = String((await responseJson(draftResponse)).id);

    const privateSentinel = "/private/runtime/api-payload-sentinel";
    const database = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    database.prepare("UPDATE runs SET edit_json = ? WHERE id = ?").run(
      JSON.stringify({
        path: "src/greeting.txt",
        expectedPreimageSha256: "a".repeat(64),
        findText: "Hello",
        replaceText: "Hello, Icarus",
        rationale: "Exercise bounded action presentation.",
      }),
      runId,
    );
    database
      .prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = 1")
      .run("not-json", runId);
    const insert = database.prepare(
      `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (let sequence = 2; sequence <= 206; sequence += 1) {
      const type =
        sequence === 205
          ? "restore.completed"
          : sequence === 206
            ? "cancellation.completed"
            : "operation.finished";
      insert.run(
        runId,
        sequence,
        type,
        JSON.stringify({ privateSentinel, sequence }),
        "2026-07-20T12:00:00.000Z",
      );
    }
    const persistenceBefore = persistenceSnapshot(database);
    database.close();

    const selected = await responseJson(await fetch(`${server.url}/api/runs/${runId}`));
    expect(selected).toMatchObject({
      id: runId,
      action: { status: "reverted" },
      eventCursor: 206,
      timelineTotal: 206,
      timelineTruncated: true,
    });
    expect(selected.timeline).toHaveLength(200);
    expect((selected.timeline as Array<{ sequence: number }>)[0]?.sequence).toBe(7);
    expect(JSON.stringify(selected)).not.toContain(privateSentinel);
    expect(JSON.stringify(selected)).not.toContain("not-json");

    const workspace = await responseJson(await fetch(`${server.url}/api/workspace`));
    const workspaceRun = (
      (workspace.runPage as Record<string, unknown>).runs as Array<Record<string, unknown>>
    ).find((run) => run.id === runId);
    expect(workspaceRun).toMatchObject({ id: runId, state: "preparing", phase: "draft" });
    expect(Object.keys(workspaceRun ?? {}).sort()).toEqual(
      ["id", "projectId", "task", "target", "state", "phase", "createdAt", "updatedAt"].sort(),
    );
    expect(JSON.stringify(workspaceRun)).not.toContain(privateSentinel);
    expect(JSON.stringify(workspaceRun)).not.toMatch(/action|eventCursor|timeline/);

    const newestHistoryResponse = await fetch(
      `${server.url}/api/runs/${runId}/events/history?snapshot=206&before=207`,
    );
    expect(newestHistoryResponse.status).toBe(200);
    const newestHistory = await responseJson(newestHistoryResponse);
    expect(Object.keys(newestHistory).sort()).toEqual(
      ["runId", "before", "snapshot", "nextBefore", "hasMore", "events"].sort(),
    );
    expect(newestHistory).toMatchObject({
      runId,
      before: 207,
      snapshot: 206,
      nextBefore: 143,
      hasMore: true,
    });
    const newestHistoryEvents = newestHistory.events as Array<Record<string, unknown>>;
    expect(newestHistoryEvents).toHaveLength(64);
    expect(newestHistoryEvents.map((event) => event.sequence)).toEqual(
      Array.from({ length: 64 }, (_, index) => index + 143),
    );
    expect(Object.keys(newestHistoryEvents[0] ?? {}).sort()).toEqual(
      ["sequence", "type", "label", "evidenceSection", "timestamp"].sort(),
    );
    expect(JSON.stringify(newestHistory)).not.toContain(privateSentinel);
    expect(JSON.stringify(newestHistory)).not.toContain("payload");
    expect(JSON.stringify(newestHistory)).not.toContain("createdAt");

    const nextHistory = await responseJson(
      await fetch(
        `${server.url}/api/runs/${runId}/events/history?before=${String(
          newestHistory.nextBefore,
        )}&snapshot=206`,
      ),
    );
    expect(nextHistory).toMatchObject({
      runId,
      before: 143,
      snapshot: 206,
      nextBefore: 79,
      hasMore: true,
    });
    expect(
      (nextHistory.events as Array<{ sequence: number }>).map((event) => event.sequence),
    ).toEqual(Array.from({ length: 64 }, (_, index) => index + 79));

    const precedingVisibleTail = await responseJson(
      await fetch(`${server.url}/api/runs/${runId}/events/history?before=7&snapshot=206`),
    );
    expect(precedingVisibleTail).toMatchObject({
      runId,
      before: 7,
      snapshot: 206,
      nextBefore: 1,
      hasMore: false,
    });
    expect(
      (precedingVisibleTail.events as Array<{ sequence: number }>).map((event) => event.sequence),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(JSON.stringify(precedingVisibleTail)).not.toContain(privateSentinel);
    expect(JSON.stringify(precedingVisibleTail)).not.toContain("not-json");

    const pinnedHistory = await responseJson(
      await fetch(`${server.url}/api/runs/${runId}/events/history?before=151&snapshot=150`),
    );
    expect(pinnedHistory).toMatchObject({
      runId,
      before: 151,
      snapshot: 150,
      nextBefore: 87,
      hasMore: true,
    });
    expect((pinnedHistory.events as Array<{ sequence: number }>).at(-1)?.sequence).toBe(150);

    for (const query of [
      "",
      "?before=207",
      "?snapshot=206",
      "?before=&snapshot=206",
      "?before=0&snapshot=206",
      "?before=-1&snapshot=206",
      "?before=0.5&snapshot=206",
      "?before=0207&snapshot=206",
      "?before=2e2&snapshot=206",
      "?before=9007199254740992&snapshot=206",
      "?before=207&snapshot=9007199254740992",
      "?before=207&before=207&snapshot=206",
      "?before=207&snapshot=206&snapshot=206",
      "?before=207&snapshot=206&extra=1",
      "?before=208&snapshot=206",
      "?before=207&snapshot=207",
    ]) {
      const invalidHistory = await fetch(`${server.url}/api/runs/${runId}/events/history${query}`);
      expect(invalidHistory.status).toBe(422);
    }
    const missingHistory = await fetch(
      `${server.url}/api/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/events/history?before=2&snapshot=1`,
    );
    expect(missingHistory.status).toBe(404);
    const forbiddenHistoryPost = await postJson(
      `${server.url}/api/runs/${runId}/events/history?before=207&snapshot=206`,
      {},
    );
    expect(forbiddenHistoryPost.status).toBe(404);

    await server.close();
    runtime.close();
    runtime = await createIcarusRuntime(fixture.stateRoot);
    server = await startWorkspaceServer(
      { runtime, stateRoot: fixture.stateRoot, workspaceDist },
      0,
    );
    cleanups.push(server.close);
    expect(
      await responseJson(
        await fetch(`${server.url}/api/runs/${runId}/events/history?before=207&snapshot=206`),
      ),
    ).toEqual(newestHistory);

    const observer = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    const persistenceAfter = persistenceSnapshot(observer);
    observer.close();
    expect(persistenceAfter).toEqual(persistenceBefore);
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
    expect(() => runtime.service.history(runId)).toThrowError(
      expect.objectContaining({ code: "DATABASE_ERROR" }),
    );
  });

  test("serves exact bounded verification provenance without read-side mutation", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const sourceBefore = await repositoryFingerprint(fixture.repository);
    const workspaceDist = path.join(fixture.root, "workspace-dist");
    await mkdir(workspaceDist);
    await writeFile(path.join(workspaceDist, "index.html"), "<!doctype html>");
    let runtime = await createIcarusRuntime(fixture.stateRoot);
    cleanups.push(async () => runtime.close());
    let server = await startWorkspaceServer(
      { runtime, stateRoot: fixture.stateRoot, workspaceDist },
      0,
    );
    cleanups.push(server.close);

    const projectResponse = await postJson(`${server.url}/api/projects`, {
      repository: { name: "provenance-fixture", path: fixture.repository },
      project: {
        name: "provenance-project",
        baseRef: "main",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify", argv: ["python", "checks/verify.py"] }],
      },
    });
    const projectId = String((await responseJson(projectResponse)).id);
    const draftResponse = await postJson(`${server.url}/api/runs`, {
      projectId,
      task: "Inspect scalar verification provenance.",
      target: "src/greeting.txt",
      provider: { model: "unused", baseUrl: "http://127.0.0.1:11434" },
    });
    const runId = String((await responseJson(draftResponse)).id);
    const checkpointSha256 = "c".repeat(64);
    const diffSha256 = "d".repeat(64);
    const privateSentinel = "/private/runtime/provenance-<img-onerror-sentinel>";
    const database = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    database
      .prepare(
        `UPDATE runs
         SET state = 'awaiting_review', provider_json = ?, context_json = ?, diff = ?,
             error_message = ?
         WHERE id = ?`,
      )
      .run("not-json-provider", "not-json-context", privateSentinel, privateSentinel, runId);
    const insert = database.prepare(
      `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run(
      runId,
      2,
      "edit.materialized",
      JSON.stringify({
        from: "running",
        to: "verifying",
        detail: { target: privateSentinel, approvedSha256: "a".repeat(64) },
      }),
      "2026-07-22T12:00:02.000Z",
    );
    insert.run(
      runId,
      3,
      "checkpoint.saved",
      JSON.stringify({ checkpointSha256 }),
      "2026-07-22T12:00:03.000Z",
    );
    const completedPayload = JSON.stringify({
      from: "verifying",
      to: "awaiting_review",
      outcome: "passed",
      diffSha256,
      diff: privateSentinel,
      verification: {
        outcome: "passed",
        checks: [{ argv: [privateSentinel], stdout: privateSentinel }],
        changedPaths: [privateSentinel],
        diffSha256,
        checkpointSha256,
      },
    });
    insert.run(runId, 4, "verification.completed", completedPayload, "2026-07-22T12:00:04.000Z");
    database
      .prepare(
        `INSERT INTO checkpoints
           (run_id, baseline_base64, approved_base64, checkpoint_sha256, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, privateSentinel, privateSentinel, checkpointSha256, "2026-07-22T12:00:03.000Z");
    const persistenceBefore = persistenceSnapshot(database);
    database.close();

    const response = await fetch(
      `${server.url}/api/runs/${runId}/verification-attempts?snapshot=4`,
    );
    expect(response.status).toBe(200);
    const projection = await responseJson(response);
    expect(Object.keys(projection).sort()).toEqual(
      [
        "runId",
        "snapshot",
        "coverage",
        "attemptLimit",
        "attemptAnchorsTruncatedWithinCoverage",
        "checkpoint",
        "attempts",
      ].sort(),
    );
    expect(projection).toMatchObject({
      runId,
      snapshot: 4,
      coverage: {
        firstSequence: 1,
        lastSequence: 4,
        eventCount: 4,
        eventLimit: 200,
        earlierEventsExcluded: false,
      },
      attemptLimit: 8,
      attemptAnchorsTruncatedWithinCoverage: false,
      checkpoint: {
        status: "saved",
        sha256: checkpointSha256,
        saveEvent: { status: "observed_in_coverage", sequence: 3 },
      },
      attempts: [
        {
          identity: "verification-anchor-4",
          anchorSequence: 4,
          startSequence: 2,
          startProvenance: "observed_initial_edit",
          status: "passed",
          endSequence: 4,
          diffSha256,
          checkpointSha256,
          checkpointProvenance: "recorded_digest_match",
          laterAttemptObservedWithinCoverage: false,
        },
      ],
    });
    expect(
      Object.keys((projection.attempts as Array<Record<string, unknown>>)[0] ?? {}).sort(),
    ).toEqual(
      [
        "identity",
        "anchorSequence",
        "startSequence",
        "startedAt",
        "startProvenance",
        "status",
        "endSequence",
        "endedAt",
        "diffSha256",
        "checkpointSha256",
        "checkpointProvenance",
        "laterAttemptObservedWithinCoverage",
      ].sort(),
    );
    expect(JSON.stringify(projection)).not.toContain(privateSentinel);
    expect(JSON.stringify(projection)).not.toMatch(/payload|checks|argv|output|changedPaths|diff"/);
    expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThan(4_096);

    const corruptDatabase = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    corruptDatabase
      .prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = 4")
      .run(`${privateSentinel}:corrupt-selected-completion`, runId);
    corruptDatabase.close();
    const corruptResponse = await fetch(
      `${server.url}/api/runs/${runId}/verification-attempts?snapshot=4`,
    );
    expect(corruptResponse.status).toBe(400);
    const corruptError = await responseJson(corruptResponse);
    expect(corruptError).toMatchObject({ error: { code: "DATABASE_ERROR" } });
    expect(JSON.stringify(corruptError)).not.toContain(privateSentinel);
    const restoreDatabase = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    restoreDatabase
      .prepare("UPDATE run_events SET payload_json = ? WHERE run_id = ? AND sequence = 4")
      .run(completedPayload, runId);
    restoreDatabase.close();

    for (const query of [
      "",
      "?snapshot=",
      "?snapshot=0",
      "?snapshot=-1",
      "?snapshot=04",
      "?snapshot=4.0",
      "?snapshot=4e0",
      "?snapshot=9007199254740992",
      "?snapshot=4&snapshot=4",
      "?snapshot=4&limit=8",
      "?before=5&snapshot=4",
    ]) {
      const invalid = await fetch(`${server.url}/api/runs/${runId}/verification-attempts${query}`);
      expect(invalid.status).toBe(422);
    }
    expect(
      (
        await fetch(
          `${server.url}/api/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/verification-attempts?snapshot=1`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await postJson(`${server.url}/api/runs/${runId}/verification-attempts?snapshot=4`, {}))
        .status,
    ).toBe(404);

    const observer = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    expect(persistenceSnapshot(observer)).toEqual(persistenceBefore);
    observer
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 5, 'review.rejected', ?, '2026-07-22T12:00:05.000Z')`,
      )
      .run(runId, "not-json-unrelated-private");
    observer.close();
    const conflict = await fetch(
      `${server.url}/api/runs/${runId}/verification-attempts?snapshot=4`,
    );
    expect(conflict.status).toBe(409);
    expect(await responseJson(conflict)).toMatchObject({
      error: { code: "EVENT_SNAPSHOT_CONFLICT" },
    });
    expect(
      (
        await responseJson(
          await fetch(`${server.url}/api/runs/${runId}/verification-attempts?snapshot=5`),
        )
      ).attempts,
    ).toEqual(projection.attempts);

    await server.close();
    runtime.close();
    runtime = await createIcarusRuntime(fixture.stateRoot);
    server = await startWorkspaceServer(
      { runtime, stateRoot: fixture.stateRoot, workspaceDist },
      0,
    );
    cleanups.push(server.close);
    expect(
      await responseJson(
        await fetch(`${server.url}/api/runs/${runId}/verification-attempts?snapshot=5`),
      ),
    ).toMatchObject({ runId, snapshot: 5, attempts: projection.attempts });
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
  });

  test("fails registration closed before invoking a repository clean filter", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    await writeFile(
      path.join(fixture.repository, ".gitattributes"),
      "src/greeting.txt filter=registration-sentinel\n",
    );
    await git(fixture.repository, ["add", ".gitattributes"]);
    await git(fixture.repository, ["commit", "-m", "declare registration test filter"]);
    const marker = path.join(fixture.root, "registration-filter-invoked");
    const unsafeKey = "filter.registration-sentinel.clean";
    await git(fixture.repository, ["config", unsafeKey, `sh -c 'printf invoked > "${marker}"'`]);
    const sourceBefore = await readFile(path.join(fixture.repository, "src/greeting.txt"));
    const headBefore = (await git(fixture.repository, ["rev-parse", "HEAD"])).trim();
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

    const response = await postJson(`${server.url}/api/projects`, {
      repository: { name: "unsafe-registration", path: fixture.repository },
      project: {
        name: "unsafe-registration",
        baseRef: "main",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify", argv: ["python", "checks/verify.py"] }],
      },
    });
    expect(response.status).toBe(422);
    const body = await responseJson(response);
    expect(body).toEqual({
      error: {
        code: "GIT_UNSAFE_CONFIGURATION",
        message: "Repository Git configuration is not safe to inspect",
      },
    });
    expect(JSON.stringify(body)).not.toContain(unsafeKey);
    expect(JSON.stringify(body)).not.toContain(marker);
    expect(JSON.stringify(body)).not.toContain(fixture.repository);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(fixture.repository, "src/greeting.txt"))).toEqual(sourceBefore);
    expect((await git(fixture.repository, ["rev-parse", "HEAD"])).trim()).toBe(headBefore);
    expect(runtime.service.listRepositories()).toEqual([]);
    expect(runtime.service.listProjects()).toEqual([]);
  });

  test("reports sanitized repository status for clean, dirty, divergent, missing, and replaced paths", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    await writeFile(
      path.join(fixture.repository, ".gitattributes"),
      "src/greeting.txt filter=icarus-malicious\n",
    );
    await git(fixture.repository, ["add", ".gitattributes"]);
    await git(fixture.repository, ["commit", "-m", "declare inert test filter"]);
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

    const created = await postJson(`${server.url}/api/projects`, {
      repository: { name: "status-fixture", path: fixture.repository },
      project: {
        name: "status-golden",
        baseRef: "main",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify", argv: ["python", "checks/verify.py"] }],
      },
    });
    expect(created.status).toBe(201);
    const projectId = String((await responseJson(created)).id);
    const statusUrl = `${server.url}/api/projects/${projectId}/repository-status`;

    const cleanFingerprint = await repositoryFingerprint(fixture.repository);
    const clean = await responseJson(await fetch(statusUrl));
    expect(clean).toMatchObject({
      projectId,
      availability: "available",
      worktree: "clean",
      branch: "main",
      baseRef: "main",
      headMatchesBaseRef: true,
      issue: null,
    });
    expect(await repositoryFingerprint(fixture.repository)).toEqual(cleanFingerprint);

    const expectDirtyStatus = async (...privateSentinels: readonly string[]): Promise<void> => {
      const before = await repositoryFingerprint(fixture.repository);
      const dirtyResponse = await fetch(statusUrl);
      expect(dirtyResponse.status).toBe(200);
      const dirty = await responseJson(dirtyResponse);
      expect(dirty).toMatchObject({
        availability: "available",
        worktree: "dirty",
        issue: { code: "DIRTY_REPOSITORY" },
      });
      const serializedDirty = JSON.stringify(dirty);
      for (const sentinel of privateSentinels) {
        expect(serializedDirty).not.toContain(sentinel);
      }
      expect(serializedDirty).not.toContain(fixture.repository);
      expect(await repositoryFingerprint(fixture.repository)).toEqual(before);
    };

    const dirtyFilename = "private-dirty-sentinel.txt";
    await writeFile(path.join(fixture.repository, dirtyFilename), "private dirty contents\n");
    await expectDirtyStatus(dirtyFilename, "private dirty contents");
    await unlink(path.join(fixture.repository, dirtyFilename));

    const unstagedFilename = "src/greeting.txt";
    await writeFile(path.join(fixture.repository, unstagedFilename), "private unstaged contents\n");
    await expectDirtyStatus(unstagedFilename, "private unstaged contents");
    await git(fixture.repository, ["restore", unstagedFilename]);

    const stagedFilename = "README.md";
    await writeFile(path.join(fixture.repository, stagedFilename), "private staged contents\n");
    await git(fixture.repository, ["add", stagedFilename]);
    await expectDirtyStatus(stagedFilename, "private staged contents");
    await git(fixture.repository, ["restore", "--staged", stagedFilename]);
    await git(fixture.repository, ["restore", stagedFilename]);

    const restoredFingerprint = await repositoryFingerprint(fixture.repository);
    expect(await responseJson(await fetch(statusUrl))).toMatchObject({
      availability: "available",
      worktree: "clean",
      issue: null,
    });
    expect(await repositoryFingerprint(fixture.repository)).toEqual(restoredFingerprint);

    const sourceBytes = await readFile(path.join(fixture.repository, "src/greeting.txt"));
    const sourceHead = (await git(fixture.repository, ["rev-parse", "HEAD"])).trim();
    for (const unsafeKey of [
      "filter.icarus-malicious.clean",
      "filter.icarus-malicious.process",
      "core.alternateRefsCommand",
    ]) {
      const marker = path.join(fixture.root, `unsafe-config-${unsafeKey.replaceAll(".", "-")}`);
      const command = `sh -c 'printf invoked > "${marker}"'`;
      let clearUnsafeConfiguration: () => Promise<void>;
      if (unsafeKey.endsWith(".process")) {
        const includedConfig = path.join(fixture.root, "included-process-filter.config");
        await git(fixture.repository, ["config", "--file", includedConfig, unsafeKey, command]);
        await git(fixture.repository, ["config", "--local", "include.path", includedConfig]);
        clearUnsafeConfiguration = async () => {
          await git(fixture.repository, ["config", "--local", "--unset", "include.path"]);
        };
      } else if (unsafeKey === "core.alternateRefsCommand") {
        await git(fixture.repository, ["config", "extensions.worktreeConfig", "true"]);
        await git(fixture.repository, ["config", "--worktree", unsafeKey, command]);
        clearUnsafeConfiguration = async () => {
          await git(fixture.repository, ["config", "--worktree", "--unset", unsafeKey]);
        };
      } else {
        await git(fixture.repository, ["config", unsafeKey, command]);
        clearUnsafeConfiguration = async () => {
          await git(fixture.repository, ["config", "--unset", unsafeKey]);
        };
      }
      const unsafeStatus = await responseJson(await fetch(statusUrl));
      expect(unsafeStatus).toMatchObject({
        availability: "unavailable",
        worktree: "unknown",
        head: null,
        branch: null,
        issue: { code: "REPOSITORY_UNAVAILABLE" },
      });
      const serialized = JSON.stringify(unsafeStatus);
      expect(serialized).not.toContain(unsafeKey);
      expect(serialized).not.toContain(marker);
      expect(serialized).not.toContain(fixture.repository);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(fixture.repository, "src/greeting.txt"))).toEqual(
        sourceBytes,
      );
      expect((await git(fixture.repository, ["rev-parse", "HEAD"])).trim()).toBe(sourceHead);
      await clearUnsafeConfiguration();
    }

    const unresolvedProject = await postJson(`${server.url}/api/projects`, {
      repository: { name: "status-fixture", path: fixture.repository },
      project: {
        name: "status-unresolved",
        baseRef: "refs/heads/does-not-exist",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify", argv: ["python", "checks/verify.py"] }],
      },
    });
    const unresolvedProjectId = String((await responseJson(unresolvedProject)).id);
    expect(
      await responseJson(
        await fetch(`${server.url}/api/projects/${unresolvedProjectId}/repository-status`),
      ),
    ).toMatchObject({
      availability: "available",
      worktree: "clean",
      baseCommit: null,
      headMatchesBaseRef: null,
      issue: { code: "BASE_REF_UNRESOLVED" },
    });

    const blobId = (await git(fixture.repository, ["rev-parse", "HEAD:src/greeting.txt"])).trim();
    await git(fixture.repository, ["update-ref", "refs/tags/blob-base", blobId]);
    const unpeelableProject = await postJson(`${server.url}/api/projects`, {
      repository: { name: "status-fixture", path: fixture.repository },
      project: {
        name: "status-unpeelable",
        baseRef: "refs/tags/blob-base",
        sandboxImage: PYTHON_IMAGE,
        checks: [{ id: "verify", name: "Verify", argv: ["python", "checks/verify.py"] }],
      },
    });
    const unpeelableProjectId = String((await responseJson(unpeelableProject)).id);
    expect(
      await responseJson(
        await fetch(`${server.url}/api/projects/${unpeelableProjectId}/repository-status`),
      ),
    ).toMatchObject({
      availability: "unavailable",
      worktree: "unknown",
      baseCommit: null,
      issue: { code: "REPOSITORY_UNAVAILABLE" },
    });
    await git(fixture.repository, ["update-ref", "-d", "refs/tags/blob-base"]);

    await git(fixture.repository, ["checkout", "--detach", "main"]);
    expect(await responseJson(await fetch(statusUrl))).toMatchObject({
      availability: "available",
      worktree: "clean",
      branch: null,
      headMatchesBaseRef: true,
      issue: null,
    });
    await git(fixture.repository, ["checkout", "main"]);

    const headPath = path.join(fixture.repository, ".git", "HEAD");
    const validHead = await readFile(headPath);
    await writeFile(headPath, "not a valid head\n");
    const failedGitStatus = await responseJson(await fetch(statusUrl));
    expect(failedGitStatus).toMatchObject({
      availability: "unavailable",
      worktree: "unknown",
      head: null,
      branch: null,
      issue: { code: "REPOSITORY_UNAVAILABLE" },
    });
    expect(JSON.stringify(failedGitStatus)).not.toContain("not a valid head");
    expect(JSON.stringify(failedGitStatus)).not.toContain(fixture.repository);
    await writeFile(headPath, validHead);

    await git(fixture.repository, ["checkout", "-b", "ahead"]);
    await writeFile(path.join(fixture.repository, "src/greeting.txt"), "Hello from ahead!\n");
    await git(fixture.repository, ["add", "src/greeting.txt"]);
    await git(fixture.repository, ["commit", "-m", "advance head away from base ref"]);
    const divergent = await responseJson(await fetch(statusUrl));
    expect(divergent).toMatchObject({
      availability: "available",
      worktree: "clean",
      branch: "ahead",
      headMatchesBaseRef: false,
      issue: { code: "BASE_REF_NOT_HEAD" },
    });

    const movedRepository = path.join(fixture.root, "registered-repository-moved");
    await rename(fixture.repository, movedRepository);
    expect(await responseJson(await fetch(statusUrl))).toMatchObject({
      availability: "missing",
      worktree: "unknown",
      head: null,
      branch: null,
      issue: { code: "REPOSITORY_MISSING" },
    });

    await mkdir(fixture.repository);
    expect(await responseJson(await fetch(statusUrl))).toMatchObject({
      availability: "identity_changed",
      worktree: "unknown",
      head: null,
      branch: null,
      issue: { code: "REPOSITORY_IDENTITY_CHANGED" },
    });
  });

  test("propagates a repository-status client disconnect through AbortSignal", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const workspaceDist = path.join(fixture.root, "workspace-dist");
    await mkdir(workspaceDist);
    await writeFile(path.join(workspaceDist, "index.html"), "<!doctype html>");
    const runtime = await createIcarusRuntime(fixture.stateRoot);
    cleanups.push(async () => runtime.close());
    let resolveSignal: (signal: AbortSignal) => void = () => undefined;
    const signalReceived = new Promise<AbortSignal>((resolve) => {
      resolveSignal = resolve;
    });
    let resolveAborted: () => void = () => undefined;
    const operationAborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    runtime.service.getProjectRepositoryStatus = async (_projectId, signal) => {
      if (signal === undefined) throw new Error("Repository status signal was not provided");
      resolveSignal(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      resolveAborted();
      throw new IcarusError("CANCELLED", "Synthetic disconnect cancellation");
    };
    const server = await startWorkspaceServer(
      { runtime, stateRoot: fixture.stateRoot, workspaceDist },
      0,
    );
    cleanups.push(server.close);

    const request = http.get(`${server.url}/api/projects/project-id/repository-status`);
    request.on("error", () => undefined);
    const propagatedSignal = await signalReceived;
    expect(propagatedSignal.aborted).toBe(false);
    request.destroy();
    await operationAborted;
    expect(propagatedSignal.aborted).toBe(true);
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
    const missingRunEvents = await fetch(`${server.url}/api/runs/missing-run/events?after=0`);
    expect(missingRunEvents.status).toBe(404);
    expect(JSON.stringify(await responseJson(missingRunEvents))).toContain("NOT_FOUND");
    const missingRepositoryStatus = await fetch(
      `${server.url}/api/projects/missing-project/repository-status`,
    );
    expect(missingRepositoryStatus.status).toBe(404);
    expect(JSON.stringify(await responseJson(missingRepositoryStatus))).toContain("NOT_FOUND");

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
