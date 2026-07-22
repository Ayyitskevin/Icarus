import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { startWorkspaceServer } from "../packages/api/dist/server.js";
import { createIcarusRuntime } from "../packages/core/dist/index.js";

const SANDBOX_IMAGE = `python:3.12-slim@sha256:${"c".repeat(64)}`;
const TARGET = "src/app.txt";
const TARGET_CONTENT = "browser acceptance source remains untouched\n";
const DIRTY_MARKER_NAME = ".browser-status-private-marker.txt";
const DIRTY_MARKER_CONTENT = "private dirty marker content must never render\n";
const TASK = "Inspect one bounded browser workspace request.";
const PLAN_SUMMARY = "Review one exact local target before any guarded execution.";
const START_TIMEOUT_MS = 15_000;
const UI_TIMEOUT_MS = 10_000;
const EVENT_POLL_INTERVAL_MS = 2_000;
const EVENT_POLL_FIRST_BACKOFF_MS = 4_000;
const HISTORICAL_EVENT_HIGH_WATER = 500;
const HISTORICAL_EVENT_SENTINEL = "/private/browser-history-payload-sentinel";
const VERIFICATION_PRIVATE_SENTINEL = "/private/browser-verification-response-sentinel";
const RUN_SUMMARY_PAGE_SIZE = 12;
const RUN_SUMMARY_MAX_PAGES = 4;
const RUN_SUMMARY_FIXTURE_COUNT = RUN_SUMMARY_PAGE_SIZE * RUN_SUMMARY_MAX_PAGES;
const PROJECT_PAGE_SIZE = 12;
const PROJECT_PAGE_MAX_PAGES = 4;
const PROJECT_PAGE_FIXTURE_COUNT = PROJECT_PAGE_SIZE * PROJECT_PAGE_MAX_PAGES;
const RUN_SUMMARY_PRIVATE_SENTINEL = "/private/browser-run-summary-heavy-sentinel";
const VALID_ARCHIVED_RUN_TASK = "Archived browser run 020";
const ALTERNATE_ARCHIVED_RUN_TASK = "Archived browser run 021";
const APPROVAL_HTML_SENTINEL = '<img data-approval-injection="true"> Recorded digest:';
const DIFF_HTML_SENTINEL = '<img data-diff-injection="true" src=x onerror=alert(1)>';

const Database = createRequire(new URL("../packages/core/package.json", import.meta.url))(
  "better-sqlite3",
);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForObserved(predicate, description, timeoutMs = UI_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function git(cwd, args) {
  const child = spawn("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (exitCode === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(
        new Error(
          `git ${args.join(" ")} failed (${exitCode ?? signal ?? "unknown"}): ${Buffer.concat(
            stderr,
          ).toString("utf8")}`,
        ),
      );
    });
  });
}

