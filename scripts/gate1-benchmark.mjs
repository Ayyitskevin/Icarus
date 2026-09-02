import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { parseStrictJson } from "../packages/core/dist/canonical-json.js";
import { GitController } from "../packages/core/dist/git.js";
import { LandingGitController } from "../packages/core/dist/landing-git.js";
import { createProviderConfig } from "../packages/core/dist/provider.js";
import { OllamaGateway } from "../packages/core/dist/providers.js";
import { createIcarusRuntime } from "../packages/core/dist/runtime.js";
import { DockerSandboxRunner } from "../packages/core/dist/sandbox.js";
import { validateGate1BenchmarkManifest } from "./gate1-benchmark-contract.mjs";
import {
  GATE1_FAILURE_REPORT_LIMITATION,
  GATE1_OFFLINE_REPORT_LIMITATIONS,
  validateGate1BenchmarkReport,
} from "./gate1-benchmark-result-contract.mjs";

const root = path.resolve(".");
const fixtureRoot = path.join(root, "fixtures", "evals", "gate1");
const manifestPath = path.join(fixtureRoot, "manifest.v1.json");
const reportDirectory = path.join(root, ".local");
const reportFilename = "gate1-benchmark-report.json";
process.umask(0o077);
const baselineRunIds = new Map([
  ["typescript-library", "10000000-0000-4000-8000-000000000001"],
  ["python-cli", "20000000-0000-4000-8000-000000000002"],
  ["react-node", "30000000-0000-4000-8000-000000000003"],
]);

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function within(base, relative, label) {
  const resolved = path.resolve(base, relative);
  assertCondition(
    resolved !== base && resolved.startsWith(`${base}${path.sep}`),
    `${label} escapes its allowed root: ${relative}`,
  );
  return resolved;
}

async function readRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  assertCondition(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1,
    `${label} must be one non-linked regular file`,
  );
  return readFile(filePath);
}

async function assertPathAbsent(filePath, label) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(`${label} must be absent`);
}

function hasErrorCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function assertOwnedPrivateDirectory(metadata, label) {
  const currentUid = process.getuid?.();
  assertCondition(
    metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      currentUid !== undefined &&
      metadata.uid === currentUid &&
      (metadata.mode & 0o077) === 0,
    `${label} must be a current-user-owned private directory`,
  );
}

async function assertReportDirectoryIdentity(output) {
  const [pathMetadata, handleMetadata, canonical] = await Promise.all([
    lstat(reportDirectory),
    output.directoryHandle.stat(),
    realpath(reportDirectory),
  ]);
  assertOwnedPrivateDirectory(pathMetadata, "Gate 1 report directory");
  assertCondition(
    canonical === reportDirectory &&
      pathMetadata.dev === handleMetadata.dev &&
      pathMetadata.ino === handleMetadata.ino,
    "Gate 1 report directory identity changed",
  );
}

