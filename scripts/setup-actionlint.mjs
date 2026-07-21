import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  constants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  ACTIONLINT_RELEASE_BASE,
  ACTIONLINT_VERSION,
  currentActionlintTarget,
  localActionlintPath,
} from "./actionlint-tool.mjs";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const root = path.resolve(".");
const target = currentActionlintTarget();
const binaryPath = localActionlintPath(root, target);
const versionDirectory = path.dirname(path.dirname(binaryPath));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileSha256(filePath) {
  return sha256(await readFile(filePath));
}

function verifyVersion(filePath) {
  const result = spawnSync(filePath, ["-version"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `actionlint version check failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  if (result.stdout.split(/\r?\n/, 1)[0] !== ACTIONLINT_VERSION) {
    throw new Error(`actionlint reported an unexpected version: ${result.stdout.trim()}`);
  }
}

async function ensureRealDirectory(directory) {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("actionlint tool directory escaped the repository");
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`actionlint tool ancestor is not a real directory: ${current}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`actionlint tool ancestor is not a real directory: ${current}`);
      }
    }
  }
}

async function existingBinaryIsValid() {
  try {
    const info = await lstat(binaryPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`actionlint path is not a regular file: ${binaryPath}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const digest = await fileSha256(binaryPath);
  if (digest !== target.binarySha256) {
    throw new Error(
      `cached actionlint digest mismatch at ${binaryPath}; remove that generated file and rerun workflow:setup`,
    );
  }
  verifyVersion(binaryPath);
  return true;
}

async function downloadArchive(url) {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "icarus-workflow-validator/0.1" },
      signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`actionlint download failed with HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
      throw new Error("actionlint archive exceeds the download ceiling");
    }
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error("actionlint archive exceeds the download ceiling");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`actionlint download exceeded ${DOWNLOAD_TIMEOUT_MS} ms`, {
        cause: error,
      });
    }
    throw error;
  }
}

await ensureRealDirectory(path.dirname(binaryPath));
if (await existingBinaryIsValid()) {
  process.stdout.write(
    `${JSON.stringify({ actionlint: ACTIONLINT_VERSION, target: target.key, installed: false })}\n`,
  );
  process.exit(0);
}

const temporaryDirectory = await mkdtemp(path.join(versionDirectory, ".download-"));
try {
  const archivePath = path.join(temporaryDirectory, target.archiveName);
  const extractDirectory = path.join(temporaryDirectory, "extract");
  await mkdir(extractDirectory, { mode: 0o700 });
  const archive = await downloadArchive(`${ACTIONLINT_RELEASE_BASE}/${target.archiveName}`);
  const archiveDigest = sha256(archive);
  if (archiveDigest !== target.archiveSha256) {
    throw new Error(
      `actionlint archive digest mismatch: expected ${target.archiveSha256}, received ${archiveDigest}`,
    );
  }
  await writeFile(archivePath, archive, { mode: 0o600, flag: "wx" });
  const extractArguments =
    target.archiveKind === "tar-gzip"
      ? ["-xzf", archivePath, "-C", extractDirectory]
      : ["-xf", archivePath, "-C", extractDirectory];
  const extracted = spawnSync("tar", extractArguments, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (extracted.error !== undefined || extracted.status !== 0) {
    throw new Error(
      `actionlint extraction failed: ${extracted.error?.message ?? extracted.stderr.trim()}`,
    );
  }
  const extractedBinary = path.join(extractDirectory, target.binaryName);
  const extractedInfo = await lstat(extractedBinary);
  if (!extractedInfo.isFile() || extractedInfo.isSymbolicLink()) {
    throw new Error("actionlint archive did not contain the expected regular executable");
  }
  const binaryDigest = await fileSha256(extractedBinary);
  if (binaryDigest !== target.binarySha256) {
    throw new Error(
      `actionlint executable digest mismatch: expected ${target.binarySha256}, received ${binaryDigest}`,
    );
  }
  if (process.platform !== "win32") await chmod(extractedBinary, 0o755);
  verifyVersion(extractedBinary);
  await copyFile(extractedBinary, binaryPath, constants.COPYFILE_EXCL);
  if (process.platform !== "win32") await chmod(binaryPath, 0o755);
  process.stdout.write(
    `${JSON.stringify({ actionlint: ACTIONLINT_VERSION, target: target.key, installed: true })}\n`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
