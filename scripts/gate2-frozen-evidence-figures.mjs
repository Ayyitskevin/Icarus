// Recompute an evaluation's figures from a frozen Gate 2 evidence directory, so a record
// can cite nothing that is not re-derived from committed bytes.
//
// Why: the 2026-09-01 evaluation's headline figures, its class breakdown and its failure
// buckets were each derived by hand, twice, by different readers. A stale token total
// survived one review because nothing recomputed it, and the bucket counts the diagnosis
// rests on existed only in prose. This prints them, and refuses to print anything until
// the freezer says the directory's manifest is true of its bytes.
//
//   node scripts/gate2-frozen-evidence-figures.mjs --set docs/evals/artifacts/<dir> [--json]
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeNonStrictGate2Json,
  GATE2_MANIFEST_PATHS_BY_SHA256,
  loadGate2BenchmarkContract,
  parseStrictGate2Json,
} from "./gate2-benchmark-contract.mjs";
import { verifyFrozenEvidence } from "./gate2-freeze-live-evidence.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const MODES = Object.freeze(["baseline", "routed"]);
/** The closed vocabulary `describeNonStrictGate2Json` uses. */
const STRICT_JSON_SHAPES = Object.freeze([
  "not_text",
  "empty",
  "markdown_fenced",
  "leading_prose",
  "truncated",
  "other",
]);

function fail(message) {
  throw new Error(`Gate 2 frozen figures: ${message}`);
}

/** The contract's own rounding, so a recomputed figure compares to a recorded one. */
function rounded(value) {
  return Number(value.toFixed(12));
}

/**
 * The strict-JSON shape a record's own error text names, or null when it names none.
 * Never recomputed here: the point of this field is what the run recorded, and a set
 * frozen before the shape vocabulary existed has to read as null rather than as a guess.
 */
function recordedStrictJsonShape(candidateError) {
  if (typeof candidateError !== "string") return null;
  const match = /\((not_text|empty|markdown_fenced|leading_prose|truncated|other)\)/.exec(
    candidateError,
  );
  return match === null ? null : match[1];
}

/**
 * Which of the four outcomes a record describes. Ordered so the buckets are disjoint: a
 * candidate that never parsed cannot also have had its plan judged, and a plan that was
 * rejected means no check ran.
 */
function bucketOf(record) {
  if (record.observation?.scenarioStatus === "passed") return "passed";
  if (record.candidate === null) return "unparseable";
  return record.evaluatorEvidence?.firstPassPlanAccepted === true
    ? "executedAndFailed"
    : "planRejectedBeforeAnyCheck";
}

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((left, right) => right[1] - left[1]));
}

async function registeredManifestPath(setDirectory) {
  const result = parseStrictGate2Json(
    await readFile(path.join(setDirectory, "baseline-result.json"), "utf8"),
  );
  const digest = result?.manifestSha256;
  if (typeof digest !== "string" || !Object.hasOwn(GATE2_MANIFEST_PATHS_BY_SHA256, digest)) {
    fail(`baseline-result.json names an unregistered benchmark manifest digest ${String(digest)}`);
  }
  return GATE2_MANIFEST_PATHS_BY_SHA256[digest];
}

async function readArmRecords(setDirectory, mode, manifestSha256) {
  const directory = path.join(setDirectory, mode);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const records = [];
  for (const name of names) {
    const relative = `${mode}/${name}`;
    const record = parseStrictGate2Json(await readFile(path.join(directory, name), "utf8"));
    const caseId = name.slice(0, -".json".length);
    if (record.caseId !== caseId) fail(`${relative} names case ${String(record.caseId)}`);
    if (record.mode !== mode) fail(`${relative} names mode ${String(record.mode)}`);
    if (record.manifestSha256 !== manifestSha256) {
      fail(`${relative} was measured against a different benchmark manifest`);
    }
    records.push(record);
  }
  return records;
}

