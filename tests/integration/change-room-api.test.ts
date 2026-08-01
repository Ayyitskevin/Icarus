import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { startWorkspaceServer } from "../../packages/api/src/server.js";
import { createIcarusRuntime, type IcarusRuntime } from "../../packages/core/src/index.js";
import {
  createFixtureRepository,
  editResponse,
  jsonOutput,
  planResponse,
  PYTHON_IMAGE,
  repositoryFingerprint,
  runCli,
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

async function postJson(
  url: string,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
}

async function rawRequest(
  url: string,
  options: { readonly method?: string; readonly body?: string },
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: options.method ?? "GET" });
    const chunks: Buffer[] = [];
    request.on("response", (response) => {
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    request.once("error", reject);
    request.end(options.body);
  });
}

function persistenceSnapshot(database: TestDatabase): Record<string, readonly unknown[]> {
  const tables = (
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ readonly name: string }>
  ).map((entry) => entry.name);
  const snapshot: Record<string, readonly unknown[]> = {
    sequences: database.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(),
  };
  for (const table of tables) {
    snapshot[table] = database.prepare(`SELECT * FROM "${table}"`).all();
  }
  return snapshot;
}

function workspaceMutationHeaders(server: {
  readonly mode: string;
  readonly launchUrl: string;
  readonly url: string;
}): Readonly<Record<string, string>> {
  if (server.mode !== "mutation-capable") {
    throw new Error("Review-only workspace has no mutation session");
  }
  const launch = new URL(server.launchUrl);
  const match = /^#icarus-action-session=([A-Za-z0-9_-]{43})$/.exec(launch.hash);
  if (match === null || launch.origin !== server.url) {
    throw new Error("Workspace launch URL did not contain one canonical action session");
  }
  return {
    origin: server.url,
    authorization: `Bearer ${match[1] ?? ""}`,
    "content-type": "application/json",
    "x-icarus-action": "workspace.mutate",
  };
}

async function makeWorkspaceDist(root: string): Promise<string> {
  const workspaceDist = path.join(root, "workspace-dist");
  await mkdir(workspaceDist);
  await writeFile(path.join(workspaceDist, "index.html"), '<!doctype html><div id="root"></div>');
  return workspaceDist;
}

