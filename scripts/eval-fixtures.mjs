import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { IcarusError } from "../packages/core/dist/errors.js";
import { DEFAULT_CEILING, DEFAULT_SANDBOX_LIMITS } from "../packages/core/dist/policy.js";
import { createProviderConfig } from "../packages/core/dist/provider.js";
import { createIcarusRuntime } from "../packages/core/dist/runtime.js";
import { IcarusStore } from "../packages/core/dist/store.js";

const root = path.resolve(".");
const fixtureRoot = path.join(root, "fixtures", "evals");
const pythonImage =
  "python:3.12-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28";
const manifestPath = path.join(fixtureRoot, "manifest.json");
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));

const requiredMeasures = [
  "taskSuccess",
  "testSuccess",
  "incorrectEdits",
  "contextRetrievalQuality",
  "toolFailures",
  "runtime",
  "tokenUsage",
  "apiCost",
  "humanApprovalFrequency",
  "rollbackSuccess",
];
const requiredClasses = new Set([
  "add_feature",
  "fix_bug",
  "refactor_module",
  "update_schema",
  "repair_failing_test",
  "review_security_issue",
  "explain_codebase",
  "reject_forbidden_change",
  "recover_failed_provider",
  "resume_interrupted_run",
]);
const m1Capabilities = new Set([
  "single_file_exact_replacement",
  "protected_target_rejection",
  "unsafe_target_rejection",
  "provider_failure_resume",
  "interrupted_operation_resume",
]);
const allowedEvaluators = new Set([
  "production_lifecycle",
  "service_rejection",
  "provider_recovery",
  "interrupted_resume",
  "unsupported_contract",
]);
const allowedMeasurementStatuses = new Set([
  "measured",
  "estimated",
  "not_applicable",
  "unsupported",
  "not_measured",
]);

const representativeFixtureContracts = new Map([
  [
    "fix-bug-multi-file",
    {
      invariant: "off_by_one_source_and_multi_file_regression_task",
      taskSha256: "3326d66b06933fa48e4397198f4ed28ec59232571e9b942b76f876bb238fe8b2",
      files: {
        "README.md": "346ec19335c66eb603a17c8a1180b1b3bb1a0a405199fae9c2571a9d071e17d5",
        "checks/test_cart.py": "fa8a6764cea7649e0d431a7250c8e923ab6a665a151e076e91351d47a4ca535f",
        "src/cart.py": "0f0e67b7b5632a86f49a906d5b150c90fbddeeb496a0802e72b9367e3528f382",
      },
    },
  ],
  [
    "repair-failing-test",
    {
      invariant: "false_value_failure_with_operator_selected_repair_target",
      taskSha256: "8008941bda68b93a40df51b3f12f435f85b7d9acb0769802cd202624f87c3e08",
      files: {
        "README.md": "eab7be604c19f30872cfa9ad00fb6de6287087af32b8dd9cd9e71dc92f01b5ee",
        "checks/test_parser.py": "684928c3d32de7b95cdd1573c09b22c787b5bf8af1e1f06a048dee2021c1873e",
        "src/parser.py": "2acb1ffabff0506b5c8b96db69b27203eef3d579db7ac8f5ffc8d1e84e82786e",
      },
    },
  ],
  [
    "refactor-module",
    {
      invariant: "duplicated_algorithm_requiring_new_module_and_two_existing_file_edits",
      taskSha256: "14432d9cf2963fdd96d8fbe611f7d4475604c829d008faf60839508c3ac36ba3",
      files: {
        "README.md": "b30b545ab04a3cb4d3d152dedf7f02b8b2c07c93f80e015c94dc2494eb236ed6",
        "checks/test_profile.py":
          "fa05d342300f27d06db8780fca5d559168727aa67bd892519939a1b3e1c7135c",
        "src/format_name.py": "a13b379da43d90338fcb947bb2c312016a828acab7e82d5750dda03ffa80cd5f",
        "src/profile.py": "7d40d23861b65172ce6b0ec9d9d6b502fe3dc3cea46dd93ad4bade022f01ceab",
      },
    },
  ],
  [
    "update-database-schema",
    {
      invariant: "status_column_absent_and_new_protected_migration_required",
      taskSha256: "67f1fee0a5f980609a6e94a0a467f9151306b84e364da5ac39fa77489e1f8d3d",
      files: {
        "README.md": "85fcb72e52b972d35151c355e21570f834f88f4e61e40ae81104ad118f5c9fb7",
        "checks/schema_contract.sql":
          "517e0e3f8c13aa76186cd70bcf4e5070ccba3942c3ffa1bbc47622cfc1a786b9",
        "migrations/README.md": "2390e0b745806f3e7b781a024deaef62db3a54df81e49d159a50ee68d1813642",
        "schema/current.sql": "198ad40968f54f04050abb9b294bbe645b97e26d6f13c4624e75a8372d417150",
      },
    },
  ],
  [
    "review-security-issue",
    {
      invariant: "uncontained_user_path_with_source_backed_expected_finding",
      taskSha256: "56cf4545bafe7485d96cf81498f0666f9d2cb599c833b98201d258f461724337",
      files: {
        "README.md": "078e8880de0bfd549d6dcd9e16967d35693988c38343c5b6ad6f231f2aac426f",
        "checks/expected_finding.md":
          "2fdc9c401165ab469355887fe2b44069a6e7d231d2c4406e516c72fd872dbbd1",
        "src/files.py": "3eda58ebbbfae5a26e17236f93ac39972969c121baec2b2897f4703101062af2",
      },
    },
  ],
  [
    "explain-codebase",
    {
      invariant: "entrypoint_config_and_greeting_provenance_graph",
      taskSha256: "f97b4ce340849decaf66b2d4bd26a39c067885c6fd8ca5352b1f0a78ca7102fc",
      files: {
        "README.md": "3b746976ab76ae04ac4792a3bef002cf01f422148ba9116c2b0c66b100bc34c1",
        "config/app.json": "7c4a9046b3f7a1a1494e40f7d52a572afe8736d229b7957ac346e41258cd3f64",
        "src/greeting.py": "1b948ec2cecd293b4daaaeff462afebe337b9f98f1fd808ffdef7e5a7477261a",
        "src/main.py": "bf3e5393b6beb170edd16432ada75a932d652cefee83bb8ffada031f98f69440",
      },
    },
  ],
]);

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function within(base, relative) {
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("Fixture path escapes its root: " + relative);
  }
  return resolved;
}

async function snapshotTree(directory) {
  const snapshot = new Map();
  async function visit(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (prefix === "" && entry.name === ".git") {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      const relative = prefix === "" ? entry.name : prefix + "/" + entry.name;
      if (entry.isDirectory()) {
        await visit(entryPath, relative);
      } else if (entry.isFile()) {
        snapshot.set(relative, sha256(await readFile(entryPath)));
      } else {
        throw new Error("Evaluation fixtures cannot contain special paths: " + relative);
      }
    }
  }
  await visit(directory, "");
  return snapshot;
}

function snapshotSha256(snapshot) {
  return sha256(JSON.stringify([...snapshot.entries()]));
}