async function prepareReportOutput() {
  assertCondition(process.platform === "linux", "Gate 1 benchmark requires Linux");
  assertCondition((await realpath(root)) === root, "Gate 1 repository root must be canonical");
  try {
    await mkdir(reportDirectory, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
  const metadata = await lstat(reportDirectory);
  assertOwnedPrivateDirectory(metadata, "Gate 1 report directory");
  assertCondition(
    (await realpath(reportDirectory)) === reportDirectory,
    "Gate 1 report directory must not traverse a symbolic link",
  );
  const directoryHandle = await open(
    reportDirectory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  const output = {
    directoryHandle,
    heldDirectory: `/proc/self/fd/${directoryHandle.fd}`,
    heldReportPath: `/proc/self/fd/${directoryHandle.fd}/${reportFilename}`,
  };
  await assertReportDirectoryIdentity(output);
  const existing = await lstat(output.heldReportPath).catch((error) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (existing !== null) {
    const currentUid = process.getuid?.();
    assertCondition(
      existing.isFile() &&
        !existing.isSymbolicLink() &&
        existing.nlink === 1 &&
        currentUid !== undefined &&
        existing.uid === currentUid &&
        (existing.mode & 0o077) === 0,
      "Existing Gate 1 report is unsafe",
    );
    await rm(output.heldReportPath);
  }
  return output;
}

async function writeReportAtomically(output, report, manifest, manifestDigest) {
  await assertReportDirectoryIdentity(output);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  validateGate1BenchmarkReport(parseStrictJson(serialized), manifest, manifestDigest);
  const temporaryName = `.gate1-benchmark-report-${process.pid}-${randomUUID()}.tmp`;
  const temporaryPath = path.join(output.heldDirectory, temporaryName);
  let temporaryHandle;
  try {
    temporaryHandle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await temporaryHandle.writeFile(serialized, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await assertReportDirectoryIdentity(output);
    await rename(temporaryPath, output.heldReportPath);
    await output.directoryHandle.sync();
    const finalMetadata = await lstat(output.heldReportPath);
    const finalHandle = await open(
      output.heldReportPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const openedMetadata = await finalHandle.stat();
      const currentUid = process.getuid?.();
      assertCondition(
        finalMetadata.isFile() &&
          !finalMetadata.isSymbolicLink() &&
          finalMetadata.nlink === 1 &&
          currentUid !== undefined &&
          finalMetadata.uid === currentUid &&
          (finalMetadata.mode & 0o177) === 0 &&
          openedMetadata.dev === finalMetadata.dev &&
          openedMetadata.ino === finalMetadata.ino,
        "Generated Gate 1 report is unsafe",
      );
      const persisted = await finalHandle.readFile();
      assertCondition(
        persisted.equals(Buffer.from(serialized, "utf8")),
        "Gate 1 report write drift",
      );
      validateGate1BenchmarkReport(
        parseStrictJson(persisted.toString("utf8")),
        manifest,
        manifestDigest,
      );
    } finally {
      await finalHandle.close();
    }
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function snapshotTree(directory) {
  const rootMetadata = await lstat(directory);
  assertCondition(
    rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(),
    `Tree root must be a non-linked directory: ${directory}`,
  );
  const files = [];
  async function visit(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
    );
    for (const entry of entries) {
      if (prefix === "" && entry.name === ".git") continue;
      const entryPath = path.join(current, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(entryPath, relative);
        continue;
      }
      assertCondition(
        entry.isFile() && !entry.isSymbolicLink(),
        `Special fixture path: ${relative}`,
      );
      const metadata = await lstat(entryPath);
      assertCondition(metadata.nlink === 1, `Linked fixture path: ${relative}`);
      files.push({ path: relative, sha256: sha256(await readFile(entryPath)) });
    }
  }
  await visit(directory, "");
  return files;
}

async function snapshotGitDirectory(repository) {
  const gitDirectory = path.join(repository, ".git");
  const rootMetadata = await lstat(gitDirectory);
  assertCondition(
    rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(),
    "Fixture Git directory must be a non-linked directory",
  );
  const records = [{ path: ".", type: "directory", mode: rootMetadata.mode & 0o7777 }];
  async function visit(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")),
    );
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const metadata = await lstat(entryPath);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        records.push({ path: relative, type: "directory", mode: metadata.mode & 0o7777 });
        await visit(entryPath, relative);
        continue;
      }
      assertCondition(
        metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1,
        `Unsafe fixture Git metadata path: ${relative}`,
      );
      records.push({
        path: relative,
        type: "file",
        mode: metadata.mode & 0o7777,
        size: metadata.size,
        sha256: sha256(await readFile(entryPath)),
      });
    }
  }
  await visit(gitDirectory, "");
  return records;
}

function treeSha256(files) {
  return sha256(
    JSON.stringify(files.map(({ path: filePath, sha256: digest }) => [filePath, digest])),
  );
}

function gitEnvironment(controlHome) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: controlHome,
    XDG_CONFIG_HOME: controlHome,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_SSH_COMMAND: "false",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Icarus Gate 1 Fixture",
    GIT_AUTHOR_EMAIL: "icarus-gate1-fixture@example.invalid",
    GIT_COMMITTER_NAME: "Icarus Gate 1 Fixture",
    GIT_COMMITTER_EMAIL: "icarus-gate1-fixture@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
}

function fixtureGitBytes(cwd, controlHome, args) {
  const result = spawnSync(
    "/usr/bin/git",
    [
      "--no-pager",
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.file.allow=always",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ],
    {
      cwd,
      encoding: null,
      env: gitEnvironment(controlHome),
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      timeout: 60_000,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `fixture git ${args[0] ?? "command"} failed: ${Buffer.from(result.stderr).toString("utf8")}`,
    );
  }
  return Buffer.from(result.stdout);
}

function fixtureGit(cwd, controlHome, args) {
  return fixtureGitBytes(cwd, controlHome, args).toString("utf8").trim();
}

async function initializeFixtureRepository(source, controlHome) {
  fixtureGit(source, controlHome, ["init", "--object-format=sha1", "--initial-branch=main"]);
  fixtureGit(source, controlHome, ["add", "--all"]);
  fixtureGit(source, controlHome, ["commit", "--no-gpg-sign", "-m", "fixture baseline"]);
  return {
    baseCommitSha1: fixtureGit(source, controlHome, ["rev-parse", "HEAD"]),
    baseTreeSha1: fixtureGit(source, controlHome, ["rev-parse", "HEAD^{tree}"]),
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
    worktrees: worktrees
      .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
      .join("\n"),
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function validateCaseAssets(benchmarkCase) {
  const source = within(root, benchmarkCase.repository.fixturePath, "Repository fixture");
  await assertPathAbsent(path.join(source, ".git"), `${benchmarkCase.id} fixture .git path`);
  const taskPath = within(root, benchmarkCase.task.path, "Task fixture");
  const taskBytes = await readRegularFile(taskPath, `${benchmarkCase.id} task`);
  assertCondition(
    sha256(taskBytes) === benchmarkCase.task.sha256,
    `${benchmarkCase.id} task drift`,
  );
  const files = await snapshotTree(source);
  assertCondition(
    files.every((entry) => path.posix.basename(entry.path) !== ".gitattributes"),
    `${benchmarkCase.id} fixture must not contain .gitattributes`,
  );
  assertCondition(
    sameValue(files, benchmarkCase.repository.files),
    `${benchmarkCase.id} source inventory drift`,
  );
  assertCondition(
    treeSha256(files) === benchmarkCase.repository.treeSha256,
    `${benchmarkCase.id} source tree digest drift`,
  );

  const changes = [];
  for (const expected of benchmarkCase.expectedChanges) {
    const baselinePath = within(source, expected.path, `${benchmarkCase.id} baseline`);
    const approvedPath = within(
      root,
      expected.expectedFixturePath,
      `${benchmarkCase.id} expected repair`,
    );
    const baseline = await readRegularFile(baselinePath, `${benchmarkCase.id} baseline`);
    const approved = await readRegularFile(approvedPath, `${benchmarkCase.id} approved repair`);
    assertCondition(
      sha256(baseline) === expected.baselineSha256,
      `${benchmarkCase.id} baseline digest drift: ${expected.path}`,
    );
    assertCondition(
      sha256(approved) === expected.approvedSha256,
      `${benchmarkCase.id} approved digest drift: ${expected.path}`,
    );
    assertCondition(!baseline.equals(approved), `${benchmarkCase.id} repair is a no-op`);
    changes.push({ ...expected, baseline, approved });
  }
  return { source, task: taskBytes.toString("utf8"), files, changes };
}

function providerResponses(benchmarkCase, assets) {
  return [
    {
      summary: "Apply the bounded Gate 1 fixture repair.",
      steps: ["Apply only the selected repair", "Run every registered check"],
      risks: ["The exact preimage may have changed"],
      target: benchmarkCase.selectedPaths[0],
      targets: benchmarkCase.selectedPaths,
      iterationCeiling: 0,
      checkIds: benchmarkCase.checks.map((check) => check.id),
      grants: [],
    },
    {
      summary: "Apply only the pinned Gate 1 fixture repair.",
      edits: assets.changes.map((change) => ({
        op: "modify",
        path: change.path,
        expectedPreimageSha256: change.baselineSha256,
        replacements: [
          {
            findText: change.baseline.toString("utf8"),
            replaceText: change.approved.toString("utf8"),
          },
        ],
        content: null,
        rationale: "Apply only the pinned Gate 1 fixture repair.",
      })),
    },
  ];
}

async function startDeterministicOllama(responses) {
  const queue = [...responses];
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let total = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        assertCondition(total <= 1024 * 1024, "Gate 1 provider request exceeded 1 MiB");
        chunks.push(bytes);
      }
      const body = parseStrictJson(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization ?? null,
        body,
      });
      const next = queue.shift();
      assertCondition(next !== undefined, "Gate 1 provider response queue exhausted");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: body.model,
          message: { content: JSON.stringify(next) },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 24,
          eval_count: 16,
        }),
      );
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "fixture provider error",
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
  assertCondition(address !== null && typeof address !== "string", "Provider did not bind TCP");
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    remaining: () => queue.length,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

function ceilingFrom(benchmarkCase) {
  const {
    maxProviderCalls: _provider,
    maxRemoteMutations: _remote,
    ...ceiling
  } = benchmarkCase.budgets;
  return ceiling;
}

function summarizeChecks(checks) {
  return checks.map((check) => ({
    checkId: check.checkId,
    argv: check.argv,
    exitCode: check.exitCode,
    signal: check.signal,
    stdoutBytes: Buffer.byteLength(check.stdout, "utf8"),
    stdoutSha256: sha256(check.stdout),
    stderrBytes: Buffer.byteLength(check.stderr, "utf8"),
    stderrSha256: sha256(check.stderr),
    truncated: check.truncated,
    outcome: check.outcome,
  }));
}

function aggregateCaseEffects(results) {
  return results.reduce(
    (aggregate, result) => {
      for (const key of Object.keys(aggregate)) aggregate[key] += result.effects[key];
      return aggregate;
    },
    {
      paidProviderCalls: 0,
      credentialReads: 0,
      externalNetworkRequests: 0,
      remoteMutations: 0,
      loopbackHttpRequests: 0,
      gatewayInstances: 0,
      localRefWrites: 0,
    },
  );
}

function validateProviderRequests(benchmarkCase, provider) {
  assertCondition(
    provider.requests.length === benchmarkCase.modelAdapter.expectedRequests &&
      provider.remaining() === 0,
    `${benchmarkCase.id} provider request count differs from the manifest`,
  );
  const instructionDigests = [];
  const requestDigests = [];
  for (const request of provider.requests) {
    const body = request.body;
    assertCondition(
      request.method === "POST" &&
        request.url === "/api/chat" &&
        request.authorization === null &&
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        body.model === benchmarkCase.modelAdapter.model &&
        body.stream === false &&
        body.think === false &&
        typeof body.format === "object" &&
        Array.isArray(body.messages) &&
        body.messages.length === 2 &&
        body.messages[0]?.role === "system" &&
        typeof body.messages[0]?.content === "string" &&
        body.messages[1]?.role === "user" &&
        typeof body.messages[1]?.content === "string",
      `${benchmarkCase.id} did not use the production Ollama structured contract`,
    );
    instructionDigests.push(sha256(body.messages[0].content));
    requestDigests.push(sha256(JSON.stringify(body)));
  }
  assertCondition(
    instructionDigests[0] === benchmarkCase.prompt.planInstructionsSha256 &&
      instructionDigests[1] === benchmarkCase.prompt.editInstructionsSha256,
    `${benchmarkCase.id} production prompt revision drift`,
  );
  return { instructionDigests, requestDigests };
}

async function runBaselineChecks(benchmarkCase, source, baseCommitSha1, temporaryRoot) {
  const stateRoot = path.join(temporaryRoot, "baseline-state");
  const controlHome = path.join(temporaryRoot, "baseline-controller-home");
  const runsRoot = path.join(temporaryRoot, "baseline-runs");
  await Promise.all(
    [stateRoot, controlHome, runsRoot].map(async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }),
  );
  const runId = baselineRunIds.get(benchmarkCase.stack);
  assertCondition(runId !== undefined, `No baseline run ID for ${benchmarkCase.stack}`);
  const runner = new DockerSandboxRunner(stateRoot, new GitController(controlHome, runsRoot));
  const evidence = await runner.runChecks({
    runId,
    worktreePath: source,
    baseCommit: baseCommitSha1,
    targets: benchmarkCase.expectedChangedPaths,
    checks: benchmarkCase.checks,
    sandbox: benchmarkCase.sandbox,
    ceiling: ceilingFrom(benchmarkCase),
  });
  assertCondition(
    evidence.some((check) => check.outcome === "failed") &&
      evidence.every(
        (check) =>
          (check.outcome === "passed" || check.outcome === "failed") && check.truncated === false,
      ),
    `${benchmarkCase.id} baseline did not reproduce a bounded registered-check failure`,
  );
  return evidence;
}

