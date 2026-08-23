import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCliMain } from "../../packages/cli/src/main.js";
import { sha256 } from "../../packages/core/src/digest.js";
import { LIVE_EVIDENCE_AUTHORIZED_EFFECTS } from "../../packages/core/src/live-evidence-profile.js";

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
  process.exitCode = undefined;
});

function fixture(): { readonly draftPath: string; readonly manifestPath: string } {
  scratch = mkdtempSync(path.join(os.tmpdir(), "icarus-live-evidence-cli-"));
  const manifestPath = path.resolve("fixtures/evals/gate1/manifest.v1.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    benchmarkId: string;
    benchmarkRevision: string;
    cases: Array<{
      id: string;
      repository: {
        githubOwner: string;
        githubRepository: string;
        baseBranch: string;
        derivativeEffects: { disclosureSha256: string };
      };
    }>;
  };
  const draft = {
    schemaVersion: 1,
    profileId: "gate1-live-cli-v1",
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
  const draftPath = path.join(scratch, "profile.draft.json");
  writeFileSync(draftPath, JSON.stringify(draft), { mode: 0o600 });
  return { draftPath, manifestPath };
}

async function invoke(args: readonly string[]): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: string | number | undefined;
  readonly createRuntime: ReturnType<typeof vi.fn>;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const createRuntime = vi.fn(() => {
    throw new Error("file-only command constructed the runtime");
  });
  process.exitCode = undefined;
  try {
    await runCliMain({
      args,
      platform: "linux",
      createRuntime: createRuntime as never,
      now: () => "2026-08-23T12:00:00.000Z",
    });
    return {
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      exitCode: process.exitCode,
      createRuntime,
    };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe("live-evidence file-only CLI", () => {
  it("authors and verifies the exact manifest-bound approval without constructing runtime state", async () => {
    const { draftPath, manifestPath } = fixture();
    const approval = await invoke([
      "live-evidence",
      "approve",
      "--input",
      draftPath,
      "--manifest",
      manifestPath,
      "--actor",
      "kevin",
    ]);
    expect(approval.stderr).toBe("");
    expect(approval.exitCode).toBeUndefined();
    expect(approval.createRuntime).not.toHaveBeenCalled();
    const approved = JSON.parse(approval.stdout) as Record<string, unknown>;
    const approvedPath = path.join(scratch as string, "profile.approved.json");
    writeFileSync(approvedPath, approval.stdout, { mode: 0o600 });

    const verified = await invoke([
      "live-evidence",
      "verify",
      "--input",
      approvedPath,
      "--manifest",
      manifestPath,
    ]);
    expect(verified.exitCode).toBeUndefined();
    expect(verified.createRuntime).not.toHaveBeenCalled();
    expect(JSON.parse(verified.stdout)).toMatchObject({
      status: "verified",
      profileId: approved.profileId,
      executionAuthority: "none",
    });
  });

  it("rejects options that do not belong to the selected command", async () => {
    const { draftPath } = fixture();
    const result = await invoke([
      "live-evidence",
      "digest",
      "--input",
      draftPath,
      "--actor",
      "kevin",
    ]);
    expect(result.stderr).toMatch(/UNKNOWN_OPTION/);
    expect(result.exitCode).toBe(1);
    expect(result.createRuntime).not.toHaveBeenCalled();
  });

  it("refuses symlink and group-writable profile inputs", async () => {
    const { draftPath } = fixture();
    const linked = path.join(scratch as string, "linked.json");
    symlinkSync(draftPath, linked);
    const symlinkResult = await invoke(["live-evidence", "digest", "--input", linked]);
    expect(symlinkResult.exitCode).toBe(2);
    expect(symlinkResult.stderr).toMatch(/INVALID_LIVE_EVIDENCE_FILE/);

    chmodSync(draftPath, 0o620);
    const writableResult = await invoke(["live-evidence", "digest", "--input", draftPath]);
    expect(writableResult.exitCode).toBe(2);
    expect(writableResult.stderr).toMatch(/group- or world-writable/);
  });
});