describe("Change Room workspace API", () => {
  test("serves bounded Change Room evidence for a completed CLI run, read-only", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const sourceBefore = await repositoryFingerprint(fixture.repository);
    const preimage = "Hello, world!\n";
    const preimageSha = createHash("sha256").update(preimage).digest("hex");
    const provider = await startOllamaQueue([planResponse(), editResponse(preimageSha)]);
    cleanups.push(provider.close);

    const check = JSON.stringify({
      id: "verify",
      name: "Verify greeting",
      argv: ["python", "checks/verify.py"],
    });
    for (const args of [
      ["repo", "add", "--name", "fixture", "--path", fixture.repository],
      [
        "project",
        "add",
        "--name",
        "golden",
        "--repo",
        "fixture",
        "--base-ref",
        "main",
        "--sandbox-image",
        PYTHON_IMAGE,
        "--check",
        check,
      ],
    ]) {
      expect((await runCli(fixture.stateRoot, args)).exitCode).toBe(0);
    }
    const planned = jsonOutput<{ id: string; planSha256: string }>(
      await runCli(fixture.stateRoot, [
        "run",
        "plan",
        "--project",
        "golden",
        "--task",
        "Replace the greeting and run the registered check.",
        "--target",
        "src/greeting.txt",
        "--provider",
        "ollama",
        "--model",
        "contract-model",
        "--base-url",
        provider.baseUrl,
      ]),
    );
    const approved = jsonOutput<{ state: string; verification: { diffSha256: string } }>(
      await runCli(fixture.stateRoot, [
        "run",
        "approve",
        planned.id,
        "--plan-sha",
        planned.planSha256,
        "--actor",
        "integration-test",
      ]),
    );
    expect(approved.state).toBe("awaiting_review");
    const diffSha = approved.verification.diffSha256;
    const reviewed = jsonOutput<{ state: string }>(
      await runCli(fixture.stateRoot, [
        "run",
        "review",
        planned.id,
        "--decision",
        "approve",
        "--diff-sha",
        diffSha,
        "--actor",
        "kevin",
      ]),
    );
    expect(reviewed.state).toBe("completed");

    const annotated = jsonOutput<{ card: string; actor: string }>(
      await runCli(fixture.stateRoot, [
        "run",
        "annotate",
        planned.id,
        "--card",
        "check_outcomes",
        "--text",
        "Observed green on the fixture.",
        "--actor",
        "kevin",
      ]),
    );
    expect(annotated).toMatchObject({ card: "check_outcomes", actor: "kevin" });
    const listed = jsonOutput<readonly unknown[]>(
      await runCli(fixture.stateRoot, ["run", "annotations", planned.id]),
    );
    expect(listed).toHaveLength(1);

    const badCard = await runCli(fixture.stateRoot, [
      "run",
      "annotate",
      planned.id,
      "--card",
      "everything",
      "--text",
      "bad card",
      "--actor",
      "kevin",
    ]);
    expect(badCard.exitCode).toBe(2);
    expect(badCard.stderr).toContain("INVALID_ANNOTATION");
    const secretBody = await runCli(fixture.stateRoot, [
      "run",
      "annotate",
      planned.id,
      "--card",
      "room",
      "--text",
      `token sk-${"a".repeat(24)}`,
      "--actor",
      "kevin",
    ]);
    expect(secretBody.exitCode).toBe(1);
    expect(secretBody.stderr).toContain("SECRET_INPUT_DETECTED");

    const workspaceDist = await makeWorkspaceDist(fixture.root);
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

    const persistenceObserver = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    const persistenceBefore = persistenceSnapshot(persistenceObserver);
    persistenceObserver.close();

    // The project-level index: bounded newest-first room summaries with safe metadata.
    const indexResponse = await fetch(`${server.url}/api/change-rooms`);
    expect(indexResponse.status).toBe(200);
    const index = await responseJson(indexResponse);
    expect(index).toMatchObject({ before: 2, snapshot: 1, hasMore: false });
    const rooms = index.rooms as readonly Record<string, unknown>[];
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      roomId: planned.id,
      state: "completed",
      phase: "completed",
      verificationOutcome: "passed",
      terminalReason: "completed",
      provider: {
        kind: "ollama",
        model: "contract-model",
        locality: "loopback",
        privacyClass: "local_process",
      },
    });

    // The room detail: the canonical explanation of the guarded change.
    const roomResponse = await fetch(`${server.url}/api/runs/${planned.id}/change-room`);
    expect(roomResponse.status).toBe(200);
    const room = await responseJson(roomResponse);
    expect(room).toMatchObject({
      schema: "icarus.change-room.v1",
      roomId: planned.id,
      state: "completed",
      phase: "completed",
      generatedBy: "deterministic_host_projection",
      integrity: { digestSemantics: "byte_binding_only", timelineTruncated: false },
    });
    const cards = room.cards as readonly Record<string, unknown>[];
    expect(cards.map((card) => card.kind)).toEqual([
      "task_scope",
      "base_context",
      "provider_plan",
      "plan_approval",
      "patchset",
      "registered_checks",
      "check_outcomes",
      "review_decision",
      "checkpoint",
      "rollback_restoration",
      "terminal_state",
    ]);
    const byKind = Object.fromEntries(cards.map((card) => [card.kind, card])) as Record<
      string,
      Record<string, unknown>
    >;
    expect(byKind.provider_plan).toMatchObject({
      provenanceClass: "provider_output",
      status: "available",
      body: { trustLabel: "untrusted_proposal", planSha256: planned.planSha256 },
    });
    expect(byKind.plan_approval).toMatchObject({
      provenanceClass: "approval_decision",
      status: "available",
      body: { approval: { actor: "integration-test", decision: "approve" } },
    });
    expect(byKind.patchset).toMatchObject({
      status: "available",
      body: {
        patchSet: {
          edits: [
            {
              op: "modify",
              path: "src/greeting.txt",
              replacementCount: 1,
            },
          ],
        },
        patchSetEditsTruncated: false,
        actionStatus: "completed",
        diffSha256: diffSha,
        changedPaths: ["src/greeting.txt"],
      },
    });
    const patchsetBody = byKind.patchset?.body as { diff: string };
    expect(String(patchsetBody.diff)).toContain("+Hello, Icarus!");
    expect(byKind.check_outcomes).toMatchObject({
      provenanceClass: "verification_evidence",
      body: { outcome: "passed" },
    });
    expect(byKind.review_decision).toMatchObject({
      body: { decision: { actor: "kevin", decision: "approve", digest: diffSha } },
    });
    expect(byKind.checkpoint).toMatchObject({ body: { status: "saved" } });
    expect(byKind.terminal_state).toMatchObject({
      body: { terminal: true, terminalReason: "completed" },
    });
    const annotations = room.annotations as readonly Record<string, unknown>[];
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      card: "check_outcomes",
      actor: "kevin",
      body: "Observed green on the fixture.",
    });
    const timeline = room.timeline as readonly Record<string, unknown>[];
    expect(timeline.length).toBeGreaterThan(5);
    for (const entry of timeline) {
      expect(Object.keys(entry).sort()).toEqual([
        "createdAt",
        "evidenceSection",
        "label",
        "sequence",
        "timestamp",
        "type",
      ]);
    }

    // Redaction boundary: no private runtime paths or payload bodies cross.
    const roomText = JSON.stringify(room);
    expect(roomText).not.toContain(fixture.stateRoot);
    expect(roomText).not.toContain("git-cache");
    expect(roomText).not.toContain("payload_json");
    expect(roomText).not.toContain("baseline_base64");
    expect(roomText).not.toContain("approved_base64");

    // Explain-this-change packets with receipts, deterministic across reads.
    const whatChanged = await responseJson(
      await fetch(`${server.url}/api/runs/${planned.id}/change-context?question=what_changed`),
    );
    expect(whatChanged).toMatchObject({
      schema: "icarus.change-context.v1",
      roomId: planned.id,
      question: "what_changed",
      generatedBy: "deterministic_host_projection",
    });
    const statements = (whatChanged.components as readonly { statement: string }[])
      .map((entry) => entry.statement)
      .join("\n");
    expect(statements).toContain("requires a separate recorded landing grant");
    const whyBlocked = await responseJson(
      await fetch(`${server.url}/api/runs/${planned.id}/change-context?question=why_blocked`),
    );
    expect(
      (whyBlocked.components as readonly { statement: string }[])
        .map((entry) => entry.statement)
        .join("\n"),
    ).toContain("not blocked");
    const replay = await responseJson(
      await fetch(`${server.url}/api/runs/${planned.id}/change-context?question=what_changed`),
    );
    expect(replay).toEqual(whatChanged);

    // Query contract validation.
    for (const suffix of ["", "?question=nope", "?question=what_changed&extra=1"]) {
      const invalid = await fetch(`${server.url}/api/runs/${planned.id}/change-context${suffix}`);
      expect(invalid.status).toBe(422);
    }
    const missingRun = await fetch(
      `${server.url}/api/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/change-room`,
    );
    expect(missingRun.status).toBe(404);
    for (const query of ["?before=0&snapshot=1", "?before=1&snapshot=99", "?before=x&snapshot=1"]) {
      const invalid = await fetch(`${server.url}/api/change-rooms${query}`);
      expect(invalid.status).toBe(422);
    }

    // The room routes add no authority: mutation verbs are refused by the
    // action-session boundary before routing, and no matching route exists
    // even behind the browser's fenced mutation session (ADR 0029).
    for (const method of ["POST", "PUT", "DELETE"]) {
      const roomMutation = await rawRequest(`${server.url}/api/runs/${planned.id}/change-room`, {
        method,
      });
      expect(roomMutation.status).toBe(401);
      const indexMutation = await rawRequest(`${server.url}/api/change-rooms`, { method });
      expect(indexMutation.status).toBe(401);
    }
    const annotationMutation = await postJson(
      `${server.url}/api/runs/${planned.id}/change-room/annotations`,
      { card: "room", text: "browser must not write", actor: "mallory" },
      workspaceMutationHeaders(server),
    );
    expect(annotationMutation.status).toBe(404);

    // Restart replay: the projection is derived, so a fresh process reads it identically.
    await server.close();
    runtime.close();
    runtime = await createIcarusRuntime(fixture.stateRoot);
    server = await startWorkspaceServer(
      { runtime, stateRoot: fixture.stateRoot, workspaceDist },
      0,
    );
    cleanups.push(server.close);
    const replayed = await responseJson(
      await fetch(`${server.url}/api/runs/${planned.id}/change-room`),
    );
    expect(replayed).toEqual(room);

    // Zero durable writes and a pristine source checkout after every read.
    const persistenceAfter = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    expect(persistenceSnapshot(persistenceAfter)).toEqual(persistenceBefore);
    persistenceAfter.close();
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
  }, 300_000);

  test("presents a planned draft room with honest pending evidence", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    const sourceBefore = await repositoryFingerprint(fixture.repository);
    const provider = await startOllamaQueue([planResponse()]);
    cleanups.push(provider.close);
    const workspaceDist = await makeWorkspaceDist(fixture.root);
    const runtime = await createIcarusRuntime(fixture.stateRoot);
    cleanups.push(async () => runtime.close());
    const server = await startWorkspaceServer(
      { runtime, stateRoot: fixture.stateRoot, workspaceDist },
      0,
    );
    cleanups.push(server.close);

    const mutationHeaders = workspaceMutationHeaders(server);
    const projectResponse = await postJson(
      `${server.url}/api/projects`,
      {
        repository: { name: "fixture", path: fixture.repository },
        project: {
          name: "golden",
          baseRef: "main",
          sandboxImage: PYTHON_IMAGE,
          checks: [{ id: "verify", name: "Verify greeting", argv: ["python", "checks/verify.py"] }],
        },
      },
      mutationHeaders,
    );
    expect(projectResponse.status).toBe(201);
    const projectId = String((await responseJson(projectResponse)).id);
    const draftResponse = await postJson(
      `${server.url}/api/runs`,
      {
        projectId,
        task: "Review one exact greeting replacement.",
        targets: ["src/greeting.txt"],
        provider: { model: "contract-model", baseUrl: provider.baseUrl },
      },
      mutationHeaders,
    );
    expect(draftResponse.status).toBe(201);
    const runId = String((await responseJson(draftResponse)).id);
    const plannedResponse = await postJson(
      `${server.url}/api/runs/${runId}/plan`,
      {},
      mutationHeaders,
    );
    expect(plannedResponse.status).toBe(200);

    const room = await responseJson(await fetch(`${server.url}/api/runs/${runId}/change-room`));
    expect(room).toMatchObject({
      schema: "icarus.change-room.v1",
      state: "awaiting_approval",
      phase: "awaiting_approval",
    });
    const cards = room.cards as readonly { kind: string; status: string }[];
    const statusByKind = Object.fromEntries(cards.map((card) => [card.kind, card.status]));
    expect(statusByKind).toMatchObject({
      task_scope: "available",
      base_context: "available",
      provider_plan: "available",
      plan_approval: "pending",
      patchset: "pending",
      registered_checks: "available",
      check_outcomes: "pending",
      review_decision: "pending",
      checkpoint: "pending",
      rollback_restoration: "not_applicable",
      terminal_state: "available",
    });

    // An operator CLI annotation becomes durable read-only browser context.
    runtime.service.annotateRun(runId, "provider_plan", "kevin", "Plan digest reviewed offline.");

    const persistenceObserver = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    const persistenceBefore = persistenceSnapshot(persistenceObserver);
    persistenceObserver.close();

    const annotatedRoom = await responseJson(
      await fetch(`${server.url}/api/runs/${runId}/change-room`),
    );
    expect(annotatedRoom.annotations).toHaveLength(1);
    expect(annotatedRoom.integrity).toMatchObject(room.integrity as Record<string, unknown>);

    const whyBlocked = await responseJson(
      await fetch(`${server.url}/api/runs/${runId}/change-context?question=why_blocked`),
    );
    const text = (whyBlocked.components as readonly { statement: string }[])
      .map((entry) => entry.statement)
      .join("\n");
    expect(text).toContain("plan approval");
    expect(text).toContain("run approve");

    const index = await responseJson(await fetch(`${server.url}/api/change-rooms`));
    const rooms = index.rooms as readonly Record<string, unknown>[];
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      roomId: runId,
      state: "awaiting_approval",
      verificationOutcome: "not_run",
      terminalReason: null,
      provider: { model: "contract-model" },
    });

    const roomText = JSON.stringify(annotatedRoom);
    expect(roomText).not.toContain(fixture.stateRoot);
    expect(roomText).not.toContain("payload_json");

    const persistenceAfter = new Database(path.join(fixture.stateRoot, "icarus.sqlite3"));
    const afterReads = persistenceSnapshot(persistenceAfter);
    persistenceAfter.close();
    // Every GET above is read-only: nothing was appended after the annotation
    // snapshot was taken.
    expect(afterReads).toEqual(persistenceBefore);
    expect(await repositoryFingerprint(fixture.repository)).toEqual(sourceBefore);
  });

  test("requires the exact one-shot CLI approval before migrating pre-annotation state", async () => {
    const fixture = await createFixtureRepository();
    cleanups.push(fixture.cleanup);
    expect(
      (
        await runCli(fixture.stateRoot, [
          "repo",
          "add",
          "--name",
          "fixture",
          "--path",
          fixture.repository,
        ])
      ).exitCode,
    ).toBe(0);
    const databasePath = path.join(fixture.stateRoot, "icarus.sqlite3");
    const legacy = new Database(databasePath);
    legacy.exec("DROP TABLE run_annotations");
    const repositoryCount = legacy.prepare("SELECT COUNT(*) AS count FROM repositories").get();
    legacy.close();
    const digestBeforeRefusal = createHash("sha256")
      .update(await readFile(databasePath))
      .digest("hex");

    const missing = await runCli(fixture.stateRoot, ["run", "list"], {
      ICARUS_APPROVE_SCHEMA_MIGRATION: undefined,
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("DATABASE_MIGRATION_REQUIRED");
    expect(
      createHash("sha256")
        .update(await readFile(databasePath))
        .digest("hex"),
    ).toBe(digestBeforeRefusal);

    const invalid = await runCli(fixture.stateRoot, ["run", "list"], {
      ICARUS_APPROVE_SCHEMA_MIGRATION: "approval-index-v1",
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("DATABASE_MIGRATION_REQUIRED");
    expect(
      createHash("sha256")
        .update(await readFile(databasePath))
        .digest("hex"),
    ).toBe(digestBeforeRefusal);

    const approved = await runCli(fixture.stateRoot, ["run", "list"], {
      ICARUS_APPROVE_SCHEMA_MIGRATION: "run-annotations-v1",
    });
    expect(approved.exitCode).toBe(0);
    const migrated = new Database(databasePath);
    expect(
      migrated
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_annotations'")
        .get(),
    ).toBeDefined();
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM repositories").get()).toEqual(
      repositoryCount,
    );
    migrated.close();
    expect(
      (
        await runCli(fixture.stateRoot, ["run", "list"], {
          ICARUS_APPROVE_SCHEMA_MIGRATION: undefined,
        })
      ).exitCode,
    ).toBe(0);
  });
});
