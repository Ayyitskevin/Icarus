import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadGate2BenchmarkContract } from "./gate2-benchmark-contract.mjs";
import {
  buildGate2V2EvidenceAdoptionResult,
  GATE2_V2_EVIDENCE_SOURCE_REPORTS,
  parseAndValidateGate2V2EvidenceAdoptionResult,
  validateGate2V2EvidenceAdoptionResult,
} from "./gate2-v2-evidence-adoption-contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const predecessorManifestPath = path.join(root, "fixtures/evals/gate2/manifest.v1.json");
const successorManifestPath = path.join(root, "fixtures/evals/gate2/manifest.v2.json");
const reportDirectory = path.join(root, ".local");
const reportPath = path.join(reportDirectory, "gate2-v2-evidence-adoption-report.json");
process.umask(0o077);

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function hasCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function withinRoot(relativePath) {
  const resolved = path.resolve(root, relativePath);
  assertCondition(
    resolved !== root && resolved.startsWith(`${root}${path.sep}`),
    "Gate 2 evidence source escapes the repository root",
  );
  return resolved;
}

async function readRegularSource(relativePath) {
  const filePath = withinRoot(relativePath);
  const metadata = await lstat(filePath);
  assertCondition(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.nlink === 1 &&
      (await realpath(filePath)) === filePath,
    `Gate 2 evidence source must be one canonical regular file: ${relativePath}`,
  );
  return readFile(filePath, "utf8");
}

async function prepareReportDestination() {
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(reportDirectory);
  const currentUid = process.getuid?.();
  assertCondition(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      currentUid !== undefined &&
      directory.uid === currentUid &&
      (directory.mode & 0o077) === 0 &&
      (await realpath(reportDirectory)) === reportDirectory,
    "Gate 2 report directory must be private, owned, and canonical",
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
      "existing Gate 2 v2 evidence adoption report is unsafe",
    );
    await unlink(reportPath);
  }
}

async function persistReport(report, context) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  validateGate2V2EvidenceAdoptionResult(report, context);
  const temporaryPath = path.join(
    reportDirectory,
    `.gate2-v2-evidence-adoption-${process.pid}-${randomUUID()}`,
  );
  let handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await rename(temporaryPath, reportPath);
  const persisted = await readFile(reportPath);
  assertCondition(
    persisted.equals(Buffer.from(serialized)),
    "persisted Gate 2 v2 evidence adoption report changed bytes",
  );
  parseAndValidateGate2V2EvidenceAdoptionResult(persisted.toString("utf8"), context);
}

async function main() {
  assertCondition(process.argv.length === 2, "usage: node scripts/gate2-v2-evidence-adoption.mjs");
  assertCondition((await realpath(root)) === root, "Gate 2 repository root must be canonical");
  const [predecessor, successor, sourceReports] = await Promise.all([
    loadGate2BenchmarkContract(predecessorManifestPath, root),
    loadGate2BenchmarkContract(successorManifestPath, root),
    Promise.all(
      GATE2_V2_EVIDENCE_SOURCE_REPORTS.map(async (specification) => ({
        path: specification.path,
        source: await readRegularSource(specification.path),
      })),
    ),
  ]);
  const context = {
    predecessorManifest: predecessor.manifest,
    predecessorManifestSha256: predecessor.manifestSha256,
    predecessorManifestSource: await readRegularSource("fixtures/evals/gate2/manifest.v1.json"),
    successorManifest: successor.manifest,
    successorManifestSha256: successor.manifestSha256,
    sourceReports,
  };
  const report = buildGate2V2EvidenceAdoptionResult(context);
  await prepareReportDestination();
  await persistReport(report, context);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main().catch((error) => {
  process.stderr.write(
    `Gate 2 v2 evidence adoption failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
