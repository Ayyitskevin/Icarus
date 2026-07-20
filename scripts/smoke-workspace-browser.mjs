import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { startWorkspaceServer } from "../packages/api/dist/server.js";
import { createIcarusRuntime } from "../packages/core/dist/index.js";

const SANDBOX_IMAGE = `python:3.12-slim@sha256:${"c".repeat(64)}`;
const TARGET = "src/app.txt";
const TARGET_CONTENT = "browser acceptance source remains untouched\n";
const TASK = "Inspect one bounded browser workspace request.";
const PLAN_SUMMARY = "Review one exact local target before any guarded execution.";
const START_TIMEOUT_MS = 15_000;
const UI_TIMEOUT_MS = 10_000;

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

async function startProvider() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        requests.push({
          method: request.method,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
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
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
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

  bodyText() {
    return this.call(() => document.body.innerText);
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

  contextFact(label) {
    return this.call((factLabel) => {
      const root = document.querySelector("#context-summary-heading")?.closest("section");
      const term = Array.from(root?.querySelectorAll("dt") ?? []).find(
        (candidate) => candidate.textContent?.trim() === factLabel,
      );
      return term?.parentElement?.querySelector("dd")?.textContent?.trim() ?? null;
    }, label);
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
  const blockedExternalRequests = [];
  const browserErrors = [];
  chromium.cdp.on(sessionId, "Network.requestWillBeSent", (event) => {
    networkRequests.push({ method: event.request?.method, url: event.request?.url });
  });
  chromium.cdp.on(sessionId, "Network.responseReceived", (event) => {
    networkResponses.push({ status: event.response?.status, url: event.response?.url });
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
    try {
      const parsed = new URL(requestUrl);
      external =
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.origin !== workspaceUrl;
    } catch {
      external = false;
    }
    if (external) blockedExternalRequests.push(requestUrl);
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
    blockedExternalRequests,
    browserErrors,
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
  const { page, networkRequests, networkResponses, blockedExternalRequests, browserErrors } =
    browserPage;

  await page.waitFor(
    () =>
      document.body.innerText.includes("No projects are registered.") &&
      document.body.innerText.includes("No run records exist."),
    [],
    "the initial empty workspace",
  );
  assert.equal(await page.capability("Provider"), "unconfigured");
  assert.equal(await page.capability("Execution"), "unconfigured");

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
  await page.clickButton("Register project");
  await page.waitFor(
    () => document.querySelector("#project-detail-heading")?.textContent === "browser-project",
    [],
    "the persisted project detail",
  );

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
  let body = await page.bodyText();
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

  await page.clickButton("Create guarded plan");
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
  assert.equal(body.includes("No diff was produced."), true);
  assert.equal(body.includes("Context egress approval"), false);
  assert.equal(body.includes("Plan approval"), true);

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
  assert.equal(contextRequests.length, 3);
  assert.equal(draftRequests.length, 1);
  assert.equal(planRequests.length, 1);
  assert.deepEqual(blockedExternalRequests, []);
  assert.deepEqual(browserErrors, []);

  const projects = runtime.service.listProjects();
  const runs = runtime.service.listRuns();
  assert.equal(projects.length, 1);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.state, "awaiting_approval");
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
        projectId: projects[0]?.id,
        contextDigest: firstDigest,
        runId: runs[0]?.id,
        draftSurvivedReload: true,
        state: runs[0]?.state,
        verification: "not_run",
        action: null,
        providerRequests: provider.requests.length,
        planSurvivedReload: true,
        browserErrors: browserErrors.length,
        blockedExternalRequests: blockedExternalRequests.length,
        sourceUnchanged: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await stopChromium(chromium);
  await workspace?.close();
  runtime?.close();
  await provider?.close();
  await rm(root, { recursive: true, force: true });
}