function computeArm(mode, records, manifest, result, disagreements) {
  const classOf = new Map(manifest.cases.map((entry) => [entry.id, entry.class]));
  const buckets = {
    passed: 0,
    planRejectedBeforeAnyCheck: 0,
    unparseable: 0,
    executedAndFailed: 0,
  };
  const classSuccesses = Object.fromEntries(
    Object.keys(manifest.thresholds.classCounts).map((name) => [name, 0]),
  );
  const failureShapes = [];
  const unparseableRecorded = [];
  const unparseableDerived = [];
  let firstPlanAccepted = 0;
  let markdownFencedFailures = 0;
  for (const record of records) {
    const benchmarkClass = classOf.get(record.caseId);
    if (benchmarkClass === undefined) fail(`${mode}/${record.caseId} is not a manifest case`);
    const bucket = bucketOf(record);
    buckets[bucket] += 1;
    if (bucket === "passed") classSuccesses[benchmarkClass] += 1;
    if (record.evaluatorEvidence?.firstPassPlanAccepted === true) firstPlanAccepted += 1;
    if (bucket === "passed") continue;
    // Derived from the recorded `rawCandidate`, which is why a fenced answer is countable
    // at all: the run recorded no shape, only the bytes it refused.
    const derived = describeNonStrictGate2Json(record.rawCandidate);
    failureShapes.push(derived);
    if (derived === "markdown_fenced") markdownFencedFailures += 1;
    if (bucket === "unparseable") {
      unparseableRecorded.push(recordedStrictJsonShape(record.candidateError));
      unparseableDerived.push(derived);
    }
  }
  const taskCount = records.length;
  const successes = buckets.passed;
  const firstPlanAcceptance = taskCount === 0 ? null : rounded(firstPlanAccepted / taskCount);
  const aggregates = result.aggregates;
  const check = (label, recomputed, recorded) => {
    if (recomputed !== recorded) {
      disagreements.push(
        `${mode} ${label}: recomputed ${JSON.stringify(recomputed)} but ${mode}-result.json records ${JSON.stringify(recorded)}`,
      );
    }
  };
  check("taskCount", taskCount, aggregates.taskCount);
  check("successes", successes, aggregates.successCount);
  check("firstPassPlanAcceptance", firstPlanAcceptance, aggregates.firstPassPlanAcceptance);
  for (const [name, count] of Object.entries(classSuccesses)) {
    check(`class ${name} successes`, count, aggregates.classSuccessCounts?.[name] ?? null);
  }
  const bucketSum = Object.values(buckets).reduce((total, count) => total + count, 0);
  if (bucketSum !== taskCount) fail(`${mode} buckets sum to ${bucketSum}, not ${taskCount}`);
  return {
    mode,
    modelIds: [...new Set(records.map((record) => record.modelId))].sort(),
    taskCount,
    successes,
    firstPlanAcceptance,
    classes: Object.fromEntries(
      Object.entries(manifest.thresholds.classCounts).map(([name, count]) => [
        name,
        { successes: classSuccesses[name], count },
      ]),
    ),
    buckets,
    failureCount: taskCount - successes,
    markdownFencedFailures,
    failureShapes: tally(failureShapes),
    unparseableShapes: {
      // Absence is null, never 0: this set was frozen before the shape vocabulary existed,
      // so its records name no shape and saying "other" would be inventing one.
      recordedInError: tally(unparseableRecorded.map((shape) => shape ?? "null")),
      derivedFromRawCandidate: tally(unparseableDerived),
    },
    // Recorded, not recomputed: these come from the frozen result the freezer verified.
    recordedRetrieval: {
      macroRecall: aggregates.macroRetrievalRecall ?? null,
      macroPrecision: aggregates.macroRetrievalPrecision ?? null,
      digestProvenanceCoverage: aggregates.digestProvenanceCoverage ?? null,
    },
    recordedIncorrectEdits: aggregates.incorrectEdits ?? null,
    recordedThresholdsPassed: aggregates.thresholdsPassed ?? null,
    recordedAssessment: aggregates.assessment ?? null,
  };
}