function assertCandidateMatches(benchmarkCase, candidate) {
  for (const field of [
    "objectFormat",
    "baseCommitSha1",
    "baseTreeSha1",
    "candidateTreeSha1",
    "candidateCommitSha1",
    "candidateCommitPayloadSha256",
    "candidateObjectManifestSha256",
  ]) {
    assertCondition(
      candidate[field] === benchmarkCase.candidate[field],
      `${benchmarkCase.id} ${field} mismatch: expected ${benchmarkCase.candidate[field]}, observed ${candidate[field]}`,
    );
  }
  assertCondition(candidate.diffByteEqual === true, `${benchmarkCase.id} candidate diff mismatch`);
}

async function runCase(benchmarkCase) {
  const fixtureBefore = await snapshotTree(fixtureRoot);
  const assets = await validateCaseAssets(benchmarkCase);
  const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "icarus-gate1-")));
  const source = path.join(temporaryRoot, "source");
  const controlHome = path.join(temporaryRoot, "fixture-controller-home");
  await mkdir(controlHome, { mode: 0o700 });
  const fixtureGitPath = path.join(assets.source, ".git");
  await cp(assets.source, source, {
    recursive: true,
    filter: (sourcePath) => sourcePath !== fixtureGitPath,
  });
  await assertPathAbsent(path.join(source, ".git"), `${benchmarkCase.id} copied fixture .git path`);

  let runtime;
  let provider;
  let restoreFetch;
  const effects = {
    paidProviderCalls: 0,
    credentialReads: 0,
    externalNetworkRequests: 0,
    remoteMutations: 0,
    loopbackHttpRequests: 0,
    gatewayInstances: 0,
    localRefWrites: 0,
  };
  try {
    const sourceRevision = await initializeFixtureRepository(source, controlHome);
    assertCondition(
      sourceRevision.baseCommitSha1 === benchmarkCase.repository.sourceRevision.commitSha1 &&
        sourceRevision.baseTreeSha1 === benchmarkCase.repository.sourceRevision.treeSha1,
      `${benchmarkCase.id} pinned source revision mismatch: ${JSON.stringify(sourceRevision)}`,
    );
    const sourceTreeBefore = await snapshotTree(source);
    const sourceGitBefore = await repositoryFingerprint(source, controlHome);
    const sourceGitDirectoryBefore = await snapshotGitDirectory(source);
    const baseline = await runBaselineChecks(
      benchmarkCase,
      source,
      sourceRevision.baseCommitSha1,
      temporaryRoot,
    );

    provider = await startDeterministicOllama(providerResponses(benchmarkCase, assets));
    const allowedProviderOrigin = new URL(provider.baseUrl).origin;
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : input);
      if (
        target.origin !== allowedProviderOrigin ||
        target.protocol !== "http:" ||
        target.hostname !== "127.0.0.1"
      ) {
        effects.externalNetworkRequests += 1;
        throw new Error(`Gate 1 blocked non-loopback fetch: ${target.origin}`);
      }
      effects.loopbackHttpRequests += 1;
      return nativeFetch(input, init);
    };
    restoreFetch = () => {
      globalThis.fetch = nativeFetch;
    };
    const gatewayFactory = (config) => {
      assertCondition(
        config.kind === "ollama" &&
          new URL(config.baseUrl).origin === allowedProviderOrigin &&
          config.capabilities.locality === "loopback",
        `${benchmarkCase.id} requested an unauthorized provider gateway`,
      );
      effects.gatewayInstances += 1;
      return new OllamaGateway(config);
    };
    const stateRoot = path.join(temporaryRoot, "state");
    runtime = await createIcarusRuntime(stateRoot, { gatewayFactory });
    await runtime.service.registerRepository("fixture", source);
    runtime.service.createProject({
      name: "gate1",
      repositoryName: "fixture",
      baseRef: "main",
      checks: benchmarkCase.checks,
      sandbox: benchmarkCase.sandbox,
      ceiling: ceilingFrom(benchmarkCase),
    });
    const providerConfig = createProviderConfig({
      kind: benchmarkCase.modelAdapter.provider,
      model: benchmarkCase.modelAdapter.model,
      baseUrl: provider.baseUrl,
      inputUsdPerMillionTokens: benchmarkCase.modelAdapter.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: benchmarkCase.modelAdapter.outputUsdPerMillionTokens,
    });
    const planned = await runtime.service.planRun({
      projectName: "gate1",
      task: assets.task,
      targets: benchmarkCase.selectedPaths,
      provider: providerConfig,
    });
    assertCondition(
      planned.state === "awaiting_approval" &&
        planned.planSha256 !== null &&
        sameValue(planned.plan?.targets, benchmarkCase.expectedChangedPaths) &&
        sameValue(
          planned.plan?.checkIds,
          benchmarkCase.checks.map((check) => check.id),
        ),
      `${benchmarkCase.id} did not reach the exact plan approval contract`,
    );
    const reviewed = await runtime.service.approvePlan(
      planned.id,
      planned.planSha256,
      "gate1-fixture-operator",
    );
    assertCondition(
      reviewed.state === "awaiting_review" &&
        reviewed.verification?.outcome === "passed" &&
        reviewed.verification.checks.length === benchmarkCase.checks.length &&
        reviewed.verification.checks.every(
          (check, index) =>
            check.outcome === "passed" &&
            check.truncated === false &&
            check.checkId === benchmarkCase.checks[index]?.id &&
            sameValue(check.argv, benchmarkCase.checks[index]?.argv),
        ) &&
        sameValue(reviewed.verification.changedPaths, benchmarkCase.expectedChangedPaths),
      `${benchmarkCase.id} repair did not produce exact passing evidence`,
    );
    assertCondition(reviewed.worktreePath !== null, `${benchmarkCase.id} has no private worktree`);
    for (const change of assets.changes) {
      assertCondition(
        (await readFile(path.join(reviewed.worktreePath, change.path))).equals(change.approved),
        `${benchmarkCase.id} approved bytes mismatch: ${change.path}`,
      );
    }
    const completed = await runtime.service.review(
      planned.id,
      "approve",
      reviewed.verification.diffSha256,
      "gate1-fixture-operator",
    );
    assertCondition(
      completed.state === "completed" && completed.diff !== null && completed.cachePath !== null,
      `${benchmarkCase.id} did not complete local review`,
    );
    const providerEvidence = validateProviderRequests(benchmarkCase, provider);
    assertCondition(
      effects.loopbackHttpRequests === benchmarkCase.modelAdapter.expectedRequests &&
        effects.gatewayInstances === benchmarkCase.modelAdapter.expectedRequests &&
        effects.externalNetworkRequests === 0,
      `${benchmarkCase.id} provider effect counters differ from the manifest`,
    );

    const checkpointFiles = assets.changes.map((change) => ({
      path: change.path,
      op: "modify",
      baselineBase64: change.baseline.toString("base64"),
      approvedBase64: change.approved.toString("base64"),
    }));
    const landingController = new LandingGitController(
      path.join(stateRoot, "controller-home"),
      path.join(stateRoot, "runs"),
    );
    const candidateInput = {
      cachePath: completed.cachePath,
      runId: completed.id,
      baseCommitSha1: sourceRevision.baseCommitSha1,
      baseTreeSha1: sourceRevision.baseTreeSha1,
      checkpointFiles,
      reviewedDiffBytes: Buffer.from(completed.diff, "utf8"),
      commitIdentity: benchmarkCase.candidate.commitIdentity,
      commitEpochSeconds: benchmarkCase.candidate.commitEpochSeconds,
      commitMessage: benchmarkCase.candidate.commitMessage,
    };
    const candidate = await landingController.prepareCandidate(candidateInput);
    const replayedCandidate = await landingController.prepareCandidate(candidateInput);
    assertCondition(
      sameValue(candidate, replayedCandidate),
      `${benchmarkCase.id} candidate replay drift`,
    );
    assertCandidateMatches(benchmarkCase, candidate);
    const { candidateObjectManifest: candidateObjectManifestEvidence, ...candidateEvidence } =
      candidate;
    assertCondition(
      candidateObjectManifestEvidence !== undefined,
      `${benchmarkCase.id} candidate object manifest is absent`,
    );

    const expectedHeadRef = benchmarkCase.candidate.headRefTemplate.replace(
      "{runId}",
      completed.id,
    );
    const recoveryRecord = {
      schemaVersion: 1,
      runId: completed.id,
      baseCommitSha1: candidate.baseCommitSha1,
      candidateCommitSha1: candidate.candidateCommitSha1,
      headRef: expectedHeadRef,
    };
    const recoveryPath = path.join(stateRoot, "gate1-benchmark-recovery.json");
    await writeFile(recoveryPath, `${JSON.stringify(recoveryRecord)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    runtime.close();
    runtime = undefined;

    const recovered = parseStrictJson((await readFile(recoveryPath, "utf8")).trimEnd());
    assertCondition(
      sameValue(recovered, recoveryRecord),
      `${benchmarkCase.id} recovery record drift`,
    );
    runtime = await createIcarusRuntime(stateRoot, { gatewayFactory });
    const recoveredRun = runtime.service.getRun(recovered.runId);
    const recoveredCachePath = path.join(stateRoot, "runs", recovered.runId, "git-cache.git");
    assertCondition(
      recoveredRun.state === "completed" &&
        recoveredRun.baseCommit === recovered.baseCommitSha1 &&
        recoveredRun.cachePath === recoveredCachePath,
      `${benchmarkCase.id} durable run did not survive the production runtime reopen`,
    );
    const restartedController = new LandingGitController(
      path.join(stateRoot, "controller-home"),
      path.join(stateRoot, "runs"),
    );
    const localRef = await restartedController.createAbsentLocalRef({
      cachePath: recoveredCachePath,
      runId: recovered.runId,
      candidateCommitSha1: recovered.candidateCommitSha1,
    });
    effects.localRefWrites += 1;
    assertCondition(
      localRef.headRef === recovered.headRef &&
        localRef.candidateCommitSha1 === recovered.candidateCommitSha1 &&
        localRef.localRefOutcome === benchmarkCase.restartRecovery.expectedLocalRefOutcome &&
        localRef.updateRefExitCode === 0 &&
        effects.localRefWrites === benchmarkCase.restartRecovery.expectedLocalRefWrites,
      `${benchmarkCase.id} runtime-reopen recovery did not create the exact absent-only local ref`,
    );
    let duplicateReplayCode = null;
    try {
      const duplicateReplay = await restartedController.createAbsentLocalRef({
        cachePath: recoveredCachePath,
        runId: recovered.runId,
        candidateCommitSha1: recovered.candidateCommitSha1,
      });
      duplicateReplayCode = duplicateReplay.outcome === "failed" ? duplicateReplay.errorCode : null;
    } catch (error) {
      duplicateReplayCode =
        typeof error === "object" && error !== null && "code" in error ? error.code : null;
    }
    assertCondition(
      duplicateReplayCode === "LANDING_LOCAL_REF_CONFLICT" &&
        effects.localRefWrites === benchmarkCase.restartRecovery.expectedLocalRefWrites,
      `${benchmarkCase.id} duplicate local-ref replay was not refused`,
    );
    const privateRefs = fixtureGit(path.join(stateRoot, "controller-home"), controlHome, [
      "--git-dir",
      recoveredCachePath,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads/icarus/",
    ]);
    assertCondition(
      privateRefs === `${recovered.headRef} ${recovered.candidateCommitSha1}`,
      `${benchmarkCase.id} private landing ref set differs from the one-write contract`,
    );

    const sourceTreeAfter = await snapshotTree(source);
    const sourceGitAfter = await repositoryFingerprint(source, controlHome);
    const sourceGitDirectoryAfter = await snapshotGitDirectory(source);
    const fixtureAfter = await snapshotTree(fixtureRoot);
    assertCondition(
      sameValue(sourceTreeAfter, sourceTreeBefore) &&
        sameValue(sourceGitAfter, sourceGitBefore) &&
        sameValue(sourceGitDirectoryAfter, sourceGitDirectoryBefore),
      `${benchmarkCase.id} changed the source checkout`,
    );
    assertCondition(sameValue(fixtureAfter, fixtureBefore), `${benchmarkCase.id} changed fixtures`);

    return {
      id: benchmarkCase.id,
      stack: benchmarkCase.stack,
      assessment: "contract_passed_gate1_live_evidence_not_run",
      source: {
        commitSha1: sourceRevision.baseCommitSha1,
        treeSha1: sourceRevision.baseTreeSha1,
        treeSha256: treeSha256(sourceTreeAfter),
        unchanged: true,
        gitFingerprintFields: benchmarkCase.sourceImmutability.gitFingerprintFields,
        completeGitDirectorySnapshotUnchanged: true,
      },
      taskSha256: benchmarkCase.task.sha256,
      baselineChecks: summarizeChecks(baseline),
      repair: {
        runId: completed.id,
        state: completed.state,
        planSha256: completed.planSha256,
        diffSha256: completed.verification?.diffSha256,
        checkpointSha256: completed.verification?.checkpointSha256,
        changedPaths: completed.verification?.changedPaths,
        checks: summarizeChecks(completed.verification?.checks ?? []),
        provider: {
          adapterVersion: benchmarkCase.modelAdapter.adapterVersion,
          model: benchmarkCase.modelAdapter.model,
          loopbackRequests: provider.requests.length,
          ...providerEvidence,
        },
      },
      candidate: {
        ...candidateEvidence,
        headRef: localRef.headRef,
        localRefOutcome: localRef.localRefOutcome,
        updateRefExitCode: localRef.updateRefExitCode,
        recoveredAfter: benchmarkCase.restartRecovery.injectionPoint,
        productionRuntimeReopened: true,
        durableRunRecovered: true,
        recoveryJournal: "benchmark_harness_only",
        duplicateReplayCode,
        localRefWrites: effects.localRefWrites,
      },
      draftPullRequest: {
        status: "not_executed_contract_only",
        contractSchemaVersion: benchmarkCase.draftPullRequestEvidence.schemaVersion,
        remoteMutationPerformed: false,
      },
      receipt: {
        status: "not_executed_contract_only",
        schemaVersion: benchmarkCase.receiptEvidence.schemaVersion,
        runtimeRequiredForGate: true,
      },
      effects,
    };
  } finally {
    runtime?.close();
    restoreFetch?.();
    await provider?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const reportOutput = await prepareReportOutput();
let manifestBytes = null;
let manifest = null;
let fixtureSnapshot = null;
let activeCaseId = null;
let failureStage = "manifest_or_fixture_preflight";
const results = [];

try {
  manifestBytes = await readRegularFile(manifestPath, "Gate 1 manifest");
  fixtureSnapshot = await snapshotTree(fixtureRoot);
  assertCondition(
    fixtureSnapshot.some(
      (entry) => entry.path === "manifest.v1.json" && entry.sha256 === sha256(manifestBytes),
    ),
    "Gate 1 manifest changed while its fixture snapshot was captured",
  );
  manifest = validateGate1BenchmarkManifest(parseStrictJson(manifestBytes.toString("utf8")));

  failureStage = "case_execution";
  for (const benchmarkCase of manifest.cases) {
    activeCaseId = benchmarkCase.id;
    results.push(await runCase(benchmarkCase));
  }
  activeCaseId = null;

  failureStage = "aggregate_verification";
  assertCondition(
    results.length === manifest.releaseGate.requiredCaseCount &&
      results.every(
        (result) => result.assessment === "contract_passed_gate1_live_evidence_not_run",
      ),
    "Gate 1 deterministic contract did not pass all three cases",
  );
  assertCondition(
    sameValue(await snapshotTree(fixtureRoot), fixtureSnapshot),
    "Gate 1 fixtures changed during the benchmark",
  );
  const aggregateEffects = aggregateCaseEffects(results);
  assertCondition(
    aggregateEffects.paidProviderCalls === manifest.executionBoundary.paidProviderCalls &&
      aggregateEffects.credentialReads === manifest.executionBoundary.credentialReads &&
      aggregateEffects.externalNetworkRequests ===
        manifest.executionBoundary.externalNetworkRequests &&
      aggregateEffects.remoteMutations === manifest.executionBoundary.remoteMutations &&
      aggregateEffects.localRefWrites ===
        manifest.cases.reduce(
          (total, benchmarkCase) => total + benchmarkCase.restartRecovery.expectedLocalRefWrites,
          0,
        ),
    "Gate 1 observed effect counters differ from the manifest",
  );

  const report = {
    schemaVersion: manifest.resultSchemaVersion,
    benchmarkId: manifest.benchmarkId,
    benchmarkRevision: manifest.benchmarkRevision,
    manifestSha256: sha256(manifestBytes),
    assessment: "offline_contract_passed_gate1_incomplete",
    counts: {
      contractPassed: results.length,
      failed: 0,
      liveEvidenceNotRun: results.length,
    },
    effects: aggregateEffects,
    cases: results,
    limitations: GATE1_OFFLINE_REPORT_LIMITATIONS,
  };
  await writeReportAtomically(reportOutput, report, manifest, sha256(manifestBytes));
  console.log(
    `Gate 1 benchmark contract: ${results.length} passed, 0 failed, ${results.length} live-evidence not run`,
  );
} catch (error) {
  const completedEffects = aggregateCaseEffects(results);
  const safeCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
      ? error.code
      : null;
  const message = error instanceof Error ? error.message : "unknown failure";
  const requiredCaseCount = manifest?.releaseGate.requiredCaseCount ?? 3;
  const failureReport = {
    schemaVersion: manifest?.resultSchemaVersion ?? 1,
    benchmarkId: manifest?.benchmarkId ?? "gate1-verified-change",
    benchmarkRevision: manifest?.benchmarkRevision ?? "gate1-three-repository-repair-v1",
    manifestSha256: manifestBytes === null ? null : sha256(manifestBytes),
    assessment: "offline_contract_failed_gate1_incomplete",
    counts: {
      contractPassed: results.length,
      failed: 1,
      liveEvidenceNotRun: requiredCaseCount,
    },
    effects: {
      status: "partial_completed_cases_only",
      ...completedEffects,
    },
    cases: results,
    failure: {
      stage: failureStage,
      caseId: activeCaseId,
      code: safeCode,
      messageSha256: sha256(message),
    },
    limitations: [...GATE1_OFFLINE_REPORT_LIMITATIONS, GATE1_FAILURE_REPORT_LIMITATION],
  };
  try {
    await writeReportAtomically(
      reportOutput,
      failureReport,
      manifest,
      manifestBytes === null ? null : sha256(manifestBytes),
    );
  } catch (reportError) {
    throw new AggregateError(
      [error, reportError],
      "Gate 1 benchmark and failure report both failed",
    );
  }
  throw error;
} finally {
  await reportOutput.directoryHandle.close();
}
