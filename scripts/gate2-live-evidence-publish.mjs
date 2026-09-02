import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findSecretSpans } from "../packages/core/dist/context.js";
import { loadGate2BenchmarkContract, parseStrictGate2Json } from "./gate2-benchmark-contract.mjs";
import { verifyFrozenEvidence } from "./gate2-freeze-live-evidence.mjs";
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
  GATE2_LIVE_ROUTING_POLICY,
  GATE2_LIVE_ROUTING_POLICY_SHA256,
} from "./gate2-live-routing-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const manifestPath = path.join(root, "fixtures/evals/gate2/manifest.v2.json");
const publishedRoot = path.join(root, "docs/evals/artifacts");
// Exact span text, never a prefix or a pattern: an adjudication covers the one string a
// reviewer looked at, so widening the screen requires a new entry and a new reason.
const ALLOWED_FALSE_POSITIVE_SECRET_TOKENS = new Set([
  "sk-priority-contract",
  "sk-priority-contract-evaluator",
  "sk-v2-host-policy-compatible",
  // Adjudicated 2026-09-02 for the 2026-09-01 frozen set, the only span in it outside
  // the three above. In `routed/refactor-parser-token-table.json` the model's candidate
  // answer contains the Python line
  //   raise ValueError(f"unrecognized boolean token: {value!r}")
  // and the assignment scanner reads the word before the colon as the key `token`, then
  // takes the rest of the line as its value. The captured span is an f-string
  // interpolation of the rejected input plus the JSON escaping around it -- a literal
  // fragment of generated source, carrying no credential and no repository secret. The
  // detector is right to be blunt here; this set is where the blunt hit is answered.
  '{value!r}\\\\\\")\\\\n\\"}]',
]);
const LEGACY_V1_ROUTING_POLICY = Object.freeze({
  schemaVersion: 1,
  baseline: Object.freeze({ defaultModelId: "code-fast", overrides: Object.freeze({}) }),
  routed: Object.freeze({
    defaultModelId: "code",
    overrides: Object.freeze({ security_review: "code-fast" }),
  }),
});
const REASONING_SUPPRESSED_ROUTING_POLICY = Object.freeze({
  schemaVersion: 1,
  baseline: Object.freeze({ defaultModelId: "code-fast", overrides: Object.freeze({}) }),
  routed: Object.freeze({ defaultModelId: "code", overrides: Object.freeze({}) }),
});
const LIVE_EVIDENCE_CONFIGS = Object.freeze({
  v1: Object.freeze({
    profileFile: "live-profile.v1.json",
    localDirectory: ".local/gate2-live-v1",
    candidateContractRevision: 3,
    evidenceRecordRevision: 2,
    instructionPolicySha256: null,
    routingPolicy: LEGACY_V1_ROUTING_POLICY,
    routingPolicySha256: sha256(stableJson(LEGACY_V1_ROUTING_POLICY)),
  }),
  v2: Object.freeze({
    profileFile: "live-profile.v2.json",
    localDirectory: ".local/gate2-live-v2",
    candidateContractRevision: GATE2_LIVE_CANDIDATE_CONTRACT_REVISION,
    evidenceRecordRevision: 4,
    // Pinned by VALUE, not by reference to the live constant. This set was published
    // under instruction-policy revision 8; binding its validation to whatever the
    // policy says today meant a published record stayed valid only while the code was
    // unchanged, which is not a binding at all. ADR 0070's revision 9 is what exposed
    // it: bumping the policy invalidated evidence the policy had never touched.
    instructionPolicySha256: "5b299c7c27cd38d3f070d4c673c0234eaf257761d3cc294e49a1fbbbf023270d",
    routingPolicy: GATE2_LIVE_ROUTING_POLICY,
    routingPolicySha256: GATE2_LIVE_ROUTING_POLICY_SHA256,
  }),
  // ADR 0070's frozen 2026-09-01 set. It shares v2's execution profile, so it cannot be
  // addressed by `profileId`, and it was published by hand with a per-file digest
  // manifest rather than by `publish()` below -- which is why nothing executable read it
  // and a manifest wrong for 30 of 64 files sat under a green 357-assertion gate.
  // Every identity here is pinned BY VALUE. A frozen set is validated against the
  // contract that produced it; validating it against today's constants would make it
  // valid only while the code is unchanged, which is not a binding at all.
  "reasoning-suppressed": Object.freeze({
    profileFile: "live-profile.v2.json",
    localDirectory: ".local/gate2-live-v2",
    artifactDirectory: "gate2-reasoning-suppressed-20260901",
    manifestFile: "manifest.json",
    manifestSchema: "icarus.gate2-frozen-evidence.v2",
    candidateContractRevision: 5,
    evidenceRecordRevision: 5,
    instructionPolicySha256: "e6fb3111f6d2b9fe5d267117f705e1043ac7755fc14cca3ad499693094c6de57",
    routingPolicy: REASONING_SUPPRESSED_ROUTING_POLICY,
    routingPolicySha256: sha256(stableJson(REASONING_SUPPRESSED_ROUTING_POLICY)),
    // What the bytes encode, asserted rather than only written down beside them. This
    // set predates `requestedThink` and mapped an ABSENT provider `thinking` member to
    // 0, so a zero here means "no thinking member surfaced under a think:false request"
    // and never "measured zero". Revision 6 records that absence as null, so a v6 zero
    // is the opposite reading; this is what lets a reader tell the two apart.
    recordContract: Object.freeze({
      requestedThinkMemberPresent: false,
      absentThinkingEncodedAs: 0,
      everyRecordReasoningChars: 0,
      writtenOn: "2026-09-01",
    }),
  }),
});
const DEFAULT_PROFILE_VERSION = "v2";
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

