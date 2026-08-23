import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import {
  assertLiveEvidenceProfileMatchesManifest,
  decodeLiveEvidenceProfileDraftV1,
} from "../../packages/core/src/live-evidence-profile.js";

const ROOT = resolve(import.meta.dirname, "../..");
const HELPER = join(ROOT, "scripts/gate1-live-3of3-artifacts.mjs");
const SOURCE_MANIFEST = join(ROOT, "fixtures/evals/gate1/manifest.v1.json");
const OWNER = "Ayyitskevin";
const REPOSITORIES = {
  "typescript-library": "icarus-gate1-typescript-library",
  "python-cli": "icarus-gate1-python-cli",
  "react-node": "icarus-gate1-react-node",
} as const;

function secureTemp(): string {
  const path = mkdtempSync(join(tmpdir(), "icarus-gate1-live-artifacts-"));
  chmodSync(path, 0o700);
  return path;
}

function run(args: readonly string[], success = true) {
  const result = spawnSync(process.execPath, [HELPER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (success && result.status !== 0) {
    throw new Error(`helper failed: ${result.stderr}`);
  }
  return result;
}

function generateManifest(directory: string): string {
  const output = join(directory, "manifest.json");
  run([
    "manifest",
    "--source",
    SOURCE_MANIFEST,
    "--output",
    output,
    "--owner",
    OWNER,
    ...Object.entries(REPOSITORIES).flatMap(([stack, repository]) => [
      "--repo",
      `${stack}=${repository}`,
    ]),
  ]);
  return output;
}

function generateAssessments(directory: string, manifestPath: string): Map<string, string> {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const paths = new Map<string, string>();
  for (const benchmarkCase of manifest.cases) {
    const output = join(directory, `${benchmarkCase.id}.assessment.json`);
    run([
      "assessment",
      "--manifest",
      manifestPath,
      "--case",
      benchmarkCase.id,
      "--output",
      output,
      "--owner",
      benchmarkCase.repository.githubOwner,
      "--repository",
      benchmarkCase.repository.githubRepository,
      "--assessed-at",
      "2026-08-23T12:00:00.000Z",
      "--private",
      "true",
      "--actions-enabled",
      "false",
      "--workflow-files",
      "0",
      "--webhooks",
      "0",
      "--actions-secrets",
      "0",
      "--environments",
      "0",
      "--deployments",
      "0",
      "--remote-main-sha1",
      benchmarkCase.repository.sourceRevision.commitSha1,
    ]);
    paths.set(benchmarkCase.id, output);
  }
  return paths;
}

describe("Gate 1 live 3/3 artifact helper", () => {
  it("rewrites only the three reviewed repository identities", () => {
    const directory = secureTemp();
    const output = generateManifest(directory);
    const source = JSON.parse(readFileSync(SOURCE_MANIFEST, "utf8"));
    const live = JSON.parse(readFileSync(output, "utf8"));

    for (const [index, benchmarkCase] of live.cases.entries()) {
      const stack = benchmarkCase.stack as keyof typeof REPOSITORIES;
      expect(benchmarkCase.repository.githubOwner).toBe(OWNER.toLowerCase());
      expect(benchmarkCase.repository.githubRepository).toBe(REPOSITORIES[stack]);
      expect(benchmarkCase.draftPullRequestEvidence.owner).toBe(OWNER.toLowerCase());
      expect(benchmarkCase.draftPullRequestEvidence.repository).toBe(REPOSITORIES[stack]);
      for (const value of [source.cases[index], benchmarkCase]) {
        delete value.repository.githubOwner;
        delete value.repository.githubRepository;
        delete value.draftPullRequestEvidence.owner;
        delete value.draftPullRequestEvidence.repository;
      }
    }
    expect(live).toEqual(source);
  });

  it("refuses to call a repository inert when Actions or another derivative surface is active", () => {
    const directory = secureTemp();
    const manifestPath = generateManifest(directory);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const benchmarkCase = manifest.cases[0];
    const base = [
      "assessment",
      "--manifest",
      manifestPath,
      "--case",
      benchmarkCase.id,
      "--output",
      join(directory, "assessment.json"),
      "--owner",
      benchmarkCase.repository.githubOwner,
      "--repository",
      benchmarkCase.repository.githubRepository,
      "--assessed-at",
      "2026-08-23T12:00:00.000Z",
      "--private",
      "true",
      "--workflow-files",
      "0",
      "--webhooks",
      "0",
      "--actions-secrets",
      "0",
      "--environments",
      "0",
      "--deployments",
      "0",
      "--remote-main-sha1",
      benchmarkCase.repository.sourceRevision.commitSha1,
    ];

    const actions = run([...base, "--actions-enabled", "true"], false);
    expect(actions.status).toBe(1);
    expect(actions.stderr).toContain("GitHub Actions must be disabled");

    const webhooks = run(
      base
        .flatMap((entry, index) =>
          entry === "0" && base[index - 1] === "--webhooks" ? ["1"] : [entry],
        )
        .concat(["--actions-enabled", "false"]),
      false,
    );
    expect(webhooks.status).toBe(1);
    expect(webhooks.stderr).toContain("webhooks must be zero");
  });

  it("binds raw inert assessments, the current adapter, and exact candidate identities", () => {
    const directory = secureTemp();
    const manifestPath = generateManifest(directory);
    const assessments = generateAssessments(directory, manifestPath);
    const output = join(directory, "profile-draft.json");
    run([
      "profile",
      "--manifest",
      manifestPath,
      "--output",
      output,
      "--profile-id",
      "gate1-live-3of3-20260823-v1",
      "--actor",
      OWNER,
      "--model",
      "qwen3.8:27b",
      "--base-url",
      "http://127.0.0.1:11434/",
      ...[...assessments].flatMap(([caseId, path]) => ["--assessment", `${caseId}=${path}`]),
    ]);

    const profile = decodeLiveEvidenceProfileDraftV1(JSON.parse(readFileSync(output, "utf8")));
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    expect(profile.provider.adapterVersion).toBe("production-ollama-api-chat-v1");
    expect(profile.provider.inputUsdPerMillionTokens).toBe(0);
    expect(profile.provider.outputUsdPerMillionTokens).toBe(0);
    expect(profile.budgets.maxSpendUsd).toBe(0);
    expect(profile.offlineManifestDigest).toBe(sha256(manifestBytes));
    for (const [index, entry] of profile.cases.entries()) {
      expect(entry.landingProfile.commitIdentity).toEqual(
        manifest.cases[index].candidate.commitIdentity,
      );
      const assessmentPath = assessments.get(entry.caseId);
      expect(assessmentPath).toBeDefined();
      if (assessmentPath === undefined) throw new Error(`missing assessment for ${entry.caseId}`);
      expect(entry.landingProfile.derivativeEffects.evidenceSha256).toBe(
        sha256(readFileSync(assessmentPath)),
      );
    }
    expect(() => assertLiveEvidenceProfileMatchesManifest(profile, manifestBytes)).not.toThrow();
  });

  it("writes a strict manifest-ordered run map and refuses duplicate runs", () => {
    const directory = secureTemp();
    const manifestPath = generateManifest(directory);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const profilePath = join(directory, "approved.json");
    writeFileSync(
      profilePath,
      `${JSON.stringify({ profileId: "gate1-live-3of3-20260823-v1", approval: {} })}\n`,
      { mode: 0o600 },
    );
    const runIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    const output = join(directory, "runs.json");
    run([
      "run-map",
      "--manifest",
      manifestPath,
      "--profile",
      profilePath,
      "--output",
      output,
      ...manifest.cases.flatMap((entry: { id: string }, index: number) => [
        "--run",
        `${entry.id}=${runIds[index]}`,
      ]),
    ]);
    const runMap = JSON.parse(readFileSync(output, "utf8"));
    expect(runMap.cases.map((entry: { caseId: string }) => entry.caseId)).toEqual(
      manifest.cases.map((entry: { id: string }) => entry.id),
    );
    expect(runMap.manifestSha256).toBe(sha256(readFileSync(manifestPath)));

    const duplicate = run(
      [
        "run-map",
        "--manifest",
        manifestPath,
        "--profile",
        profilePath,
        "--output",
        join(directory, "duplicate.json"),
        ...manifest.cases.flatMap((entry: { id: string }) => ["--run", `${entry.id}=${runIds[0]}`]),
      ],
      false,
    );
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("Run IDs must be distinct");
  });

  it("reuses only byte-identical output and refuses symlink targets", () => {
    const directory = secureTemp();
    const output = generateManifest(directory);
    expect(() => generateManifest(directory)).not.toThrow();

    const changed = run(
      [
        "manifest",
        "--source",
        SOURCE_MANIFEST,
        "--output",
        output,
        "--owner",
        "DifferentOwner",
        ...Object.entries(REPOSITORIES).flatMap(([stack, repository]) => [
          "--repo",
          `${stack}=${repository}`,
        ]),
      ],
      false,
    );
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("already exists with different bytes");

    const target = join(directory, "target.json");
    writeFileSync(target, "safe\n", { mode: 0o600 });
    const symlink = join(directory, "symlink.json");
    symlinkSync(target, symlink);
    const linked = run(
      [
        "manifest",
        "--source",
        SOURCE_MANIFEST,
        "--output",
        symlink,
        "--owner",
        OWNER,
        ...Object.entries(REPOSITORIES).flatMap(([stack, repository]) => [
          "--repo",
          `${stack}=${repository}`,
        ]),
      ],
      false,
    );
    expect(linked.status).toBe(1);
    expect(linked.stderr).toContain("regular non-symlink file");
  });
});
