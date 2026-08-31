import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { retrieveReadOnlyContextV3 } from "../packages/core/dist/context-retrieval.js";
import { GitController } from "../packages/core/dist/git.js";
import {
  GATE2_RETRIEVAL_LIMITATIONS,
  validateGate2RetrievalManifest,
  validateGate2RetrievalResult,
} from "./gate2-retrieval-contract.mjs";

const root = path.resolve(".");
const manifestPath = path.join(root, "fixtures/evals/gate2/retrieval-manifest.v1.json");
const reportDirectory = path.join(root, ".local");
const reportPath = path.join(reportDirectory, "gate2-retrieval-report.json");
process.umask(0o077);

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hasCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function within(base, relative, label) {
  const resolved = path.resolve(base, relative);
  assertCondition(
    resolved !== base && resolved.startsWith(`${base}${path.sep}`),
    `${label} escapes its root`,
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

async function snapshotFiles(directory, prefix = "") {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (prefix === "" && entry.name === ".git") continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const entryPath = within(directory, entry.name, "snapshot path");
    const metadata = await lstat(entryPath);
    assertCondition(!metadata.isSymbolicLink(), `Fixture path is symbolic: ${relative}`);
    if (metadata.isDirectory()) {
      result.push(...(await snapshotFiles(entryPath, relative)));
    } else {
      assertCondition(
        metadata.isFile() && metadata.nlink === 1,
        `Fixture path is special: ${relative}`,
      );
      result.push({ path: relative, sha256: sha256(await readFile(entryPath)) });
    }
  }
  return result;
}

function git(cwd, controlHome, args) {
  const result = spawnSync(
    "/usr/bin/git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.allow=never",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      shell: false,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: controlHome,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        GIT_SSH_COMMAND: "false",
        GIT_AUTHOR_NAME: "Icarus Eval",
        GIT_AUTHOR_EMAIL: "icarus-eval@example.invalid",
        GIT_COMMITTER_NAME: "Icarus Eval",
        GIT_COMMITTER_EMAIL: "icarus-eval@example.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    },
  );
  if (result.error !== undefined) throw result.error;
  assertCondition(
    result.status === 0,
    `fixture Git ${args[0] ?? "command"} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

async function writeReport(report, manifest, manifestSha256) {
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(reportDirectory);
  const currentUid = process.getuid?.();
  assertCondition(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      currentUid !== undefined &&
      directory.uid === currentUid &&
      (directory.mode & 0o077) === 0,
    "Gate 2 report directory must be private and must not be a symbolic link",
  );
  assertCondition(
    (await realpath(reportDirectory)) === reportDirectory,
    "Report directory changed identity",
  );
  const existing = await lstat(reportPath).catch((error) => {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  });
  if (existing !== null) {
    assertCondition(
      existing.isFile() &&
        !existing.isSymbolicLink() &&
        existing.nlink === 1 &&
        existing.uid === currentUid,
      "Existing Gate 2 retrieval report is unsafe",
    );
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  validateGate2RetrievalResult(JSON.parse(serialized), manifest, manifestSha256);
  const temporaryPath = path.join(
    reportDirectory,
    `.gate2-retrieval-${process.pid}-${randomUUID()}`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, reportPath);
  const persisted = await readFile(reportPath);
  assertCondition(
    persisted.equals(Buffer.from(serialized)),
    "Persisted Gate 2 report changed bytes",
  );
  validateGate2RetrievalResult(JSON.parse(persisted.toString("utf8")), manifest, manifestSha256);
}

assertCondition((await realpath(root)) === root, "Gate 2 repository root must be canonical");
const manifestBytes = await readRegularFile(manifestPath, "Gate 2 manifest");
const manifest = validateGate2RetrievalManifest(JSON.parse(manifestBytes.toString("utf8")));
const manifestSha256 = sha256(manifestBytes);
const scenario = manifest.case;
const source = within(root, scenario.repository.fixturePath, "fixture repository");
const taskPath = within(root, scenario.task.path, "fixture task");
const sourceMetadata = await lstat(source);
assertCondition(
  sourceMetadata.isDirectory() &&
    !sourceMetadata.isSymbolicLink() &&
    (await realpath(source)) === source,
  "Gate 2 fixture repository must be one canonical directory",
);
const sourceBefore = await snapshotFiles(source);
assertCondition(
  JSON.stringify(sourceBefore) === JSON.stringify(scenario.repository.files),
  "Fixture repository does not match its closed inventory",
);
const task = await readRegularFile(taskPath, "Gate 2 task");
assertCondition(sha256(task) === scenario.task.sha256, "Fixture task digest changed");

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "icarus-gate2-retrieval-"));
try {
  const workspace = path.join(temporaryRoot, "repository");
  const controlHome = path.join(temporaryRoot, "control-home");
  const runsRoot = path.join(temporaryRoot, "runs");
  await Promise.all([mkdir(workspace), mkdir(controlHome), mkdir(runsRoot)]);
  await cp(source, workspace, { recursive: true, dereference: false, errorOnExist: true });
  git(workspace, controlHome, ["init", "--quiet", "--initial-branch=main"]);
  git(workspace, controlHome, ["add", "--all"]);
  git(workspace, controlHome, ["commit", "--quiet", "--no-gpg-sign", "-m", "fixture baseline"]);
  const baseCommit = git(workspace, controlHome, ["rev-parse", "HEAD"]);
  const treeSha1 = git(workspace, controlHome, ["rev-parse", "HEAD^{tree}"]);
  assertCondition(baseCommit === scenario.repository.commitSha1, "Fixture commit identity changed");
  assertCondition(treeSha1 === scenario.repository.treeSha1, "Fixture tree identity changed");
  const workspaceBefore = {
    files: await snapshotFiles(workspace),
    head: baseCommit,
    status: git(workspace, controlHome, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };

  const controller = new GitController(controlHome, runsRoot, "/usr/bin/git");
  const retrieval = await retrieveReadOnlyContextV3(
    controller,
    workspace,
    baseCommit,
    task.toString("utf8"),
    scenario.retrievalBudget,
  );
  const selectedPaths = retrieval.entries.map((entry) => entry.path);
  const expected = new Set(scenario.expectedPaths);
  const matched = selectedPaths.filter((entry) => expected.has(entry));
  const recall = matched.length / scenario.expectedPaths.length;
  const precision = selectedPaths.length === 0 ? 0 : matched.length / selectedPaths.length;
  const provenance = retrieval.entries.map((entry) => ({
    path: entry.path,
    sha256: entry.sha256,
    lineCount: entry.lineCount,
    matches: entry.matches,
  }));
  const workspaceAfter = {
    files: await snapshotFiles(workspace),
    head: git(workspace, controlHome, ["rev-parse", "HEAD"]),
    status: git(workspace, controlHome, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
  const sourceAfter = await snapshotFiles(source);
  const sourceCheckoutUnchanged = JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore);
  const workspaceUnchanged = JSON.stringify(workspaceAfter) === JSON.stringify(workspaceBefore);
  const passed =
    recall >= scenario.thresholds.minimumRecall &&
    precision >= scenario.thresholds.minimumPrecision &&
    sourceCheckoutUnchanged &&
    workspaceUnchanged &&
    provenance.every((entry) => entry.lineCount > 0) &&
    provenance.some((entry) => entry.matches.length > 0);
  const report = {
    schemaVersion: manifest.resultSchemaVersion,
    benchmarkId: manifest.benchmarkId,
    benchmarkRevision: manifest.benchmarkRevision,
    manifestSha256,
    generatedAt: new Date().toISOString(),
    passed,
    case: {
      id: scenario.id,
      baseCommit,
      treeSha1,
      retrievalDigestSha256: retrieval.digestSha256,
      repositoryDigestSha256: retrieval.repositoryDigestSha256,
      selectedPaths,
      provenance,
      recall,
      precision,
      sourceCheckoutUnchanged,
      workspaceUnchanged,
      effects: {
        providerCalls: 0,
        networkRequests: 0,
        repositoryMutations: 0,
        registeredCommands: 0,
      },
      passed,
    },
    limitations: GATE2_RETRIEVAL_LIMITATIONS,
  };
  await writeReport(report, manifest, manifestSha256);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