export async function computeGate2FrozenEvidenceFigures(setDirectory, options = {}) {
  const repositoryRoot = options.repositoryRoot ?? root;
  const absoluteSet = path.resolve(repositoryRoot, setDirectory);
  // Nothing is read for figures until the manifest is true of the bytes. A figure taken
  // from a directory whose manifest was wrong is what this script exists to prevent.
  const problems = await verifyFrozenEvidence(absoluteSet);
  if (problems.length > 0) {
    fail(`${absoluteSet} did not verify: ${problems.join("; ")}`);
  }
  const frozenManifest = parseStrictGate2Json(
    await readFile(path.join(absoluteSet, "manifest.json"), "utf8"),
  );
  // The set names its benchmark by digest (every record and result file carries it); the
  // digest becomes a path only through the contract's registry, so an unregistered manifest
  // fails here instead of being recomputed against whatever is current.
  const manifestPath = path.resolve(
    repositoryRoot,
    options.manifestPath ?? (await registeredManifestPath(absoluteSet)),
  );
  const loaded = await loadGate2BenchmarkContract(manifestPath, repositoryRoot);
  const disagreements = [];
  const arms = {};
  for (const mode of MODES) {
    const records = await readArmRecords(absoluteSet, mode, loaded.manifestSha256);
    const result = parseStrictGate2Json(
      await readFile(path.join(absoluteSet, `${mode}-result.json`), "utf8"),
    );
    if (result.manifestSha256 !== loaded.manifestSha256) {
      fail(`${mode}-result.json was measured against a different benchmark manifest`);
    }
    if (result.mode !== mode) fail(`${mode}-result.json names mode ${String(result.mode)}`);
    arms[mode] = computeArm(mode, records, loaded.manifest, result, disagreements);
  }
  const comparison = parseStrictGate2Json(
    await readFile(path.join(absoluteSet, "comparison.json"), "utf8"),
  );
  if (comparison.baselineSuccessCount !== arms.baseline.successes) {
    disagreements.push(
      `comparison baselineSuccessCount: recomputed ${arms.baseline.successes} but comparison.json records ${JSON.stringify(comparison.baselineSuccessCount)}`,
    );
  }
  if (comparison.routedSuccessCount !== arms.routed.successes) {
    disagreements.push(
      `comparison routedSuccessCount: recomputed ${arms.routed.successes} but comparison.json records ${JSON.stringify(comparison.routedSuccessCount)}`,
    );
  }
  return {
    set: setDirectory,
    verified: true,
    frozenManifest: {
      schema: frozenManifest.schema ?? null,
      capturedAt: frozenManifest.capturedAt ?? null,
      commit: frozenManifest.commit ?? null,
      evidenceRecordRevision: frozenManifest.evidenceRecordRevision ?? null,
      instructionPolicyRevision: frozenManifest.instructionPolicyRevision ?? null,
      instructionPolicySha256: frozenManifest.instructionPolicySha256 ?? null,
      executionProfileDigestSha256: frozenManifest.executionProfileDigestSha256 ?? null,
      recordContract: frozenManifest.recordContract ?? null,
      fileCount: Array.isArray(frozenManifest.files) ? frozenManifest.files.length : null,
    },
    benchmarkManifest: {
      path: path.relative(repositoryRoot, manifestPath),
      sha256: loaded.manifestSha256,
    },
    thresholds: loaded.manifest.thresholds,
    arms,
    comparison: {
      baselineSuccessCount: comparison.baselineSuccessCount ?? null,
      routedSuccessCount: comparison.routedSuccessCount ?? null,
      successCountRatio: comparison.successCountRatio ?? null,
      costReduction: comparison.costReduction ?? null,
      passed: comparison.passed ?? null,
      assessment: comparison.assessment ?? null,
    },
    agreesWithCommittedResults: disagreements.length === 0,
    disagreements,
  };
}

function show(value) {
  return value === null || value === undefined ? "null" : String(value);
}

function shapeList(counts) {
  const entries = Object.entries(counts);
  return entries.length === 0 ? "none" : entries.map(([k, n]) => `${k} x${n}`).join(", ");
}