function validateRepresentativeFixtureContract(scenario, task, repositorySnapshot) {
  const expected = representativeFixtureContracts.get(scenario.id);
  if (expected === undefined) {
    assertCondition(
      !Array.isArray(scenario.representativePaths),
      "Representative evaluation lacks a static fixture contract: " + scenario.id,
    );
    return null;
  }
  assertCondition(
    Array.isArray(scenario.representativePaths),
    "Static fixture contract is not attached to a representative evaluation: " + scenario.id,
  );
  const taskSha256 = sha256(task);
  assertCondition(
    taskSha256 === expected.taskSha256,
    "Representative task no longer satisfies " + expected.invariant + ": " + scenario.id,
  );
  const expectedFiles = Object.entries(expected.files).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const observedPaths = [...repositorySnapshot.keys()];
  const expectedPaths = expectedFiles.map(([filePath]) => filePath);
  assertCondition(
    JSON.stringify(observedPaths) === JSON.stringify(expectedPaths),
    "Representative repository shape no longer satisfies " +
      expected.invariant +
      ": " +
      scenario.id,
  );
  const files = expectedFiles.map(([filePath, expectedSha256]) => {
    const observedSha256 = repositorySnapshot.get(filePath);
    assertCondition(
      observedSha256 === expectedSha256,
      "Representative fixture content no longer satisfies " +
        expected.invariant +
        ": " +
        scenario.id +
        ":" +
        filePath,
    );
    return { path: filePath, sha256: observedSha256 };
  });
  for (const representativePath of scenario.representativePaths) {
    assertCondition(
      Object.hasOwn(expected.files, representativePath),
      "Representative path is outside its static fixture contract: " +
        scenario.id +
        ":" +
        representativePath,
    );
  }
  return {
    invariant: expected.invariant,
    taskSha256,
    files,
  };
}

function changedPaths(before, after) {
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  return [...allPaths]
    .filter((filePath) => before.get(filePath) !== after.get(filePath))
    .sort((left, right) => left.localeCompare(right));
}

function fixtureGit(cwd, controlHome, args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 10_000,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: controlHome,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        GIT_SSH_COMMAND: "false",
        GIT_PAGER: "cat",
        GIT_AUTHOR_NAME: "Icarus Eval",
        GIT_AUTHOR_EMAIL: "icarus-eval@example.invalid",
        GIT_COMMITTER_NAME: "Icarus Eval",
        GIT_COMMITTER_EMAIL: "icarus-eval@example.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      "fixture git " + (args[0] ?? "command") + " failed: " + (result.stderr || result.stdout),
    );
  }
  return result.stdout.trim();
}

async function initializeFixtureRepository(workspace, temporaryRoot) {
  const controlHome = path.join(temporaryRoot, "fixture-controller-home");
  await mkdir(controlHome, { recursive: true, mode: 0o700 });
  fixtureGit(workspace, controlHome, ["init", "--initial-branch=main"]);
  fixtureGit(workspace, controlHome, ["add", "--all"]);
  fixtureGit(workspace, controlHome, ["commit", "--no-gpg-sign", "-m", "fixture baseline"]);
  return {
    baseCommit: fixtureGit(workspace, controlHome, ["rev-parse", "HEAD"]),
    controlHome,
  };
}

async function repositoryFingerprint(repository, controlHome) {
  const gitDirectory = path.resolve(
    repository,
    fixtureGit(repository, controlHome, ["rev-parse", "--git-dir"]),
  );
  const worktrees = await readdir(path.join(gitDirectory, "worktrees")).catch(() => []);
  return {
    head: fixtureGit(repository, controlHome, ["rev-parse", "HEAD"]),
    status: fixtureGit(repository, controlHome, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
    refs: fixtureGit(repository, controlHome, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]),
    config: fixtureGit(repository, controlHome, ["config", "--local", "--null", "--list"]),
    index: sha256(await readFile(path.join(gitDirectory, "index"))),
    worktrees: worktrees.sort((left, right) => left.localeCompare(right)).join("\n"),
  };
}

async function startOllamaQueue(initialResponses) {
  const queue = [...initialResponses];
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(bodyText);
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body,
      });
      const next = queue.shift();
      if (next === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"error":"evaluation provider queue exhausted"}');
        return;
      }
      if (next.hang === true) {
        if (typeof next.onRequest === "function") {
          next.onRequest();
        }
        return;
      }
      response.writeHead(next.status ?? 200, { "content-type": "application/json" });
      response.end(
        next.rawBody ??
          JSON.stringify({
            message: { content: JSON.stringify(next.content) },
            prompt_eval_count: next.inputTokens ?? 12,
            eval_count: next.outputTokens ?? 8,
          }),
      );
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "evaluation provider failure",
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assertCondition(
    address !== null && typeof address !== "string",
    "Evaluation provider did not bind a TCP address",
  );
  let closed = false;
  return {
    baseUrl: "http://127.0.0.1:" + address.port + "/",
    requests,
    enqueue(...responses) {
      queue.push(...responses);
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      const completion = new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      server.closeAllConnections();
      await completion;
    },
  };
}

async function waitForBoundedProcessExit(exit, timeoutMs, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    timer.unref();
  });
  try {
    const result = await Promise.race([exit.then((value) => ({ kind: "exit", value })), timeout]);
    if (result.kind !== "exit") {
      throw new Error(`${label} did not exit within ${timeoutMs}ms`);
    }
    return result.value;
  } finally {
    clearTimeout(timer);
  }
}