/**
 * A published set is addressed by a repository-relative path, and every check below reads
 * bytes THROUGH that path: the manifest, the 60 records, the results, the secret screen,
 * and the freezer's walk. A link anywhere between the repository root and the directory
 * means all of them describe a tree outside the repository while the path says otherwise,
 * and each one individually passes -- an intact set moved to a sibling and reached through
 * a directory symlink verified as 64 bound files. Resolved here, once, before a byte is
 * read. The repository root itself is resolved first, so a checkout that legitimately
 * lives under a link is not refused; nothing below it may be one.
 */
async function assertCanonicalSetRoot(repositoryRoot, destination) {
  const metadata = await lstat(destination).catch(() => null);
  assertCondition(
    metadata !== null && metadata.isDirectory() && !metadata.isSymbolicLink(),
    "published evidence root must be a directory, not a link",
  );
  const expected = path.join(
    await realpath(repositoryRoot),
    path.relative(repositoryRoot, destination),
  );
  assertCondition(
    (await realpath(destination)) === expected,
    "published evidence root must not resolve through a link",
  );
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

/** The declaration a frozen manifest must carry, rebuilt from the pinned config. */
function frozenRecordContract(config) {
  return {
    evidenceRecordRevision: config.evidenceRecordRevision,
    ...config.recordContract,
  };
}

/**
 * A file present in the directory but absent from the validated list was screened by
 * nothing -- not the digest comparison, not the secret scan. The published sets are
 * closed directories, so enumerate rather than trust the manifest's own file list.
 */
async function assertNoUnlistedFile(directory, relativePaths, config) {
  const expected = new Set([...relativePaths, config.manifestFile ?? "artifact-manifest.json"]);
  const found = [];
  const walk = async (current, prefix) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
      else found.push(relative);
    }
  };
  await walk(directory, "");
  const unlisted = found.filter((relative) => !expected.has(relative)).sort();
  assertCondition(
    unlisted.length === 0,
    `published evidence directory holds unlisted files: ${unlisted.join(", ")}`,
  );
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

function instructionPolicyBound(record, config) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  return config.instructionPolicySha256 === null
    ? !("instructionPolicySha256" in record)
    : record.instructionPolicySha256 === config.instructionPolicySha256;
}

function routingPolicyBound(record, config) {
  return (
    record !== null &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    record.routingPolicySha256 === config.routingPolicySha256
  );
}

/**
 * Checks a frozen set's declared record contract against its own bytes, so the label
 * saying how an absent `thinking` member was encoded is falsifiable rather than prose.
 * Configs without a declared contract are unaffected.
 */
export function recordContractBound(record, config) {
  const contract = config.recordContract;
  if (contract === undefined) return true;
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  if ("requestedThink" in record !== contract.requestedThinkMemberPresent) return false;
  if (typeof record.generatedAt !== "string") return false;
  if (!record.generatedAt.startsWith(`${contract.writtenOn}T`)) return false;
  // `everyRecordReasoningChars` is a claim only when every record in the set reported the
  // same value; the freezer omits the member when they differ, which is the ordinary case
  // for a reasoning-enabled arm. An absent member is NO CLAIM, so nothing is compared
  // against it. Requiring it regardless compared every record against `undefined` and
  // refused the whole set -- precisely the sets the member was omitted from.
  if (!("everyRecordReasoningChars" in contract)) return true;
  return record.reasoningChars === contract.everyRecordReasoningChars;
}

function selectBoundModel(config, mode, benchmarkClass) {
  const policy = config.routingPolicy[mode];
  assertCondition(policy !== undefined, "published evidence mode is invalid");
  return policy.overrides[benchmarkClass] ?? policy.defaultModelId;
}

