import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { sha256 } from "../packages/core/dist/digest.js";
import { LIVE_EVIDENCE_AUTHORIZED_EFFECTS } from "../packages/core/dist/live-evidence-profile.js";

const root = mkdtempSync(path.join(os.tmpdir(), "icarus-gate1-approval-measurement-"));
const stateRoot = path.join(root, "state");
const cli = path.resolve("packages/cli/dist/main.js");
const manifestPath = path.resolve("fixtures/evals/gate1/manifest.v1.json");
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const results = [];

function writeJson(name, value, mode = 0o600) {
  const target = path.join(root, name);
  writeFileSync(target, JSON.stringify(value), { mode });
  return target;
}

function execute(name, args, expectedExit, verify = () => {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ICARUS_HOME: stateRoot },
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const exitCode = result.status ?? 128;
  let passed = exitCode === expectedExit;
  let detail = passed ? "exit matched" : `expected ${expectedExit}, received ${exitCode}`;
  try {
    verify(result);
  } catch (error) {
    passed = false;
    detail = error instanceof Error ? error.message : String(error);
  }
  if (existsSync(stateRoot)) {
    passed = false;
    detail = "file-only command created runtime state";
  }
  results.push({ name, passed, exitCode, detail });
  if (!passed) throw new Error(`${name}: ${detail}\n${result.stderr}`);
  return result;
}

function assertIncludes(value, expected) {
  if (!value.includes(expected)) throw new Error(`missing ${expected}`);
}

const draft = {
  schemaVersion: 1,
  profileId: "gate1-live-measurement-v1",
  benchmarkId: manifest.benchmarkId,
  benchmarkRevision: manifest.benchmarkRevision,
  offlineManifestDigest: sha256(manifestBytes),
  provider: {
    kind: "ollama",
    model: "qwen3.8:27b",
    baseUrl: "http://127.0.0.1:11434/",
    adapterVersion: "ollama-adapter-v1",
    inputUsdPerMillionTokens: null,
    outputUsdPerMillionTokens: null,
  },
  budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 3600 },
  authorizedEffects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS],
  cases: manifest.cases.map((entry) => ({
    caseId: entry.id,
    landingProfile: {
      version: 1,
      provider: "github",
      owner: entry.repository.githubOwner,
      repository: entry.repository.githubRepository,
      baseBranch: entry.repository.baseBranch,
      branchNamespace: "icarus/",
      credentialRef: { kind: "environment", name: "ICARUS_GITHUB_TOKEN_GATE1" },
      expectedActor: "icarus-gate1-benchmark",
      commitIdentity: { name: "Icarus Gate 1", email: "gate1@example.invalid" },
      derivativeEffects: {
        version: 1,
        disposition: "inert-repository",
        evidenceSha256: entry.repository.derivativeEffects.disclosureSha256,
      },
    },
  })),
};

