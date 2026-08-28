import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findSecretSpans } from "../packages/core/dist/context.js";
import { loadGate2BenchmarkContract, parseStrictGate2Json } from "./gate2-benchmark-contract.mjs";
import {
  compareGate2BenchmarkResults,
  computeGate2ExecutionProfileDigest,
  validateGate2BenchmarkResult,
} from "./gate2-benchmark-result-contract.mjs";
import {
  GATE2_LIVE_CANDIDATE_CONTRACT_REVISION,
  isGate2ProviderOutputComplete,
} from "./gate2-live-candidate-contract.mjs";
import {
  GATE2_LIVE_ROUTING_POLICY_SHA256,
  selectGate2LiveModel,
} from "./gate2-live-routing-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const manifestPath = path.join(root, "fixtures/evals/gate2/manifest.v2.json");
const profilePath = path.join(root, "fixtures/evals/gate2/live-profile.v1.json");
const localRoot = path.join(root, ".local/gate2-live-v1");
const publishedRoot = path.join(root, "docs/evals/artifacts");
const ALLOWED_FALSE_POSITIVE_SECRET_TOKENS = new Set([
  "sk-priority-contract",
  "sk-priority-contract-evaluator",
  "sk-v2-host-policy-compatible",
]);
const LIVE_EVIDENCE_RECORD_REVISION = 2;
const EXPECTED_LOCAL_PROVIDER = Object.freeze({
  id: "local-ollama",
  type: "ollama",
  baseUrl: "http://127.0.0.1:11434",
});
process.umask(0o077);

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function safeJoin(base, relative) {
  const resolved = path.resolve(base, relative);
  assertCondition(resolved.startsWith(`${base}${path.sep}`), "published evidence path escaped");
  return resolved;
}

async function regularBytes(filePath, label) {
  const metadata = await lstat(filePath);
  assertCondition(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1,
    `${label} must be one non-linked regular file`,
  );
  return readFile(filePath);
}