export function isGate2ProviderOutcomeBound(record, profile, evidenceRecordRevision) {
  if (evidenceRecordRevision < 4) return true;
  const evaluator = record.evaluatorEvidence;
  const usage = record.observation?.usage;
  if (
    evaluator?.providerFailure !== record.providerFailure ||
    evaluator?.usageBasis !== record.usageBasis
  ) {
    return false;
  }
  if (record.finishReason === "timeout") {
    return (
      record.providerFailure === "request_timeout" &&
      record.usageBasis === "declared_budget_upper_bound" &&
      record.rawCandidate === "" &&
      record.candidate === null &&
      usage?.inputTokens === profile.budgets.maxInputTokens &&
      usage?.outputTokens === profile.budgets.maxOutputTokens &&
      usage?.latencyMs === profile.budgets.maxRuntimeSeconds * 1_000
    );
  }
  return record.providerFailure === null && record.usageBasis === "provider_reported";
}

async function validateEvidenceSet(evidenceDirectory, loaded, profile, config) {
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
      routingPolicyBound(preflight, config) &&
      instructionPolicyBound(preflight, config) &&
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
        record.candidateContractRevision === config.candidateContractRevision &&
          record.evidenceRecordRevision === config.evidenceRecordRevision &&
          instructionPolicyBound(record, config) &&
          routingPolicyBound(record, config) &&
          record.manifestSha256 === loaded.manifestSha256 &&
          record.executionProfileDigestSha256 === profile.profileDigestSha256 &&
          record.mode === mode &&
          record.caseId === benchmarkCase.id &&
          record.modelId === selectBoundModel(config, mode, benchmarkCase.class) &&
          instructionPolicyBound(record.evaluatorEvidence, config) &&
          routingPolicyBound(record.evaluatorEvidence, config) &&
          record.evaluatorEvidence.finishReason === record.finishReason &&
          isGate2ProviderOutcomeBound(record, profile, config.evidenceRecordRevision) &&
          record.evaluatorEvidence.providerOutputComplete === providerOutputComplete &&
          record.evaluatorEvidence.scenarioStatus === record.observation.scenarioStatus &&
          (providerOutputComplete || record.observation.scenarioStatus === "failed") &&
          stableJson(record.observation) === stableJson(result.observations[index]) &&
          recordContractBound(record, config) &&
          record.evaluatorEvidence.candidateSha256 === sha256(record.rawCandidate) &&
          record.observation.scenarioEvidenceSha256 ===
            sha256(stableJson(record.evaluatorEvidence)),
        `published case record is not bound: ${relative}`,
      );
    }
  }
  return { relativePaths, files, bytesByPath, baseline, routed, comparison };
}