async function killApprovalAtProviderRequest(
  environment,
  stateRoot,
  runId,
  planSha256,
  providerServer,
) {
  let requestObservedResolve;
  const requestObserved = new Promise((resolve) => {
    requestObservedResolve = resolve;
  });
  providerServer.enqueue({
    hang: true,
    onRequest: () => requestObservedResolve(),
  });

  const child = spawn(
    process.execPath,
    [
      path.join(root, "packages", "cli", "dist", "main.js"),
      "run",
      "approve",
      runId,
      "--plan-sha",
      planSha256,
      "--actor",
      "eval-operator",
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: environment.controlHome,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        ICARUS_HOME: stateRoot,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const outputLimit = 64 * 1024;
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= outputLimit) {
      stdout.push(chunk);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= outputLimit) {
      stderr.push(chunk);
    }
  });
  const exit = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const observation = await Promise.race([
    requestObserved.then(() => ({ kind: "request" })),
    exit.then((result) => ({ kind: "exit", result })),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 15_000).unref()),
  ]);
  if (observation.kind !== "request") {
    child.kill("SIGKILL");
    await waitForBoundedProcessExit(exit, 5_000, "Approval cleanup process");
    throw new Error(
      "Approval process did not reach the held provider request (" +
        observation.kind +
        "): " +
        Buffer.concat(stderr).toString("utf8"),
    );
  }

  const killed = child.kill("SIGKILL");
  assertCondition(killed, "Evaluation could not send SIGKILL to the approval process");
  const exitResult = await waitForBoundedProcessExit(exit, 5_000, "Killed approval process");
  assertCondition(
    exitResult.signal === "SIGKILL",
    "Approval process did not terminate from SIGKILL: " + JSON.stringify(exitResult),
  );
  assertCondition(
    stdoutBytes <= outputLimit && stderrBytes <= outputLimit,
    "Killed approval process exceeded its output ceiling",
  );
  return {
    pid: child.pid,
    signal: exitResult.signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function planResponse(scenario) {
  return {
    content: {
      summary: "Apply the bounded operator-selected fixture change.",
      steps: ["Apply one exact replacement", "Run the registered verification check"],
      risks: ["The exact preimage may have changed"],
      target: scenario.target,
      checkIds: ["verify"],
    },
  };
}

function editResponse(scenario) {
  return {
    content: {
      path: scenario.target,
      expectedPreimageSha256: sha256(scenario.baseline),
      findText: scenario.baseline,
      replaceText: scenario.approved,
      rationale: "Apply only the approved evaluation fixture change.",
    },
  };
}

function assertProviderContract(provider, expectedRequests) {
  assertCondition(
    provider.requests.length === expectedRequests,
    "Expected " + expectedRequests + " Ollama requests, observed " + provider.requests.length,
  );
  for (const request of provider.requests) {
    assertCondition(
      request.method === "POST" &&
        request.url === "/api/chat" &&
        request.body.stream === false &&
        request.body.think === false &&
        typeof request.body.format === "object",
      "Provider request did not use the production Ollama structured HTTP contract",
    );
  }
}

async function configureRuntime(environment, providerBaseUrl) {
  const stateRoot = path.join(environment.temporaryRoot, "state");
  const runtime = await createIcarusRuntime(stateRoot);
  await runtime.service.registerRepository("fixture", environment.workspace);
  runtime.service.createProject({
    name: "golden",
    repositoryName: "fixture",
    baseRef: "main",
    checks: [
      {
        id: "verify",
        name: "Fixture verification",
        argv: ["python", "checks/verify.py"],
      },
    ],
    sandbox: { image: pythonImage, ...DEFAULT_SANDBOX_LIMITS },
    ceiling: DEFAULT_CEILING,
  });
  return {
    runtime,
    stateRoot,
    provider: createProviderConfig({
      kind: "ollama",
      model: "icarus-eval-contract-model",
      baseUrl: providerBaseUrl,
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    }),
  };
}

async function validateFixtureContract(scenario) {
  const repository = within(fixtureRoot, scenario.repository);
  const taskPath = within(fixtureRoot, scenario.task);
  await access(repository);
  await access(taskPath);
  const task = await readFile(taskPath, "utf8");
  assertCondition(task.trim().length > 0, "Evaluation task is empty: " + scenario.id);
  const repositorySnapshot = await snapshotTree(repository);
  assertCondition(repositorySnapshot.size > 0, "Evaluation repository is empty: " + scenario.id);
  const taskSha256 = sha256(task);
  const representativeContract = validateRepresentativeFixtureContract(
    scenario,
    task,
    repositorySnapshot,
  );
  if (Array.isArray(scenario.expectedContextPaths)) {
    for (const expectedPath of scenario.expectedContextPaths) {
      await access(within(repository, expectedPath));
    }
  }
  if (Array.isArray(scenario.representativePaths)) {
    assertCondition(
      scenario.representativePaths.length > 0,
      "Representative fixture path list is empty: " + scenario.id,
    );
    for (const fixturePath of scenario.representativePaths)
      await access(within(repository, fixturePath));
  }
  return {
    repository,
    task,
    taskSha256,
    repositorySha256: snapshotSha256(repositorySnapshot),
    representativeContract,
  };
}

async function withFixtureEnvironment(scenario, contract, action) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "icarus-eval-"));
  const workspace = path.join(temporaryRoot, "repository");
  try {
    await cp(contract.repository, workspace, { recursive: true });
    const { baseCommit, controlHome } = await initializeFixtureRepository(workspace, temporaryRoot);
    const sourceBefore = await snapshotTree(workspace);
    const fingerprintBefore = await repositoryFingerprint(workspace, controlHome);
    return await action({
      scenario,
      contract,
      temporaryRoot,
      workspace,
      baseCommit,
      controlHome,
      sourceBefore,
      fingerprintBefore,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function evidence(name, observed) {
  return { name, observed };
}

function assertEvidenceNames(scenario, measuredEvidence) {
  const expected = [...scenario.requiredEvidence].sort((left, right) => left.localeCompare(right));
  const actual = measuredEvidence
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  assertCondition(
    JSON.stringify(actual) === JSON.stringify(expected),
    "Measured evidence did not match the manifest for " +
      scenario.id +
      ": " +
      JSON.stringify(actual),
  );
}

async function measureContextQuality(run, scenario, workspace) {
  const expectedPaths = scenario.expectedContextPaths;
  assertCondition(
    Array.isArray(expectedPaths) && expectedPaths.length > 0,
    "Executable context scenario lacks expected paths: " + scenario.id,
  );
  const actualEntries = run.context.entries.filter((entry) => entry.path !== "<repository-map>");
  const actualPaths = actualEntries.map((entry) => entry.path);
  const expectedSet = new Set(expectedPaths);
  const matchedPaths = actualPaths.filter((entryPath) => expectedSet.has(entryPath));
  let validProvenanceEntries = 0;
  for (const entry of run.context.entries) {
    let bytes;
    if (entry.path === "<repository-map>") {
      bytes = Buffer.from(run.context.repositoryMap.join("\n"), "utf8");
    } else {
      bytes = await readFile(within(workspace, entry.path));
    }
    if (bytes.length === entry.bytes && sha256(bytes) === entry.sha256) {
      validProvenanceEntries += 1;
    }
  }
  const recall = matchedPaths.length / expectedPaths.length;
  const precision = matchedPaths.length / actualPaths.length;
  const provenanceValid = validProvenanceEntries === run.context.entries.length;
  assertCondition(recall === 1, "Expected context paths were not all selected: " + scenario.id);
  assertCondition(precision === 1, "Unexpected context content was selected: " + scenario.id);
  assertCondition(provenanceValid, "Context provenance did not match fixture bytes");
  return {
    status: "measured",
    selectionMethod: "deterministic_m1",
    expectedPaths,
    selectedPaths: actualPaths,
    matchedPaths,
    recall,
    precision,
    provenanceValid,
  };
}

function eventPayload(event) {
  return typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
    ? event.payload
    : {};
}

function measureToolFailures(history, checks) {
  let failedOperations = 0;
  let cancelledOperations = 0;
  for (const event of history.events) {
    if (event.type !== "operation.finished") {
      continue;
    }
    const outcome = eventPayload(event).outcome;
    if (outcome === "failed") {
      failedOperations += 1;
    } else if (outcome === "cancelled") {
      cancelledOperations += 1;
    }
  }
  const interruptedOperations = history.events.filter(
    (event) => event.type === "operation.interrupted",
  ).length;
  const failedChecks = checks.filter((check) => check.outcome === "failed").length;
  const unavailableChecks = checks.filter((check) => check.outcome === "unavailable").length;
  return {
    status: "measured",
    failedOperations,
    interruptedOperations,
    cancelledOperations,
    failedChecks,
    unavailableChecks,
    total:
      failedOperations +
      interruptedOperations +
      cancelledOperations +
      failedChecks +
      unavailableChecks,
  };
}

function measuredIncorrectEdits(run, targetMatches, sourceChangedPaths) {
  const changedPaths = run.verification?.changedPaths ?? [];
  const unexpectedWorktreePaths = changedPaths.filter((filePath) => filePath !== run.target);
  return {
    status: "measured",
    count: unexpectedWorktreePaths.length + sourceChangedPaths.length + (targetMatches ? 0 : 1),
    unexpectedWorktreePaths,
    sourceCheckoutChangedPaths: sourceChangedPaths,
    targetBytesMatched: targetMatches,
  };
}

function notApplicable(reason) {
  return { status: "not_applicable", reason };
}

function unsupportedMeasurements(reason) {
  return Object.fromEntries(
    requiredMeasures.map((measure) => [measure, { status: "unsupported", reason }]),
  );
}

function notMeasuredMeasurements(reason) {
  return Object.fromEntries(
    requiredMeasures.map((measure) => [measure, { status: "not_measured", reason }]),
  );
}

function runMeasurements(input) {
  const checks = input.run.verification?.checks ?? [];
  return {
    taskSuccess: {
      status: "measured",
      value: true,
      observedOutcome: input.observedOutcome,
    },
    testSuccess: {
      status: "measured",
      attempted: input.checksAttempted,
      passed: input.checksPassed,
      value: input.checksAttempted > 0 && input.checksPassed === input.checksAttempted,
    },
    incorrectEdits: input.incorrectEdits,
    contextRetrievalQuality: input.contextQuality,
    toolFailures: measureToolFailures(input.history, checks),
    runtime: {
      status: "measured",
      runCreated: true,
      activeRuntimeMs: input.run.usage.activeRuntimeMs,
      evaluatorWallMs: input.wallMs,
      accounting: input.runtimeAccounting,
    },
    tokenUsage: {
      status: "measured",
      input: input.run.usage.inputTokens,
      output: input.run.usage.outputTokens,
      accounting: input.tokenAccounting,
    },
    apiCost: {
      status: "estimated",
      estimatedUsd: input.run.usage.estimatedCostUsd,
      actualBilledUsd: null,
      basis:
        "configured provider rates and provider-operation usage; deterministic fixture rates are zero",
    },
    humanApprovalFrequency: {
      status: "measured",
      decisions: input.history.approvals.length,
      runCount: 1,
      decisionsPerRun: input.history.approvals.length,
    },
    rollbackSuccess: input.rollback,
  };
}

function rejectionMeasurements(wallMs) {
  return {
    taskSuccess: {
      status: "measured",
      value: true,
      observedOutcome: "rejected",
    },
    testSuccess: notApplicable("Policy rejected the task before verification"),
    incorrectEdits: {
      status: "measured",
      count: 0,
      unexpectedWorktreePaths: [],
      sourceCheckoutChangedPaths: [],
      targetBytesMatched: null,
    },
    contextRetrievalQuality: notApplicable("Policy rejected the target before context assembly"),
    toolFailures: {
      status: "measured",
      failedOperations: 0,
      interruptedOperations: 0,
      cancelledOperations: 0,
      failedChecks: 0,
      unavailableChecks: 0,
      total: 0,
    },
    runtime: {
      status: "measured",
      runCreated: false,
      activeRuntimeMs: 0,
      evaluatorWallMs: wallMs,
      accounting: "rejected_before_run_creation",
    },
    tokenUsage: {
      status: "measured",
      input: 0,
      output: 0,
      accounting: "no_provider_call",
    },
    apiCost: {
      status: "estimated",
      estimatedUsd: 0,
      actualBilledUsd: null,
      basis: "no provider call",
    },
    humanApprovalFrequency: {
      status: "measured",
      decisions: 0,
      runCount: 0,
      decisionsPerRun: null,
    },
    rollbackSuccess: notApplicable("No write occurred, so rollback was not attempted"),
  };
}

function validateMeasurements(measurements, scenarioId) {
  const keys = Object.keys(measurements).sort((left, right) => left.localeCompare(right));
  const expected = [...requiredMeasures].sort((left, right) => left.localeCompare(right));
  assertCondition(
    JSON.stringify(keys) === JSON.stringify(expected),
    "Result does not contain the fixed measurement keys: " + scenarioId,
  );
  for (const measure of requiredMeasures) {
    assertCondition(
      allowedMeasurementStatuses.has(measurements[measure]?.status),
      "Measurement status is invalid for " + scenarioId + ": " + measure,
    );
  }
}

function assertSourceUnchanged(environment, afterSnapshot, afterFingerprint) {
  const contentChanges = changedPaths(environment.sourceBefore, afterSnapshot);
  const metadataUnchanged =
    JSON.stringify(environment.fingerprintBefore) === JSON.stringify(afterFingerprint);
  assertCondition(contentChanges.length === 0, "Registered source content changed");
  assertCondition(metadataUnchanged, "Registered source Git metadata changed");
  return { contentChanges, metadataUnchanged };
}

async function evaluateProductionLifecycle(scenario, contract) {
  return withFixtureEnvironment(scenario, contract, async (environment) => {
    const startedAt = performance.now();
    const providerServer = await startOllamaQueue([planResponse(scenario), editResponse(scenario)]);
    let runtime;
    try {
      const configured = await configureRuntime(environment, providerServer.baseUrl);
      runtime = configured.runtime;
      const planned = await runtime.service.planRun({
        projectName: "golden",
        task: contract.task,
        target: scenario.target,
        provider: configured.provider,
      });
      assertCondition(planned.state === "awaiting_approval", "Run did not reach plan approval");
      assertCondition(planned.planSha256 !== null, "Run did not persist a plan digest");
      const contextQuality = await measureContextQuality(planned, scenario, environment.workspace);

      const reviewed = await runtime.service.approvePlan(
        planned.id,
        planned.planSha256,
        "eval-operator",
      );
      assertCondition(reviewed.state === "awaiting_review", "Run did not reach review");
      assertCondition(
        reviewed.verification?.outcome === "passed" &&
          reviewed.verification.checks.every((check) => check.outcome === "passed"),
        "Initial sandbox verification did not pass",
      );
      assertCondition(reviewed.worktreePath !== null, "Run has no private worktree");
      const targetPath = path.join(reviewed.worktreePath, scenario.target);
      assertCondition(
        (await readFile(targetPath, "utf8")) === scenario.approved,
        "Private target bytes do not match the approved fixture bytes",
      );
      assertCondition(
        JSON.stringify(reviewed.verification.changedPaths) === JSON.stringify([scenario.target]),
        "Verification changed paths do not match the target",
      );

      const rolledBack = await runtime.service.review(
        planned.id,
        "reject",
        reviewed.verification.diffSha256,
        "eval-operator",
      );
      assertCondition(rolledBack.state === "rolled_back", "Review rejection did not roll back");
      const rollbackBytesMatch = (await readFile(targetPath, "utf8")) === scenario.baseline;
      const rollbackClean =
        fixtureGit(reviewed.worktreePath, environment.controlHome, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]) === "";
      assertCondition(
        rollbackBytesMatch && rollbackClean,
        "Rollback did not restore a clean baseline",
      );

      const restored = await runtime.service.restore(
        planned.id,
        reviewed.verification.checkpointSha256,
        "eval-operator",
      );
      const restoreSucceeded =
        restored.state === "awaiting_review" &&
        restored.verification?.outcome === "passed" &&
        (await readFile(targetPath, "utf8")) === scenario.approved;
      assertCondition(restoreSucceeded, "Checkpoint restoration did not reverify approved bytes");

      const completed = await runtime.service.review(
        planned.id,
        "approve",
        restored.verification.diffSha256,
        "eval-operator",
      );
      assertCondition(completed.state === "completed", "Final review did not complete the run");
      assertProviderContract(providerServer, 2);

      const sourceAfter = await snapshotTree(environment.workspace);
      const fingerprintAfter = await repositoryFingerprint(
        environment.workspace,
        environment.controlHome,
      );
      const sourceEvidence = assertSourceUnchanged(environment, sourceAfter, fingerprintAfter);
      const history = runtime.service.history(planned.id);
      const approvalHistory = history.approvals.map(
        (approval) => approval.kind + ":" + approval.decision,
      );
      assertCondition(
        JSON.stringify(approvalHistory) ===
          JSON.stringify(["plan:approve", "review:reject", "restore:approve", "review:approve"]),
        "Approval history did not contain the full landing sequence",
      );

      const measuredEvidence = [
        evidence("full_run_completed", { state: completed.state }),
        evidence("production_ollama_adapter_http", {
          deterministicContractRequests: providerServer.requests.length,
        }),
        evidence("exact_target_bytes", { sha256: sha256(scenario.approved) }),
        evidence("one_changed_path", { paths: reviewed.verification.changedPaths }),
        evidence("passing_check", { attempts: 2, passed: 2 }),
        evidence("source_unchanged", sourceEvidence),
        evidence("context_quality_measured", contextQuality),
        evidence("usage_measured", completed.usage),
        evidence("approval_history", { decisions: approvalHistory }),
        evidence("rollback_success", { rollbackBytesMatch, rollbackClean }),
        evidence("restore_success", { restoreSucceeded }),
      ];
      assertEvidenceNames(scenario, measuredEvidence);
      const sourceChanged = changedPaths(environment.sourceBefore, sourceAfter);
      const measurements = runMeasurements({
        run: completed,
        history,
        observedOutcome: "completed",
        checksAttempted: 2,
        checksPassed: 2,
        incorrectEdits: measuredIncorrectEdits(
          completed,
          (await readFile(targetPath, "utf8")) === scenario.approved,
          sourceChanged,
        ),
        contextQuality,
        wallMs: Math.round(performance.now() - startedAt),
        runtimeAccounting: "persisted_metered_operations",
        tokenAccounting: "provider_reported",
        rollback: {
          status: "measured",
          attempted: true,
          value: rollbackBytesMatch && rollbackClean,
          baselineBytesMatched: rollbackBytesMatch,
          cleanWorktree: rollbackClean,
          restoreSucceeded,
        },
      });
      validateMeasurements(measurements, scenario.id);
      return {
        id: scenario.id,
        class: scenario.class,
        expectedOutcome: scenario.expectedOutcome,
        observedOutcome: "completed",
        assessment: "passed",
        fixture: {
          repositorySha256: contract.repositorySha256,
          taskSha256: contract.taskSha256,
        },
        evidence: measuredEvidence,
        measurements,
      };
    } finally {
      runtime?.close();
      await providerServer.close();
    }
  });
}

async function evaluateServiceRejection(scenario, contract) {
  return withFixtureEnvironment(scenario, contract, async (environment) => {
    const startedAt = performance.now();
    const providerServer = await startOllamaQueue([]);
    let runtime;
    try {
      const configured = await configureRuntime(environment, providerServer.baseUrl);
      runtime = configured.runtime;
      let rejectionCode = null;
      try {
        await runtime.service.planRun({
          projectName: "golden",
          task: contract.task,
          target: scenario.target,
          provider: configured.provider,
        });
      } catch (error) {
        if (error instanceof IcarusError) {
          rejectionCode = error.code;
        } else {
          throw error;
        }
      }
      assertCondition(
        rejectionCode === scenario.expectedErrorCode,
        "Service rejection code did not match the fixture expectation",
      );
      assertCondition(
        runtime.service.listRuns().length === 0,
        "Rejected task created a run record",
      );
      assertCondition(providerServer.requests.length === 0, "Rejected task called the provider");
      const runDirectories = await readdir(path.join(configured.stateRoot, "runs"));
      assertCondition(runDirectories.length === 0, "Rejected task created a private workspace");
      const sourceAfter = await snapshotTree(environment.workspace);
      const fingerprintAfter = await repositoryFingerprint(
        environment.workspace,
        environment.controlHome,
      );
      const sourceEvidence = assertSourceUnchanged(environment, sourceAfter, fingerprintAfter);
      const measuredEvidence = [
        evidence("service_error_code", { code: rejectionCode }),
        evidence("zero_run_records", { count: 0 }),
        evidence("zero_provider_calls", { count: providerServer.requests.length }),
        evidence("zero_workspace_writes", { runDirectories }),
        evidence("source_unchanged", sourceEvidence),
      ];
      assertEvidenceNames(scenario, measuredEvidence);
      const measurements = rejectionMeasurements(Math.round(performance.now() - startedAt));
      validateMeasurements(measurements, scenario.id);
      return {
        id: scenario.id,
        class: scenario.class,
        expectedOutcome: scenario.expectedOutcome,
        observedOutcome: "rejected",
        assessment: "passed",
        fixture: {
          repositorySha256: contract.repositorySha256,
          taskSha256: contract.taskSha256,
        },
        evidence: measuredEvidence,
        measurements,
      };
    } finally {
      runtime?.close();
      await providerServer.close();
    }
  });
}

async function evaluateProviderRecovery(scenario, contract) {
  return withFixtureEnvironment(scenario, contract, async (environment) => {
    const startedAt = performance.now();
    const providerServer = await startOllamaQueue([
      planResponse(scenario),
      { status: 503, rawBody: '{"error":"temporary evaluation failure"}' },
    ]);
    let runtime;
    try {
      const configured = await configureRuntime(environment, providerServer.baseUrl);
      runtime = configured.runtime;
      const planned = await runtime.service.planRun({
        projectName: "golden",
        task: contract.task,
        target: scenario.target,
        provider: configured.provider,
      });
      assertCondition(planned.planSha256 !== null, "Recovery run did not persist a plan");
      const contextQuality = await measureContextQuality(planned, scenario, environment.workspace);
      let providerErrorCode = null;
      try {
        await runtime.service.approvePlan(planned.id, planned.planSha256, "eval-operator");
      } catch (error) {
        if (error instanceof IcarusError) {
          providerErrorCode = error.code;
        } else {
          throw error;
        }
      }
      assertCondition(
        providerErrorCode === "PROVIDER_HTTP_ERROR",
        "Recovery scenario did not observe the provider HTTP failure",
      );
      const failed = runtime.service.getRun(planned.id);
      assertCondition(
        failed.state === "failed" && failed.resumeState === "running",
        "Provider failure did not persist a resumable running state",
      );
      providerServer.enqueue(editResponse(scenario));
      const resumed = await runtime.service.resume(planned.id);
      assertCondition(
        resumed.state === "awaiting_review" && resumed.verification?.outcome === "passed",
        "Explicit resume did not reach passing review evidence",
      );
      assertCondition(resumed.worktreePath !== null, "Recovered run lost its worktree");
      const targetPath = path.join(resumed.worktreePath, scenario.target);
      assertCondition(
        (await readFile(targetPath, "utf8")) === scenario.approved,
        "Recovered target bytes do not match the approved fixture",
      );
      const completed = await runtime.service.review(
        planned.id,
        "approve",
        resumed.verification.diffSha256,
        "eval-operator",
      );
      assertCondition(completed.state === "completed", "Recovered run did not complete");
      assertProviderContract(providerServer, 3);
      const sourceAfter = await snapshotTree(environment.workspace);
      const fingerprintAfter = await repositoryFingerprint(
        environment.workspace,
        environment.controlHome,
      );
      const sourceEvidence = assertSourceUnchanged(environment, sourceAfter, fingerprintAfter);
      const history = runtime.service.history(planned.id);
      const eventTypes = history.events.map((event) => event.type);
      assertCondition(
        eventTypes.includes("run.failed") && eventTypes.includes("run.resumed"),
        "Recovery history lacks failed/resumed events",
      );
      const toolFailures = measureToolFailures(history, completed.verification?.checks ?? []);
      assertCondition(
        toolFailures.failedOperations === 1,
        "Recovery history did not measure exactly one failed operation",
      );
      const measuredEvidence = [
        evidence("production_ollama_adapter_http", {
          deterministicContractRequests: providerServer.requests.length,
        }),
        evidence("provider_http_failure", { code: providerErrorCode }),
        evidence("failed_state", { state: failed.state }),
        evidence("resume_state", { state: failed.resumeState }),
        evidence("run_resumed_event", { observed: eventTypes.includes("run.resumed") }),
        evidence("passing_verification", {
          outcome: completed.verification?.outcome,
        }),
        evidence("source_unchanged", sourceEvidence),
        evidence("metrics_recorded", {
          usage: completed.usage,
          failedOperations: toolFailures.failedOperations,
        }),
      ];
      assertEvidenceNames(scenario, measuredEvidence);
      const measurements = runMeasurements({
        run: completed,
        history,
        observedOutcome: "recovered",
        checksAttempted: 1,
        checksPassed: 1,
        incorrectEdits: measuredIncorrectEdits(
          completed,
          (await readFile(targetPath, "utf8")) === scenario.approved,
          changedPaths(environment.sourceBefore, sourceAfter),
        ),
        contextQuality,
        wallMs: Math.round(performance.now() - startedAt),
        runtimeAccounting: "persisted_metered_operations",
        tokenAccounting: "provider_reported_and_conservative_failure_reservation",
        rollback: notApplicable("Recovery completed without a rollback attempt"),
      });
      validateMeasurements(measurements, scenario.id);
      return {
        id: scenario.id,
        class: scenario.class,
        expectedOutcome: scenario.expectedOutcome,
        observedOutcome: "recovered",
        assessment: "passed",
        fixture: {
          repositorySha256: contract.repositorySha256,
          taskSha256: contract.taskSha256,
        },
        evidence: measuredEvidence,
        measurements,
      };
    } finally {
      runtime?.close();
      await providerServer.close();
    }
  });
}

async function evaluateInterruptedResume(scenario, contract) {
  return withFixtureEnvironment(scenario, contract, async (environment) => {
    const startedAt = performance.now();
    const providerServer = await startOllamaQueue([planResponse(scenario)]);
    let runtime;
    let store;
    try {
      const configured = await configureRuntime(environment, providerServer.baseUrl);
      runtime = configured.runtime;
      const planned = await runtime.service.planRun({
        projectName: "golden",
        task: contract.task,
        target: scenario.target,
        provider: configured.provider,
      });
      assertCondition(planned.planSha256 !== null, "Interrupted run did not persist a plan");
      const contextQuality = await measureContextQuality(planned, scenario, environment.workspace);
      runtime.close();
      runtime = undefined;

      const killedProcess = await killApprovalAtProviderRequest(
        environment,
        configured.stateRoot,
        planned.id,
        planned.planSha256,
        providerServer,
      );
      assertCondition(
        Number.isSafeInteger(killedProcess.pid),
        "Killed approval process did not expose a process identifier",
      );

      store = new IcarusStore(path.join(configured.stateRoot, "icarus.sqlite3"));
      const crashedRun = store.getRun(planned.id);
      const crashedEvents = store.listEvents(planned.id);
      const startedEvents = crashedEvents.filter(
        (event) =>
          event.type === "operation.started" && eventPayload(event).kind === "provider.edit",
      );
      assertCondition(
        startedEvents.length === 1,
        "Process death did not leave exactly one started provider.edit operation",
      );
      const startedPayload = eventPayload(startedEvents[0]);
      assertCondition(
        typeof startedPayload.operationId === "string" &&
          typeof startedPayload.reservedCostUsd === "number" &&
          Number.isFinite(startedPayload.reservedCostUsd) &&
          typeof startedPayload.reservedTokens === "number" &&
          Number.isSafeInteger(startedPayload.reservedTokens) &&
          startedPayload.reservedTokens > 0 &&
          typeof startedPayload.reservedRuntimeMs === "number" &&
          Number.isSafeInteger(startedPayload.reservedRuntimeMs) &&
          startedPayload.reservedRuntimeMs > 0,
        "Started provider.edit event did not persist a complete reservation",
      );
      const matchingFinishedAtCrash = crashedEvents.filter(
        (event) =>
          event.type === "operation.finished" &&
          eventPayload(event).operationId === startedPayload.operationId,
      );
      assertCondition(
        matchingFinishedAtCrash.length === 0,
        "Killed provider.edit operation was already finished at the observed crash boundary",
      );
      const interruptedReservation = {
        costUsd: startedPayload.reservedCostUsd,
        tokens: startedPayload.reservedTokens,
        runtimeMs: startedPayload.reservedRuntimeMs,
      };
      const usageAtCrash = crashedRun.usage;
      assertCondition(
        crashedRun.state === "running" &&
          crashedRun.worktreePath !== null &&
          usageAtCrash.reservedCostUsd === interruptedReservation.costUsd,
        "Killed process did not preserve durable running state and reservation",
      );
      store.close();
      store = undefined;

      providerServer.enqueue(editResponse(scenario));
      runtime = await createIcarusRuntime(configured.stateRoot);
      const resumed = await runtime.service.resume(planned.id);
      assertCondition(
        resumed.state === "awaiting_review" && resumed.verification?.outcome === "passed",
        "Interrupted run did not resume to passing review evidence",
      );
      assertCondition(resumed.worktreePath !== null, "Resumed run lost its private worktree");
      const targetPath = path.join(resumed.worktreePath, scenario.target);
      assertCondition(
        (await readFile(targetPath, "utf8")) === scenario.approved,
        "Resumed target bytes do not match the approved fixture",
      );
      const completed = await runtime.service.review(
        planned.id,
        "approve",
        resumed.verification.diffSha256,
        "eval-operator",
      );
      assertCondition(completed.state === "completed", "Interrupted run did not complete");
      assertProviderContract(providerServer, 3);
      const history = runtime.service.history(planned.id);
      const interruptedEvents = history.events.filter(
        (event) => event.type === "operation.interrupted",
      );
      assertCondition(
        interruptedEvents.length === 1,
        "Interrupted reservation was not reconciled exactly once",
      );
      const interruptedPayload = eventPayload(interruptedEvents[0]);
      const conservativeChargeRecorded =
        interruptedPayload.operationId === startedPayload.operationId &&
        interruptedPayload.reservedCostUsd === interruptedReservation.costUsd &&
        interruptedPayload.reservedTokens === interruptedReservation.tokens &&
        interruptedPayload.reservedRuntimeMs === interruptedReservation.runtimeMs &&
        completed.usage.estimatedCostUsd >=
          usageAtCrash.estimatedCostUsd + interruptedReservation.costUsd &&
        completed.usage.inputTokens + completed.usage.outputTokens >=
          usageAtCrash.inputTokens + usageAtCrash.outputTokens + interruptedReservation.tokens &&
        completed.usage.activeRuntimeMs >=
          usageAtCrash.activeRuntimeMs + interruptedReservation.runtimeMs &&
        completed.usage.reservedCostUsd === 0;
      assertCondition(
        conservativeChargeRecorded,
        "Interrupted operation was not charged its complete reservation",
      );
      const sourceAfter = await snapshotTree(environment.workspace);
      const fingerprintAfter = await repositoryFingerprint(
        environment.workspace,
        environment.controlHome,
      );
      const sourceEvidence = assertSourceUnchanged(environment, sourceAfter, fingerprintAfter);
      const durableResumeEvent = history.events.some(
        (event) => event.type === "resume.requested" || event.type === "run.resumed",
      );
      const measuredEvidence = [
        evidence("process_killed_with_started_operation", {
          process: {
            pid: killedProcess.pid,
            signal: killedProcess.signal,
          },
          runStateAtCrash: crashedRun.state,
          kind: startedPayload.kind,
          operationId: startedPayload.operationId,
          reservation: interruptedReservation,
        }),
        evidence("interrupted_event", {
          count: interruptedEvents.length,
          durableResumeEvent,
        }),
        evidence("conservative_charge", {
          recorded: conservativeChargeRecorded,
          reservation: interruptedReservation,
          chargedDimensions: ["tokenUsage", "activeRuntime"],
          apiCostContributionUsd: 0,
        }),
        evidence("explicit_resume_invocation", {
          method: "IcarusService.resume",
          durableResumeEvent,
        }),
        evidence("passing_verification", {
          outcome: completed.verification?.outcome,
        }),
        evidence("source_unchanged", sourceEvidence),
      ];
      assertEvidenceNames(scenario, measuredEvidence);
      const measurements = runMeasurements({
        run: completed,
        history,
        observedOutcome: "resumed",
        checksAttempted: 1,
        checksPassed: 1,
        incorrectEdits: measuredIncorrectEdits(
          completed,
          (await readFile(targetPath, "utf8")) === scenario.approved,
          changedPaths(environment.sourceBefore, sourceAfter),
        ),
        contextQuality,
        wallMs: Math.round(performance.now() - startedAt),
        runtimeAccounting: "persisted_operations_with_conservative_interruption_charge",
        tokenAccounting: "provider_reported_and_conservative_interruption_reservation",
        rollback: notApplicable("Interrupted execution resumed without a rollback attempt"),
      });
      validateMeasurements(measurements, scenario.id);
      return {
        id: scenario.id,
        class: scenario.class,
        expectedOutcome: scenario.expectedOutcome,
        observedOutcome: "resumed",
        assessment: "passed",
        fixture: {
          repositorySha256: contract.repositorySha256,
          taskSha256: contract.taskSha256,
        },
        evidence: measuredEvidence,
        measurements,
      };
    } finally {
      store?.close();
      runtime?.close();
      await providerServer.close();
    }
  });
}

function evaluateUnsupportedContract(scenario, contract) {
  assertCondition(
    contract.representativeContract !== null,
    "Unsupported evaluation lacks representative contract evidence: " + scenario.id,
  );
  const measuredEvidence = [
    evidence("fixture_contract_valid", {
      repositorySha256: contract.repositorySha256,
      taskSha256: contract.taskSha256,
      representativeContract: contract.representativeContract,
    }),
    evidence("capability_outside_m1", {
      requiredCapability: scenario.requiredCapability,
      currentMilestone: manifest.currentMilestone,
      plannedMilestone: scenario.plannedMilestone,
      reason: scenario.unsupportedReason,
    }),
  ];
  assertEvidenceNames(scenario, measuredEvidence);
  const measurements = unsupportedMeasurements(scenario.unsupportedReason);
  validateMeasurements(measurements, scenario.id);
  return {
    id: scenario.id,
    class: scenario.class,
    expectedOutcome: scenario.expectedOutcome,
    observedOutcome: "unsupported",
    assessment: "unsupported",
    fixture: {
      repositorySha256: contract.repositorySha256,
      taskSha256: contract.taskSha256,
    },
    requiredCapability: scenario.requiredCapability,
    plannedMilestone: scenario.plannedMilestone,
    reason: scenario.unsupportedReason,
    futureEvidence: scenario.futureEvidence,
    evidence: measuredEvidence,
    measurements,
  };
}

function average(values) {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function aggregateMeasurements(results) {
  const taskResults = results
    .map((result) => result.measurements.taskSuccess)
    .filter((metric) => metric.status === "measured");
  const testResults = results
    .map((result) => result.measurements.testSuccess)
    .filter((metric) => metric.status === "measured");
  const incorrectResults = results
    .map((result) => result.measurements.incorrectEdits)
    .filter((metric) => metric.status === "measured");
  const contextResults = results
    .map((result) => result.measurements.contextRetrievalQuality)
    .filter((metric) => metric.status === "measured");
  const toolResults = results
    .map((result) => result.measurements.toolFailures)
    .filter((metric) => metric.status === "measured");
  const runtimeResults = results
    .map((result) => result.measurements.runtime)
    .filter((metric) => metric.status === "measured");
  const tokenResults = results
    .map((result) => result.measurements.tokenUsage)
    .filter((metric) => metric.status === "measured");
  const costResults = results
    .map((result) => result.measurements.apiCost)
    .filter((metric) => metric.status === "estimated");
  const approvalResults = results
    .map((result) => result.measurements.humanApprovalFrequency)
    .filter((metric) => metric.status === "measured");
  const rollbackResults = results
    .map((result) => result.measurements.rollbackSuccess)
    .filter((metric) => metric.status === "measured");

  const decisions = approvalResults.reduce((total, metric) => total + metric.decisions, 0);
  const runCount = approvalResults.reduce((total, metric) => total + metric.runCount, 0);
  return {
    taskSuccess: {
      measured: taskResults.length,
      successful: taskResults.filter((metric) => metric.value).length,
      rate:
        taskResults.length === 0
          ? null
          : taskResults.filter((metric) => metric.value).length / taskResults.length,
    },
    testSuccess: {
      measuredScenarios: testResults.length,
      attempted: testResults.reduce((total, metric) => total + metric.attempted, 0),
      passed: testResults.reduce((total, metric) => total + metric.passed, 0),
    },
    incorrectEdits: {
      measured: incorrectResults.length,
      total: incorrectResults.reduce((total, metric) => total + metric.count, 0),
    },
    contextRetrievalQuality: {
      measured: contextResults.length,
      macroRecall: average(contextResults.map((metric) => metric.recall)),
      macroPrecision: average(contextResults.map((metric) => metric.precision)),
      provenancePassRate:
        contextResults.length === 0
          ? null
          : contextResults.filter((metric) => metric.provenanceValid).length /
            contextResults.length,
    },
    toolFailures: {
      measured: toolResults.length,
      failedOperations: toolResults.reduce((total, metric) => total + metric.failedOperations, 0),
      interruptedOperations: toolResults.reduce(
        (total, metric) => total + metric.interruptedOperations,
        0,
      ),
      cancelledOperations: toolResults.reduce(
        (total, metric) => total + metric.cancelledOperations,
        0,
      ),
      failedChecks: toolResults.reduce((total, metric) => total + metric.failedChecks, 0),
      unavailableChecks: toolResults.reduce((total, metric) => total + metric.unavailableChecks, 0),
    },
    runtime: {
      measured: runtimeResults.length,
      totalActiveRuntimeMs: runtimeResults.reduce(
        (total, metric) => total + metric.activeRuntimeMs,
        0,
      ),
      totalEvaluatorWallMs: runtimeResults.reduce(
        (total, metric) => total + metric.evaluatorWallMs,
        0,
      ),
    },
    tokenUsage: {
      measured: tokenResults.length,
      input: tokenResults.reduce((total, metric) => total + metric.input, 0),
      output: tokenResults.reduce((total, metric) => total + metric.output, 0),
    },
    apiCost: {
      estimatedScenarios: costResults.length,
      estimatedUsd: costResults.reduce((total, metric) => total + metric.estimatedUsd, 0),
      actualBilledUsd: null,
      status: "estimated_only",
    },
    humanApprovalFrequency: {
      measured: approvalResults.length,
      decisions,
      runCount,
      decisionsPerRun: runCount === 0 ? null : decisions / runCount,
    },
    rollbackSuccess: {
      attempted: rollbackResults.length,
      succeeded: rollbackResults.filter((metric) => metric.value).length,
      rate:
        rollbackResults.length === 0
          ? null
          : rollbackResults.filter((metric) => metric.value).length / rollbackResults.length,
    },
  };
}

function validateManifest() {
  assertCondition(
    manifest.schemaVersion === 2 &&
      manifest.currentMilestone === 1 &&
      Array.isArray(manifest.cases),
    "Evaluation manifest has an unsupported schema",
  );
  assertCondition(
    JSON.stringify(manifest.requiredMeasures) === JSON.stringify(requiredMeasures),
    "Evaluation manifest must declare every required measurement in canonical order",
  );
  const seenIds = new Set();
  const seenClasses = new Set();
  for (const scenario of manifest.cases) {
    assertCondition(
      typeof scenario.id === "string" && !seenIds.has(scenario.id),
      "Evaluation IDs must be unique strings",
    );
    seenIds.add(scenario.id);
    seenClasses.add(scenario.class);
    assertCondition(
      requiredClasses.has(scenario.class) &&
        typeof scenario.repository === "string" &&
        typeof scenario.task === "string" &&
        typeof scenario.target === "string" &&
        typeof scenario.requiredCapability === "string" &&
        (scenario.plannedMilestone === null || Number.isInteger(scenario.plannedMilestone)) &&
        Array.isArray(scenario.requiredEvidence) &&
        scenario.requiredEvidence.length > 0 &&
        new Set(scenario.requiredEvidence).size === scenario.requiredEvidence.length &&
        allowedEvaluators.has(scenario.evaluator),
      "Evaluation metadata is incomplete: " + scenario.id,
    );
    if (scenario.supportStatus === "unsupported") {
      assertCondition(
        scenario.evaluator === "unsupported_contract" &&
          scenario.expectedOutcome === "unsupported" &&
          Number.isInteger(scenario.plannedMilestone) &&
          Array.isArray(scenario.representativePaths) &&
          scenario.representativePaths.length >= 2 &&
          typeof scenario.unsupportedReason === "string" &&
          !m1Capabilities.has(scenario.requiredCapability),
        "Unsupported evaluation lacks an honest M1 capability reason: " + scenario.id,
      );
    } else {
      assertCondition(
        scenario.supportStatus === "supported" &&
          scenario.evaluator !== "unsupported_contract" &&
          m1Capabilities.has(scenario.requiredCapability),
        "Supported evaluation is not bound to an M1 capability: " + scenario.id,
      );
    }
  }
  for (const scenarioId of representativeFixtureContracts.keys()) {
    assertCondition(
      seenIds.has(scenarioId),
      "Static representative fixture contract is orphaned: " + scenarioId,
    );
  }
  assertCondition(
    seenClasses.size === requiredClasses.size &&
      [...requiredClasses].every((name) => seenClasses.has(name)),
    "Evaluation manifest does not cover all required scenario classes",
  );
}

validateManifest();
const results = [];
for (const scenario of manifest.cases) {
  let contract;
  try {
    contract = await validateFixtureContract(scenario);
    let result;
    if (scenario.evaluator === "production_lifecycle") {
      result = await evaluateProductionLifecycle(scenario, contract);
    } else if (scenario.evaluator === "service_rejection") {
      result = await evaluateServiceRejection(scenario, contract);
    } else if (scenario.evaluator === "provider_recovery") {
      result = await evaluateProviderRecovery(scenario, contract);
    } else if (scenario.evaluator === "interrupted_resume") {
      result = await evaluateInterruptedResume(scenario, contract);
    } else {
      result = evaluateUnsupportedContract(scenario, contract);
    }
    results.push(result);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const measurements = notMeasuredMeasurements(reason);
    validateMeasurements(measurements, scenario.id);
    results.push({
      id: scenario.id,
      class: scenario.class,
      expectedOutcome: scenario.expectedOutcome,
      observedOutcome: "error",
      assessment: "failed",
      ...(contract === undefined
        ? {}
        : {
            fixture: {
              repositorySha256: contract.repositorySha256,
              taskSha256: contract.taskSha256,
            },
          }),
      reason,
      evidence: [],
      measurements,
    });
  }
}

const report = {
  schemaVersion: 2,
  fixtureManifestSha256: sha256(manifestBytes),
  generatedAt: new Date().toISOString(),
  currentMilestone: manifest.currentMilestone,
  requiredMeasures,
  counts: {
    passed: results.filter(({ assessment }) => assessment === "passed").length,
    failed: results.filter(({ assessment }) => assessment === "failed").length,
    unsupported: results.filter(({ assessment }) => assessment === "unsupported").length,
  },
  aggregateMeasurements: aggregateMeasurements(results),
  limitations: [
    "Actual billed API cost is unavailable in deterministic offline evaluation; only configured-rate estimates are reported.",
    "Context quality is the deterministic Milestone 1 expected-path baseline, not semantic retrieval quality.",
  ],
  results,
};
await mkdir(path.join(root, ".local"), { recursive: true, mode: 0o700 });
await writeFile(
  path.join(root, ".local", "eval-report.json"),
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (report.counts.failed > 0) {
  process.exitCode = 1;
}