try {
  const draftPath = writeJson("draft.json", draft);
  execute("01 valid digest", ["live-evidence", "digest", "--input", draftPath], 0, (r) =>
    assertIncludes(r.stdout, "profileDigestSha256"),
  );
  const approval = execute(
    "02 valid approval against collaborative manifest",
    [
      "live-evidence",
      "approve",
      "--input",
      draftPath,
      "--manifest",
      manifestPath,
      "--actor",
      "kevin",
    ],
    0,
  );
  const approved = JSON.parse(approval.stdout);
  const approvedPath = writeJson("approved.json", approved);
  execute(
    "03 inspect approved profile",
    ["live-evidence", "inspect", "--input", approvedPath, "--manifest", manifestPath],
    0,
    (r) => assertIncludes(r.stdout, '"executionAuthority":"none"'),
  );
  execute(
    "04 verify approved profile",
    ["live-evidence", "verify", "--input", approvedPath, "--manifest", manifestPath],
    0,
    (r) => assertIncludes(r.stdout, '"status":"verified"'),
  );
  execute(
    "05 draft refuses approval field",
    ["live-evidence", "digest", "--input", approvedPath],
    2,
    (r) => assertIncludes(r.stderr, "missing or unknown keys"),
  );

  const changedManifest = {
    ...manifest,
    benchmarkRevision: `${manifest.benchmarkRevision}-changed`,
  };
  const changedManifestPath = writeJson("changed-manifest.json", changedManifest);
  execute(
    "06 approval refuses changed manifest",
    [
      "live-evidence",
      "approve",
      "--input",
      draftPath,
      "--manifest",
      changedManifestPath,
      "--actor",
      "kevin",
    ],
    2,
    (r) => assertIncludes(r.stderr, "does not match"),
  );
  execute(
    "07 approval refuses added effect",
    [
      "live-evidence",
      "approve",
      "--input",
      writeJson("extra-effect.json", {
        ...draft,
        authorizedEffects: [...draft.authorizedEffects, "github.ref.force_update"],
      }),
      "--manifest",
      manifestPath,
      "--actor",
      "kevin",
    ],
    2,
    (r) => assertIncludes(r.stderr, "authorizedEffects"),
  );

  const swappedCases = draft.cases.map((entry, index) =>
    index === 0
      ? { ...entry, landingProfile: { ...entry.landingProfile, repository: "production" } }
      : entry,
  );
  execute(
    "08 approval refuses repository swap",
    [
      "live-evidence",
      "approve",
      "--input",
      writeJson("swapped-repo.json", { ...draft, cases: swappedCases }),
      "--manifest",
      manifestPath,
      "--actor",
      "kevin",
    ],
    2,
    (r) => assertIncludes(r.stderr, "targets"),
  );
  execute(
    "09 approval refuses blank actor",
    [
      "live-evidence",
      "approve",
      "--input",
      draftPath,
      "--manifest",
      manifestPath,
      "--actor",
      "   ",
    ],
    2,
    (r) => assertIncludes(r.stderr, "actor"),
  );
  execute(
    "10 verify refuses post-approval budget tamper",
    [
      "live-evidence",
      "verify",
      "--input",
      writeJson("tampered-budget.json", {
        ...approved,
        budgets: { ...approved.budgets, maxRuntimeSeconds: 7200 },
      }),
      "--manifest",
      manifestPath,
    ],
    2,
    (r) => assertIncludes(r.stderr, "does not apply"),
  );
  execute(
    "11 verify refuses unapproved draft",
    ["live-evidence", "verify", "--input", draftPath, "--manifest", manifestPath],
    2,
    (r) => assertIncludes(r.stderr, "missing or unknown keys"),
  );

  const linkedPath = path.join(root, "linked.json");
  symlinkSync(draftPath, linkedPath);
  execute("12 digest refuses symlink", ["live-evidence", "digest", "--input", linkedPath], 2, (r) =>
    assertIncludes(r.stderr, "Cannot safely open"),
  );
  const writablePath = writeJson("shared-writable.json", draft, 0o620);
  chmodSync(writablePath, 0o620);
  execute(
    "13 digest refuses group-writable authority",
    ["live-evidence", "digest", "--input", writablePath],
    2,
    (r) => assertIncludes(r.stderr, "group- or world-writable"),
  );
  execute(
    "14 approval refuses missing manifest",
    [
      "live-evidence",
      "approve",
      "--input",
      draftPath,
      "--manifest",
      path.join(root, "missing.json"),
      "--actor",
      "kevin",
    ],
    2,
    (r) => assertIncludes(r.stderr, "Cannot safely open"),
  );
  execute(
    "15 inspect refuses irrelevant actor option",
    [
      "live-evidence",
      "inspect",
      "--input",
      approvedPath,
      "--manifest",
      manifestPath,
      "--actor",
      "kevin",
    ],
    1,
    (r) => assertIncludes(r.stderr, "UNKNOWN_OPTION"),
  );
  execute(
    "16 verify refuses changed manifest",
    ["live-evidence", "verify", "--input", approvedPath, "--manifest", changedManifestPath],
    2,
    (r) => assertIncludes(r.stderr, "does not match"),
  );
  const oversizedPath = path.join(root, "oversized.json");
  writeFileSync(oversizedPath, " ".repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
  execute(
    "17 digest refuses oversized input",
    ["live-evidence", "digest", "--input", oversizedPath],
    2,
    (r) => assertIncludes(r.stderr, "file-size ceiling"),
  );
  execute(
    "18 digest refuses unrelated manifest option",
    ["live-evidence", "digest", "--input", draftPath, "--manifest", manifestPath],
    1,
    (r) => assertIncludes(r.stderr, "UNKNOWN_OPTION"),
  );

  process.stdout.write(
    `${JSON.stringify({ cases: results.length, passed: results.filter((entry) => entry.passed).length, results }, null, 2)}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
