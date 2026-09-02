// Freeze a Gate 2 live-evidence directory into docs/evals/artifacts/ with a manifest the
// repository can verify, and verify one that is already frozen.
//
// Why a script: on 2026-09-01 a frozen set's manifest was generated BEFORE `pnpm format`
// reflowed the JSON it had just hashed, so 30 of 64 digests were wrong, the integrity layer
// asserted something untrue, and a 357-assertion security gate stayed green because nothing
// read the directory. The manifest is now computed after formatting settles and excludes
// itself, and `--verify` recomputes every digest from the committed bytes.
//
// Schema v2 adds `recordContract`: what the case records encode, derived from their bytes at
// freeze time and re-derived on verify, so a manifest cannot claim a record revision, a
// `requestedThink` presence, or a write date that the records contradict.
//
//   node scripts/gate2-freeze-live-evidence.mjs --from <live-dir> --to <artifact-dir> --commit <sha> --policy-revision <n> --evidence-revision <n>
//   node scripts/gate2-freeze-live-evidence.mjs --verify <artifact-dir>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseStrictGate2Json } from "./gate2-benchmark-contract.mjs";

export const GATE2_FROZEN_EVIDENCE_SCHEMA = "icarus.gate2-frozen-evidence.v2";
const MANIFEST = "manifest.json";
const PREFLIGHT = "preflight.json";
// Case records live in these directories; the other files in a set are results and preflight.
const RECORD_DIRECTORIES = ["baseline", "routed"];
// How each evidence record revision writes a provider response that carried no `thinking`
// member. Revision 5 wrote 0, indistinguishable from a measured zero; revision 6 writes null.
// A revision missing here has no known encoding, and the freeze refuses rather than guess.
const ABSENT_THINKING_ENCODING = new Map([
  [5, 0],
  [6, null],
]);

