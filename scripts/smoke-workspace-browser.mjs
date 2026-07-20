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
const DIRTY_MARKER_NAME = ".browser-status-private-marker.txt";
const DIRTY_MARKER_CONTENT = "private dirty marker content must never render\n";
const TASK = "Inspect one bounded browser workspace request.";
const PLAN_SUMMARY = "Review one exact local target before any guarded execution.";
const START_TIMEOUT_MS = 15_000;
const UI_TIMEOUT_MS = 10_000;
const EVENT_POLL_INTERVAL_MS = 2_000;
const EVENT_POLL_FIRST_BACKOFF_MS = 4_000;

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
  let repositoryStatusFailuresRemaining = 0;
  let eventRequestHold = null;
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
    const failEventPoll = localEventPoll && eventFailuresRemaining > 0;
    const failRepositoryStatus = localRepositoryStatus && repositoryStatusFailuresRemaining > 0;
    if (failEventPoll) eventFailuresRemaining -= 1;
    if (failRepositoryStatus) repositoryStatusFailuresRemaining -= 1;
    if (failEventPoll || failRepositoryStatus) {
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
  assert.equal(body.includes("No diff was produced."), true);
  assert.equal(body.includes("Context egress approval"), false);
  assert.equal(body.includes("Plan approval"), true);

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
  const liveReadErrors = networkResponses.filter(
    (response) =>
      (response.url?.endsWith("/repository-status") || response.url?.includes("/events?after=")) &&
      response.status !== 200,
  );
  assert.equal(contextRequests.length, 3);
  assert.equal(draftRequests.length, 1);
  assert.equal(planRequests.length, 1);
  assert.ok(repositoryStatusRequests.length >= 3);
  assert.ok(eventRequests.length > 0);
  for (const request of eventRequests) {
    const eventUrl = new URL(request.url);
    assert.equal(
      eventUrl.pathname,
      `/api/runs/${encodeURIComponent(browserRunId)}/events`,
      "every selected-run event poll must remain bound to that run id",
    );
    assert.deepEqual([...eventUrl.searchParams.keys()], ["after"]);
  }
  assert.deepEqual(
    liveReadErrors.map(({ status }) => status),
    [503, 503],
  );
  assert.deepEqual(blockedExternalRequests, []);
  assert.deepEqual(browserErrors, []);

  const projects = runtime.service.listProjects();
  const runs = runtime.service.listRuns();
  assert.equal(projects.length, 2);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.id, browserRunId);
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
        repositoryStatus: ["not_observed", "clean", "dirty", "clean"],
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
        controlledReadFailures: liveReadErrors.length,
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