async function fingerprint(repository) {
  const gitDirectory = (await git(repository, ["rev-parse", "--git-dir"])).trim();
  const worktrees = await readdir(path.resolve(repository, gitDirectory, "worktrees")).catch(
    () => [],
  );
  const index = await readFile(path.resolve(repository, gitDirectory, "index"));
  return {
    head: (await git(repository, ["rev-parse", "HEAD"])).trim(),
    status: await git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    refs: await git(repository, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    config: await git(repository, ["config", "--local", "--null", "--list"]),
    indexSha256: createHash("sha256").update(index).digest("hex"),
    worktrees: worktrees.sort().join("\n"),
    targetSha256: createHash("sha256")
      .update(await readFile(path.join(repository, TARGET)))
      .digest("hex"),
  };
}

function persistenceSnapshot(stateRoot) {
  const database = new Database(path.join(stateRoot, "icarus.sqlite3"));
  try {
    return {
      repositories: database.prepare("SELECT * FROM repositories ORDER BY id").all(),
      projects: database.prepare("SELECT * FROM projects ORDER BY id").all(),
      runs: database.prepare("SELECT rowid AS cursor, * FROM runs ORDER BY rowid").all(),
      events: database.prepare("SELECT * FROM run_events ORDER BY id").all(),
      approvals: database.prepare("SELECT * FROM approvals ORDER BY id").all(),
      operations: database.prepare("SELECT * FROM operations ORDER BY id").all(),
      checkpoints: database.prepare("SELECT * FROM checkpoints ORDER BY run_id").all(),
      sequences: database.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(),
    };
  } finally {
    database.close();
  }
}

function runSummaryFixtureId(index) {
  return `f0000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function projectPageFixtureId(index) {
  return `e0000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function projectPageFixtureName(index) {
  return `browser-project-archive-${String(index).padStart(3, "0")}`;
}

function insertProjectPageFixtures(stateRoot) {
  const database = new Database(path.join(stateRoot, "icarus.sqlite3"));
  const cloneProject = database.prepare(
    `INSERT INTO projects
       (id, name, repository_id, base_ref, checks_json, sandbox_json, ceiling_json, created_at)
     SELECT ?, ?, repository_id, base_ref, checks_json, sandbox_json, ceiling_json, ?
     FROM projects WHERE name = 'browser-project'`,
  );
  try {
    database.transaction(() => {
      for (let index = 1; index <= PROJECT_PAGE_FIXTURE_COUNT; index += 1) {
        const inserted = cloneProject.run(
          projectPageFixtureId(index),
          projectPageFixtureName(index),
          "2026-07-22T11:00:00.000Z",
        );
        assert.equal(inserted.changes, 1, `fixture project ${index} must clone the valid project`);
      }
      for (const name of ["browser-project-two", "browser-project"]) {
        const moved = database
          .prepare(
            "UPDATE projects SET rowid = (SELECT MAX(rowid) + 1 FROM projects) WHERE name = ?",
          )
          .run(name);
        assert.equal(moved.changes, 1, `${name} must remain on the newest project page`);
      }
    })();
    const aggregate = database
      .prepare("SELECT COUNT(*) AS count, MAX(rowid) AS snapshot FROM projects")
      .get();
    assert.equal(aggregate.count, PROJECT_PAGE_FIXTURE_COUNT + 2);
    assert.equal(aggregate.snapshot, PROJECT_PAGE_FIXTURE_COUNT + 4);
    return { snapshot: aggregate.snapshot };
  } finally {
    database.close();
  }
}

function insertRunSummaryFixtures(stateRoot, browserRunId) {
  const database = new Database(path.join(stateRoot, "icarus.sqlite3"));
  const cloneRun = database.prepare(
    `INSERT INTO runs
       (id, project_id, task, target, provider_json, state, resume_state, base_commit,
        context_json, context_artifact_path, context_sha256, plan_json, plan_sha256,
        edit_json, cache_path, worktree_path, baseline_base64, approved_base64, diff,
        verification_json, tool_calls, input_tokens, output_tokens, active_runtime_ms,
        estimated_cost_usd, reserved_cost_usd, error_code, error_message, version,
        created_at, updated_at)
     SELECT ?, project_id, ?, target, provider_json, 'completed', NULL, base_commit,
            context_json, context_artifact_path, context_sha256, plan_json, plan_sha256,
            edit_json, cache_path, worktree_path, baseline_base64, approved_base64, diff,
            verification_json, tool_calls, input_tokens, output_tokens, active_runtime_ms,
            estimated_cost_usd, reserved_cost_usd, error_code, error_message, version,
            ?, ?
     FROM runs WHERE id = ?`,
  );
  const corruptHeavyColumns = database.prepare(
    `UPDATE runs
     SET provider_json = ?, base_commit = ?, context_json = ?, context_artifact_path = ?,
         context_sha256 = ?, plan_json = ?, plan_sha256 = ?, edit_json = ?, cache_path = ?,
         worktree_path = ?, baseline_base64 = ?, approved_base64 = ?, diff = ?,
         verification_json = ?, error_code = ?, error_message = ?
     WHERE id = ?`,
  );
  try {
    const addFixtures = database.transaction(() => {
      for (let index = 1; index <= RUN_SUMMARY_FIXTURE_COUNT; index += 1) {
        const id = runSummaryFixtureId(index);
        const task = `Archived browser run ${String(index).padStart(3, "0")}`;
        const timestamp = "2026-07-20T11:00:00.000Z";
        const result = cloneRun.run(id, task, timestamp, timestamp, browserRunId);
        assert.equal(result.changes, 1, `fixture run ${index} must clone the valid source run`);
        if (task !== VALID_ARCHIVED_RUN_TASK && task !== ALTERNATE_ARCHIVED_RUN_TASK) {
          const privateValue = `${RUN_SUMMARY_PRIVATE_SENTINEL}:${index}`;
          const corruptResult = corruptHeavyColumns.run(
            `${privateValue}:provider`,
            `${privateValue}:base`,
            `${privateValue}:context`,
            `${privateValue}:context-path`,
            `${privateValue}:context-digest`,
            `${privateValue}:plan`,
            `${privateValue}:plan-digest`,
            `${privateValue}:edit`,
            `${privateValue}:cache`,
            `${privateValue}:worktree`,
            `${privateValue}:baseline`,
            `${privateValue}:approved`,
            `${privateValue}:diff`,
            `${privateValue}:verification`,
            `${privateValue}:error-code`,
            `${privateValue}:error-message`,
            id,
          );
          assert.equal(corruptResult.changes, 1, `fixture run ${index} must poison heavy columns`);
        }
      }
      const reassigned = database
        .prepare("UPDATE runs SET project_id = ? WHERE id = ?")
        .run(projectPageFixtureId(20), runSummaryFixtureId(21));
      assert.equal(
        reassigned.changes,
        1,
        "the alternate archived run must belong to a project outside the newest catalog page",
      );
      const moved = database
        .prepare("UPDATE runs SET rowid = (SELECT MAX(rowid) + 1 FROM runs) WHERE id = ?")
        .run(browserRunId);
      assert.equal(moved.changes, 1, "the real browser run must remain on the newest summary page");
    });
    addFixtures();
    const aggregate = database
      .prepare(
        `SELECT COUNT(*) AS count, MAX(rowid) AS snapshot,
                SUM(CASE WHEN task IN (?, ?) THEN 1 ELSE 0 END) AS valid_archived
         FROM runs`,
      )
      .get(VALID_ARCHIVED_RUN_TASK, ALTERNATE_ARCHIVED_RUN_TASK);
    assert.equal(aggregate.count, RUN_SUMMARY_FIXTURE_COUNT + 1);
    assert.equal(aggregate.snapshot, RUN_SUMMARY_FIXTURE_COUNT + 2);
    assert.equal(aggregate.valid_archived, 2);
    return {
      snapshot: aggregate.snapshot,
      validArchivedRunId: runSummaryFixtureId(20),
      alternateArchivedRunId: runSummaryFixtureId(21),
    };
  } finally {
    database.close();
  }
}

function installPersistedDiffReviewFixture(stateRoot, runId) {
  const database = new Database(path.join(stateRoot, "icarus.sqlite3"));
  const addedLines = Array.from({ length: 80 }, (_, index) =>
    index === 40 ? DIFF_HTML_SENTINEL : `bounded persisted diff line ${String(index + 1)}`,
  );
  const diff = [
    `diff --git a/${TARGET} b/${TARGET}`,
    "index ce01362..63c704a 100644",
    `--- a/${TARGET}`,
    `+++ b/${TARGET}`,
    "@@ -1 +1,80 @@",
    `-${TARGET_CONTENT.trimEnd()}`,
    ...addedLines.map((line) => `+${line}`),
    "",
  ].join("\n");
  const diffSha256 = createHash("sha256").update(diff, "utf8").digest("hex");
  const verification = {
    outcome: "passed",
    checks: [],
    changedPaths: [TARGET],
    diffSha256,
    checkpointSha256: "d".repeat(64),
  };
  try {
    const secondaryProject = database
      .prepare("SELECT id FROM projects WHERE name = ?")
      .get("browser-project-two");
    assert.equal(
      typeof secondaryProject?.id,
      "string",
      "the persisted diff fixture requires the inactive secondary project",
    );
    const updated = database
      .prepare(
        `UPDATE runs
         SET project_id = ?, state = 'awaiting_review', diff = ?, verification_json = ?, updated_at = ?
         WHERE id = ? AND target = ?`,
      )
      .run(
        secondaryProject.id,
        diff,
        JSON.stringify(verification),
        "2026-07-22T12:30:00.000Z",
        runId,
        TARGET,
      );
    assert.equal(updated.changes, 1, "the persisted diff browser fixture must update one run");
    database
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, 1, 'verification.completed', '{}', ?)`,
      )
      .run(runId, "2026-07-22T12:30:00.000Z");
  } finally {
    database.close();
  }
  return { diff, diffSha256 };
}

function workspaceStateSnapshot(databasePath) {
  const database = new Database(databasePath);
  try {
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
  } finally {
    database.close();
  }
}

async function startProvider() {
  const requests = [];
  let responseGate = null;
  const releaseResponseGate = () => {
    const gate = responseGate;
    responseGate = null;
    gate?.release();
  };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      try {
        requests.push({
          method: request.method,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        const gate = responseGate;
        if (gate !== null) await gate.promise;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                summary: PLAN_SUMMARY,
                steps: [
                  "Review the selected target",
                  "Run the registered check only after approval",
                ],
                risks: ["This browser smoke stops before execution"],
                target: TARGET,
                checkIds: ["verify"],
              }),
            },
            prompt_eval_count: 12,
            eval_count: 8,
          }),
        );
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid request" }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Browser smoke provider did not bind to loopback");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    holdNextResponse: () => {
      if (responseGate !== null) throw new Error("A provider response is already held");
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      responseGate = { promise, release };
      return releaseResponseGate;
    },
    close: () => {
      releaseResponseGate();
      return new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      });
    },
  };
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    socket.addEventListener("message", (event) => void this.handleMessage(event));
    socket.addEventListener("close", () => this.handleClose());
    socket.addEventListener("error", () => this.handleClose());
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out connecting to the Chromium CDP endpoint")),
        START_TIMEOUT_MS,
      );
      const opened = () => {
        clearTimeout(timeout);
        socket.removeEventListener("error", failed);
        resolve();
      };
      const failed = () => {
        clearTimeout(timeout);
        socket.removeEventListener("open", opened);
        reject(new Error("Failed to connect to the Chromium CDP endpoint"));
      };
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
    });
    return new CdpClient(socket);
  }

  async handleMessage(event) {
    let raw;
    if (typeof event.data === "string") raw = event.data;
    else if (event.data instanceof Blob) raw = await event.data.text();
    else if (event.data instanceof ArrayBuffer) raw = Buffer.from(event.data).toString("utf8");
    else
      raw = Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength).toString();
    const message = JSON.parse(raw);
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error === undefined) pending.resolve(message.result ?? {});
      else pending.reject(new Error(`CDP ${pending.method} failed: ${message.error.message}`));
      return;
    }
    if (typeof message.method !== "string") return;
    const key = `${message.sessionId ?? "browser"}:${message.method}`;
    for (const listener of this.listeners.get(key) ?? []) {
      listener(message.params ?? {});
    }
  }

  handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error(`Chromium closed before CDP ${pending.method} completed`));
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("Chromium CDP connection is closed"));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      );
    });
  }

  on(sessionId, method, listener) {
    const key = `${sessionId ?? "browser"}:${method}`;
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => listeners.delete(listener);
  }

  waitForEvent(sessionId, method, timeoutMs = UI_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => undefined;
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      unsubscribe = this.on(sessionId, method, (params) => {
        clearTimeout(timeout);
        unsubscribe();
        resolve(params);
      });
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

async function waitForDevToolsEndpoint(profile, child, stderr) {
  const activePortPath = path.join(profile, "DevToolsActivePort");
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chromium exited before CDP was ready: ${stderr.value}`);
    }
    try {
      const [port, browserPath] = (await readFile(activePortPath, "utf8")).trim().split("\n");
      if (/^\d+$/.test(port ?? "") && browserPath?.startsWith("/devtools/browser/")) {
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for Chromium CDP: ${stderr.value}`);
}

async function startChromium(executable, profile) {
  await access(executable, fsConstants.X_OK);
  const stderr = { value: "" };
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-component-extensions-with-background-pages",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-extensions",
      "--disable-features=AutofillServerCommunication,MediaRouter,OptimizationHints",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-proxy-server",
      "--password-store=basic",
      "--safebrowsing-disable-auto-update",
      "--use-mock-keychain",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
      "--remote-allow-origins=*",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { shell: false, stdio: ["ignore", "ignore", "pipe"] },
  );
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stderr.on("data", (chunk) => {
    stderr.value = `${stderr.value}${chunk.toString("utf8")}`.slice(-32 * 1024);
  });
  try {
    const endpoint = await waitForDevToolsEndpoint(profile, child, stderr).catch((error) => {
      throw spawnError ?? error;
    });
    const cdp = await CdpClient.connect(endpoint);
    return { child, cdp, stderr };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (!(await waitForExit(child, 2_000))) {
      child.kill("SIGKILL");
      await waitForExit(child, 2_000);
    }
    throw error;
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener("exit", exited);
      resolve(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", exited);
  });
}

async function stopChromium(chromium) {
  if (chromium === undefined) return;
  await chromium.cdp.send("Browser.close").catch(() => undefined);
  if (!(await waitForExit(chromium.child, 3_000))) chromium.child.kill("SIGTERM");
  if (!(await waitForExit(chromium.child, 2_000))) {
    chromium.child.kill("SIGKILL");
    await waitForExit(chromium.child, 2_000);
  }
  chromium.cdp.close();
}

class BrowserPage {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }

  async evaluate(expression) {
    const response = await this.cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
    );
    if (response.exceptionDetails !== undefined) {
      const description =
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
      throw new Error(`Browser evaluation failed: ${description}`);
    }
    return response.result?.value;
  }

  call(fn, ...args) {
    return this.evaluate(`(${fn.toString()})(...${JSON.stringify(args)})`);
  }

  async waitFor(fn, args, description, timeoutMs = UI_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const value = await this.call(fn, ...args);
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await delay(25);
    }
    throw new Error(
      `Timed out waiting for ${description}${
        lastError === undefined ? "" : `: ${lastError.message}`
      }`,
    );
  }

  async setField(labelText, value) {
    const changed = await this.call(
      (label, nextValue) => {
        const normalize = (text) => text.replaceAll(/\s+/g, " ").trim();
        const fieldLabel = Array.from(document.querySelectorAll("label")).find((candidate) => {
          const ownText = Array.from(candidate.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent ?? "")
            .join(" ");
          return normalize(ownText) === label;
        });
        const control = fieldLabel?.querySelector("input, textarea");
        if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
          return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value");
        descriptor?.set?.call(control, nextValue);
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
        return control.value === nextValue;
      },
      labelText,
      value,
    );
    assert.equal(changed, true, `Could not set form field ${labelText}`);
    await delay(10);
  }

  async clickButton(text) {
    const clicked = await this.call((label) => {
      const normalize = (value) => value.replaceAll(/\s+/g, " ").trim();
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => normalize(candidate.textContent ?? "") === label,
      );
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    }, text);
    assert.equal(clicked, true, `Could not click enabled button ${text}`);
  }

  async clickButtonTwice(text) {
    const clicked = await this.call((label) => {
      const normalize = (value) => value.replaceAll(/\s+/g, " ").trim();
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => normalize(candidate.textContent ?? "") === label,
      );
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      button.click();
      return true;
    }, text);
    assert.equal(clicked, true, `Could not contend enabled button ${text}`);
  }

  async pressKey(key, code, virtualKeyCode) {
    const event = {
      key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
    };
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...event }, this.sessionId);
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event }, this.sessionId);
  }

  async clickRecentRun(task) {
    const clicked = await this.call((taskText) => {
      const section = document.querySelector('section[aria-labelledby="all-runs-heading"]');
      const button = Array.from(section?.querySelectorAll("button") ?? []).find(
        (candidate) => candidate.querySelector("strong")?.textContent?.trim() === taskText,
      );
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    }, task);
    assert.equal(clicked, true, `Could not open persisted run ${task}`);
  }

  async clickProject(name) {
    const clicked = await this.call((projectName) => {
      const section = document.querySelector('section[aria-labelledby="projects-heading"]');
      const button = Array.from(section?.querySelectorAll("button") ?? []).find(
        (candidate) => candidate.querySelector("strong")?.textContent?.trim() === projectName,
      );
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    }, name);
    assert.equal(clicked, true, `Could not select project ${name}`);
  }

  bodyText() {
    return this.call(() => document.body.innerText);
  }

  runPageTasks() {
    return this.call(() =>
      Array.from(document.querySelectorAll("#workspace-run-page .selection-list strong")).map(
        (node) => node.textContent?.trim() ?? "",
      ),
    );
  }

  projectPageNames() {
    return this.call(() =>
      Array.from(document.querySelectorAll("#workspace-project-page .selection-list strong")).map(
        (node) => node.textContent?.trim() ?? "",
      ),
    );
  }

  projectPageStatus() {
    return this.call(() =>
      document.querySelector("#workspace-project-page .run-page__status")?.textContent?.trim(),
    );
  }

  runPageStatus() {
    return this.call(() =>
      document.querySelector("#workspace-run-page .run-page__status")?.textContent?.trim(),
    );
  }

  runFact(label) {
    return this.call((factLabel) => {
      const root = document.querySelector(".run-evidence");
      const term = Array.from(root?.querySelectorAll("dt") ?? []).find(
        (candidate) => candidate.textContent?.trim() === factLabel,
      );
      return term?.parentElement?.querySelector("dd")?.textContent?.trim() ?? null;
    }, label);
  }

  historyFact(label) {
    return this.call((factLabel) => {
      const root = document.querySelector(".history-panel");
      const term = Array.from(root?.querySelectorAll("dt") ?? []).find(
        (candidate) => candidate.textContent?.trim() === factLabel,
      );
      return term?.parentElement?.querySelector("dd")?.textContent?.trim() ?? null;
    }, label);
  }

  verificationFact(label) {
    return this.call((factLabel) => {
      const root = document.querySelector("#verification-attempts");
      const term = Array.from(root?.querySelectorAll("dt") ?? []).find(
        (candidate) => candidate.textContent?.trim() === factLabel,
      );
      return term?.parentElement?.querySelector("dd")?.textContent?.trim() ?? null;
    }, label);
  }

  contextFact(label) {
    return this.call((factLabel) => {
      const root = document.querySelector("#context-summary-heading")?.closest("section");
      const term = Array.from(root?.querySelectorAll("dt") ?? []).find(
        (candidate) => candidate.textContent?.trim() === factLabel,
      );
      return term?.parentElement?.querySelector("dd")?.textContent?.trim() ?? null;
    }, label);
  }

  repositoryFact(label) {
    return this.call((factLabel) => {
      const root = document.querySelector(".repository-status");
      const term = Array.from(root?.querySelectorAll("dt") ?? []).find(
        (candidate) => candidate.textContent?.trim() === factLabel,
      );
      return term?.parentElement?.querySelector("dd")?.textContent?.trim() ?? null;
    }, label);
  }

  async clickTimelineEvidence(label) {
    const href = await this.call((eventLabel) => {
      const normalize = (value) => value.replaceAll(/\s+/g, " ").trim();
      const link = Array.from(
        document.querySelectorAll("#run-activity .timeline__evidence-link"),
      ).find((candidate) => normalize(candidate.textContent ?? "") === eventLabel);
      if (!(link instanceof HTMLAnchorElement)) return null;
      const target = link.getAttribute("href");
      link.click();
      return target;
    }, label);
    assert.equal(typeof href, "string", `Could not follow timeline evidence link ${label}`);
    return href;
  }

  locationHash() {
    return this.call(() => window.location.hash);
  }

  capability(label) {
    return this.call((capabilityLabel) => {
      const card = Array.from(document.querySelectorAll(".capability-card")).find(
        (candidate) => candidate.querySelector("h3")?.textContent?.trim() === capabilityLabel,
      );
      return card?.querySelector(".status")?.textContent?.trim() ?? null;
    }, label);
  }

  buttonDisabled(text) {
    return this.call((label) => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.replaceAll(/\s+/g, " ").trim() === label,
      );
      return button instanceof HTMLButtonElement ? button.disabled : null;
    }, text);
  }

  async setVisibility(state) {
    const changed = await this.call((nextState) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => nextState,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      return document.visibilityState === nextState;
    }, state);
    assert.equal(changed, true, `Could not set synthetic document visibility to ${state}`);
  }

  async installDelayedRunPageSuccess(page) {
    const installed = await this.call((payload) => {
      if (window.__icarusDelayedRunPage !== undefined) return false;
      const originalFetch = window.fetch;
      const state = {
        observed: false,
        originalFetch,
        release: null,
      };
      window.__icarusDelayedRunPage = state;
      window.fetch = (input, init) => {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, window.location.origin);
        if (
          !state.observed &&
          url.origin === window.location.origin &&
          url.pathname === "/api/runs" &&
          url.search.length > 0 &&
          (init?.method ?? "GET") === "GET"
        ) {
          state.observed = true;
          return new Promise((resolve) => {
            state.release = () => {
              window.fetch = originalFetch;
              delete window.__icarusDelayedRunPage;
              resolve(
                new Response(JSON.stringify(payload), {
                  status: 200,
                  headers: { "content-type": "application/json; charset=utf-8" },
                }),
              );
            };
          });
        }
        return originalFetch.call(window, input, init);
      };
      return true;
    }, page);
    assert.equal(installed, true, "Could not install the delayed run-page success fixture");
  }

  async installDelayedProjectPageSuccess(projectPage) {
    const installed = await this.call((payload) => {
      if (window.__icarusDelayedProjectPage !== undefined) return false;
      const originalFetch = window.fetch;
      const state = {
        observed: false,
        originalFetch,
        release: null,
      };
      window.__icarusDelayedProjectPage = state;
      window.fetch = (input, init) => {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, window.location.origin);
        if (
          !state.observed &&
          url.origin === window.location.origin &&
          url.pathname === "/api/projects" &&
          url.search.length > 0 &&
          (init?.method ?? "GET") === "GET"
        ) {
          state.observed = true;
          return new Promise((resolve) => {
            state.release = () => {
              window.fetch = originalFetch;
              delete window.__icarusDelayedProjectPage;
              resolve(
                new Response(JSON.stringify(payload), {
                  status: 200,
                  headers: { "content-type": "application/json; charset=utf-8" },
                }),
              );
            };
          });
        }
        return originalFetch.call(window, input, init);
      };
      return true;
    }, projectPage);
    assert.equal(installed, true, "Could not install the delayed project-page success fixture");
  }

  async releaseDelayedProjectPageSuccess() {
    const released = await this.call(() => {
      const state = window.__icarusDelayedProjectPage;
      if (state === undefined || state.release === null) return false;
      state.release();
      return true;
    });
    assert.equal(released, true, "Could not release the delayed project-page success fixture");
  }

  delayedRunPageObserved() {
    return this.call(() => window.__icarusDelayedRunPage?.observed === true);
  }

  async releaseDelayedRunPageSuccess() {
    const released = await this.call(() => {
      const state = window.__icarusDelayedRunPage;
      if (state === undefined) return false;
      if (state.release === null) {
        window.fetch = state.originalFetch;
        delete window.__icarusDelayedRunPage;
        return false;
      }
      state.release();
      return true;
    });
    assert.equal(released, true, "Could not release the delayed run-page success fixture");
  }

  async installDelayedRunDetailSuccess(runId, run) {
    const installed = await this.call(
      (expectedRunId, payload) => {
        if (window.__icarusDelayedRunDetail !== undefined) return false;
        const originalFetch = window.fetch;
        const state = {
          observed: false,
          originalFetch,
          release: null,
        };
        window.__icarusDelayedRunDetail = state;
        window.fetch = (input, init) => {
          const raw =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const url = new URL(raw, window.location.origin);
          if (
            !state.observed &&
            url.origin === window.location.origin &&
            url.pathname === `/api/runs/${encodeURIComponent(expectedRunId)}` &&
            url.search.length === 0 &&
            (init?.method ?? "GET") === "GET"
          ) {
            state.observed = true;
            return new Promise((resolve) => {
              state.release = () => {
                window.fetch = originalFetch;
                delete window.__icarusDelayedRunDetail;
                resolve(
                  new Response(JSON.stringify(payload), {
                    status: 200,
                    headers: { "content-type": "application/json; charset=utf-8" },
                  }),
                );
              };
            });
          }
          return originalFetch.call(window, input, init);
        };
        return true;
      },
      runId,
      run,
    );
    assert.equal(installed, true, "Could not install delayed selected-run detail");
  }

  delayedRunDetailObserved() {
    return this.call(() => window.__icarusDelayedRunDetail?.observed === true);
  }

  async releaseDelayedRunDetailSuccess() {
    const released = await this.call(() => {
      const state = window.__icarusDelayedRunDetail;
      if (state === undefined || state.release === null) return false;
      state.release();
      return true;
    });
    assert.equal(released, true, "Could not release delayed selected-run detail");
  }
}

async function createBrowserPage(chromium, workspaceUrl) {
  const { targetId } = await chromium.cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chromium.cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await chromium.cdp.send("Page.enable", {}, sessionId);
  await chromium.cdp.send("Runtime.enable", {}, sessionId);
  await chromium.cdp.send("Network.enable", {}, sessionId);
  await chromium.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);

  const networkRequests = [];
  const networkResponses = [];
  const networkFinished = [];
  const networkFailures = [];
  const networkRequestUrls = new Map();
  const blockedExternalRequests = [];
  const browserErrors = [];
  let eventFailuresRemaining = 0;
  let eventHistoryFailuresRemaining = 0;
  let verificationAttemptFailuresRemaining = 0;
  let projectPageFailuresRemaining = 0;
  let runPageFailuresRemaining = 0;
  let repositoryStatusFailuresRemaining = 0;
  let eventRequestHold = null;
  let historyRequestHold = null;
  let verificationRequestHold = null;
  let projectPageRequestHold = null;
  let runPageRequestHold = null;
  let workspaceRequestHold = null;
  chromium.cdp.on(sessionId, "Network.requestWillBeSent", (event) => {
    networkRequestUrls.set(event.requestId, event.request?.url);
    networkRequests.push({
      requestId: event.requestId,
      method: event.request?.method,
      url: event.request?.url,
      observedAt: Date.now(),
    });
  });
  chromium.cdp.on(sessionId, "Network.responseReceived", (event) => {
    networkResponses.push({
      requestId: event.requestId,
      status: event.response?.status,
      url: event.response?.url,
      observedAt: Date.now(),
    });
  });
  chromium.cdp.on(sessionId, "Network.loadingFinished", (event) => {
    networkFinished.push({
      requestId: event.requestId,
      url: networkRequestUrls.get(event.requestId),
      observedAt: Date.now(),
    });
    networkRequestUrls.delete(event.requestId);
  });
  chromium.cdp.on(sessionId, "Network.loadingFailed", (event) => {
    networkFailures.push({
      requestId: event.requestId,
      url: networkRequestUrls.get(event.requestId),
      canceled: event.canceled === true,
      errorText: event.errorText,
      observedAt: Date.now(),
    });
    networkRequestUrls.delete(event.requestId);
  });
  chromium.cdp.on(sessionId, "Runtime.exceptionThrown", (event) => {
    browserErrors.push(
      event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text,
    );
  });
  chromium.cdp.on(sessionId, "Runtime.consoleAPICalled", (event) => {
    if (event.type === "error") browserErrors.push("Browser console error");
  });
  chromium.cdp.on(sessionId, "Fetch.requestPaused", (event) => {
    const requestUrl = event.request?.url ?? "";
    let external = false;
    let localEventPoll = false;
    let localEventHistory = false;
    let localVerificationAttempt = false;
    let localProjectPage = false;
    let localRunPage = false;
    let localRepositoryStatus = false;
    let localWorkspaceRead = false;
    try {
      const parsed = new URL(requestUrl);
      external =
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.origin !== workspaceUrl;
      localEventPoll =
        parsed.origin === workspaceUrl &&
        event.request?.method === "GET" &&
        parsed.pathname.endsWith("/events");
      localEventHistory =
        parsed.origin === workspaceUrl &&
        event.request?.method === "GET" &&
        parsed.pathname.endsWith("/events/history");
      localVerificationAttempt =
        parsed.origin === workspaceUrl &&
        event.request?.method === "GET" &&
        parsed.pathname.endsWith("/verification-attempts");
      localProjectPage =
        parsed.origin === workspaceUrl &&
        event.request?.method === "GET" &&
        parsed.pathname === "/api/projects";
      localRunPage =
        parsed.origin === workspaceUrl &&
        event.request?.method === "GET" &&
        parsed.pathname === "/api/runs";
      localRepositoryStatus =
        parsed.origin === workspaceUrl &&
        event.request?.method === "GET" &&
        parsed.pathname.endsWith("/repository-status");
      localWorkspaceRead =
        parsed.origin === workspaceUrl &&
        event.request?.method === "GET" &&
        parsed.pathname === "/api/workspace";
    } catch {
      external = false;
    }
    if (external) blockedExternalRequests.push(requestUrl);
    if (
      localWorkspaceRead &&
      workspaceRequestHold !== null &&
      workspaceRequestHold.event === null
    ) {
      workspaceRequestHold.event = event;
      workspaceRequestHold.observed();
      return;
    }
    if (localEventPoll && eventRequestHold !== null && eventRequestHold.event === null) {
      const observation = {
        requestId: event.requestId,
        networkId: event.networkId ?? null,
        url: requestUrl,
        observedAt: Date.now(),
      };
      eventRequestHold.event = event;
      eventRequestHold.observation = observation;
      eventRequestHold.observed(observation);
      return;
    }
    if (localEventHistory && historyRequestHold !== null && historyRequestHold.event === null) {
      const observation = {
        requestId: event.requestId,
        networkId: event.networkId ?? null,
        url: requestUrl,
        observedAt: Date.now(),
      };
      historyRequestHold.event = event;
      historyRequestHold.observation = observation;
      historyRequestHold.observed(observation);
      return;
    }
    if (
      localVerificationAttempt &&
      verificationRequestHold !== null &&
      verificationRequestHold.event === null
    ) {
      const observation = {
        requestId: event.requestId,
        networkId: event.networkId ?? null,
        url: requestUrl,
        observedAt: Date.now(),
      };
      verificationRequestHold.event = event;
      verificationRequestHold.observation = observation;
      verificationRequestHold.observed(observation);
      return;
    }
    if (
      localProjectPage &&
      projectPageRequestHold !== null &&
      projectPageRequestHold.event === null
    ) {
      const observation = {
        requestId: event.requestId,
        networkId: event.networkId ?? null,
        url: requestUrl,
        observedAt: Date.now(),
      };
      projectPageRequestHold.event = event;
      projectPageRequestHold.observation = observation;
      projectPageRequestHold.observed(observation);
      return;
    }
    if (localRunPage && runPageRequestHold !== null && runPageRequestHold.event === null) {
      const observation = {
        requestId: event.requestId,
        networkId: event.networkId ?? null,
        url: requestUrl,
        observedAt: Date.now(),
      };
      runPageRequestHold.event = event;
      runPageRequestHold.observation = observation;
      runPageRequestHold.observed(observation);
      return;
    }
    const failEventPoll = localEventPoll && eventFailuresRemaining > 0;
    const failEventHistory = localEventHistory && eventHistoryFailuresRemaining > 0;
    const failVerificationAttempt =
      localVerificationAttempt && verificationAttemptFailuresRemaining > 0;
    const failProjectPage = localProjectPage && projectPageFailuresRemaining > 0;
    const failRunPage = localRunPage && runPageFailuresRemaining > 0;
    const failRepositoryStatus = localRepositoryStatus && repositoryStatusFailuresRemaining > 0;
    if (failEventPoll) eventFailuresRemaining -= 1;
    if (failEventHistory) eventHistoryFailuresRemaining -= 1;
    if (failVerificationAttempt) verificationAttemptFailuresRemaining -= 1;
    if (failProjectPage) projectPageFailuresRemaining -= 1;
    if (failRunPage) runPageFailuresRemaining -= 1;
    if (failRepositoryStatus) repositoryStatusFailuresRemaining -= 1;
    if (
      failEventPoll ||
      failEventHistory ||
      failVerificationAttempt ||
      failProjectPage ||
      failRunPage ||
      failRepositoryStatus
    ) {
      void chromium.cdp
        .send(
          "Fetch.fulfillRequest",
          {
            requestId: event.requestId,
            responseCode: 503,
            responseHeaders: [{ name: "content-type", value: "application/json; charset=utf-8" }],
            body: Buffer.from(
              JSON.stringify({
                error: {
                  code: "BROWSER_SMOKE_CONTROLLED_FAILURE",
                  message: "Controlled browser smoke read failure.",
                },
              }),
            ).toString("base64"),
          },
          sessionId,
        )
        .catch((error) => browserErrors.push(error.message));
      return;
    }
    void chromium.cdp
      .send(
        external ? "Fetch.failRequest" : "Fetch.continueRequest",
        external
          ? { requestId: event.requestId, errorReason: "BlockedByClient" }
          : { requestId: event.requestId },
        sessionId,
      )
      .catch((error) => browserErrors.push(error.message));
  });

  const loaded = chromium.cdp.waitForEvent(sessionId, "Page.loadEventFired");
  await chromium.cdp.send("Page.navigate", { url: workspaceUrl }, sessionId);
  await loaded;
  const page = new BrowserPage(chromium.cdp, sessionId);
  await page.waitFor(
    () => document.querySelector("h1")?.textContent?.includes("Icarus local workspace"),
    [],
    "the mounted React workspace",
  );
  return {
    page,
    sessionId,
    networkRequests,
    networkResponses,
    networkFinished,
    networkFailures,
    blockedExternalRequests,
    browserErrors,
    failNextEventPoll: () => {
      eventFailuresRemaining += 1;
    },
    failNextEventHistory: () => {
      eventHistoryFailuresRemaining += 1;
    },
    failNextVerificationAttempt: () => {
      verificationAttemptFailuresRemaining += 1;
    },
    failNextProjectPage: () => {
      projectPageFailuresRemaining += 1;
    },
    failNextRunPage: () => {
      runPageFailuresRemaining += 1;
    },
    failNextRepositoryStatus: () => {
      repositoryStatusFailuresRemaining += 1;
    },
    holdNextEventPoll: () => {
      if (eventRequestHold !== null) throw new Error("An event request is already held");
      let markObserved;
      const observed = new Promise((resolve) => {
        markObserved = resolve;
      });
      const hold = {
        event: null,
        observation: null,
        observed: markObserved,
      };
      eventRequestHold = hold;
      let finishPromise = null;
      const finish = () => {
        if (finishPromise !== null) return finishPromise;
        finishPromise = (async () => {
          if (eventRequestHold === hold) eventRequestHold = null;
          const held = hold.event;
          if (held === null) return "not_observed";
          try {
            await chromium.cdp.send(
              "Fetch.continueRequest",
              { requestId: held.requestId },
              sessionId,
            );
            return "continued";
          } catch (releaseError) {
            const sawCancellation = () =>
              held.networkId !== null &&
              held.networkId !== undefined &&
              networkFailures.some(
                (failure) => failure.requestId === held.networkId && failure.canceled,
              );
            if (!sawCancellation()) {
              await waitForObserved(
                sawCancellation,
                "the browser cancellation for an aborted held event poll",
                500,
              ).catch(() => undefined);
            }
            if (sawCancellation()) return "cancelled";
            try {
              await chromium.cdp.send(
                "Fetch.failRequest",
                { requestId: held.requestId, errorReason: "Aborted" },
                sessionId,
              );
              return "failed";
            } catch (cleanupError) {
              if (sawCancellation()) return "cancelled";
              throw new Error(
                `Could not release or fail the held event request: ${
                  releaseError instanceof Error ? releaseError.message : String(releaseError)
                }; cleanup failed: ${
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }`,
              );
            }
          }
        })();
        return finishPromise;
      };
      return {
        observed,
        observation: () => hold.observation,
        finish,
      };
    },
    holdNextEventHistory: () => {
      if (historyRequestHold !== null) throw new Error("A history request is already held");
      let markObserved;
      const observed = new Promise((resolve) => {
        markObserved = resolve;
      });
      const hold = {
        event: null,
        observation: null,
        observed: markObserved,
      };
      historyRequestHold = hold;
      let finishPromise = null;
      const finish = () => {
        if (finishPromise !== null) return finishPromise;
        finishPromise = (async () => {
          if (historyRequestHold === hold) historyRequestHold = null;
          const held = hold.event;
          if (held === null) return "not_observed";
          try {
            await chromium.cdp.send(
              "Fetch.continueRequest",
              { requestId: held.requestId },
              sessionId,
            );
            return "continued";
          } catch (releaseError) {
            const sawCancellation = () =>
              held.networkId !== null &&
              held.networkId !== undefined &&
              networkFailures.some(
                (failure) => failure.requestId === held.networkId && failure.canceled,
              );
            if (!sawCancellation()) {
              await waitForObserved(
                sawCancellation,
                "the browser cancellation for an aborted held history request",
                500,
              ).catch(() => undefined);
            }
            if (sawCancellation()) return "cancelled";
            try {
              await chromium.cdp.send(
                "Fetch.failRequest",
                { requestId: held.requestId, errorReason: "Aborted" },
                sessionId,
              );
              return "failed";
            } catch (cleanupError) {
              if (sawCancellation()) return "cancelled";
              throw new Error(
                `Could not release or fail the held history request: ${
                  releaseError instanceof Error ? releaseError.message : String(releaseError)
                }; cleanup failed: ${
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }`,
              );
            }
          }
        })();
        return finishPromise;
      };
      return {
        observed,
        observation: () => hold.observation,
        finish,
      };
    },
    holdNextVerificationAttempt: () => {
      if (verificationRequestHold !== null) {
        throw new Error("A verification-attempt request is already held");
      }
      let markObserved;
      const observed = new Promise((resolve) => {
        markObserved = resolve;
      });
      const hold = {
        event: null,
        observation: null,
        observed: markObserved,
      };
      verificationRequestHold = hold;
      let finishPromise = null;
      const finish = () => {
        if (finishPromise !== null) return finishPromise;
        finishPromise = (async () => {
          if (verificationRequestHold === hold) verificationRequestHold = null;
          const held = hold.event;
          if (held === null) return "not_observed";
          try {
            await chromium.cdp.send(
              "Fetch.continueRequest",
              { requestId: held.requestId },
              sessionId,
            );
            return "continued";
          } catch (releaseError) {
            const sawCancellation = () =>
              held.networkId !== null &&
              held.networkId !== undefined &&
              networkFailures.some(
                (failure) => failure.requestId === held.networkId && failure.canceled,
              );
            if (!sawCancellation()) {
              await waitForObserved(
                sawCancellation,
                "the browser cancellation for an aborted verification-attempt request",
                500,
              ).catch(() => undefined);
            }
            if (sawCancellation()) return "cancelled";
            try {
              await chromium.cdp.send(
                "Fetch.failRequest",
                { requestId: held.requestId, errorReason: "Aborted" },
                sessionId,
              );
              return "failed";
            } catch (cleanupError) {
              if (sawCancellation()) return "cancelled";
              throw new Error(
                `Could not release or fail the held verification-attempt request: ${
                  releaseError instanceof Error ? releaseError.message : String(releaseError)
                }; cleanup failed: ${
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }`,
              );
            }
          }
        })();
        return finishPromise;
      };
      return {
        observed,
        observation: () => hold.observation,
        finish,
      };
    },
    holdNextProjectPage: () => {
      if (projectPageRequestHold !== null) {
        throw new Error("A project-page request is already held");
      }
      let markObserved;
      const observed = new Promise((resolve) => {
        markObserved = resolve;
      });
      const hold = {
        event: null,
        observation: null,
        observed: markObserved,
      };
      projectPageRequestHold = hold;
      let finishPromise = null;
      const finish = () => {
        if (finishPromise !== null) return finishPromise;
        finishPromise = (async () => {
          if (projectPageRequestHold === hold) projectPageRequestHold = null;
          const held = hold.event;
          if (held === null) return "not_observed";
          try {
            await chromium.cdp.send(
              "Fetch.continueRequest",
              { requestId: held.requestId },
              sessionId,
            );
            return "continued";
          } catch (releaseError) {
            const sawCancellation = () =>
              held.networkId !== null &&
              held.networkId !== undefined &&
              networkFailures.some(
                (failure) => failure.requestId === held.networkId && failure.canceled,
              );
            if (!sawCancellation()) {
              await waitForObserved(
                sawCancellation,
                "the browser cancellation for an aborted held project-page request",
                500,
              ).catch(() => undefined);
            }
            if (sawCancellation()) return "cancelled";
            if (
              releaseError instanceof Error &&
              releaseError.message.includes("Invalid InterceptionId")
            ) {
              return "invalidated";
            }
            try {
              await chromium.cdp.send(
                "Fetch.failRequest",
                { requestId: held.requestId, errorReason: "Aborted" },
                sessionId,
              );
              return "failed";
            } catch (cleanupError) {
              if (sawCancellation()) return "cancelled";
              throw new Error(
                `Could not release or fail the held project-page request: ${
                  releaseError instanceof Error ? releaseError.message : String(releaseError)
                }; cleanup failed: ${
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }`,
              );
            }
          }
        })();
        return finishPromise;
      };
      return {
        observed,
        observation: () => hold.observation,
        finish,
      };
    },
    holdNextRunPage: () => {
      if (runPageRequestHold !== null) throw new Error("A run-page request is already held");
      let markObserved;
      const observed = new Promise((resolve) => {
        markObserved = resolve;
      });
      const hold = {
        event: null,
        observation: null,
        observed: markObserved,
      };
      runPageRequestHold = hold;
      let finishPromise = null;
      const finish = () => {
        if (finishPromise !== null) return finishPromise;
        finishPromise = (async () => {
          if (runPageRequestHold === hold) runPageRequestHold = null;
          const held = hold.event;
          if (held === null) return "not_observed";
          try {
            await chromium.cdp.send(
              "Fetch.continueRequest",
              { requestId: held.requestId },
              sessionId,
            );
            return "continued";
          } catch (releaseError) {
            const sawCancellation = () =>
              held.networkId !== null &&
              held.networkId !== undefined &&
              networkFailures.some(
                (failure) => failure.requestId === held.networkId && failure.canceled,
              );
            if (!sawCancellation()) {
              await waitForObserved(
                sawCancellation,
                "the browser cancellation for an aborted held run-page request",
                500,
              ).catch(() => undefined);
            }
            if (sawCancellation()) return "cancelled";
            if (
              releaseError instanceof Error &&
              releaseError.message.includes("Invalid InterceptionId")
            ) {
              return "invalidated";
            }
            try {
              await chromium.cdp.send(
                "Fetch.failRequest",
                { requestId: held.requestId, errorReason: "Aborted" },
                sessionId,
              );
              return "failed";
            } catch (cleanupError) {
              if (sawCancellation()) return "cancelled";
              throw new Error(
                `Could not release or fail the held run-page request: ${
                  releaseError instanceof Error ? releaseError.message : String(releaseError)
                }; cleanup failed: ${
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }`,
              );
            }
          }
        })();
        return finishPromise;
      };
      return {
        observed,
        observation: () => hold.observation,
        finish,
      };
    },
    holdNextWorkspaceRequest: () => {
      if (workspaceRequestHold !== null) throw new Error("A workspace request is already held");
      let markObserved;
      const observed = new Promise((resolve) => {
        markObserved = resolve;
      });
      workspaceRequestHold = { event: null, observed: markObserved };
      return {
        observed,
        release: async () => {
          await observed;
          const held = workspaceRequestHold?.event;
          workspaceRequestHold = null;
          if (held === null || held === undefined) {
            throw new Error("The held workspace request was not available to release");
          }
          await chromium.cdp.send(
            "Fetch.continueRequest",
            { requestId: held.requestId },
            sessionId,
          );
        },
      };
    },
  };
}

async function reloadPage(chromium, browserPage) {
  const loaded = chromium.cdp.waitForEvent(browserPage.sessionId, "Page.loadEventFired");
  await chromium.cdp.send("Page.reload", { ignoreCache: true }, browserPage.sessionId);
  await loaded;
  await browserPage.page.waitFor(
    () => document.querySelector("#projects-heading") !== null,
    [],
    "workspace state after reload",
  );
}

const chromiumExecutable = process.env.ICARUS_CHROMIUM_EXECUTABLE;
if (chromiumExecutable === undefined || chromiumExecutable.trim().length === 0) {
  throw new Error("ICARUS_CHROMIUM_EXECUTABLE must name an explicit local Chromium executable");
}

const root = await mkdtemp(path.join(os.tmpdir(), "icarus-workspace-browser-smoke-"));
let runtime;
let workspace;
let provider;
let chromium;
let releaseProviderResponse;
let finishHeldBrowserEventPoll;
let finishHeldBrowserHistoryRequest;
let finishHeldBrowserVerificationRequest;
let finishHeldBrowserProjectPageRequest;
let finishHeldBrowserRunPageRequest;
try {
  const repository = path.join(root, "repository");
  const stateRoot = path.join(root, "state");
  const profile = path.join(root, "chromium-profile");
  await mkdir(path.join(repository, "src"), { recursive: true });
  await mkdir(path.join(repository, "generated"));
  await mkdir(path.join(repository, "assets"));
  await mkdir(profile);
  await writeFile(path.join(repository, "README.md"), "# Browser smoke fixture\n");
  await writeFile(path.join(repository, TARGET), TARGET_CONTENT);
  await writeFile(path.join(repository, ".env.example"), "EXAMPLE_VALUE=placeholder\n");
  await writeFile(path.join(repository, "generated", "client.ts"), "generated output\n");
  await writeFile(path.join(repository, "assets", "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.name", "Icarus Browser Smoke"]);
  await git(repository, ["config", "user.email", "icarus-browser@example.invalid"]);
  await git(repository, ["add", "-f", "."]);
  await git(repository, ["commit", "-m", "browser smoke fixture"]);
  const before = await fingerprint(repository);

  provider = await startProvider();
  runtime = await createIcarusRuntime(stateRoot);
  workspace = await startWorkspaceServer(
    {
      runtime,
      stateRoot,
      workspaceDist: path.resolve("packages/workspace/dist"),
    },
    0,
  );
  chromium = await startChromium(path.resolve(chromiumExecutable), profile);
  const browserPage = await createBrowserPage(chromium, workspace.url);
  const {
    page,
    networkRequests,
    networkResponses,
    networkFinished,
    networkFailures,
    blockedExternalRequests,
    browserErrors,
  } = browserPage;

  await page.waitFor(
    () =>
      document.body.innerText.includes("No projects are registered.") &&
      document.body.innerText.includes("No run records exist in this pinned workspace page."),
    [],
    "the initial empty workspace",
  );
  assert.equal(await page.capability("Provider"), "unconfigured");
  assert.equal(await page.capability("Execution"), "unconfigured");

  await page.pressKey("Tab", "Tab", 9);
  assert.equal(
    await page.call(
      () =>
        document.activeElement?.classList.contains("skip-link") === true &&
        getComputedStyle(document.activeElement).transform !== "none",
    ),
    true,
    "the first keyboard stop must expose the skip link",
  );
  await page.pressKey("Enter", "Enter", 13);
  await page.waitFor(
    () => document.activeElement?.id === "workspace-main" && location.hash === "#workspace-main",
    [],
    "keyboard entry into the workspace main landmark",
  );
  const skipLinkKeyboardAccepted = true;

  await page.setField("Repository name", "browser-repository");
  await page.setField("Absolute repository path", repository);
  await page.setField("Project name", "browser-project");
  await page.setField("Digest-pinned sandbox image", SANDBOX_IMAGE);
  await page.setField("Exact check argv (JSON array, never shell text)", "{");
  await page.clickButton("Register project");
  await page.waitFor(
    () => document.body.innerText.includes("Check argv must be a valid JSON array of strings."),
    [],
    "the local project-form validation error",
  );
  assert.equal(
    networkRequests.filter(
      (request) => request.method === "POST" && request.url === `${workspace.url}/api/projects`,
    ).length,
    0,
  );

  await page.setField(
    "Exact check argv (JSON array, never shell text)",
    JSON.stringify(["node", "--test"]),
  );
  browserPage.failNextRepositoryStatus();
  await page.clickButton("Register project");
  await page.waitFor(
    () => document.querySelector("#project-detail-heading")?.textContent === "browser-project",
    [],
    "the persisted project detail",
  );

  await page.waitFor(
    () =>
      document.querySelector(".repository-status .status")?.textContent?.trim() ===
        "not observed" && document.body.innerText.includes("Repository was not observed"),
    [],
    "the truthful initial repository-observation failure",
  );
  assert.equal(
    await page.call(
      () =>
        document.querySelector(".repository-status .status")?.textContent?.trim() === "checking",
    ),
    false,
  );
  await page.clickButton("Refresh repository status");

  await page.waitFor(
    () => {
      const root = document.querySelector(".repository-status");
      const facts = new Map(
        Array.from(root?.querySelectorAll("dt") ?? []).map((term) => [
          term.textContent?.trim(),
          term.parentElement?.querySelector("dd")?.textContent?.trim(),
        ]),
      );
      return (
        facts.get("Availability") === "available" &&
        facts.get("Observed worktree") === "clean" &&
        facts.get("HEAD matches base ref") === "Yes"
      );
    },
    [],
    "the initial clean repository observation",
  );
  assert.equal(await page.repositoryFact("HEAD"), before.head.slice(0, 12));
  assert.equal(await page.repositoryFact("Branch"), "main");

  const dirtyMarker = path.join(repository, DIRTY_MARKER_NAME);
  await writeFile(dirtyMarker, DIRTY_MARKER_CONTENT);
  await page.clickButton("Refresh repository status");
  await page.waitFor(
    () => {
      const root = document.querySelector(".repository-status");
      const term = Array.from(root?.querySelectorAll("dt") ?? []).find(
        (candidate) => candidate.textContent?.trim() === "Observed worktree",
      );
      return term?.parentElement?.querySelector("dd")?.textContent?.trim() === "dirty";
    },
    [],
    "the controlled dirty repository observation",
  );
  let body = await page.bodyText();
  assert.equal(body.includes(DIRTY_MARKER_NAME), false);
  assert.equal(body.includes(DIRTY_MARKER_CONTENT.trim()), false);

  await rm(dirtyMarker);
  await page.clickButton("Refresh repository status");
  await page.waitFor(
    () => {
      const root = document.querySelector(".repository-status");
      const term = Array.from(root?.querySelectorAll("dt") ?? []).find(
        (candidate) => candidate.textContent?.trim() === "Observed worktree",
      );
      return term?.parentElement?.querySelector("dd")?.textContent?.trim() === "clean";
    },
    [],
    "the restored clean repository observation",
  );

  await page.setField("Repository name", "browser-repository");
  await page.setField("Absolute repository path", repository);
  await page.setField("Project name", "browser-project-two");
  await page.setField("Digest-pinned sandbox image", SANDBOX_IMAGE);
  await page.setField(
    "Exact check argv (JSON array, never shell text)",
    JSON.stringify(["node", "--test"]),
  );
  const heldWorkspaceRefresh = browserPage.holdNextWorkspaceRequest();
  await page.clickButton("Register project");
  await heldWorkspaceRefresh.observed;
  await page.waitFor(
    () => document.querySelector("#project-detail-heading")?.textContent === "browser-project-two",
    [],
    "the locally bound newly created project",
  );
  await page.clickProject("browser-project");
  await page.waitFor(
    () => document.querySelector("#project-detail-heading")?.textContent === "browser-project",
    [],
    "a newer project selection while workspace refresh is deferred",
  );
  await heldWorkspaceRefresh.release();
  await page.waitFor(
    () =>
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Refresh workspace" && !button.disabled,
      ),
    [],
    "the deferred workspace refresh completion",
  );
  assert.equal(
    await page.call(
      () => document.querySelector("#project-detail-heading")?.textContent === "browser-project",
    ),
    true,
    "a deferred project-created refresh must not overwrite the newer project selection",
  );

  const projectPageFixture = insertProjectPageFixtures(stateRoot);
  const projectPageFirstResponse = await fetch(`${workspace.url}/api/projects`);
  assert.equal(projectPageFirstResponse.status, 200);
  const projectPageFirst = await projectPageFirstResponse.json();
  assert.equal(projectPageFirst.snapshot, projectPageFixture.snapshot);
  assert.equal(projectPageFirst.projects.length, PROJECT_PAGE_SIZE);
  const projectPageSecondResponse = await fetch(
    workspace.url +
      "/api/projects?before=" +
      String(projectPageFirst.nextBefore) +
      "&snapshot=" +
      String(projectPageFixture.snapshot),
  );
  assert.equal(projectPageSecondResponse.status, 200);
  const projectPageSecond = await projectPageSecondResponse.json();
  const projectPagePersistenceBefore = persistenceSnapshot(stateRoot);
  const projectPageSourceBefore = await fingerprint(repository);
  const projectPageRequestCount = () =>
    networkRequests.filter((request) => {
      if (request.method !== "GET" || request.url === undefined) return false;
      const url = new URL(request.url);
      return (
        url.origin === workspace.url && url.pathname === "/api/projects" && url.search.length > 0
      );
    }).length;
  const settleHeldProjectPageRequest = async (held, observation, description) => {
    const releaseOutcome = await held.finish();
    finishHeldBrowserProjectPageRequest = undefined;
    assert.notEqual(releaseOutcome, "not_observed");
    if (releaseOutcome === "invalidated") return "invalidated";
    const matches = (record) =>
      observation.networkId === null
        ? record.url === observation.url && record.observedAt >= observation.observedAt
        : record.requestId === observation.networkId;
    await waitForObserved(
      () => networkFinished.some(matches) || networkFailures.some(matches),
      description,
    );
    assert.equal(
      networkFailures.some((failure) => matches(failure) && failure.canceled === true),
      true,
      `${description} must end as a transport cancellation`,
    );
    return "cancelled";
  };

  await reloadPage(chromium, browserPage);
  await page.waitFor(
    () =>
      document
        .querySelector("#workspace-project-page .run-page__status")
        ?.textContent?.includes("Page 1"),
    [],
    "the newest bounded project page",
  );
  const firstProjectPageNames = await page.projectPageNames();
  assert.equal(firstProjectPageNames.length, PROJECT_PAGE_SIZE);
  assert.deepEqual(firstProjectPageNames.slice(0, 2), ["browser-project", "browser-project-two"]);
  assert.match(
    (await page.projectPageStatus()) ?? "",
    /^Page 1 in a pinned session window of at most 4/,
  );

  browserPage.failNextProjectPage();
  await page.clickButton("Older projects");
  await page.waitFor(
    () =>
      document.querySelector("#workspace-project-page")?.getAttribute("aria-busy") === "false" &&
      document.body.innerText.includes("Controlled browser smoke read failure."),
    [],
    "the truthful failed project-page read",
  );
  assert.deepEqual(await page.projectPageNames(), firstProjectPageNames);
  await page.clickButton("Retry project page");
  await page.waitFor(
    () =>
      document
        .querySelector("#workspace-project-page .run-page__status")
        ?.textContent?.includes("Page 2"),
    [],
    "the retried second project page",
  );
  assert.equal((await page.projectPageNames()).length, PROJECT_PAGE_SIZE);
  await page.clickButton("Newer projects");
  await page.waitFor(
    () =>
      document
        .querySelector("#workspace-project-page .run-page__status")
        ?.textContent?.includes("Page 1"),
    [],
    "newer navigation back to the first project page",
  );

  const contendedProjectPageRequest = browserPage.holdNextProjectPage();
  finishHeldBrowserProjectPageRequest = contendedProjectPageRequest.finish;
  const contendedProjectPageBaseline = projectPageRequestCount();
  await page.clickButtonTwice("Older projects");
  const contendedProjectPageObservation = await contendedProjectPageRequest.observed;
  await page.waitFor(
    () =>
      document
        .querySelector("#workspace-project-page .run-page__status")
        ?.textContent?.includes("Page 2"),
    [],
    "the replacement second project-page request",
  );
  assert.equal(
    projectPageRequestCount(),
    contendedProjectPageBaseline + 2,
    "a contending project-page request must replace its held predecessor",
  );
  const contendedProjectPageOutcome = await settleHeldProjectPageRequest(
    contendedProjectPageRequest,
    contendedProjectPageObservation,
    "the superseded project-page request",
  );
  assert.notEqual(contendedProjectPageOutcome, "continued");

  const hiddenProjectPageRequest = browserPage.holdNextProjectPage();
  finishHeldBrowserProjectPageRequest = hiddenProjectPageRequest.finish;
  await page.clickButton("Older projects");
  const hiddenProjectPageObservation = await hiddenProjectPageRequest.observed;
  await page.setVisibility("hidden");
  await page.waitFor(
    () =>
      document.querySelector("#workspace-project-page")?.getAttribute("aria-busy") === "false" &&
      document.body.innerText.includes(
        "Project-page navigation paused while this document is hidden",
      ),
    [],
    "the hidden-document project-page cancellation",
  );
  const hiddenProjectPageOutcome = await settleHeldProjectPageRequest(
    hiddenProjectPageRequest,
    hiddenProjectPageObservation,
    "the hidden project-page request",
  );
  assert.match((await page.projectPageStatus()) ?? "", /^Page 2 /);
  await page.setVisibility("visible");
  await page.clickButton("Retry project page");
  await page.waitFor(
    () =>
      document
        .querySelector("#workspace-project-page .run-page__status")
        ?.textContent?.includes("Page 3"),
    [],
    "the third project page after hidden-request retry",
  );

  const selectionProjectPageRequest = browserPage.holdNextProjectPage();
  finishHeldBrowserProjectPageRequest = selectionProjectPageRequest.finish;
  await page.clickButton("Older projects");
  const selectionProjectPageObservation = await selectionProjectPageRequest.observed;
  await page.clickProject(projectPageFixtureName(26));
  await page.waitFor(
    (name) => document.querySelector("#project-detail-heading")?.textContent === name,
    [projectPageFixtureName(26)],
    "the project selection that cancels catalog navigation",
  );
  const selectionProjectPageOutcome = await settleHeldProjectPageRequest(
    selectionProjectPageRequest,
    selectionProjectPageObservation,
    "the selection-cancelled project-page request",
  );
  assert.match((await page.projectPageStatus()) ?? "", /^Page 3 /);

  await page.clickButton("Newer projects");
  await page.waitFor(
    () =>
      document
        .querySelector("#workspace-project-page .run-page__status")
        ?.textContent?.includes("Page 2"),
    [],
    "the second project page before delayed-response acceptance",
  );
  await page.clickButton("Newer projects");
  await page.waitFor(
    () =>
      document
        .querySelector("#workspace-project-page .run-page__status")
        ?.textContent?.includes("Page 1"),
    [],
    "the first project page before delayed-response acceptance",
  );
  await page.installDelayedProjectPageSuccess(projectPageSecond);
  await page.clickButton("Older projects");
  await page.waitFor(
    () => window.__icarusDelayedProjectPage?.observed === true,
    [],
    "the cancellation-ignoring delayed project-page success",
  );
  await page.clickButton("Refresh workspace");
  await page.waitFor(
    () =>
      document
        .querySelector("#workspace-project-page .run-page__status")
        ?.textContent?.includes("Page 1") &&
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Refresh workspace" && !button.disabled,
      ),
    [],
    "the refreshed newest project-page session",
  );
  await page.releaseDelayedProjectPageSuccess();
  await delay(100);
  assert.match((await page.projectPageStatus()) ?? "", /^Page 1 /);
  const lateProjectPageSuccessRejected = true;

  for (const pageNumber of [2, 3, 4]) {
    await page.clickButton("Older projects");
    await page.waitFor(
      (expectedPage) =>
        document
          .querySelector("#workspace-project-page .run-page__status")
          ?.textContent?.includes(`Page ${String(expectedPage)}`),
      [pageNumber],
      `bounded project page ${String(pageNumber)}`,
    );
    assert.equal((await page.projectPageNames()).length, PROJECT_PAGE_SIZE);
  }
  assert.equal(await page.buttonDisabled("Older projects"), true);
  assert.equal(
    (await page.bodyText()).includes("This browser session keeps four project pages."),
    true,
  );
  for (const expectedPage of [3, 2, 1]) {
    await page.clickButton("Newer projects");
    await page.waitFor(
      (pageNumber) =>
        document
          .querySelector("#workspace-project-page .run-page__status")
          ?.textContent?.includes(`Page ${String(pageNumber)}`),
      [expectedPage],
      `newer project navigation to page ${String(expectedPage)}`,
    );
  }
  await page.clickProject("browser-project");
  await page.waitFor(
    () => document.querySelector("#project-detail-heading")?.textContent === "browser-project",
    [],
    "the original project after bounded catalog navigation",
  );

  const browserProjectPageRequests = networkRequests.filter((request) => {
    if (request.method !== "GET" || request.url === undefined) return false;
    const url = new URL(request.url);
    return (
      url.origin === workspace.url && url.pathname === "/api/projects" && url.search.length > 0
    );
  });
  assert.ok(browserProjectPageRequests.length >= 10);
  for (const request of browserProjectPageRequests) {
    const url = new URL(request.url);
    assert.deepEqual([...url.searchParams.keys()].sort(), ["before", "snapshot"]);
    assert.equal(url.searchParams.get("snapshot"), String(projectPageFixture.snapshot));
    assert.match(url.searchParams.get("before") ?? "", /^[1-9][0-9]*$/);
  }
  assert.deepEqual(persistenceSnapshot(stateRoot), projectPagePersistenceBefore);
  assert.deepEqual(await fingerprint(repository), projectPageSourceBefore);
  const boundedProjectPageEvidence = {
    snapshot: projectPageFixture.snapshot,
    pageSize: PROJECT_PAGE_SIZE,
    maximumPages: PROJECT_PAGE_MAX_PAGES,
    requests: browserProjectPageRequests.length,
    contentionCancellation: contendedProjectPageOutcome,
    hiddenCancellation: hiddenProjectPageOutcome,
    selectionCancellation: selectionProjectPageOutcome,
    latePageSuccessRejected: lateProjectPageSuccessRejected,
    durableStateUnchanged: true,
    sourceUnchanged: true,
  };

  await page.setField("Tracked target path", "src/missing.txt");
  await page.clickButton("Preview context");
  await page.waitFor(
    () => document.body.innerText.includes("TARGET_NOT_TRACKED"),
    [],
    "a rendered backend context error",
  );

  await page.setField("Tracked target path", TARGET);
  await page.clickButton("Preview context");
  await page.waitFor(
    (target) =>
      document.querySelector("#context-summary-heading") !== null &&
      document.body.innerText.includes(target) &&
      !document.body.innerText.includes("TARGET_NOT_TRACKED"),
    [TARGET],
    "the deterministic context preview",
  );
  const firstDigest = await page.contextFact("Digest");
  assert.match(firstDigest, /^[a-f0-9]{64}$/);
  body = await page.bodyText();
  assert.equal(body.includes(TARGET_CONTENT.trim()), false);
  assert.equal(body.includes(".env.example"), false);
  assert.equal(body.includes("generated/client.ts"), false);
  assert.equal(body.includes("assets/binary.dat"), false);
  await page.clickButton("Preview context");
  await waitForObserved(
    () =>
      networkResponses.filter(
        (response) => response.status === 200 && response.url?.endsWith("/context-preview"),
      ).length === 2,
    "the second successful context-preview response",
  );
  await page.waitFor(
    () =>
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Preview context" && !button.disabled,
      ),
    [],
    "the repeated context preview response",
  );
  assert.equal(await page.contextFact("Digest"), firstDigest);

  await page.setField("Task", TASK);
  await page.setField("Tracked target", TARGET);
  await page.setField("Model", "browser-contract-model");
  await page.setField("Loopback provider URL", "not-a-url");
  await page.waitFor(
    () => document.body.innerText.includes("Provider URL is invalid."),
    [],
    "the provider URL validation state",
  );
  assert.equal(await page.buttonDisabled("Create persisted draft"), true);
  assert.equal(provider.requests.length, 0);

  await page.setField("Loopback provider URL", provider.baseUrl);
  await page.waitFor(
    () =>
      Array.from(document.querySelectorAll(".status")).some(
        (status) => status.textContent?.trim() === "provider configured",
      ),
    [],
    "the explicit loopback provider configuration",
  );
  assert.equal(await page.buttonDisabled("Create persisted draft"), false);
  await page.clickButton("Create persisted draft");
  await page.waitFor(
    (task) =>
      document.querySelector("#run-evidence-heading")?.textContent === task &&
      Array.from(document.querySelectorAll(".run-evidence dt")).some(
        (term) =>
          term.textContent?.trim() === "Exact persisted state" &&
          term.parentElement?.querySelector("dd")?.textContent?.trim() === "preparing",
      ),
    [TASK],
    "the persisted draft evidence",
  );
  assert.equal(provider.requests.length, 0);
  assert.equal(await page.runFact("Product phase"), "draft");
  assert.equal(await page.runFact("Exact persisted state"), "preparing");
  const browserRunId = await page.runFact("Run ID");
  assert.equal(typeof browserRunId, "string");
  assert.match(browserRunId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);

  const historyDatabase = new Database(path.join(stateRoot, "icarus.sqlite3"));
  try {
    const revision = historyDatabase
      .prepare("SELECT MAX(sequence) AS revision FROM run_events WHERE run_id = ?")
      .get(browserRunId)?.revision;
    assert.equal(revision, 1, "the browser fixture must begin with only run.created");
    const insertHistoryEvent = historyDatabase.prepare(
      `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    historyDatabase.transaction(() => {
      for (let sequence = 2; sequence <= HISTORICAL_EVENT_HIGH_WATER; sequence += 1) {
        insertHistoryEvent.run(
          browserRunId,
          sequence,
          sequence === 300 ? "context.assembled" : "operation.finished",
          `${HISTORICAL_EVENT_SENTINEL}:${sequence}`,
          "2026-07-20T12:00:00.000Z",
        );
      }
    })();
  } finally {
    historyDatabase.close();
  }

  const runSummaryFixture = insertRunSummaryFixtures(stateRoot, browserRunId);
  const diffReviewFixture = installPersistedDiffReviewFixture(
    stateRoot,
    runSummaryFixture.validArchivedRunId,
  );

  const runSummaryFirstResponse = await fetch(`${workspace.url}/api/runs`);
  assert.equal(runSummaryFirstResponse.status, 200);
  const runSummaryFirstPage = await runSummaryFirstResponse.json();
  assert.equal(runSummaryFirstPage.snapshot, runSummaryFixture.snapshot);
  assert.equal(runSummaryFirstPage.runs.length, RUN_SUMMARY_PAGE_SIZE);
  const runSummarySecondResponse = await fetch(
    workspace.url +
      "/api/runs?before=" +
      String(runSummaryFirstPage.nextBefore) +
      "&snapshot=" +
      String(runSummaryFixture.snapshot),
  );
  assert.equal(runSummarySecondResponse.status, 200);
  const runSummarySecondPage = await runSummarySecondResponse.json();
  const delayedRunDetailResponse = await fetch(
    `${workspace.url}/api/runs/${encodeURIComponent(runSummaryFixture.validArchivedRunId)}`,
  );
  assert.equal(delayedRunDetailResponse.status, 200);
  const delayedRunDetail = await delayedRunDetailResponse.json();
  const runSummaryPersistenceBefore = persistenceSnapshot(stateRoot);
  const runSummarySourceBefore = await fingerprint(repository);

  const runPageRequestCount = () =>
    networkRequests.filter((request) => {
      if (request.method !== "GET" || request.url === undefined) return false;
      const url = new URL(request.url);
      return url.origin === workspace.url && url.pathname === "/api/runs" && url.search.length > 0;
    }).length;
  const settleHeldRunPageRequest = async (held, observation, description) => {
    const releaseOutcome = await held.finish();
    finishHeldBrowserRunPageRequest = undefined;
    assert.notEqual(releaseOutcome, "not_observed");
    if (releaseOutcome === "invalidated") return "invalidated";
    const matches = (record) =>
      observation.networkId === null
        ? record.url === observation.url && record.observedAt >= observation.observedAt
        : record.requestId === observation.networkId;
    await waitForObserved(
      () => networkFinished.some(matches) || networkFailures.some(matches),
      description,
    );
    assert.equal(
      networkFailures.some((failure) => matches(failure) && failure.canceled === true),
      true,
      `${description} must end as a transport cancellation`,
    );
    return "cancelled";
  };

  await reloadPage(chromium, browserPage);
  await page.waitFor(
    (task) =>
      Array.from(
        document.querySelectorAll('section[aria-labelledby="all-runs-heading"] strong'),
      ).some((node) => node.textContent?.trim() === task),
    [TASK],
    "the newest bounded run-summary page",
  );
  const firstRunPageTasks = await page.runPageTasks();
  assert.equal(firstRunPageTasks.length, RUN_SUMMARY_PAGE_SIZE);
  assert.equal(firstRunPageTasks[0], TASK);
  assert.match(
    (await page.runPageStatus()) ?? "",
    /^Page 1 in a pinned session window of at most 4/,
  );
  body = await page.bodyText();
  assert.equal(body.includes("Project matches in loaded page"), true);
  assert.equal(body.includes("not the project's complete history"), true);
  assert.equal(body.includes(RUN_SUMMARY_PRIVATE_SENTINEL), false);

  browserPage.failNextRunPage();
  await page.clickButton("Older runs");
  await page.waitFor(
    () =>
      document.querySelector("#workspace-run-page")?.getAttribute("aria-busy") === "false" &&
      document.body.innerText.includes("Controlled browser smoke read failure."),
    [],
    "the truthful failed run-page read",
  );
  assert.deepEqual(await page.runPageTasks(), firstRunPageTasks);
  await page.clickButton("Retry run page");
  await page.waitFor(
    () =>
      document
        .querySelector("#workspace-run-page .run-page__status")
        ?.textContent?.includes("Page 2"),
    [],
    "the retried second run page",
  );
  assert.equal((await page.runPageTasks()).length, RUN_SUMMARY_PAGE_SIZE);
  await page.clickButton("Newer runs");
  await page.waitFor(
    (task) =>
      document
        .querySelector("#workspace-run-page .run-page__status")
        ?.textContent?.includes("Page 1") &&
      Array.from(document.querySelectorAll("#workspace-run-page strong")).some(
        (node) => node.textContent?.trim() === task,
      ),
    [TASK],
    "newer navigation back to the first run page",
  );

  const contendedRunPageRequest = browserPage.holdNextRunPage();
  finishHeldBrowserRunPageRequest = contendedRunPageRequest.finish;
  const contendedRunPageBaseline = runPageRequestCount();
  await page.clickButtonTwice("Older runs");
  const contendedRunPageObservation = await contendedRunPageRequest.observed;
  await page.waitFor(
    () =>
      document
        .querySelector("#workspace-run-page .run-page__status")
        ?.textContent?.includes("Page 2"),
    [],
    "the replacement second run-page request",
  );
  assert.equal(
    runPageRequestCount(),
    contendedRunPageBaseline + 2,
    "a contending run-page request must replace its held predecessor",
  );
  const contendedRunPageOutcome = await settleHeldRunPageRequest(
    contendedRunPageRequest,
    contendedRunPageObservation,
    "the superseded run-page request",
  );
  assert.notEqual(contendedRunPageOutcome, "continued");

  const hiddenRunPageRequest = browserPage.holdNextRunPage();
  finishHeldBrowserRunPageRequest = hiddenRunPageRequest.finish;
  await page.clickButton("Older runs");
  const hiddenRunPageObservation = await hiddenRunPageRequest.observed;
  await page.setVisibility("hidden");
  await page.waitFor(
    () =>
      document.querySelector("#workspace-run-page")?.getAttribute("aria-busy") === "false" &&
      document.body.innerText.includes("paused while this document is hidden"),
    [],
    "the hidden-document run-page cancellation",
  );
  const hiddenRunPageOutcome = await settleHeldRunPageRequest(
    hiddenRunPageRequest,
    hiddenRunPageObservation,
    "the hidden run-page request",
  );
  assert.match((await page.runPageStatus()) ?? "", /^Page 2 /);
  await page.setVisibility("visible");
  await page.clickButton("Retry run page");
  await page.waitFor(
    () =>
      document
        .querySelector("#workspace-run-page .run-page__status")
        ?.textContent?.includes("Page 3") &&
      Array.from(document.querySelectorAll("#workspace-run-page strong")).some(
        (node) => node.textContent?.trim() === "Archived browser run 019",
      ),
    [],
    "the third run page after hidden-request retry",
  );
  const thirdRunPageTasks = await page.runPageTasks();
  assert.equal(thirdRunPageTasks.includes(VALID_ARCHIVED_RUN_TASK), true);
  assert.equal(thirdRunPageTasks.includes(ALTERNATE_ARCHIVED_RUN_TASK), true);
  await page.clickRecentRun("Archived browser run 019");
  await page.waitFor(
    () =>
      document.querySelector("#run-evidence-heading") === null &&
      document.body.innerText.includes("DATABASE_ERROR"),
    [],
    "a failed lazy detail read that preserves the run-summary page",
  );
  assert.deepEqual(await page.runPageTasks(), thirdRunPageTasks);

  const selectionRunPageRequest = browserPage.holdNextRunPage();
  finishHeldBrowserRunPageRequest = selectionRunPageRequest.finish;
  await page.clickButton("Older runs");
  const selectionRunPageObservation = await selectionRunPageRequest.observed;
  await page.clickRecentRun(ALTERNATE_ARCHIVED_RUN_TASK);
  await page.waitFor(
    (runId) =>
      Array.from(document.querySelectorAll(".run-evidence dt")).some(
        (term) =>
          term.textContent?.trim() === "Run ID" &&
          term.parentElement?.querySelector("dd")?.textContent?.trim() === runId,
      ),
    [runSummaryFixture.alternateArchivedRunId],
    "lazy full detail for an older run summary",
  );
  const selectionRunPageOutcome = await settleHeldRunPageRequest(
    selectionRunPageRequest,
    selectionRunPageObservation,
    "the selection-cancelled run-page request",
  );
  assert.match((await page.runPageStatus()) ?? "", /^Page 3 /);
  assert.equal(
    networkRequests.some(
      (request) =>
        request.method === "GET" &&
        request.url ===
          workspace.url +
            "/api/runs/" +
            encodeURIComponent(runSummaryFixture.alternateArchivedRunId),
    ),
    true,
    "summary selection must use the existing full selected-run route",
  );
  assert.equal(
    await page.call(
      () => document.querySelectorAll("#workspace-project-page button[aria-pressed='true']").length,
    ),
    0,
    "an open run outside the loaded catalog page must not select an unrelated project",
  );
  for (const expectedPage of [2, 3]) {
    await page.clickButton("Older projects");
    await page.waitFor(
      (pageNumber) =>
        document
          .querySelector("#workspace-project-page .run-page__status")
          ?.textContent?.includes(`Page ${String(pageNumber)}`),
      [expectedPage],
      `project navigation while an off-page run remains open on page ${String(expectedPage)}`,
    );
    assert.equal(await page.runFact("Run ID"), runSummaryFixture.alternateArchivedRunId);
  }
  assert.equal(
    await page.call(
      (name) =>
        Array.from(document.querySelectorAll("#workspace-project-page button")).some(
          (button) =>
            button.getAttribute("aria-pressed") === "true" &&
            button.querySelector("strong")?.textContent?.trim() === name,
        ),
      projectPageFixtureName(20),
    ),
    true,
    "the catalog may select only the project that owns the visible run",
  );
  await page.clickButton("Refresh workspace");
  await page.waitFor(
    (runId) =>
      document
        .querySelector("#workspace-project-page .run-page__status")
        ?.textContent?.includes("Page 1") &&
      Array.from(document.querySelectorAll(".run-evidence dt")).some(
        (term) =>
          term.textContent?.trim() === "Run ID" &&
          term.parentElement?.querySelector("dd")?.textContent?.trim() === runId,
      ),
    [runSummaryFixture.alternateArchivedRunId],
    "workspace refresh while an off-page project run remains visible",
  );
  assert.equal(
    await page.call(
      () => document.querySelectorAll("#workspace-project-page button[aria-pressed='true']").length,
    ),
    0,
    "refresh must not mark a first-page project unrelated to the visible run",
  );
  const offPageRunSelectionPreserved = true;
  await page.clickButton("← Back to project");
  await page.waitFor(
    (name) => document.querySelector("#project-detail-heading")?.textContent === name,
    [projectPageFixtureName(20)],
    "the project after lazy older-run detail",
  );
  for (const expectedPage of [2, 3]) {
    await page.clickButton("Older runs");
    await page.waitFor(
      (pageNumber) =>
        document
          .querySelector("#workspace-run-page .run-page__status")
          ?.textContent?.includes(`Page ${String(pageNumber)}`),
      [expectedPage],
      `restored run page ${String(expectedPage)} after workspace refresh`,
    );
  }

  await page.installDelayedRunDetailSuccess(runSummaryFixture.validArchivedRunId, delayedRunDetail);
  await page.clickRecentRun(VALID_ARCHIVED_RUN_TASK);
  await page.waitFor(
    () => window.__icarusDelayedRunDetail?.observed === true,
    [],
    "the deliberately delayed selected-run detail",
  );
  await page.clickRecentRun(ALTERNATE_ARCHIVED_RUN_TASK);
  await page.waitFor(
    (runId) =>
      Array.from(document.querySelectorAll(".run-evidence dt")).some(
        (term) =>
          term.textContent?.trim() === "Run ID" &&
          term.parentElement?.querySelector("dd")?.textContent?.trim() === runId,
      ),
    [runSummaryFixture.alternateArchivedRunId],
    "the newer selected-run detail",
  );
  await page.releaseDelayedRunDetailSuccess();
  await delay(100);
  assert.equal(await page.runFact("Run ID"), runSummaryFixture.alternateArchivedRunId);
  const lateRunDetailRejected = true;
  await page.clickButton("← Back to project");
  await page.waitFor(
    (name) => document.querySelector("#project-detail-heading")?.textContent === name,
    [projectPageFixtureName(20)],
    "the project after the selected-run generation guard",
  );

  await page.clickRecentRun(VALID_ARCHIVED_RUN_TASK);
  await page.waitFor(
    (runId) =>
      Array.from(document.querySelectorAll(".run-evidence dt")).some(
        (term) =>
          term.textContent?.trim() === "Run ID" &&
          term.parentElement?.querySelector("dd")?.textContent?.trim() === runId,
      ),
    [runSummaryFixture.validArchivedRunId],
    "the bounded persisted diff review fixture",
  );
  const diffReviewBrowserEvidence = await page.call((expectedDiff) => {
    const root = document.querySelector("#run-diff");
    const fact = (label) => {
      const term = Array.from(root?.querySelectorAll("dt") ?? []).find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      return term?.parentElement?.querySelector("dd")?.textContent?.trim() ?? null;
    };
    return {
      heading: root?.querySelector("h3")?.textContent?.trim() ?? null,
      status: root?.querySelector(".status")?.textContent?.trim() ?? null,
      runState: fact("Exact persisted run state"),
      verification: fact("Verification outcome"),
      path: fact("Recorded changed path"),
      digest: fact("Recorded diff digest"),
      digestRelationship: fact("Digest relationship"),
      detailsOpen: root?.querySelector("details")?.open ?? null,
      exactPatch: root?.querySelector("pre")?.textContent === expectedDiff,
      injectedElement: root?.querySelector('[data-diff-injection="true"]') !== null,
      buttonCount: root?.querySelectorAll("button").length ?? -1,
      tabIndex: root?.getAttribute("tabindex") ?? null,
      patchTabIndex: root?.querySelector("pre")?.getAttribute("tabindex") ?? null,
      patchRole: root?.querySelector("pre")?.getAttribute("role") ?? null,
      patchLabelledBy: root?.querySelector("pre")?.getAttribute("aria-labelledby") ?? null,
      truthCopy:
        root?.textContent?.includes("This does not prove current repository bytes.") ?? false,
    };
  }, diffReviewFixture.diff);
  assert.deepEqual(diffReviewBrowserEvidence, {
    heading: "Persisted diff review",
    status: "exact persisted text",
    runState: "awaiting_review",
    verification: "passed",
    path: TARGET,
    digest: diffReviewFixture.diffSha256,
    digestRelationship: "displayed text rehash match",
    detailsOpen: true,
    exactPatch: true,
    injectedElement: false,
    buttonCount: 0,
    tabIndex: "-1",
    patchTabIndex: "0",
    patchRole: "region",
    patchLabelledBy: "persisted-diff-patch-heading",
    truthCopy: true,
  });
  const keyboardStart = await page.call(() => {
    const summary = document.querySelector("#persisted-diff-patch-heading");
    const patch = document.querySelector(".diff-review__patch");
    if (!(summary instanceof HTMLElement) || !(patch instanceof HTMLElement)) return null;
    summary.focus();
    return {
      summaryFocused: document.activeElement === summary,
      overflow: patch.scrollHeight > patch.clientHeight,
      scrollTop: patch.scrollTop,
    };
  });
  assert.deepEqual(keyboardStart, { summaryFocused: true, overflow: true, scrollTop: 0 });
  await page.pressKey("Tab", "Tab", 9);
  await page.waitFor(
    () => document.activeElement?.classList.contains("diff-review__patch") === true,
    [],
    "keyboard focus on the persisted diff scroll region",
  );
  await page.pressKey("PageDown", "PageDown", 34);
  await page.waitFor(
    () => (document.querySelector(".diff-review__patch")?.scrollTop ?? 0) > 0,
    [],
    "keyboard scrolling in the persisted diff region",
  );
  assert.equal((await page.bodyText()).includes(DIFF_HTML_SENTINEL), true);
  const diffEvidenceHref = await page.clickTimelineEvidence("verification completed");
  assert.equal(diffEvidenceHref, "#run-diff");
  await page.waitFor(
    () => window.location.hash === "#run-diff" && document.querySelector("#run-diff") !== null,
    [],
    "timeline-to-diff evidence anchor navigation",
  );
  await page.clickButton("← Back to project");
  await page.waitFor(
    () => document.querySelector("#project-detail-heading")?.textContent === "browser-project-two",
    [],
    "the persisted diff fixture project after bounded diff review",
  );
  await page.clickProject("browser-project");
  await page.waitFor(
    () => document.querySelector("#project-detail-heading")?.textContent === "browser-project",
    [],
    "the project after bounded diff review",
  );

  const unmountedRunPageRequest = browserPage.holdNextRunPage();
  finishHeldBrowserRunPageRequest = unmountedRunPageRequest.finish;
  await page.clickButton("Older runs");
  const unmountedRunPageObservation = await unmountedRunPageRequest.observed;
  await reloadPage(chromium, browserPage);
  const unmountedRunPageOutcome = await settleHeldRunPageRequest(
    unmountedRunPageRequest,
    unmountedRunPageObservation,
    "the unmounted run-page request",
  );
  await page.waitFor(
    (task) =>
      document
        .querySelector("#workspace-run-page .run-page__status")
        ?.textContent?.includes("Page 1") &&
      Array.from(document.querySelectorAll("#workspace-run-page strong")).some(
        (node) => node.textContent?.trim() === task,
      ),
    [TASK],
    "the newest page after unmount cancellation",
  );

  await page.installDelayedRunPageSuccess(runSummarySecondPage);
  await page.clickButton("Older runs");
  await page.waitFor(
    () => window.__icarusDelayedRunPage?.observed === true,
    [],
    "the cancellation-ignoring delayed run-page success",
  );
  await page.clickButton("Refresh workspace");
  await page.waitFor(
    (task) =>
      document
        .querySelector("#workspace-run-page .run-page__status")
        ?.textContent?.includes("Page 1") &&
      Array.from(document.querySelectorAll("#workspace-run-page strong")).some(
        (node) => node.textContent?.trim() === task,
      ) &&
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Refresh workspace" && !button.disabled,
      ),
    [TASK],
    "the refreshed newest run-page session",
  );
  await page.releaseDelayedRunPageSuccess();
  await delay(100);
  assert.match((await page.runPageStatus()) ?? "", /^Page 1 /);
  assert.equal((await page.runPageTasks())[0], TASK);
  const lateRunPageSuccessRejected = true;

  const heldRunPageRefresh = browserPage.holdNextWorkspaceRequest();
  await page.clickButton("Refresh workspace");
  await heldRunPageRefresh.observed;
  await page.waitFor(
    () => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const older = buttons.find((button) => button.textContent?.trim() === "Older runs");
      const refresh = document.querySelector(".app-header > button");
      return older?.disabled === true && refresh?.disabled === true;
    },
    [],
    "run-page navigation disabled during workspace refresh",
  );
  const refreshNavigationBaseline = runPageRequestCount();
  const refreshNavigationAttempted = await page.call(() => {
    const older = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Older runs",
    );
    if (!(older instanceof HTMLButtonElement)) return false;
    older.disabled = false;
    older.click();
    older.disabled = true;
    return true;
  });
  assert.equal(refreshNavigationAttempted, true);
  await delay(250);
  assert.equal(
    runPageRequestCount(),
    refreshNavigationBaseline,
    "workspace refresh must guard against a reverse-order run-page request",
  );
  await heldRunPageRefresh.release();
  await page.waitFor(
    (task) =>
      document
        .querySelector("#workspace-run-page .run-page__status")
        ?.textContent?.includes("Page 1") &&
      Array.from(document.querySelectorAll("#workspace-run-page strong")).some(
        (node) => node.textContent?.trim() === task,
      ) &&
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Refresh workspace" && !button.disabled,
      ),
    [TASK],
    "the workspace refresh after guarded reverse-order navigation",
  );
  const refreshNavigationBlocked = true;

  for (const pageNumber of [2, 3, 4]) {
    await page.clickButton("Older runs");
    await page.waitFor(
      (expectedPage) =>
        document
          .querySelector("#workspace-run-page .run-page__status")
          ?.textContent?.includes(`Page ${String(expectedPage)}`),
      [pageNumber],
      `bounded run page ${String(pageNumber)}`,
    );
    assert.equal((await page.runPageTasks()).length, RUN_SUMMARY_PAGE_SIZE);
  }
  assert.equal(await page.buttonDisabled("Older runs"), true);
  assert.equal(
    (await page.bodyText()).includes("This browser session keeps four run pages."),
    true,
  );
  await page.clickButton("Newer runs");
  await page.waitFor(
    () =>
      document
        .querySelector("#workspace-run-page .run-page__status")
        ?.textContent?.includes("Page 3"),
    [],
    "newer navigation inside the four-page run window",
  );

  const browserRunPageRequests = networkRequests.filter((request) => {
    if (request.method !== "GET" || request.url === undefined) return false;
    const url = new URL(request.url);
    return url.origin === workspace.url && url.pathname === "/api/runs" && url.search.length > 0;
  });
  assert.ok(browserRunPageRequests.length >= 10);
  for (const request of browserRunPageRequests) {
    const url = new URL(request.url);
    assert.deepEqual([...url.searchParams.keys()], ["before", "snapshot"]);
    assert.equal(Number(url.searchParams.get("snapshot")), runSummaryFixture.snapshot);
  }
  body = await page.bodyText();
  assert.equal(body.includes(RUN_SUMMARY_PRIVATE_SENTINEL), false);
  assert.deepEqual(
    persistenceSnapshot(stateRoot),
    runSummaryPersistenceBefore,
    "run-page browsing and lazy detail must not mutate durable state",
  );
  assert.deepEqual(
    await fingerprint(repository),
    runSummarySourceBefore,
    "run-page browsing and lazy detail must not mutate source state",
  );
  const boundedRunPageEvidence = {
    snapshot: runSummaryFixture.snapshot,
    pageSize: RUN_SUMMARY_PAGE_SIZE,
    maximumPages: RUN_SUMMARY_MAX_PAGES,
    requests: browserRunPageRequests.length,
    contentionCancellation: contendedRunPageOutcome,
    hiddenCancellation: hiddenRunPageOutcome,
    selectionCancellation: selectionRunPageOutcome,
    unmountCancellation: unmountedRunPageOutcome,
    latePageSuccessRejected: lateRunPageSuccessRejected,
    refreshNavigationBlocked,
    lateDetailRejected: lateRunDetailRejected,
    privateHeavyColumns: "not rendered",
    persistedDiffReview: diffReviewBrowserEvidence,
    durableStateUnchanged: true,
    sourceUnchanged: true,
  };

  await reloadPage(chromium, browserPage);
  await page.waitFor(
    (task) =>
      Array.from(
        document.querySelectorAll('section[aria-labelledby="all-runs-heading"] strong'),
      ).some((node) => node.textContent?.trim() === task),
    [TASK],
    "the draft in recent runs after reload",
  );
  await page.clickRecentRun(TASK);
  await page.waitFor(
    () => document.querySelector("#run-evidence-heading") !== null,
    [],
    "the reopened draft",
  );
  assert.equal(await page.runFact("Exact persisted state"), "preparing");
  assert.equal(
    (await page.bodyText()).includes("No plan exists. This is not a completed agent run."),
    true,
  );
  assert.equal(provider.requests.length, 0);

  const verificationRequestPath = `/api/runs/${encodeURIComponent(
    browserRunId,
  )}/verification-attempts`;
  const verificationRequests = () =>
    networkRequests.filter((request) => {
      if (request.method !== "GET" || request.url === undefined) return false;
      const url = new URL(request.url);
      return url.origin === workspace.url && url.pathname === verificationRequestPath;
    });
  assert.equal(
    verificationRequests().length,
    0,
    "verification provenance must remain lazy until the operator opens it",
  );
  const directVerificationResponse = await fetch(
    `${workspace.url}${verificationRequestPath}?snapshot=${HISTORICAL_EVENT_HIGH_WATER}`,
  );
  assert.equal(directVerificationResponse.status, 200);
  const directVerification = await directVerificationResponse.json();
  assert.equal(directVerification.snapshot, HISTORICAL_EVENT_HIGH_WATER);
  assert.equal(directVerification.coverage.eventCount, 200);
  assert.deepEqual(directVerification.attempts, []);
  assert.equal(JSON.stringify(directVerification).includes(HISTORICAL_EVENT_SENTINEL), false);

  await page.clickButton("Load verification evidence");
  await page.waitFor(
    () => {
      const root = document.querySelector("#verification-attempts");
      const status = root?.querySelector('[role="status"]')?.textContent?.trim() ?? "";
      return (
        root?.getAttribute("aria-busy") === "false" &&
        status !== "Verification evidence has not been loaded." &&
        status !== "Loading pinned verification evidence."
      );
    },
    [],
    "the lazy bounded verification projection",
  );
  const initialVerificationStatus = await page.call(
    () =>
      document.querySelector('#verification-attempts [role="status"]')?.textContent?.trim() ?? null,
  );
  assert.equal(initialVerificationStatus, "Loaded 0 verification intervals at revision 500.");
  assert.equal((await page.bodyText()).includes("No verification interval was observed"), true);
  assert.equal(await page.verificationFact("Pinned revision"), "500");
  assert.equal(await page.verificationFact("Sequence coverage"), "301–500");
  assert.equal(await page.verificationFact("Events examined"), "200 of 200 maximum");
  assert.equal(await page.verificationFact("Attempt intervals"), "0 of 8 maximum");
  assert.equal(verificationRequests().length, 1);
  const verificationUrl = new URL(verificationRequests()[0].url);
  assert.deepEqual([...verificationUrl.searchParams.keys()], ["snapshot"]);
  assert.equal(verificationUrl.searchParams.get("snapshot"), "500");
  body = await page.bodyText();
  assert.equal(body.includes(HISTORICAL_EVENT_SENTINEL), false);
  assert.equal(body.includes(VERIFICATION_PRIVATE_SENTINEL), false);

  browserPage.failNextVerificationAttempt();
  await page.clickButton("Refresh evidence");
  await page.waitFor(
    () =>
      document.querySelector("#verification-attempts")?.getAttribute("aria-busy") === "false" &&
      document.body.innerText.includes("Controlled browser smoke read failure."),
    [],
    "a retained verification projection after a transient read failure",
  );
  assert.equal(await page.verificationFact("Pinned revision"), "500");
  assert.equal((await page.bodyText()).includes("No verification interval was observed"), true);
  await page.clickButton("Retry evidence");
  await page.waitFor(
    () =>
      document.querySelector("#verification-attempts")?.getAttribute("aria-busy") === "false" &&
      !document.body.innerText.includes("Controlled browser smoke read failure."),
    [],
    "a successful explicit verification retry",
  );

  assert.equal(
    await page.call((sentinel) => {
      const originalFetch = window.fetch;
      let used = false;
      window.fetch = async (input, init) => {
        const requestUrl =
          typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        if (used || !requestUrl.includes("/verification-attempts?snapshot=")) {
          return originalFetch.call(window, input, init);
        }
        used = true;
        const response = await originalFetch.call(window, input, init);
        const value = await response.json();
        value.privateUnexpectedField = sentinel;
        window.fetch = originalFetch;
        return new Response(JSON.stringify(value), {
          status: response.status,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      };
      return true;
    }, VERIFICATION_PRIVATE_SENTINEL),
    true,
  );
  await page.clickButton("Refresh evidence");
  await page.waitFor(
    () =>
      document.querySelector("#verification-attempts")?.getAttribute("aria-busy") === "false" &&
      document.body.innerText.includes("verification-attempt response shape was invalid"),
    [],
    "strict browser rejection of an extra response field",
  );
  assert.equal(await page.verificationFact("Pinned revision"), "500");
  assert.equal((await page.bodyText()).includes(VERIFICATION_PRIVATE_SENTINEL), false);
  await page.clickButton("Retry evidence");
  await page.waitFor(
    () =>
      document.querySelector("#verification-attempts")?.getAttribute("aria-busy") === "false" &&
      !document.body.innerText.includes("verification-attempt response shape was invalid"),
    [],
    "a valid response after strict response-shape rejection",
  );

  const hostileVerificationError =
    '<img src="x" onerror="window.__icarusVerificationErrorExecuted=true">';
  assert.equal(
    await page.call((message) => {
      const originalFetch = window.fetch;
      let used = false;
      window.fetch = (input, init) => {
        const requestUrl =
          typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        if (used || !requestUrl.includes("/verification-attempts?snapshot=")) {
          return originalFetch.call(window, input, init);
        }
        used = true;
        window.fetch = originalFetch;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "HOSTILE_BROWSER_FIXTURE", message },
            }),
            {
              status: 503,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          ),
        );
      };
      return true;
    }, hostileVerificationError),
    true,
  );
  await page.clickButton("Refresh evidence");
  await page.waitFor(
    (message) => document.body.innerText.includes(message),
    [hostileVerificationError],
    "literal hostile verification error text",
  );
  assert.equal(
    await page.call(
      () =>
        document.querySelector("#verification-attempts img") === null &&
        window.__icarusVerificationErrorExecuted !== true,
    ),
    true,
    "hostile error text must not create an element or execute an event handler",
  );
  assert.equal(await page.verificationFact("Pinned revision"), "500");
  await page.clickButton("Retry evidence");
  await page.waitFor(
    (message) =>
      document.querySelector("#verification-attempts")?.getAttribute("aria-busy") === "false" &&
      !document.body.innerText.includes(message),
    [hostileVerificationError],
    "a valid response after hostile error rendering",
  );

  assert.equal(
    await page.call(() => {
      const originalFetch = window.fetch;
      let used = false;
      window.fetch = async (input, init) => {
        const requestUrl =
          typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        if (used || !requestUrl.includes("/verification-attempts?snapshot=")) {
          return originalFetch.call(window, input, init);
        }
        used = true;
        const response = await originalFetch.call(window, input, init);
        const value = await response.json();
        value.runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        window.fetch = originalFetch;
        return new Response(JSON.stringify(value), {
          status: response.status,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      };
      return true;
    }),
    true,
  );
  await page.clickButton("Refresh evidence");
  await page.waitFor(
    () => document.body.innerText.includes("verification-attempt response metadata was invalid"),
    [],
    "strict browser rejection of a mismatched run seed",
  );
  assert.equal(await page.verificationFact("Pinned revision"), "500");
  await page.clickButton("Retry evidence");
  await page.waitFor(
    () =>
      document.querySelector("#verification-attempts")?.getAttribute("aria-busy") === "false" &&
      !document.body.innerText.includes("verification-attempt response metadata was invalid"),
    [],
    "a valid response after mismatched-seed rejection",
  );

  assert.equal(
    await page.call(() => {
      const originalFetch = window.fetch;
      const state = { observed: false, release: null, originalFetch };
      window.__icarusLateVerificationResponse = state;
      window.fetch = (input, init) => {
        const requestUrl =
          typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        if (state.observed || !requestUrl.includes("/verification-attempts?snapshot=")) {
          return originalFetch.call(window, input, init);
        }
        state.observed = true;
        return new Promise((resolve, reject) => {
          state.release = async () => {
            try {
              const options = init === undefined ? {} : { ...init, signal: undefined };
              const response = await originalFetch.call(window, input, options);
              const value = await response.json();
              value.snapshot = 499;
              resolve(
                new Response(JSON.stringify(value), {
                  status: response.status,
                  headers: { "content-type": "application/json; charset=utf-8" },
                }),
              );
            } catch (error) {
              reject(error);
            }
          };
        });
      };
      return true;
    }),
    true,
  );
  await page.clickButton("Refresh evidence");
  await page.waitFor(
    () => window.__icarusLateVerificationResponse?.observed === true,
    [],
    "the deliberately delayed cancellation-ignoring verification response",
  );
  await page.clickButton("Close");
  await page.waitFor(
    () =>
      !document.body.innerText.includes("Pinned revision") &&
      document.querySelector("#verification-attempts")?.getAttribute("aria-busy") === "false",
    [],
    "the closed verification panel before a late successful response",
  );
  assert.equal(
    await page.call(
      () =>
        document.activeElement instanceof HTMLButtonElement &&
        document.activeElement.textContent?.trim() === "Load verification evidence",
    ),
    true,
    "operator Close must restore focus before any late response settles",
  );
  await page.clickButton("Load verification evidence");
  await page.waitFor(
    () =>
      document.querySelector('#verification-attempts [role="status"]')?.textContent?.trim() ===
      "Loaded 0 verification intervals at revision 500.",
    [],
    "replacement verification request B before delayed request A settles",
  );
  assert.equal(
    await page.call(async () => {
      const state = window.__icarusLateVerificationResponse;
      if (state === undefined || typeof state.release !== "function") return false;
      window.fetch = state.originalFetch;
      await state.release();
      delete window.__icarusLateVerificationResponse;
      return true;
    }),
    true,
  );
  await delay(100);
  assert.equal(
    await page.call(
      () =>
        document.querySelector('#verification-attempts [role="status"]')?.textContent?.trim() ===
          "Loaded 0 verification intervals at revision 500." &&
        !document.body.innerText.includes("verification-attempt response metadata was invalid"),
    ),
    true,
    "late mismatched request A must not overwrite or clear replacement request B",
  );
  assert.equal(await page.verificationFact("Pinned revision"), "500");
  const appendDatabase = new Database(path.join(stateRoot, "icarus.sqlite3"));
  try {
    appendDatabase
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        browserRunId,
        HISTORICAL_EVENT_HIGH_WATER + 1,
        "operation.finished",
        `${HISTORICAL_EVENT_SENTINEL}:stale-pin`,
        "2026-07-20T12:00:00.000Z",
      );
  } finally {
    appendDatabase.close();
  }
  await page.waitFor(
    () => document.body.innerText.includes("Newer persisted activity exists"),
    [],
    "a pinned verification panel becoming stale under live reconciliation",
  );
  assert.equal(await page.verificationFact("Pinned revision"), "500");
  await page.clickButton("Refresh evidence");
  await page.waitFor(
    () =>
      document.querySelector("#verification-attempts")?.getAttribute("aria-busy") === "false" &&
      !document.body.innerText.includes("Newer persisted activity exists"),
    [],
    "an explicit refresh to the newest verification snapshot",
  );
  assert.equal(await page.verificationFact("Pinned revision"), "501");
  assert.equal(await page.verificationFact("Sequence coverage"), "302–501");

  const conflictVerificationRequest = browserPage.holdNextVerificationAttempt();
  finishHeldBrowserVerificationRequest = conflictVerificationRequest.finish;
  await page.clickButton("Refresh evidence");
  await conflictVerificationRequest.observed;
  const conflictDatabase = new Database(path.join(stateRoot, "icarus.sqlite3"));
  try {
    conflictDatabase
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        browserRunId,
        HISTORICAL_EVENT_HIGH_WATER + 2,
        "operation.finished",
        `${HISTORICAL_EVENT_SENTINEL}:snapshot-conflict`,
        "2026-07-20T12:00:00.000Z",
      );
  } finally {
    conflictDatabase.close();
  }
  const conflictVerificationOutcome = await conflictVerificationRequest.finish();
  finishHeldBrowserVerificationRequest = undefined;
  assert.equal(conflictVerificationOutcome, "continued");
  await page.waitFor(
    () =>
      document.body.innerText.includes("successful persisted-run refresh is required") &&
      document.body.innerText.includes("run advanced before this pinned read began"),
    [],
    "the verification snapshot-conflict lock",
  );
  assert.equal(await page.verificationFact("Pinned revision"), "501");
  assert.equal(await page.buttonDisabled("Retry evidence"), true);
  const conflictLockedRequestCount = verificationRequests().length;
  await delay(100);
  assert.equal(
    verificationRequests().length,
    conflictLockedRequestCount,
    "the conflict lock must not replay its failed snapshot",
  );
  await page.clickButton("Refresh persisted run");
  await page.waitFor(
    () =>
      !document.body.innerText.includes("successful persisted-run refresh is required") &&
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Refresh evidence" && !button.disabled,
      ),
    [],
    "successful persisted-run refresh unlocking a conflicted verification panel",
  );
  await page.clickButton("Refresh evidence");
  await page.waitFor(
    () =>
      document.querySelector("#verification-attempts")?.getAttribute("aria-busy") === "false" &&
      !document.body.innerText.includes("Newer persisted activity exists"),
    [],
    "explicit verification retry after conflict recovery",
  );
  assert.equal(await page.verificationFact("Pinned revision"), "502");
  assert.equal(await page.verificationFact("Sequence coverage"), "303–502");

  const verificationPersistenceBefore = workspaceStateSnapshot(
    path.join(stateRoot, "icarus.sqlite3"),
  );
  const verificationSourceBefore = await fingerprint(repository);
  const hiddenVerificationRequest = browserPage.holdNextVerificationAttempt();
  finishHeldBrowserVerificationRequest = hiddenVerificationRequest.finish;
  await page.clickButton("Refresh evidence");
  await hiddenVerificationRequest.observed;
  await page.setVisibility("hidden");
  await page.waitFor(
    () => document.body.innerText.includes("cancelled while this tab was hidden"),
    [],
    "hidden-document verification cancellation",
  );
  const hiddenVerificationOutcome = await hiddenVerificationRequest.finish();
  finishHeldBrowserVerificationRequest = undefined;
  assert.equal(hiddenVerificationOutcome, "cancelled");
  await page.setVisibility("visible");
  await page.clickButton("Retry evidence");
  await page.waitFor(
    () =>
      document.querySelector("#verification-attempts")?.getAttribute("aria-busy") === "false" &&
      !document.body.innerText.includes("cancelled while this tab was hidden"),
    [],
    "verification retry after hidden-document cancellation",
  );

  const refreshVerificationRequest = browserPage.holdNextVerificationAttempt();
  finishHeldBrowserVerificationRequest = refreshVerificationRequest.finish;
  await page.clickButton("Refresh evidence");
  await refreshVerificationRequest.observed;
  await page.clickButton("Refresh persisted run");
  await page.waitFor(
    () => document.body.innerText.includes("cancelled by the persisted-run refresh"),
    [],
    "persisted-run refresh cancelling verification evidence first",
  );
  const refreshVerificationOutcome = await refreshVerificationRequest.finish();
  finishHeldBrowserVerificationRequest = undefined;
  assert.equal(refreshVerificationOutcome, "cancelled");
  await page.clickButton("Retry evidence");
  await page.waitFor(
    () =>
      document.querySelector("#verification-attempts")?.getAttribute("aria-busy") === "false" &&
      !document.body.innerText.includes("cancelled by the persisted-run refresh"),
    [],
    "verification retry after persisted-run refresh cancellation",
  );

  const historyVerificationRequest = browserPage.holdNextVerificationAttempt();
  finishHeldBrowserVerificationRequest = historyVerificationRequest.finish;
  await page.clickButton("Refresh evidence");
  await historyVerificationRequest.observed;
  const verificationHistoryRequestBaseline = networkRequests.length;
  await page.clickButton("Load older activity");
  const historyVerificationOutcome = await historyVerificationRequest.finish();
  finishHeldBrowserVerificationRequest = undefined;
  assert.equal(historyVerificationOutcome, "cancelled");
  await page.waitFor(
    () =>
      document.querySelector(".history-panel")?.getAttribute("aria-busy") === "false" &&
      document.body.innerText.includes("cancelled before older activity opened"),
    [],
    "abort-before-history verification ordering with retained evidence",
  );
  assert.equal(await page.verificationFact("Pinned revision"), "502");
  const verificationHistoryNetworkRequest = networkRequests
    .slice(verificationHistoryRequestBaseline)
    .find(
      (request) => request.method === "GET" && request.url?.includes("/events/history?before="),
    );
  assert.notEqual(verificationHistoryNetworkRequest, undefined);
  const verificationHistoryUrl = new URL(verificationHistoryNetworkRequest.url);
  assert.equal(verificationHistoryUrl.searchParams.get("snapshot"), "502");
  await page.clickButton("Close");
  await page.waitFor(
    () => document.activeElement?.id === "run-verification",
    [],
    "verification focus fallback while older activity disables its launcher",
  );
  await page.clickButton("Close older activity");
  await page.waitFor(
    () => document.querySelector(".history-panel") === null,
    [],
    "closing older activity after verification cancellation ordering",
  );
  await page.clickButton("Load verification evidence");
  await page.waitFor(
    () =>
      document.querySelector("#verification-attempts")?.getAttribute("aria-busy") === "false" &&
      !document.body.innerText.includes("cancelled before older activity opened"),
    [],
    "verification retry after older activity closes",
  );

  const selectionVerificationRequest = browserPage.holdNextVerificationAttempt();
  finishHeldBrowserVerificationRequest = selectionVerificationRequest.finish;
  await page.clickButton("Refresh evidence");
  await selectionVerificationRequest.observed;
  await page.clickProject("browser-project-two");
  await page.waitFor(
    () =>
      document.querySelector("#project-detail-heading")?.textContent === "browser-project-two" &&
      document.querySelector("#run-evidence-heading") === null,
    [],
    "selection unmount while verification evidence is in flight",
  );
  const selectionVerificationOutcome = await selectionVerificationRequest.finish();
  finishHeldBrowserVerificationRequest = undefined;
  assert.equal(selectionVerificationOutcome, "cancelled");
  assert.deepEqual(
    workspaceStateSnapshot(path.join(stateRoot, "icarus.sqlite3")),
    verificationPersistenceBefore,
    "verification browsing must not mutate durable control state",
  );
  assert.deepEqual(
    await fingerprint(repository),
    verificationSourceBefore,
    "verification browsing must not read through to or mutate source state",
  );
  body = await page.bodyText();
  assert.equal(body.includes(HISTORICAL_EVENT_SENTINEL), false);
  assert.equal(body.includes(VERIFICATION_PRIVATE_SENTINEL), false);

  await page.clickProject("browser-project");
  await page.waitFor(
    () => document.querySelector("#project-detail-heading")?.textContent === "browser-project",
    [],
    "the original project after verification request isolation",
  );
  await page.clickRecentRun(TASK);
  await page.waitFor(
    (runId) =>
      Array.from(document.querySelectorAll(".run-evidence dt")).some(
        (term) =>
          term.textContent?.trim() === "Run ID" &&
          term.parentElement?.querySelector("dd")?.textContent?.trim() === runId,
      ),
    [browserRunId],
    "the original run after verification request isolation",
  );
  const boundedVerificationEvidence = {
    initialSnapshot: 500,
    staleRefreshedSnapshot: 501,
    conflictRecoveredSnapshot: 502,
    eventLimit: 200,
    attemptLimit: 8,
    lazy: true,
    retainedRetry: true,
    strictShapeRejected: true,
    mismatchedSeedRejected: true,
    hostileErrorRenderedAsText: true,
    replacementRaceRejected: true,
    lateSuccessRejected: true,
    stalePinObserved: true,
    conflictLockRecovered: true,
    focusRestored: true,
    hiddenCancellation: hiddenVerificationOutcome,
    refreshCancellation: refreshVerificationOutcome,
    historyCancellation: historyVerificationOutcome,
    selectionCancellation: selectionVerificationOutcome,
    privatePayloads: "not rendered",
    durableStateUnchanged: true,
    sourceUnchanged: true,
  };

  await page.waitFor(
    () =>
      document.querySelector(".live-refresh .status")?.textContent?.trim() === "auto-refresh on",
    [],
    "the initial visible event poll",
  );
  await page.setVisibility("hidden");
  await page.waitFor(
    () =>
      document.querySelector(".live-refresh .status")?.textContent?.trim() ===
      "paused while hidden",
    [],
    "the hidden-document polling pause",
  );
  const hiddenEventRequestCount = networkRequests.filter(
    (request) => request.method === "GET" && request.url?.includes("/events?after="),
  ).length;
  await delay(EVENT_POLL_INTERVAL_MS + 500);
  assert.equal(
    networkRequests.filter(
      (request) => request.method === "GET" && request.url?.includes("/events?after="),
    ).length,
    hiddenEventRequestCount,
    "event polling must remain paused beyond one steady-state interval",
  );

  await page.setVisibility("visible");
  await waitForObserved(
    () =>
      networkRequests.filter(
        (request) => request.method === "GET" && request.url?.includes("/events?after="),
      ).length > hiddenEventRequestCount,
    "an immediate event poll after visibility resumes",
  );
  await page.waitFor(
    () =>
      document.querySelector(".live-refresh .status")?.textContent?.trim() === "auto-refresh on",
    [],
    "successful event polling after visibility resumes",
  );

  const controlledEventFailuresBefore = networkResponses.filter(
    (response) => response.status === 503 && response.url?.includes("/events?after="),
  ).length;
  browserPage.failNextEventPoll();
  await waitForObserved(
    () =>
      networkResponses.filter(
        (response) => response.status === 503 && response.url?.includes("/events?after="),
      ).length ===
      controlledEventFailuresBefore + 1,
    "the controlled failed event poll",
  );
  const failedEventResponse = networkResponses.findLast(
    (response) => response.status === 503 && response.url?.includes("/events?after="),
  );
  assert.notEqual(failedEventResponse, undefined);
  await page.waitFor(
    () =>
      document.querySelector(".live-refresh .status")?.textContent?.trim() ===
      "evidence may be stale",
    [],
    "the stale-evidence state after a failed event poll",
  );
  const failedPollRequestCount = networkRequests.filter(
    (request) => request.method === "GET" && request.url?.includes("/events?after="),
  ).length;
  await delay(EVENT_POLL_INTERVAL_MS + 500);
  assert.equal(
    networkRequests.filter(
      (request) => request.method === "GET" && request.url?.includes("/events?after="),
    ).length,
    failedPollRequestCount,
    "the first failed poll must delay recovery beyond the steady-state interval",
  );
  await waitForObserved(
    () =>
      networkResponses.some(
        (response) =>
          response.status === 200 &&
          response.url?.includes("/events?after=") &&
          response.observedAt > failedEventResponse.observedAt,
      ),
    "a bounded successful event-poll recovery",
  );
  const recoveredEventResponse = networkResponses.find(
    (response) =>
      response.status === 200 &&
      response.url?.includes("/events?after=") &&
      response.observedAt > failedEventResponse.observedAt,
  );
  assert.notEqual(recoveredEventResponse, undefined);
  const recoveryDelayMs = recoveredEventResponse.observedAt - failedEventResponse.observedAt;
  assert.ok(recoveryDelayMs >= EVENT_POLL_FIRST_BACKOFF_MS - 500);
  assert.ok(recoveryDelayMs <= EVENT_POLL_FIRST_BACKOFF_MS + UI_TIMEOUT_MS);
  await page.waitFor(
    () =>
      document.querySelector(".live-refresh .status")?.textContent?.trim() === "auto-refresh on",
    [],
    "the successful event-poll recovery state",
  );

  releaseProviderResponse = provider.holdNextResponse();
  const heldEventPoll = browserPage.holdNextEventPoll();
  finishHeldBrowserEventPoll = heldEventPoll.finish;
  await page.clickButton("Create guarded plan");
  await waitForObserved(
    () => provider.requests.length === 1,
    "the held provider request after separately committed run events",
  );
  await waitForObserved(
    () => heldEventPoll.observation() !== null,
    "the deliberately held in-flight event poll",
  );
  const heldEventObservation = heldEventPoll.observation();
  assert.notEqual(heldEventObservation, null);
  assert.equal(
    new URL(heldEventObservation.url).pathname,
    `/api/runs/${encodeURIComponent(browserRunId)}/events`,
  );
  const heldEventRequestCount = networkRequests.filter(
    (request) => request.method === "GET" && request.url?.includes("/events?after="),
  ).length;
  await delay(EVENT_POLL_INTERVAL_MS + 500);
  assert.equal(
    networkRequests.filter(
      (request) => request.method === "GET" && request.url?.includes("/events?after="),
    ).length,
    heldEventRequestCount,
    "an in-flight event poll must prevent an overlapping second poll",
  );

  await page.clickProject("browser-project-two");
  await page.waitFor(
    () =>
      document.querySelector("#project-detail-heading")?.textContent === "browser-project-two" &&
      document.querySelector("#run-evidence-heading") === null,
    [],
    "the project selection that unmounts the polled run",
  );
  const unmountedEventRequestCount = networkRequests.filter(
    (request) => request.method === "GET" && request.url?.includes("/events?after="),
  ).length;
  assert.equal(unmountedEventRequestCount, heldEventRequestCount);
  await delay(EVENT_POLL_INTERVAL_MS + 500);
  assert.equal(
    networkRequests.filter(
      (request) => request.method === "GET" && request.url?.includes("/events?after="),
    ).length,
    unmountedEventRequestCount,
    "event polling must remain stopped after the selected run unmounts",
  );

  const heldEventReleaseOutcome = await heldEventPoll.finish();
  finishHeldBrowserEventPoll = undefined;
  assert.notEqual(heldEventReleaseOutcome, "not_observed");
  const matchesHeldNetworkRecord = (record) =>
    heldEventObservation.networkId === null
      ? record.url === heldEventObservation.url &&
        record.observedAt >= heldEventObservation.observedAt
      : record.requestId === heldEventObservation.networkId;
  await waitForObserved(
    () =>
      networkFinished.some(matchesHeldNetworkRecord) ||
      networkFailures.some(matchesHeldNetworkRecord),
    "the terminal network outcome for the released held event poll",
  );
  const heldEventFinished = networkFinished.find(matchesHeldNetworkRecord);
  const heldEventFailure = networkFailures.find(matchesHeldNetworkRecord);
  const heldEventTerminal =
    heldEventFinished !== undefined
      ? "completed"
      : heldEventFailure?.canceled === true
        ? "cancelled"
        : "failed";
  if (heldEventFinished !== undefined) {
    assert.equal(
      networkResponses.find(matchesHeldNetworkRecord)?.status,
      200,
      "a continued held event poll must finish with the real API response",
    );
  }
  if (heldEventReleaseOutcome === "cancelled") {
    assert.equal(heldEventFailure?.canceled, true);
  }
  assert.equal(
    await page.call(
      () =>
        document.querySelector("#project-detail-heading")?.textContent === "browser-project-two" &&
        document.querySelector("#run-evidence-heading") === null,
    ),
    true,
    "the late held-poll outcome must not overwrite the newer project selection",
  );

  await page.clickProject("browser-project");
  await page.waitFor(
    () => document.querySelector("#project-detail-heading")?.textContent === "browser-project",
    [],
    "the original project after the held-poll isolation check",
  );
  await page.clickRecentRun(TASK);
  await page.waitFor(
    (runId) =>
      Array.from(document.querySelectorAll(".run-evidence dt")).some(
        (term) =>
          term.textContent?.trim() === "Run ID" &&
          term.parentElement?.querySelector("dd")?.textContent?.trim() === runId,
      ),
    [browserRunId],
    "the original run after the held-poll isolation check",
  );

  await page.waitFor(
    () =>
      document.querySelector(".live-refresh .status")?.textContent?.trim() === "auto-refresh on",
    [],
    "live polling before explicit historical navigation",
  );
  const historyPersistenceBefore = workspaceStateSnapshot(path.join(stateRoot, "icarus.sqlite3"));
  const livePollHeldForHistory = browserPage.holdNextEventPoll();
  finishHeldBrowserEventPoll = livePollHeldForHistory.finish;
  await waitForObserved(
    () => livePollHeldForHistory.observation() !== null,
    "the active live poll held before opening historical activity",
  );
  const historyOpenLiveObservation = livePollHeldForHistory.observation();
  assert.notEqual(historyOpenLiveObservation, null);
  const historyRequestBaseline = networkRequests.length;
  await page.clickButton("Load older activity");
  const historyOpenLiveReleaseOutcome = await livePollHeldForHistory.finish();
  finishHeldBrowserEventPoll = undefined;
  assert.notEqual(historyOpenLiveReleaseOutcome, "not_observed");
  const matchesHistoryOpenLivePoll = (record) =>
    historyOpenLiveObservation.networkId === null
      ? record.url === historyOpenLiveObservation.url &&
        record.observedAt >= historyOpenLiveObservation.observedAt
      : record.requestId === historyOpenLiveObservation.networkId;
  await waitForObserved(
    () =>
      networkFinished.some(matchesHistoryOpenLivePoll) ||
      networkFailures.some(matchesHistoryOpenLivePoll),
    "the terminal outcome for the live poll aborted by historical activity",
  );
  assert.equal(
    networkFailures.some(
      (failure) => matchesHistoryOpenLivePoll(failure) && failure.canceled === true,
    ),
    true,
    "opening historical activity must cancel the active live poll",
  );
  const historyOpenLivePollOutcome = "cancelled";
  await page.waitFor(
    () =>
      document.querySelector(".history-panel")?.getAttribute("aria-busy") === "false" &&
      document.body.innerText.includes("Persisted sequence 300"),
    [],
    "the first pinned historical metadata page",
  );
  assert.equal(
    await page.call(
      () =>
        document.querySelector(".live-refresh .status")?.textContent?.trim() ===
        "paused for older activity",
    ),
    true,
  );
  assert.equal(
    await page.call(
      () =>
        document.activeElement instanceof HTMLButtonElement &&
        document.activeElement.textContent?.trim() === "Close older activity",
    ),
    true,
    "opening historical activity must move focus into the disclosure",
  );
  const firstHistoryRange = await page.historyFact("Sequences shown");
  const historySnapshot = Number(await page.historyFact("Pinned revision"));
  assert.match(firstHistoryRange ?? "", /^\d+–\d+$/);
  assert.equal(Number.isSafeInteger(historySnapshot) && historySnapshot > 0, true);
  body = await page.bodyText();
  assert.equal(body.includes(HISTORICAL_EVENT_SENTINEL), false);
  assert.equal(
    body.includes("Event links navigate to the current allowlisted evidence section."),
    true,
  );
  const historicalContextEvidenceHref = await page.call(() => {
    const link = Array.from(
      document.querySelectorAll(".history-panel .timeline__evidence-link"),
    ).find(
      (candidate) => candidate.textContent?.replaceAll(/\s+/g, " ").trim() === "context assembled",
    );
    if (!(link instanceof HTMLAnchorElement)) return null;
    const href = link.getAttribute("href");
    link.click();
    return href;
  });
  assert.equal(historicalContextEvidenceHref, "#run-context");
  await page.waitFor(
    () =>
      window.location.hash === "#run-context" && document.querySelector("#run-context") !== null,
    [],
    "historical metadata navigation to the current context evidence section",
  );
  assert.equal(
    await page.call(() => {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      return window.location.hash;
    }),
    "",
  );

  const pausedLiveEventRequestCount = networkRequests.filter(
    (request) => request.method === "GET" && request.url?.includes("/events?after="),
  ).length;
  await delay(EVENT_POLL_INTERVAL_MS + 500);
  assert.equal(
    networkRequests.filter(
      (request) => request.method === "GET" && request.url?.includes("/events?after="),
    ).length,
    pausedLiveEventRequestCount,
    "live polling must remain paused while the historical panel is open",
  );

  browserPage.failNextEventHistory();
  await page.clickButton("← Older events");
  await page.waitFor(
    () =>
      document.querySelector(".history-panel")?.getAttribute("aria-busy") === "false" &&
      document.body.innerText.includes("The last successful pinned page remains visible"),
    [],
    "a truthful failed historical-page state",
  );
  assert.equal(await page.historyFact("Sequences shown"), firstHistoryRange);
  assert.equal((await page.bodyText()).includes("Persisted sequence 300"), true);

  await page.clickButton("Retry older activity");
  await page.waitFor(
    () =>
      document.querySelector(".history-panel")?.getAttribute("aria-busy") === "false" &&
      Array.from(document.querySelectorAll(".history-panel dt")).some(
        (term) =>
          term.textContent?.trim() === "Browser window" &&
          term.parentElement?.querySelector("dd")?.textContent?.trim() === "Page 2 of at most 4",
      ),
    [],
    "the retried second historical page",
  );
  assert.notEqual(await page.historyFact("Sequences shown"), firstHistoryRange);
  assert.equal((await page.bodyText()).includes("Persisted sequence 300"), false);

  for (const pageNumber of [3, 4]) {
    await page.clickButton("← Older events");
    await page.waitFor(
      (expectedPage) =>
        document.querySelector(".history-panel")?.getAttribute("aria-busy") === "false" &&
        Array.from(document.querySelectorAll(".history-panel dt")).some(
          (term) =>
            term.textContent?.trim() === "Browser window" &&
            term.parentElement?.querySelector("dd")?.textContent?.trim() ===
              `Page ${expectedPage} of at most 4`,
        ),
      [pageNumber],
      `historical page ${pageNumber}`,
    );
  }
  assert.equal(await page.buttonDisabled("← Older events"), true);
  assert.equal(
    (await page.bodyText()).includes("This four-page browser window has reached its limit."),
    true,
  );

  await page.clickButton("Newer events →");
  await page.waitFor(
    () =>
      document.querySelector(".history-panel")?.getAttribute("aria-busy") === "false" &&
      Array.from(document.querySelectorAll(".history-panel dt")).some(
        (term) =>
          term.textContent?.trim() === "Browser window" &&
          term.parentElement?.querySelector("dd")?.textContent?.trim() === "Page 3 of at most 4",
      ),
    [],
    "newer navigation inside the bounded historical window",
  );
  const liveEventRequestCountBeforeHistoryClose = networkRequests.filter(
    (request) => request.method === "GET" && request.url?.includes("/events?after="),
  ).length;
  await page.clickButton("Close older activity");
  await page.waitFor(
    () =>
      document.querySelector(".history-panel") === null &&
      document.querySelector(".live-refresh .status")?.textContent?.trim() === "auto-refresh on",
    [],
    "live polling after historical navigation closes",
  );
  await waitForObserved(
    () =>
      networkRequests.filter(
        (request) => request.method === "GET" && request.url?.includes("/events?after="),
      ).length > liveEventRequestCountBeforeHistoryClose,
    "an immediate live event poll after historical navigation",
  );
  assert.equal(
    await page.call(
      () =>
        document.activeElement instanceof HTMLButtonElement &&
        document.activeElement.textContent?.trim() === "Load older activity",
    ),
    true,
    "closing historical activity must restore focus to its launch control",
  );
  const historicalRequestsDuringNavigation = networkRequests
    .slice(historyRequestBaseline)
    .filter(
      (request) => request.method === "GET" && request.url?.includes("/events/history?before="),
    );
  assert.equal(historicalRequestsDuringNavigation.length, 6);
  for (const request of historicalRequestsDuringNavigation) {
    const requestUrl = new URL(request.url);
    assert.equal(
      requestUrl.pathname,
      `/api/runs/${encodeURIComponent(browserRunId)}/events/history`,
    );
    assert.deepEqual([...requestUrl.searchParams.keys()], ["before", "snapshot"]);
    assert.equal(Number(requestUrl.searchParams.get("snapshot")), historySnapshot);
  }

  const settleHeldHistoryRequest = async (held, observation, description) => {
    const releaseOutcome = await held.finish();
    finishHeldBrowserHistoryRequest = undefined;
    assert.notEqual(releaseOutcome, "not_observed");
    const matches = (record) =>
      observation.networkId === null
        ? record.url === observation.url && record.observedAt >= observation.observedAt
        : record.requestId === observation.networkId;
    await waitForObserved(
      () => networkFinished.some(matches) || networkFailures.some(matches),
      description,
    );
    assert.equal(
      networkFailures.some((failure) => matches(failure) && failure.canceled === true),
      true,
      `${description} must be a transport cancellation`,
    );
    return "cancelled";
  };

  const hiddenHistoryRequest = browserPage.holdNextEventHistory();
  finishHeldBrowserHistoryRequest = hiddenHistoryRequest.finish;
  await page.clickButton("Load older activity");
  const hiddenHistoryObservation = await hiddenHistoryRequest.observed;
  const heldHistoryRequestCount = networkRequests.filter(
    (request) => request.method === "GET" && request.url?.includes("/events/history?before="),
  ).length;
  await delay(250);
  assert.equal(
    networkRequests.filter(
      (request) => request.method === "GET" && request.url?.includes("/events/history?before="),
    ).length,
    heldHistoryRequestCount,
    "a held historical request must not overlap another historical request",
  );
  await page.setVisibility("hidden");
  await page.waitFor(
    () =>
      document.querySelector(".history-panel")?.getAttribute("aria-busy") === "false" &&
      document.body.innerText.includes("cancelled while this tab was hidden"),
    [],
    "the hidden-tab historical cancellation state",
  );
  const hiddenHistoryReleaseOutcome = await settleHeldHistoryRequest(
    hiddenHistoryRequest,
    hiddenHistoryObservation,
    "the terminal outcome for the hidden historical request",
  );
  assert.equal(await page.historyFact("Sequences shown"), null);
  await page.setVisibility("visible");
  await page.clickButton("Retry older activity");
  await page.waitFor(
    () =>
      document.querySelector(".history-panel")?.getAttribute("aria-busy") === "false" &&
      document.body.innerText.includes("Persisted sequence 300"),
    [],
    "a successful retry after hidden historical cancellation",
  );

  const closeHistoryRequest = browserPage.holdNextEventHistory();
  finishHeldBrowserHistoryRequest = closeHistoryRequest.finish;
  await page.clickButton("← Older events");
  const closeHistoryObservation = await closeHistoryRequest.observed;
  const contendedHistoryRequestCount = networkRequests.filter(
    (request) => request.method === "GET" && request.url?.includes("/events/history?before="),
  ).length;
  assert.equal(
    await page.call(() => {
      const buttons = Array.from(document.querySelectorAll(".history-panel__navigation button"));
      if (buttons.length !== 2 || !buttons.every((button) => button.disabled)) return false;
      for (const button of buttons) button.click();
      return true;
    }),
    true,
    "historical navigation controls must disable while a request is active",
  );
  await delay(250);
  assert.equal(
    networkRequests.filter(
      (request) => request.method === "GET" && request.url?.includes("/events/history?before="),
    ).length,
    contendedHistoryRequestCount,
    "attempted historical navigation must not overlap an active request",
  );
  await page.clickButton("Close older activity");
  await page.waitFor(
    () => document.querySelector(".history-panel") === null,
    [],
    "the closed panel while a historical request is held",
  );
  const closeHistoryReleaseOutcome = await settleHeldHistoryRequest(
    closeHistoryRequest,
    closeHistoryObservation,
    "the terminal outcome for the closed historical request",
  );
  assert.equal(
    await page.call(() => document.querySelector(".history-panel") === null),
    true,
    "a held closed-panel outcome must not reopen historical activity",
  );
  await page.waitFor(
    () =>
      document.querySelector(".live-refresh .status")?.textContent?.trim() === "auto-refresh on",
    [],
    "live polling after the held historical request closes",
  );

  assert.equal(
    await page.call(() => {
      const originalFetch = window.fetch;
      const state = {
        observed: false,
        release: null,
        originalFetch,
      };
      window.__icarusLateHistoryResponse = state;
      window.fetch = (input, init) => {
        const requestUrl =
          typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        if (state.observed || !requestUrl.includes("/events/history?before=")) {
          return originalFetch.call(window, input, init);
        }
        state.observed = true;
        return new Promise((resolve, reject) => {
          state.release = async () => {
            try {
              const options = init === undefined ? {} : { ...init, signal: undefined };
              resolve(await originalFetch.call(window, input, options));
            } catch (error) {
              reject(error);
            }
          };
        });
      };
      return true;
    }),
    true,
  );
  await page.clickButton("Load older activity");
  await page.waitFor(
    () => window.__icarusLateHistoryResponse?.observed === true,
    [],
    "the deliberately delayed cancellation-ignoring historical request",
  );
  await page.clickButton("Close older activity");
  await page.waitFor(
    () => document.querySelector(".history-panel") === null,
    [],
    "the closed panel before a delayed successful history response",
  );
  const lateHistoryReleaseStartedAt = Date.now();
  assert.equal(
    await page.call(async () => {
      const state = window.__icarusLateHistoryResponse;
      if (state === undefined || typeof state.release !== "function") return false;
      window.fetch = state.originalFetch;
      await state.release();
      delete window.__icarusLateHistoryResponse;
      return true;
    }),
    true,
  );
  await waitForObserved(
    () =>
      networkResponses.some(
        (response) =>
          response.status === 200 &&
          response.url?.includes("/events/history?before=") &&
          response.observedAt >= lateHistoryReleaseStartedAt,
      ),
    "the delayed successful historical response after panel close",
  );
  await delay(100);
  assert.equal(
    await page.call(
      () =>
        document.querySelector(".history-panel") === null &&
        document.querySelector(".live-refresh .status")?.textContent?.trim() === "auto-refresh on",
    ),
    true,
    "the generation guard must reject a late successful historical response",
  );
  const lateHistorySuccessRejected = true;

  const selectionHistoryRequest = browserPage.holdNextEventHistory();
  finishHeldBrowserHistoryRequest = selectionHistoryRequest.finish;
  await page.clickButton("Load older activity");
  const selectionHistoryObservation = await selectionHistoryRequest.observed;
  await page.clickProject("browser-project-two");
  await page.waitFor(
    () =>
      document.querySelector("#project-detail-heading")?.textContent === "browser-project-two" &&
      document.querySelector("#run-evidence-heading") === null,
    [],
    "the project selection that unmounts held historical activity",
  );
  const selectionHistoryReleaseOutcome = await settleHeldHistoryRequest(
    selectionHistoryRequest,
    selectionHistoryObservation,
    "the terminal outcome for the unmounted historical request",
  );
  assert.equal(
    await page.call(
      () =>
        document.querySelector("#project-detail-heading")?.textContent === "browser-project-two" &&
        document.querySelector("#run-evidence-heading") === null,
    ),
    true,
    "a held historical outcome must not overwrite the newer project selection",
  );

  await page.clickProject("browser-project");
  await page.waitFor(
    () => document.querySelector("#project-detail-heading")?.textContent === "browser-project",
    [],
    "the original project after held historical isolation",
  );
  await page.clickRecentRun(TASK);
  await page.waitFor(
    (runId) =>
      Array.from(document.querySelectorAll(".run-evidence dt")).some(
        (term) =>
          term.textContent?.trim() === "Run ID" &&
          term.parentElement?.querySelector("dd")?.textContent?.trim() === runId,
      ),
    [browserRunId],
    "the original run after held historical isolation",
  );
  assert.deepEqual(
    workspaceStateSnapshot(path.join(stateRoot, "icarus.sqlite3")),
    historyPersistenceBefore,
    "historical browsing must not mutate durable control state",
  );

  await page.waitFor(
    (eventLabel) =>
      Array.from(document.querySelectorAll("#run-activity .timeline__evidence-link")).some(
        (link) => link.textContent?.replaceAll(/\s+/g, " ").trim() === eventLabel,
      ),
    ["context assembled"],
    "the persisted context event after run reselection",
  );
  assert.equal(await page.locationHash(), "");
  assert.equal((await page.bodyText()).includes(PLAN_SUMMARY), false);
  const contextEvidenceHref = await page.clickTimelineEvidence("context assembled");
  assert.equal(contextEvidenceHref, "#run-context");
  await page.waitFor(
    () =>
      window.location.hash === "#run-context" && document.querySelector("#run-context") !== null,
    [],
    "timeline-to-context evidence anchor navigation",
  );

  releaseProviderResponse();
  releaseProviderResponse = undefined;
  await page.waitFor(
    (summary) =>
      Array.from(document.querySelectorAll(".run-evidence dt")).some(
        (term) =>
          term.textContent?.trim() === "Exact persisted state" &&
          term.parentElement?.querySelector("dd")?.textContent?.trim() === "awaiting_approval",
      ) && document.body.innerText.includes(summary),
    [PLAN_SUMMARY],
    "the guarded plan approval gate",
  );
  assert.equal(provider.requests.length, 1);
  assert.equal(await page.runFact("Product phase"), "awaiting approval");
  assert.equal(await page.runFact("Exact persisted state"), "awaiting_approval");
  body = await page.bodyText();
  assert.equal(body.includes("No action was proposed or allowed."), true);
  assert.equal(body.includes("not run"), true);
  assert.equal(
    body.includes("No verification diff exists. This does not imply that verification passed."),
    true,
  );
  assert.equal(body.includes("Context egress approval"), false);
  assert.equal(body.includes("Plan approval"), true);

  const approvalDatabase = new Database(path.join(stateRoot, "icarus.sqlite3"));
  try {
    approvalDatabase
      .prepare(
        `INSERT INTO approvals (id, run_id, kind, digest, actor, decision, created_at)
         VALUES (?, ?, 'plan', ?, ?, 'approve', ?)`,
      )
      .run(
        "b0000000-0000-4000-8000-000000000001",
        browserRunId,
        "f".repeat(64),
        APPROVAL_HTML_SENTINEL,
        "2026-07-22T12:00:00.000Z",
      );
  } finally {
    approvalDatabase.close();
  }

  const exactSelectedRunUrl = `${workspace.url}/api/runs/${encodeURIComponent(browserRunId)}`;
  const automaticEventResponseBaseline = networkResponses.length;
  const automaticRunReadBaseline = networkRequests.length;
  const automaticRefreshStartedAt = Date.now();
  await runtime.service.resume(browserRunId);
  await page.waitFor(
    (eventLabel) =>
      Array.from(document.querySelectorAll("#run-activity .timeline__evidence-link")).some(
        (link) => link.textContent?.replaceAll(/\s+/g, " ").trim() === eventLabel,
      ),
    ["resume requested"],
    "a newly appended event rendered by automatic refresh while the run stays selected",
  );
  await page.waitFor(
    (actor) => document.querySelector("#run-approvals")?.textContent?.includes(actor) === true,
    [APPROVAL_HTML_SENTINEL],
    "hostile approval actor rendered as inert provenance text",
  );
  assert.deepEqual(
    await page.call((actor) => {
      const section = document.querySelector("#run-approvals");
      return {
        literalText: section?.textContent?.includes(actor) === true,
        injectedElement: section?.querySelector('[data-approval-injection="true"]') !== null,
        actionControls: section?.querySelectorAll("a, button, form, input, textarea").length ?? -1,
      };
    }, APPROVAL_HTML_SENTINEL),
    { literalText: true, injectedElement: false, actionControls: 0 },
  );
  const automaticFullRunRead = networkRequests
    .slice(automaticRunReadBaseline)
    .find(
      (request) =>
        request.method === "GET" &&
        request.url === exactSelectedRunUrl &&
        request.observedAt >= automaticRefreshStartedAt,
    );
  assert.notEqual(
    automaticFullRunRead,
    undefined,
    "a newly observed event must trigger a selected-run snapshot read",
  );
  const automaticEventResponse = networkResponses
    .slice(automaticEventResponseBaseline)
    .find(
      (response) =>
        response.status === 200 &&
        response.url?.includes(`/api/runs/${encodeURIComponent(browserRunId)}/events?after=`) &&
        response.observedAt >= automaticRefreshStartedAt &&
        response.observedAt <= automaticFullRunRead.observedAt,
    );
  assert.notEqual(
    automaticEventResponse,
    undefined,
    "the automatic selected-run read must follow a successful event-page response",
  );

  await reloadPage(chromium, browserPage);
  await page.clickRecentRun(TASK);
  await page.waitFor(
    (summary) => document.body.innerText.includes(summary),
    [PLAN_SUMMARY],
    "the persisted plan evidence after reload",
  );
  assert.equal(await page.runFact("Exact persisted state"), "awaiting_approval");
  body = await page.bodyText();
  assert.equal(body.includes("No action was proposed or allowed."), true);
  assert.equal(body.includes("not run"), true);
  assert.equal(provider.requests.length, 1);

  const contextRequests = networkRequests.filter(
    (request) => request.method === "POST" && request.url?.endsWith("/context-preview"),
  );
  const draftRequests = networkRequests.filter(
    (request) => request.method === "POST" && request.url === `${workspace.url}/api/runs`,
  );
  const planRequests = networkRequests.filter(
    (request) => request.method === "POST" && request.url?.endsWith("/plan"),
  );
  const repositoryStatusRequests = networkRequests.filter(
    (request) => request.method === "GET" && request.url?.endsWith("/repository-status"),
  );
  const eventRequests = networkRequests.filter(
    (request) => request.method === "GET" && request.url?.includes("/events?after="),
  );
  const historyRequests = networkRequests.filter(
    (request) => request.method === "GET" && request.url?.includes("/events/history?before="),
  );
  const verificationAttemptRequests = verificationRequests();
  const liveReadErrors = networkResponses.filter(
    (response) =>
      (response.url?.endsWith("/repository-status") || response.url?.includes("/events?after=")) &&
      response.status !== 200,
  );
  const historyReadErrors = networkResponses.filter(
    (response) => response.url?.includes("/events/history?before=") && response.status !== 200,
  );
  const verificationReadErrors = networkResponses.filter(
    (response) =>
      response.url?.includes("/verification-attempts?snapshot=") && response.status !== 200,
  );
  assert.equal(contextRequests.length, 3);
  assert.equal(draftRequests.length, 1);
  assert.equal(planRequests.length, 1);
  assert.ok(repositoryStatusRequests.length >= 3);
  assert.ok(eventRequests.length > 0);
  assert.equal(
    historyRequests.length,
    historicalRequestsDuringNavigation.length + 6,
    "five historical lifecycle probes plus the verification abort-before-history probe are expected",
  );
  assert.ok(verificationAttemptRequests.length >= 10);
  for (const request of verificationAttemptRequests) {
    const requestUrl = new URL(request.url);
    assert.equal(request.method, "GET");
    assert.equal(requestUrl.pathname, verificationRequestPath);
    assert.deepEqual([...requestUrl.searchParams.keys()], ["snapshot"]);
    assert.equal(
      [500, 501, 502].includes(Number(requestUrl.searchParams.get("snapshot"))),
      true,
      "every verification read must stay pinned to an observed selected-run revision",
    );
  }
  for (const request of historyRequests) {
    const historyUrl = new URL(request.url);
    assert.equal(
      historyUrl.pathname,
      `/api/runs/${encodeURIComponent(browserRunId)}/events/history`,
    );
    assert.deepEqual([...historyUrl.searchParams.keys()], ["before", "snapshot"]);
    assert.equal(
      Number(historyUrl.searchParams.get("snapshot")),
      request.requestId === verificationHistoryNetworkRequest.requestId ? 502 : historySnapshot,
    );
  }
  const selectedRunEventPaths = new Set([
    `/api/runs/${encodeURIComponent(browserRunId)}/events`,
    `/api/runs/${encodeURIComponent(runSummaryFixture.validArchivedRunId)}/events`,
    `/api/runs/${encodeURIComponent(runSummaryFixture.alternateArchivedRunId)}/events`,
  ]);
  let sawArchivedRunPoll = false;
  for (const request of eventRequests) {
    const eventUrl = new URL(request.url);
    assert.equal(
      selectedRunEventPaths.has(eventUrl.pathname),
      true,
      "every event poll must remain bound to a run selected in the browser",
    );
    if (eventUrl.pathname.includes(runSummaryFixture.alternateArchivedRunId)) {
      sawArchivedRunPoll = true;
    }
    assert.deepEqual([...eventUrl.searchParams.keys()], ["after"]);
  }
  assert.equal(sawArchivedRunPoll, true, "lazy older-run detail must bind its event observer");
  assert.deepEqual(
    liveReadErrors.map(({ status }) => status),
    [503, 503],
  );
  assert.deepEqual(
    historyReadErrors.map(({ status }) => status),
    [503],
  );
  assert.deepEqual(
    verificationReadErrors.map(({ status }) => status),
    [503, 409],
  );
  assert.deepEqual(blockedExternalRequests, []);
  assert.deepEqual(browserErrors, []);
  assert.equal((await page.bodyText()).includes(HISTORICAL_EVENT_SENTINEL), false);

  const projects = runtime.service.listProjects();
  const browserProject = projects.find((project) => project.name === "browser-project");
  const run = runtime.service.getRun(browserRunId);
  assert.equal(projects.length, PROJECT_PAGE_FIXTURE_COUNT + 2);
  assert.notEqual(browserProject, undefined);
  assert.equal(run.id, browserRunId);
  assert.equal(run.state, "awaiting_approval");
  const after = await fingerprint(repository);
  assert.deepEqual(after, before);

  process.stdout.write(
    `${JSON.stringify(
      {
        binding: workspace.host,
        browser: path.basename(chromiumExecutable),
        initialProvider: "unconfigured",
        initialExecution: "unconfigured",
        validationErrors: ["invalid_check_argv", "missing_context_target", "invalid_provider_url"],
        projectId: browserProject?.id,
        contextDigest: firstDigest,
        runId: run.id,
        draftSurvivedReload: true,
        state: run.state,
        verification: "not_run",
        action: null,
        providerRequests: provider.requests.length,
        planSurvivedReload: true,
        repositoryStatus: ["not_observed", "clean", "dirty", "clean"],
        skipLinkKeyboardAccepted,
        deferredWorkspaceSelectionGuard: true,
        automaticEventRefresh: true,
        visibilityPolling: ["visible", "hidden", "visible"],
        heldEventPolling: {
          overlapPrevented: true,
          stoppedOnUnmount: true,
          release: heldEventReleaseOutcome,
          terminal: heldEventTerminal,
          selectionPreserved: true,
        },
        boundedProjectPageNavigation: boundedProjectPageEvidence,
        offPageRunSelectionPreserved,
        boundedVerificationProvenance: boundedVerificationEvidence,
        boundedRunPageNavigation: boundedRunPageEvidence,
        historicalEventNavigation: {
          pinnedRevision: historySnapshot,
          firstPageRange: firstHistoryRange,
          pageReplacement: true,
          retryPreservedPage: true,
          maximumPages: 4,
          historicalEvidenceAnchor: historicalContextEvidenceHref,
          activeLivePollCancelled: historyOpenLivePollOutcome,
          livePollingPaused: true,
          livePollingResumed: true,
          singleFlightContended: true,
          lateSuccessRejected: lateHistorySuccessRejected,
          focusRestored: true,
          payloadPrivate: true,
          durableStateUnchanged: true,
          heldRequests: {
            hidden: hiddenHistoryReleaseOutcome,
            close: closeHistoryReleaseOutcome,
            selection: selectionHistoryReleaseOutcome,
            statePreserved: true,
          },
          requests: historyRequests.length,
        },
        controlledReadFailures: liveReadErrors.length,
        controlledHistoryReadFailures: historyReadErrors.length,
        controlledVerificationReadFailures: verificationReadErrors.length,
        eventRecoveryDelayMs: recoveryDelayMs,
        evidenceAnchor: contextEvidenceHref,
        repositoryStatusRequests: repositoryStatusRequests.length,
        eventRequests: eventRequests.length,
        browserErrors: browserErrors.length,
        blockedExternalRequests: blockedExternalRequests.length,
        sourceUnchanged: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await finishHeldBrowserProjectPageRequest?.().catch(() => undefined);
  finishHeldBrowserProjectPageRequest = undefined;
  await finishHeldBrowserRunPageRequest?.().catch(() => undefined);
  finishHeldBrowserRunPageRequest = undefined;
  await finishHeldBrowserHistoryRequest?.().catch(() => undefined);
  finishHeldBrowserHistoryRequest = undefined;
  await finishHeldBrowserVerificationRequest?.().catch(() => undefined);
  finishHeldBrowserVerificationRequest = undefined;
  await finishHeldBrowserEventPoll?.().catch(() => undefined);
  finishHeldBrowserEventPoll = undefined;
  releaseProviderResponse?.();
  releaseProviderResponse = undefined;
  await stopChromium(chromium);
  await workspace?.close();
  runtime?.close();
  await provider?.close();
  await rm(root, { recursive: true, force: true });
}