async function exclusiveWrite(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}`;
  let handle = await open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function assertNoUnknownSecretShape(bytes, relative) {
  const text = bytes.toString("utf8");
  const unknown = findSecretSpans(bytes).filter(
    (span) => !ALLOWED_FALSE_POSITIVE_SECRET_TOKENS.has(text.slice(span.start, span.end)),
  );
  assertCondition(unknown.length === 0, `${relative} contains an unknown secret-shaped span`);
}

function sourceRelativePaths(manifest) {
  return [
    "preflight.json",
    "baseline-result.json",
    "routed-result.json",
    "comparison.json",
    ...["baseline", "routed"].flatMap((mode) =>
      manifest.cases.map((benchmarkCase) => `${mode}/${benchmarkCase.id}.json`),
    ),
  ];
}

async function validateEvidenceSet(evidenceDirectory, loaded, profile) {
  const relativePaths = sourceRelativePaths(loaded.manifest);
  const files = [];
  const bytesByPath = new Map();
  for (const relative of relativePaths) {
    const bytes = await regularBytes(safeJoin(evidenceDirectory, relative), relative);
    assertNoUnknownSecretShape(bytes, relative);
    bytesByPath.set(relative, bytes);
    files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const baseline = parseStrictGate2Json(bytesByPath.get("baseline-result.json").toString("utf8"));
  const routed = parseStrictGate2Json(bytesByPath.get("routed-result.json").toString("utf8"));
  const comparison = parseStrictGate2Json(bytesByPath.get("comparison.json").toString("utf8"));
  const preflight = parseStrictGate2Json(bytesByPath.get("preflight.json").toString("utf8"));
  assertCondition(
    preflight.manifestSha256 === loaded.manifestSha256 &&
      preflight.executionProfileDigestSha256 === profile.profileDigestSha256 &&
      preflight.routingPolicySha256 === GATE2_LIVE_ROUTING_POLICY_SHA256 &&
      stableJson(preflight.provider) === stableJson(EXPECTED_LOCAL_PROVIDER),
    "published preflight is not bound",
  );
  validateGate2BenchmarkResult(baseline, loaded.manifest, loaded.manifestSha256);
  validateGate2BenchmarkResult(routed, loaded.manifest, loaded.manifestSha256);
  assertCondition(
    stableJson(
      compareGate2BenchmarkResults(baseline, routed, loaded.manifest, loaded.manifestSha256),
    ) === stableJson(comparison),
    "published comparison does not recompute",
  );
  for (const [mode, result] of [
    ["baseline", baseline],
    ["routed", routed],
  ]) {
    for (const [index, benchmarkCase] of loaded.manifest.cases.entries()) {
      const relative = `${mode}/${benchmarkCase.id}.json`;
      const record = parseStrictGate2Json(bytesByPath.get(relative).toString("utf8"));
      const providerOutputComplete = isGate2ProviderOutputComplete(record.finishReason);
      assertCondition(
        record.candidateContractRevision === GATE2_LIVE_CANDIDATE_CONTRACT_REVISION &&
          record.evidenceRecordRevision === LIVE_EVIDENCE_RECORD_REVISION &&
          record.routingPolicySha256 === GATE2_LIVE_ROUTING_POLICY_SHA256 &&
          record.manifestSha256 === loaded.manifestSha256 &&
          record.executionProfileDigestSha256 === profile.profileDigestSha256 &&
          record.mode === mode &&
          record.caseId === benchmarkCase.id &&
          record.modelId === selectGate2LiveModel(mode, benchmarkCase.class) &&
          record.evaluatorEvidence.routingPolicySha256 === GATE2_LIVE_ROUTING_POLICY_SHA256 &&
          record.evaluatorEvidence.finishReason === record.finishReason &&
          record.evaluatorEvidence.providerOutputComplete === providerOutputComplete &&
          record.evaluatorEvidence.scenarioStatus === record.observation.scenarioStatus &&
          (providerOutputComplete || record.observation.scenarioStatus === "failed") &&
          stableJson(record.observation) === stableJson(result.observations[index]) &&
          record.evaluatorEvidence.candidateSha256 === sha256(record.rawCandidate) &&
          record.observation.scenarioEvidenceSha256 ===
            sha256(stableJson(record.evaluatorEvidence)),
        `published case record is not bound: ${relative}`,
      );
    }
  }
  return { relativePaths, files, bytesByPath, baseline, routed, comparison };
}

export async function verifyGate2PublishedEvidence(repositoryRoot = root) {
  const loaded = await loadGate2BenchmarkContract(
    path.join(repositoryRoot, "fixtures/evals/gate2/manifest.v2.json"),
    repositoryRoot,
  );
  const profile = parseStrictGate2Json(
    await readFile(path.join(repositoryRoot, "fixtures/evals/gate2/live-profile.v1.json"), "utf8"),
  );
  assertCondition(
    computeGate2ExecutionProfileDigest(profile) === profile.profileDigestSha256,
    "published profile digest is invalid",
  );
  const destination = path.join(repositoryRoot, "docs/evals/artifacts", profile.profileId);
  const validated = await validateEvidenceSet(destination, loaded, profile);
  const manifest = parseStrictGate2Json(
    await readFile(path.join(destination, "artifact-manifest.json"), "utf8"),
  );
  assertCondition(
    manifest.schemaVersion === 1 &&
      manifest.benchmarkManifestSha256 === loaded.manifestSha256 &&
      manifest.executionProfileDigestSha256 === profile.profileDigestSha256 &&
      manifest.routingPolicySha256 === GATE2_LIVE_ROUTING_POLICY_SHA256 &&
      stableJson(manifest.files) === stableJson(validated.files) &&
      manifest.filesDigestSha256 === sha256(stableJson(validated.files)),
    "published artifact manifest is invalid",
  );
  return { destination, manifest, ...validated };
}

async function publish() {
  assertCondition((await realpath(root)) === root, "repository root must be canonical");
  const loaded = await loadGate2BenchmarkContract(manifestPath, root);
  const profile = parseStrictGate2Json(await readFile(profilePath, "utf8"));
  assertCondition(
    computeGate2ExecutionProfileDigest(profile) === profile.profileDigestSha256,
    "live profile digest is invalid",
  );
  const source = path.join(localRoot, profile.profileDigestSha256);
  const destination = path.join(publishedRoot, profile.profileId);
  const existing = await lstat(destination).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    const verified = await verifyGate2PublishedEvidence(root);
    process.stdout.write(
      `${JSON.stringify({ status: "verified-existing", ...verified.manifest })}\n`,
    );
    return;
  }
  const validated = await validateEvidenceSet(source, loaded, profile);
  await mkdir(publishedRoot, { recursive: true, mode: 0o755 });
  await mkdir(destination, { recursive: false, mode: 0o755 });
  for (const relative of validated.relativePaths) {
    await exclusiveWrite(safeJoin(destination, relative), validated.bytesByPath.get(relative));
  }
  const artifactManifest = {
    schemaVersion: 1,
    benchmarkManifestSha256: loaded.manifestSha256,
    executionProfileDigestSha256: profile.profileDigestSha256,
    routingPolicySha256: GATE2_LIVE_ROUTING_POLICY_SHA256,
    generatedAt: new Date().toISOString(),
    files: validated.files,
    filesDigestSha256: sha256(stableJson(validated.files)),
  };
  await exclusiveWrite(
    path.join(destination, "artifact-manifest.json"),
    Buffer.from(`${JSON.stringify(artifactManifest, null, 2)}\n`),
  );
  await verifyGate2PublishedEvidence(root);
  process.stdout.write(`${JSON.stringify({ status: "published", ...artifactManifest })}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath) {
  await publish().catch((error) => {
    process.stderr.write(
      `Gate 2 live evidence publish failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