function fail(message) {
  throw new Error(`Gate 2 evidence freeze: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** JSON with object keys sorted, so two contracts compare by content rather than key order. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function distinct(values) {
  const seen = new Map();
  for (const value of values) seen.set(stableJson(value), value);
  return [...seen.values()];
}

// A frozen directory is closed: every entry that is not a directory is listed and digested,
// whatever its name, so a stray file is refused rather than ignored. The publisher's walk
// (scripts/gate2-live-evidence-publish.mjs) enumerates the same universe; a file one accepts
// and the other refuses was the 2026-09-02 review finding this closes. Every listed entry
// must be a regular file: a symlink would let the manifest vouch for bytes outside the
// frozen root, so it is refused rather than followed -- the second finding of that review.
async function listFiles(root) {
  const out = [];
  async function visit(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) fail(`${relative} is not a regular file`);
      // A hard link is a regular file whose bytes also live under another name, possibly
      // outside the set; the publisher refuses it, and so does the freezer.
      if ((await lstat(path.join(directory, entry.name))).nlink > 1) {
        fail(`${relative} is hard-linked`);
      }
      if (relative !== MANIFEST) out.push(relative);
    }
  }
  await visit(root, "");
  return out;
}

/** Digest every file except the manifest, from the bytes on disk right now. */
export async function computeFrozenEntries(root) {
  const entries = [];
  for (const relative of await listFiles(root)) {
    const bytes = await readFile(path.join(root, relative));
    entries.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return entries;
}

async function readRecords(root) {
  const records = [];
  for (const directory of RECORD_DIRECTORIES) {
    const names = await readdir(path.join(root, directory)).catch(() => []);
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const relative = `${directory}/${name}`;
      const record = parseStrictGate2Json(await readFile(path.join(root, relative), "utf8"));
      if (
        !Number.isSafeInteger(record?.evidenceRecordRevision) ||
        typeof record.generatedAt !== "string"
      ) {
        fail(`${relative} is not an evidence record`);
      }
      records.push({ relative, record });
    }
  }
  if (records.length === 0) fail(`no case records under ${RECORD_DIRECTORIES.join("/ or ")}/`);
  return records;
}

/**
 * What the case records encode, derived from their bytes. Every record must agree on the
 * revision, on whether `requestedThink` is a member, and on the UTC date it was written; a
 * set that disagrees is not one run and is refused. `everyRecordReasoningChars` is present
 * only when every record reports the same value, so the member is a claim or it is absent.
 */
export async function deriveRecordContract(root) {
  const records = (await readRecords(root)).map(({ record }) => record);
  const one = (label, values) => {
    const seen = distinct(values);
    if (seen.length !== 1) fail(`records disagree on ${label}: ${seen.map(String).join(", ")}`);
    return seen[0];
  };
  const evidenceRecordRevision = one(
    "evidenceRecordRevision",
    records.map((record) => record.evidenceRecordRevision),
  );
  if (!ABSENT_THINKING_ENCODING.has(evidenceRecordRevision)) {
    fail(
      `no absent-thinking encoding is known for evidence record revision ${evidenceRecordRevision}`,
    );
  }
  const contract = {
    evidenceRecordRevision,
    requestedThinkMemberPresent: one(
      "requestedThink presence",
      records.map((record) => "requestedThink" in record),
    ),
    absentThinkingEncodedAs: ABSENT_THINKING_ENCODING.get(evidenceRecordRevision),
    // Schema v2 carries one date. A run that crossed midnight UTC needs a schema change,
    // not a guess about which day to write down.
    writtenOn: one(
      "the UTC date written",
      records.map((record) => record.generatedAt.slice(0, 10)),
    ),
  };
  const reasoning = distinct(records.map((record) => record.reasoningChars));
  if (reasoning.length === 1) contract.everyRecordReasoningChars = reasoning[0];
  return contract;
}

/** Returns the mismatched paths; an empty array means the manifest is true of the bytes. */
export async function verifyFrozenEvidence(root) {
  // The same strict parser the publisher and the benchmark use: a manifest with a
  // duplicated member is refused here as it is there, never read twice two ways.
  const manifest = parseStrictGate2Json(await readFile(path.join(root, MANIFEST), "utf8"));
  if (manifest.schema !== GATE2_FROZEN_EVIDENCE_SCHEMA) fail("manifest schema is not recognised");
  const problems = [];
  let entries;
  try {
    entries = await computeFrozenEntries(root);
  } catch (error) {
    // An entry the freezer itself refused is a verdict about the directory, not a crash;
    // anything else (an I/O fault, a bug) is rethrown as itself.
    if (!(error instanceof Error) || !error.message.startsWith("Gate 2 evidence freeze:")) {
      throw error;
    }
    problems.push(error.message);
    return problems;
  }
  const actual = new Map(entries.map((e) => [e.path, e]));
  for (const claimed of manifest.files) {
    const found = actual.get(claimed.path);
    if (found === undefined) problems.push(`${claimed.path}: listed but absent`);
    else if (found.sha256 !== claimed.sha256 || found.bytes !== claimed.bytes) {
      problems.push(
        `${claimed.path}: manifest ${claimed.sha256.slice(0, 12)} != bytes ${found.sha256.slice(0, 12)}`,
      );
    }
    actual.delete(claimed.path);
  }
  for (const unlisted of actual.keys()) problems.push(`${unlisted}: present but unlisted`);
  // The contract is re-derived from the records, never read back from the manifest.
  try {
    const derived = await deriveRecordContract(root);
    if (stableJson(manifest.recordContract) !== stableJson(derived)) {
      problems.push(
        `recordContract: manifest ${stableJson(manifest.recordContract)} != bytes ${stableJson(derived)}`,
      );
    }
    if (manifest.evidenceRecordRevision !== derived.evidenceRecordRevision) {
      problems.push(
        `evidenceRecordRevision: manifest ${manifest.evidenceRecordRevision} != bytes ${derived.evidenceRecordRevision}`,
      );
    }
  } catch (error) {
    problems.push(`recordContract: ${error instanceof Error ? error.message : String(error)}`);
  }
  return problems;
}

function formatInPlace(root) {
  // The repository formatter is what reflows these files on the next `pnpm format`; run it
  // now so the digests are taken from the bytes that will actually be committed.
  const result = spawnSync("pnpm", ["exec", "biome", "format", "--write", root], {
    stdio: "pipe",
    shell: false,
  });
  if (result.status !== 0) fail(`formatter failed: ${String(result.stderr)}`);
}

/** A set whose records name a different policy or profile than its preflight is not one run. */
async function assertRecordsBoundToPreflight(root, preflight) {
  for (const { relative, record } of await readRecords(root)) {
    for (const member of ["instructionPolicySha256", "executionProfileDigestSha256"]) {
      if (record[member] !== preflight[member]) {
        fail(
          `${relative} ${member} ${String(record[member]).slice(0, 12)} != preflight ${String(preflight[member]).slice(0, 12)}; this is not one run`,
        );
      }
    }
  }
}

export async function freezeLiveEvidence({
  from,
  to,
  commit,
  policyRevision,
  evidenceRevision,
  note,
}) {
  if ((await stat(from).catch(() => null))?.isDirectory() !== true)
    fail(`${from} is not a directory`);
  if (await stat(to).catch(() => null))
    fail(`${to} already exists; a frozen set is never overwritten`);
  await mkdir(to, { recursive: true });
  await cp(from, to, {
    recursive: true,
    // Prior-record backups are working state, not evidence of this run.
    filter: (source) => !path.basename(source).includes(".evidence-record-"),
  });
  formatInPlace(to);
  const preflightBytes = await readFile(path.join(to, PREFLIGHT), "utf8").catch(() => null);
  if (preflightBytes === null)
    fail(`${PREFLIGHT} is missing; a set without its preflight is not one run`);
  const preflight = parseStrictGate2Json(preflightBytes);
  const { instructionPolicySha256, executionProfileDigestSha256 } = preflight;
  if (
    typeof instructionPolicySha256 !== "string" ||
    typeof executionProfileDigestSha256 !== "string"
  ) {
    fail(`${PREFLIGHT} does not name the instruction policy and execution profile digests`);
  }
  const recordContract = await deriveRecordContract(to);
  if (recordContract.evidenceRecordRevision !== evidenceRevision) {
    fail(
      `--evidence-revision ${evidenceRevision} but the records say ${recordContract.evidenceRecordRevision}`,
    );
  }
  await assertRecordsBoundToPreflight(to, preflight);
  const files = await computeFrozenEntries(to);
  const manifest = {
    schema: GATE2_FROZEN_EVIDENCE_SCHEMA,
    capturedAt: new Date().toISOString().slice(0, 10),
    commit,
    instructionPolicyRevision: policyRevision,
    instructionPolicySha256,
    executionProfileDigestSha256,
    evidenceRecordRevision: evidenceRevision,
    recordContract,
    note:
      note ??
      "Frozen so the evaluation's figures recompute from the repository. Digests taken after formatting settled; the manifest excludes itself. recordContract is derived from the case records and re-derived on verify.",
    files,
  };
  await writeFile(path.join(to, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  formatInPlace(to);
  const problems = await verifyFrozenEvidence(to);
  if (problems.length > 0) fail(`manifest did not survive formatting: ${problems.join("; ")}`);
  return { files: files.length, manifest: path.join(to, MANIFEST) };
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv) {
  const verifyTarget = argument(argv, "--verify");
  if (verifyTarget !== undefined) {
    const problems = await verifyFrozenEvidence(verifyTarget);
    if (problems.length > 0) {
      for (const p of problems) console.error(p);
      fail(`${problems.length} manifest claims do not match the bytes on disk`);
    }
    console.log(`verified: manifest matches every committed file under ${verifyTarget}`);
    return;
  }
  const from = argument(argv, "--from");
  const to = argument(argv, "--to");
  const commit = argument(argv, "--commit");
  const policyRevision = Number(argument(argv, "--policy-revision"));
  const evidenceRevision = Number(argument(argv, "--evidence-revision"));
  if (
    !from ||
    !to ||
    !commit ||
    !Number.isSafeInteger(policyRevision) ||
    !Number.isSafeInteger(evidenceRevision)
  ) {
    fail(
      "usage: --from <live-dir> --to <artifact-dir> --commit <sha> --policy-revision <n> --evidence-revision <n> | --verify <artifact-dir>",
    );
  }
  const result = await freezeLiveEvidence({ from, to, commit, policyRevision, evidenceRevision });
  console.log(`frozen ${result.files} files; manifest at ${result.manifest}`);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main(process.argv.slice(2));
}
