import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ACTIONLINT_VERSION,
  currentActionlintTarget,
  localActionlintPath,
} from "./actionlint-tool.mjs";

const root = path.resolve(".");
const target = currentActionlintTarget();
const defaultBinaryPath = localActionlintPath(root, target);

function fail(message) {
  throw new Error(message);
}

async function fileSha256(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

function actionlintPath() {
  const override = process.env.ACTIONLINT_BIN;
  if (override === undefined) return defaultBinaryPath;
  if (override.trim().length === 0 || /[\r\n\0]/.test(override)) {
    fail("ACTIONLINT_BIN is invalid");
  }
  return path.resolve(override);
}

function invokeActionlint(binaryPath, configPath, files) {
  return spawnSync(
    binaryPath,
    ["-no-color", "-oneline", "-shellcheck=", "-pyflakes=", "-config-file", configPath, ...files],
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

async function verifyDefaultBinaryAncestors(binaryPath) {
  if (binaryPath !== defaultBinaryPath) return;
  const directory = path.dirname(binaryPath);
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("default actionlint path escaped the repository");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail(`actionlint tool ancestor is not a real directory: ${current}`);
    }
  }
}

async function verifyBinary(binaryPath) {
  let info;
  try {
    info = await lstat(binaryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(`actionlint is missing at ${binaryPath}; run pnpm workflow:setup`);
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail(`actionlint path is not a regular file: ${binaryPath}`);
  }
  await verifyDefaultBinaryAncestors(binaryPath);
  const digest = await fileSha256(binaryPath);
  if (digest !== target.binarySha256) {
    fail(
      `actionlint digest mismatch at ${binaryPath}; expected ${target.binarySha256}, received ${digest}`,
    );
  }
  const version = spawnSync(binaryPath, ["-version"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (version.error !== undefined || version.status !== 0) {
    fail(`actionlint version check failed: ${version.error?.message ?? version.stderr.trim()}`);
  }
  if (version.stdout.split(/\r?\n/, 1)[0] !== ACTIONLINT_VERSION) {
    fail(`actionlint reported an unexpected version: ${version.stdout.trim()}`);
  }
}

async function workflowFiles() {
  const directory = path.join(root, ".github", "workflows");
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    fail(".github/workflows must be a real directory");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => [".yml", ".yaml"].includes(path.extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (candidates.length === 0) fail("no GitHub Actions workflow files were found");
  for (const entry of candidates) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(`workflow is not a regular file: ${entry.name}`);
    }
  }
  return candidates.map((entry) => path.join(".github", "workflows", entry.name));
}

async function main() {
  const binaryPath = actionlintPath();
  await verifyBinary(binaryPath);
  const files = await workflowFiles();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "icarus-actionlint-self-test-"));
  try {
    const configPath = path.join(temporaryDirectory, "config.yaml");
    const invalidPath = path.join(temporaryDirectory, "known-invalid.yml");
    await writeFile(configPath, "{}\n", { mode: 0o600, flag: "wx" });
    await writeFile(
      invalidPath,
      "name: workflow-lint-self-test\non: push\njobs:\n  broken:\n    runs-on: ubuntu-latest\n    steps:\n      - run: [\n",
      { mode: 0o600, flag: "wx" },
    );

    const negative = invokeActionlint(binaryPath, configPath, [invalidPath]);
    if (negative.error !== undefined || negative.status === null) {
      fail(`actionlint self-test could not run: ${negative.error?.message ?? "no exit status"}`);
    }
    if (negative.status === 0) {
      fail("actionlint accepted the known-invalid self-test workflow");
    }

    const result = invokeActionlint(binaryPath, configPath, files);
    if (result.error !== undefined || result.status === null) {
      fail(`actionlint could not run: ${result.error?.message ?? "no exit status"}`);
    }
    if (result.status !== 0) {
      if (result.stdout.length > 0) process.stderr.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
      fail(`actionlint rejected ${files.length} workflow file(s)`);
    }
    process.stdout.write(
      `${JSON.stringify({
        actionlint: ACTIONLINT_VERSION,
        target: target.key,
        workflows: files,
        negativeSelfTest: "rejected",
      })}\n`,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `workflow lint failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