function renderMarkdown(figures) {
  const [baseline, routed] = [figures.arms.baseline, figures.arms.routed];
  const lines = [];
  lines.push("# Gate 2 frozen evidence figures", "");
  lines.push(`Set: \`${figures.set}\``);
  lines.push(`Manifest verification: PASS (0 problems from \`verifyFrozenEvidence\`)`);
  lines.push(
    `Frozen manifest: ${show(figures.frozenManifest.schema)} · ${show(figures.frozenManifest.fileCount)} files · captured ${show(figures.frozenManifest.capturedAt)} · commit ${show(figures.frozenManifest.commit)}`,
  );
  lines.push(
    `Evidence record revision ${show(figures.frozenManifest.evidenceRecordRevision)} · instruction policy revision ${show(figures.frozenManifest.instructionPolicyRevision)} (${String(figures.frozenManifest.instructionPolicySha256).slice(0, 12)})`,
  );
  const contract = figures.frozenManifest.recordContract;
  lines.push(
    `Record contract: requestedThink member ${contract === null ? "null" : show(contract.requestedThinkMemberPresent)} · absent thinking encoded as ${contract === null ? "null" : show(contract.absentThinkingEncodedAs)} · written ${contract === null ? "null" : show(contract.writtenOn)}`,
  );
  lines.push(
    `Benchmark manifest: \`${figures.benchmarkManifest.path}\` (${figures.benchmarkManifest.sha256.slice(0, 12)})`,
    "",
  );

  lines.push("## Per arm", "");
  lines.push(
    `| figure | baseline (${baseline.modelIds.join(", ")}) | routed (${routed.modelIds.join(", ")}) |`,
  );
  lines.push("| --- | --- | --- |");
  const row = (label, pick) => lines.push(`| ${label} | ${pick(baseline)} | ${pick(routed)} |`);
  row("successes / tasks", (a) => `${a.successes} / ${a.taskCount}`);
  row("first-plan acceptance", (a) => show(a.firstPlanAcceptance));
  row("passed", (a) => a.buckets.passed);
  row("plan rejected before any check", (a) => a.buckets.planRejectedBeforeAnyCheck);
  row("unparseable", (a) => a.buckets.unparseable);
  row("executed and failed", (a) => a.buckets.executedAndFailed);
  row("failures", (a) => a.failureCount);
  row("markdown-fenced failures", (a) => a.markdownFencedFailures);
  row("incorrect edits (recorded)", (a) => show(a.recordedIncorrectEdits));
  row("thresholds passed (recorded)", (a) => show(a.recordedThresholdsPassed));
  lines.push("");

  lines.push("## Per class", "");
  lines.push("| class | tasks | baseline | routed |");
  lines.push("| --- | --- | --- | --- |");
  for (const name of Object.keys(figures.thresholds.classCounts)) {
    lines.push(
      `| ${name} | ${baseline.classes[name].count} | ${baseline.classes[name].successes} | ${routed.classes[name].successes} |`,
    );
  }
  lines.push("");

  lines.push("## Unparseable candidates", "");
  lines.push(
    "| arm | count | shape named in the recorded error | shape derived from rawCandidate |",
  );
  lines.push("| --- | --- | --- | --- |");
  for (const arm of [baseline, routed]) {
    lines.push(
      `| ${arm.mode} | ${arm.buckets.unparseable} | ${shapeList(arm.unparseableShapes.recordedInError)} | ${shapeList(arm.unparseableShapes.derivedFromRawCandidate)} |`,
    );
  }
  lines.push("");

  lines.push("## Thresholds", "");
  lines.push("| threshold | required | baseline | routed |");
  lines.push("| --- | --- | --- | --- |");
  const t = figures.thresholds;
  lines.push(
    `| successful tasks | >= ${t.minimumSuccessfulTasks} | ${baseline.successes} | ${routed.successes} |`,
  );
  lines.push(
    `| first-plan acceptance | >= ${t.minimumFirstPassPlanAcceptance} | ${show(baseline.firstPlanAcceptance)} | ${show(routed.firstPlanAcceptance)} |`,
  );
  lines.push(
    `| macro retrieval recall | >= ${t.minimumMacroRetrievalRecall} | ${show(baseline.recordedRetrieval.macroRecall)} | ${show(routed.recordedRetrieval.macroRecall)} |`,
  );
  lines.push(
    `| macro retrieval precision | >= ${t.minimumMacroRetrievalPrecision} | ${show(baseline.recordedRetrieval.macroPrecision)} | ${show(routed.recordedRetrieval.macroPrecision)} |`,
  );
  lines.push(
    `| digest provenance coverage | >= ${t.minimumDigestProvenanceCoverage} | ${show(baseline.recordedRetrieval.digestProvenanceCoverage)} | ${show(routed.recordedRetrieval.digestProvenanceCoverage)} |`,
  );
  lines.push(
    `| incorrect edits per success | <= ${t.maximumIncorrectEditsPerSuccess} | ${show(baseline.recordedIncorrectEdits)} | ${show(routed.recordedIncorrectEdits)} |`,
  );
  lines.push(
    `| routed success ratio | >= ${t.minimumRoutedSuccessCountRatio} | ${show(figures.comparison.successCountRatio)} (pair) | |`,
  );
  lines.push(
    `| routed cost reduction | >= ${t.minimumRoutedCostReduction} | ${show(figures.comparison.costReduction)} (pair) | |`,
  );
  lines.push(
    `| **comparison passed** | | **${show(figures.comparison.passed)}** | ${show(figures.comparison.assessment)} |`,
  );
  lines.push("");

  lines.push(
    figures.agreesWithCommittedResults
      ? "Every recomputed figure agrees with the committed result and comparison files."
      : "## Disagreements with the committed results",
  );
  if (!figures.agreesWithCommittedResults) {
    lines.push("");
    for (const problem of figures.disagreements) lines.push(`- ${problem}`);
  }
  lines.push("");
  lines.push(
    "Recomputed from the 60 case records: successes, first-plan acceptance, per-class successes, every bucket, the failure shapes. Read from the frozen result files the manifest covers: retrieval metrics, incorrect edits, cost and the comparison. `null` means the records carry no such value, never zero.",
  );
  return lines.join("\n");
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv) {
  const setDirectory = argument(argv, "--set");
  if (setDirectory === undefined) {
    fail("usage: --set docs/evals/artifacts/<dir> [--manifest <path>] [--json]");
  }
  const figures = await computeGate2FrozenEvidenceFigures(setDirectory, {
    manifestPath: argument(argv, "--manifest"),
  });
  process.stdout.write(
    argv.includes("--json")
      ? `${JSON.stringify(figures, null, 2)}\n`
      : `${renderMarkdown(figures)}\n`,
  );
  if (!figures.agreesWithCommittedResults) process.exitCode = 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath) {
  await main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { renderMarkdown, STRICT_JSON_SHAPES };
