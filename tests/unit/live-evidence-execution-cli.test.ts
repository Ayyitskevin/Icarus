import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCliMain } from "../../packages/cli/src/main.js";
import { sha256 } from "../../packages/core/src/digest.js";
import {
  approveLiveEvidenceProfileV1,
  LIVE_EVIDENCE_AUTHORIZED_EFFECTS,
} from "../../packages/core/src/live-evidence-profile.js";

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("live-evidence execution CLI", () => {
  it("emits NDJSON and stable exit 3 with a durable resume id when a case is blocked", async () => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "icarus-live-execution-cli-"));
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
        candidate: { commitIdentity: { name: string; email: string } };
      }>;
    };
    const draft = {
      schemaVersion: 1 as const,
      profileId: "gate1-live-cli-execution-v1",
      benchmarkId: manifest.benchmarkId,
      benchmarkRevision: manifest.benchmarkRevision,
      offlineManifestDigest: sha256(manifestBytes),
      provider: {
        kind: "ollama" as const,
        model: "qwen3.8:27b",
        baseUrl: "http://127.0.0.1:11434/",
        adapterVersion: "production-ollama-api-chat-v1",
        inputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: null,
      },
      budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 3600 },
      authorizedEffects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS],
      cases: manifest.cases.map((entry) => ({
        caseId: entry.id,
        landingProfile: {
          version: 1 as const,
          provider: "github" as const,
          owner: entry.repository.githubOwner,
          repository: entry.repository.githubRepository,
          baseBranch: entry.repository.baseBranch,
          branchNamespace: "icarus/" as const,
          credentialRef: { kind: "environment" as const, name: "ICARUS_GITHUB_TOKEN_GATE1" },
          expectedActor: "icarus-gate1-benchmark",
          commitIdentity: entry.candidate.commitIdentity,
          derivativeEffects: {
            version: 1 as const,
            disposition: "inert-repository" as const,
            evidenceSha256: entry.repository.derivativeEffects.disclosureSha256,
          },
        },
      })),
    };
    const approved = approveLiveEvidenceProfileV1(
      draft,
      manifestBytes,
      "kevin",
      "2026-08-23T12:00:00.000Z",
    );
    const profilePath = path.join(scratch, "profile.json");
    const runMapPath = path.join(scratch, "run-map.json");
    writeFileSync(profilePath, JSON.stringify(approved), { mode: 0o600 });
    const runIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    writeFileSync(
      runMapPath,
      JSON.stringify({
        schemaVersion: 1,
        profileId: approved.profileId,
        manifestSha256: sha256(manifestBytes),
        cases: approved.cases.map((entry, index) => ({
          caseId: entry.caseId,
          runId: runIds[index],
        })),
      }),
      { mode: 0o600 },
    );

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const prior = {
      home: process.env.ICARUS_HOME,
      token: process.env.ICARUS_GITHUB_TOKEN_GATE1,
      allowlist: process.env.ICARUS_GITHUB_TOKEN_ALLOWLIST,
    };
    process.env.ICARUS_HOME = path.join(scratch, "state");
    process.env.ICARUS_GITHUB_TOKEN_GATE1 = "usable-token";
    process.env.ICARUS_GITHUB_TOKEN_ALLOWLIST = "ICARUS_GITHUB_TOKEN_GATE1";
    try {
      await runCliMain({
        args: [
          "live-evidence",
          "execute",
          "--input",
          profilePath,
          "--manifest",
          manifestPath,
          "--runs",
          runMapPath,
        ],
        platform: "linux",
        createRuntime: vi.fn(async () => ({
          service: {
            getRun: () => {
              throw new Error("simulated missing completed run");
            },
          },
          close: () => undefined,
        })) as never,
      });
    } finally {
      if (prior.home === undefined) delete process.env.ICARUS_HOME;
      else process.env.ICARUS_HOME = prior.home;
      if (prior.token === undefined) delete process.env.ICARUS_GITHUB_TOKEN_GATE1;
      else process.env.ICARUS_GITHUB_TOKEN_GATE1 = prior.token;
      if (prior.allowlist === undefined) delete process.env.ICARUS_GITHUB_TOKEN_ALLOWLIST;
      else process.env.ICARUS_GITHUB_TOKEN_ALLOWLIST = prior.allowlist;
    }

    const events = output
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(process.exitCode).toBe(3);
    expect(events.at(-1)).toMatchObject({
      type: "live_evidence_terminal",
      outcome: "blocked",
      code: "LIVE_EVIDENCE_CASE_UNAVAILABLE",
    });
    expect(events.at(-1)?.resumeId).toMatch(/^[a-f0-9-]{36}$/);
  });
});