export async function verifyGate2PublishedEvidence(
  repositoryRoot = root,
  profileVersion = DEFAULT_PROFILE_VERSION,
) {
  const config = LIVE_EVIDENCE_CONFIGS[profileVersion];
  assertCondition(config !== undefined, "published profile version is invalid");
  const loaded = await loadGate2BenchmarkContract(
    path.join(repositoryRoot, "fixtures/evals/gate2/manifest.v2.json"),
    repositoryRoot,
  );
  const profile = parseStrictGate2Json(
    await readFile(path.join(repositoryRoot, "fixtures/evals/gate2", config.profileFile), "utf8"),
  );
  assertCondition(
    computeGate2ExecutionProfileDigest(profile) === profile.profileDigestSha256,
    "published profile digest is invalid",
  );
  const destination = path.join(
    repositoryRoot,
    "docs/evals/artifacts",
    config.artifactDirectory ?? profile.profileId,
  );
  await assertCanonicalSetRoot(repositoryRoot, destination);
  const validated = await validateEvidenceSet(destination, loaded, profile, config);
  if (config.manifestSchema === undefined) {
    await assertNoUnlistedFile(destination, validated.relativePaths, config);
  }
  const manifestFile = config.manifestFile ?? "artifact-manifest.json";
  const manifestBytes = await regularBytes(path.join(destination, manifestFile), manifestFile);
  assertNoUnknownSecretShape(manifestBytes, manifestFile);
  const manifest = parseStrictGate2Json(manifestBytes.toString("utf8"));
  if (config.manifestSchema === undefined) {
    assertCondition(
      manifest.schemaVersion === 1 &&
        manifest.benchmarkManifestSha256 === loaded.manifestSha256 &&
        manifest.executionProfileDigestSha256 === profile.profileDigestSha256 &&
        routingPolicyBound(manifest, config) &&
        instructionPolicyBound(manifest, config) &&
        stableJson(manifest.files) === stableJson(validated.files) &&
        manifest.filesDigestSha256 === sha256(stableJson(validated.files)),
      "published artifact manifest is invalid",
    );
  } else {
    // What this publisher pins BY VALUE, which the freezer cannot know: the schema and
    // record revision this set was published under, the execution profile and instruction
    // policy that produced it, and the record contract as reviewed. The freezer checks a
    // manifest against its own bytes; these check it against the reviewed publication.
    assertCondition(
      manifest.schema === config.manifestSchema &&
        manifest.evidenceRecordRevision === config.evidenceRecordRevision &&
        manifest.executionProfileDigestSha256 === profile.profileDigestSha256 &&
        instructionPolicyBound(manifest, config) &&
        manifest.recordContract?.evidenceRecordRevision === config.evidenceRecordRevision &&
        stableJson(manifest.recordContract) === stableJson(frozenRecordContract(config)),
      "frozen evidence manifest is invalid",
    );
    // One directory-ENUMERATING digest walk, which is not the same as one read pass and
    // was described as if it were. `validateEvidenceSet` above has already read and hashed
    // the 64 contract paths for its own binding and its secret screen; the freezer then
    // re-reads every entry it enumerates. Two passes over the same bytes at two instants:
    // a file replaced between them shows each pass something different, and neither
    // notices, because each is internally consistent. What was removed was the second
    // ENUMERATION of the directory, so the two verifiers can no longer disagree about
    // which files exist. The freezer owns manifest-versus-bytes, the closed-directory
    // refusal, and re-deriving the record contract from the records.
    const problems = await verifyFrozenEvidence(destination);
    assertCondition(
      problems.length === 0,
      `frozen evidence manifest is invalid: ${problems.join("; ")}`,
    );
    // `verifyFrozenEvidence` returned no problem, so the directory holds exactly what
    // `manifest.files` lists and every listed digest matches its bytes. The list is
    // therefore the directory, and reading the present paths from it rather than walking
    // again is the last duplicate walk gone. This proves that list is exactly the
    // benchmark contract's file set, so every present file is one the secret screen above
    // actually read.
    const present = manifest.files.map((entry) => entry.path);
    assertCondition(
      stableJson([...present].sort()) === stableJson([...validated.relativePaths].sort()),
      "frozen evidence directory does not hold exactly the contract's files",
    );
  }
  return { destination, manifest, ...validated };
}

export async function verifyGate2PublishedEvidenceSet(repositoryRoot = root) {
  const v1 = await verifyGate2PublishedEvidence(repositoryRoot, "v1");
  const v2 = await verifyGate2PublishedEvidence(repositoryRoot, "v2");
  const reasoningSuppressed = await verifyGate2PublishedEvidence(
    repositoryRoot,
    "reasoning-suppressed",
  );
  return { v1, v2, reasoningSuppressed };
}

async function publish() {
  assertCondition((await realpath(root)) === root, "repository root must be canonical");
  const config = LIVE_EVIDENCE_CONFIGS[DEFAULT_PROFILE_VERSION];
  const loaded = await loadGate2BenchmarkContract(manifestPath, root);
  const profile = parseStrictGate2Json(
    await readFile(path.join(root, "fixtures/evals/gate2", config.profileFile), "utf8"),
  );
  assertCondition(
    computeGate2ExecutionProfileDigest(profile) === profile.profileDigestSha256,
    "live profile digest is invalid",
  );
  const source = path.join(root, config.localDirectory, profile.profileDigestSha256);
  const destination = path.join(publishedRoot, profile.profileId);
  const existing = await lstat(destination).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    const verified = await verifyGate2PublishedEvidenceSet(root);
    process.stdout.write(
      `${JSON.stringify({ status: "verified-existing", ...verified.v2.manifest })}\n`,
    );
    return;
  }
  const validated = await validateEvidenceSet(source, loaded, profile, config);
  await mkdir(publishedRoot, { recursive: true, mode: 0o755 });
  await mkdir(destination, { recursive: false, mode: 0o755 });
  for (const relative of validated.relativePaths) {
    await exclusiveWrite(safeJoin(destination, relative), validated.bytesByPath.get(relative));
  }
  const artifactManifest = {
    schemaVersion: 1,
    benchmarkManifestSha256: loaded.manifestSha256,
    executionProfileDigestSha256: profile.profileDigestSha256,
    instructionPolicySha256: config.instructionPolicySha256,
    routingPolicySha256: config.routingPolicySha256,
    generatedAt: new Date().toISOString(),
    files: validated.files,
    filesDigestSha256: sha256(stableJson(validated.files)),
  };
  await exclusiveWrite(
    path.join(destination, "artifact-manifest.json"),
    Buffer.from(`${JSON.stringify(artifactManifest, null, 2)}\n`),
  );
  await verifyGate2PublishedEvidenceSet(root);
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
