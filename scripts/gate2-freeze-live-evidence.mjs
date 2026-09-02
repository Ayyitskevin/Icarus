// Freeze a Gate 2 live-evidence directory into docs/evals/artifacts/ with a manifest the
// repository can verify, and verify one that is already frozen.
//
// Why a script: on 2026-09-01 a frozen set's manifest was generated BEFORE `pnpm format`
// reflowed the JSON it had just hashed, so 30 of 64 digests were wrong, the integrity layer
// asserted something untrue, and a 357-assertion security gate stayed green because nothing
// read the directory. The manifest is now computed after formatting settles and excludes
// itself, and `--verify` recomputes every digest from the committed bytes.
//
//   node scripts/gate2-freeze-live-evidence.mjs --from <live-dir> --to <artifact-dir> --commit <sha> --policy-revision <n> --evidence-revision <n>
//   node scripts/gate2-freeze-live-evidence.mjs --verify <artifact-dir>
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GATE2_FROZEN_EVIDENCE_SCHEMA = "icarus.gate2-frozen-evidence.v1";
const MANIFEST = "manifest.json";

function fail(message) {
  throw new Error(`Gate 2 evidence freeze: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listJsonFiles(root) {
  const out = [];
  async function visit(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else if (entry.isFile() && entry.name.endsWith(".json") && relative !== MANIFEST) {
        out.push(relative);
      }
    }
  }
  await visit(root, "");
  return out;
}

/** Digest every JSON file except the manifest, from the bytes on disk right now. */
export async function computeFrozenEntries(root) {
  const entries = [];
  for (const relative of await listJsonFiles(root)) {
    const bytes = await readFile(path.join(root, relative));
    entries.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return entries;
}

/** Returns the mismatched paths; an empty array means the manifest is true of the bytes. */
export async function verifyFrozenEvidence(root) {
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8"));
  if (manifest.schema !== GATE2_FROZEN_EVIDENCE_SCHEMA) fail("manifest schema is not recognised");
  const actual = new Map((await computeFrozenEntries(root)).map((e) => [e.path, e]));
  const problems = [];
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
  const files = await computeFrozenEntries(to);
  const manifest = {
    schema: GATE2_FROZEN_EVIDENCE_SCHEMA,
    capturedAt: new Date().toISOString().slice(0, 10),
    commit,
    instructionPolicyRevision: policyRevision,
    evidenceRecordRevision: evidenceRevision,
    note:
      note ??
      "Frozen so the evaluation's figures recompute from the repository. Digests taken after formatting settled; the manifest excludes itself.",
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
      fail(`${problems.length} manifest entries do not match the bytes on disk`);
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
