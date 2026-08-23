import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJsonLine } from "../packages/core/dist/canonical-json.js";
import { sha256 } from "../packages/core/dist/digest.js";
import { runLiveEvidenceExecutor } from "../packages/core/dist/live-evidence-executor.js";
import { FileLiveEvidenceJournalStore } from "../packages/core/dist/live-evidence-journal.js";
import {
  decodeLiveEvidenceProfileV1,
  LIVE_EVIDENCE_AUTHORIZED_EFFECTS,
  liveEvidenceProfileApprovalDigest,
} from "../packages/core/dist/live-evidence-profile.js";

const CASE_IDS = ["case-b", "case-a", "case-c"];
const TOKEN_NAME = "ICARUS_GITHUB_TOKEN_GATE1";
const SELF = fileURLToPath(import.meta.url);

function manifestBytes(revision = "v1") {
  return new TextEncoder().encode(
    JSON.stringify({
      benchmarkId: "gate1-live-executor-measurement",
      benchmarkRevision: revision,
      cases: CASE_IDS.map((id) => ({
        id,
        repository: {
          githubOwner: "measurement-owner",
          githubRepository: `measurement-${id}`,
          baseBranch: "main",
        },
        modelAdapter: {
          provider: "ollama",
          model: "measurement-fixture",
          adapterVersion: "measurement-v1",
          transport: "loopback",
          inputUsdPerMillionTokens: 0,
          outputUsdPerMillionTokens: 0,
          expectedRequests: 1,
          paid: false,
          credentials: false,
        },
        budgets: { maxCostUsd: 0 },
      })),
    }),
  );
}

function profile(bytes, profileId = "gate1-live-executor-measurement-v1") {
  const draft = {
    schemaVersion: 1,
    profileId,
    benchmarkId: "gate1-live-executor-measurement",
    benchmarkRevision: JSON.parse(new TextDecoder().decode(bytes)).benchmarkRevision,
    offlineManifestDigest: sha256(bytes),
    provider: {
      kind: "ollama",
      model: "qwen3.8:27b",
      baseUrl: "http://127.0.0.1:11434/",
      adapterVersion: "production-ollama-api-chat-v1",
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
    },
    budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 3_600 },
    authorizedEffects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS],
    cases: CASE_IDS.map((caseId) => ({
      caseId,
      landingProfile: {
        version: 1,
        provider: "github",
        owner: "measurement-owner",
        repository: `measurement-${caseId}`,
        baseBranch: "main",
        branchNamespace: "icarus/",
        credentialRef: { kind: "environment", name: TOKEN_NAME },
        expectedActor: "measurement-owner",
        commitIdentity: { name: "Icarus", email: "icarus@example.invalid" },
        derivativeEffects: {
          version: 1,
          disposition: "inert-repository",
          evidenceSha256: "a".repeat(64),
        },
      },
    })),
  };
  return decodeLiveEvidenceProfileV1({
    ...draft,
    approval: {
      actor: "kevin",
      approvedAt: "2026-08-23T12:00:00.000Z",
      profileDigestSha256: liveEvidenceProfileApprovalDigest(draft),
    },
  });
}

function driverStatePath(root) {
  return path.join(root, "measurement-driver.json");
}

function readDriverState(root) {
  try {
    return JSON.parse(readFileSync(driverStatePath(root), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { stages: {}, calls: [], ambiguous: null, lostStart: false, lostResume: false };
    }
    throw error;
  }
}

function writeDriverState(root, state) {
  writeFileSync(driverStatePath(root), JSON.stringify(state), { mode: 0o600 });
}

function simulatedDriver(root, scenario) {
  const state = readDriverState(root);
  const save = () => writeDriverState(root, state);
  return {
    observe(context) {
      const stage = state.stages[context.caseId] ?? 0;
      const effects = LIVE_EVIDENCE_AUTHORIZED_EFFECTS.slice(0, Math.min(stage, 4));
      if (scenario === "drift") {
        return Promise.resolve({
          caseId: context.caseId,
          durableStage: "case.preflight",
          outcome: "blocked",
          effects: [],
          nextEffects: [],
          spendUsd: 0,
          elapsedSeconds: 0,
          receipt: null,
          errorCode: "LIVE_EVIDENCE_CASE_MISMATCH",
        });
      }
      if (scenario === "preblock" && context.mode === "start") {
        return Promise.resolve({
          caseId: context.caseId,
          durableStage: "remote.preflight",
          outcome: "blocked",
          effects: [],
          nextEffects: [],
          spendUsd: 0,
          elapsedSeconds: 0,
          receipt: null,
          errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
        });
      }
      if (scenario === "incomplete") {
        return Promise.resolve({
          caseId: context.caseId,
          durableStage: "landed",
          outcome: "complete",
          effects: [],
          nextEffects: [],
          spendUsd: 0,
          elapsedSeconds: 0,
          receipt: { caseId: context.caseId },
          errorCode: null,
        });
      }
      if (state.ambiguous === context.caseId) {
        if (context.mode === "start") {
          return Promise.resolve({
            caseId: context.caseId,
            durableStage: "github.reconciliation_required",
            outcome: "blocked",
            effects,
            nextEffects: [],
            spendUsd: 0,
            elapsedSeconds: stage,
            receipt: null,
            errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
          });
        }
        return Promise.resolve({
          caseId: context.caseId,
          durableStage: "github.reconciliation_required",
          outcome: "ready",
          effects,
          nextEffects: [],
          spendUsd: 0,
          elapsedSeconds: stage,
          receipt: null,
          errorCode: null,
        });
      }
      if (stage === 4) {
        return Promise.resolve({
          caseId: context.caseId,
          durableStage: "landed",
          outcome: "complete",
          effects,
          nextEffects: [],
          spendUsd: 0,
          elapsedSeconds: stage,
          receipt: { caseId: context.caseId, pullRequestNumber: context.caseIndex + 1 },
          errorCode: null,
        });
      }
      return Promise.resolve({
        caseId: context.caseId,
        durableStage: `stage-${stage}`,
        outcome: "ready",
        effects,
        nextEffects: [LIVE_EVIDENCE_AUTHORIZED_EFFECTS[stage]],
        spendUsd: 0,
        elapsedSeconds: stage,
        receipt: null,
        errorCode: null,
      });
    },
    advance(context) {
      state.calls.push(context.caseId);
      if (state.ambiguous === context.caseId) {
        state.ambiguous = null;
        save();
        return Promise.resolve();
      }
      const stage = state.stages[context.caseId] ?? 0;
      if (
        scenario === "lost-start" &&
        context.caseId === "case-a" &&
        stage === 1 &&
        !state.lostStart
      ) {
        state.stages[context.caseId] = stage + 1;
        state.ambiguous = context.caseId;
        state.lostStart = true;
        save();
        return Promise.reject(new Error("simulated lost response"));
      }
      if (scenario === "lost-resume" && context.mode === "resume" && !state.lostResume) {
        state.stages[context.caseId] = stage + 1;
        state.ambiguous = context.caseId;
        state.lostResume = true;
        save();
        return Promise.reject(new Error("simulated lost response during resume"));
      }
      state.stages[context.caseId] = stage + 1;
      save();
      return Promise.resolve();
    },
  };
}

async function worker(scenario, root, resumeId) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const bytes = manifestBytes(scenario === "wrong-manifest" ? "v2" : "v1");
  const approved = profile(
    bytes,
    scenario === "wrong-profile"
      ? "gate1-live-executor-measurement-other"
      : "gate1-live-executor-measurement-v1",
  );
  const controller = new AbortController();
  if (scenario === "abort") controller.abort();
  try {
    const terminal = await runLiveEvidenceExecutor({
      mode: resumeId === undefined ? "start" : "resume",
      ...(resumeId === undefined ? {} : { resumeId }),
      profile: approved,
      manifestBytes: bytes,
      environment: scenario === "missing-credential" ? {} : { [TOKEN_NAME]: "usable-token" },
      journalStore: new FileLiveEvidenceJournalStore(root),
      driver: simulatedDriver(root, scenario),
      eventSink: (event) => process.stdout.write(canonicalJsonLine(event)),
      signal: controller.signal,
    });
    process.exitCode =
      terminal.outcome === "succeeded"
        ? 0
        : terminal.outcome === "blocked"
          ? 3
          : terminal.outcome === "interrupted"
            ? 130
            : 1;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : error })}\n`,
    );
    process.exitCode = 1;
  }
}

function terminal(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  return lines
    .map((line) => JSON.parse(line))
    .findLast((entry) => entry.type === "live_evidence_terminal");
}

function orchestrate() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "icarus-gate1-executor-measurement-"));
  const results = [];
  const run = (name, scenario, root, expectedExit, resumeId, verify = () => {}) => {
    const result = spawnSync(
      process.execPath,
      [SELF, "--worker", scenario, root, ...(resumeId === undefined ? [] : [resumeId])],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const exitCode = result.status ?? 128;
    let passed = exitCode === expectedExit;
    let detail = passed ? "exit matched" : `expected ${expectedExit}, received ${exitCode}`;
    try {
      verify(result, terminal(result.stdout));
    } catch (error) {
      passed = false;
      detail = error instanceof Error ? error.message : String(error);
    }
    results.push({ name, passed, exitCode, detail });
    if (!passed) throw new Error(`${name}: ${detail}\n${result.stderr}`);
    return terminal(result.stdout);
  };
  const assertOutcome = (expected) => (_result, value) => {
    if (value?.outcome !== expected) throw new Error(`expected ${expected} terminal receipt`);
  };

  try {
    const successRoot = path.join(scratch, "success");
    const success = run(
      "01 serial success",
      "success",
      successRoot,
      0,
      undefined,
      (result, value) => {
        assertOutcome("succeeded")(result, value);
        const calls = readDriverState(successRoot).calls;
        const expected = CASE_IDS.flatMap((caseId) => Array(4).fill(caseId));
        if (JSON.stringify(calls) !== JSON.stringify(expected))
          throw new Error("cases were not serial");
      },
    );
    run(
      "02 terminal success replay without credentials",
      "missing-credential",
      successRoot,
      0,
      success.resumeId,
      assertOutcome("succeeded"),
    );

    const credentialRoot = path.join(scratch, "credential");
    const credential = run(
      "03 missing credential",
      "missing-credential",
      credentialRoot,
      3,
      undefined,
      assertOutcome("blocked"),
    );
    run(
      "04 missing credential resume",
      "missing-credential",
      credentialRoot,
      3,
      credential.resumeId,
      assertOutcome("blocked"),
    );

    const ambiguousRoot = path.join(scratch, "ambiguous-start");
    const ambiguous = run(
      "05 lost response blocks",
      "lost-start",
      ambiguousRoot,
      3,
      undefined,
      assertOutcome("blocked"),
    );
    run(
      "06 explicit resume reconciles",
      "recover",
      ambiguousRoot,
      0,
      ambiguous.resumeId,
      assertOutcome("succeeded"),
    );
    run(
      "07 reconciled success replays",
      "recover",
      ambiguousRoot,
      0,
      ambiguous.resumeId,
      assertOutcome("succeeded"),
    );

    const resumeRoot = path.join(scratch, "ambiguous-resume");
    const preblocked = run(
      "08 initial remote block",
      "preblock",
      resumeRoot,
      3,
      undefined,
      assertOutcome("blocked"),
    );
    run(
      "09 lost response during resume blocks",
      "lost-resume",
      resumeRoot,
      3,
      preblocked.resumeId,
      assertOutcome("blocked"),
    );
    run(
      "10 later resume reconciles",
      "recover",
      resumeRoot,
      0,
      preblocked.resumeId,
      assertOutcome("succeeded"),
    );

    run(
      "11 remote drift blocks",
      "drift",
      path.join(scratch, "drift"),
      3,
      undefined,
      assertOutcome("blocked"),
    );
    run(
      "12 interruption is exit 130",
      "abort",
      path.join(scratch, "abort"),
      130,
      undefined,
      assertOutcome("interrupted"),
    );
    run("13 incomplete effect ledger fails", "incomplete", path.join(scratch, "incomplete"), 1);
    run("14 changed manifest refuses resume", "wrong-manifest", successRoot, 1, success.resumeId);
    run("15 changed profile refuses resume", "wrong-profile", successRoot, 1, success.resumeId);
    run(
      "16 invalid resume id refuses",
      "success",
      path.join(scratch, "invalid-id"),
      1,
      "not-a-resume-id",
    );

    const symlinkRoot = path.join(scratch, "symlink");
    mkdirSync(path.join(symlinkRoot, "live-evidence"), { recursive: true, mode: 0o700 });
    const symlinkResume = "66666666-6666-4666-8666-666666666666";
    const outside = path.join(scratch, "outside.json");
    writeFileSync(outside, "{}\n", { mode: 0o600 });
    symlinkSync(outside, path.join(symlinkRoot, "live-evidence", `${symlinkResume}.json`));
    run("17 symlink journal refuses", "success", symlinkRoot, 1, symlinkResume);

    const permissionsRoot = path.join(scratch, "permissions");
    const permissions = run(
      "18 secure journal control",
      "success",
      permissionsRoot,
      0,
      undefined,
      assertOutcome("succeeded"),
    );
    chmodSync(path.join(permissionsRoot, "live-evidence", `${permissions.resumeId}.json`), 0o644);
    run("19 shared-readable journal refuses", "success", permissionsRoot, 1, permissions.resumeId);

    const cliRoot = path.join(scratch, "cli");
    mkdirSync(cliRoot, { mode: 0o700 });
    const bytes = readFileSync(path.resolve("fixtures/evals/gate1/manifest.v1.json"));
    const fixtureManifest = JSON.parse(bytes.toString("utf8"));
    const fixtureDraft = {
      schemaVersion: 1,
      profileId: "gate1-live-executor-cli-measurement-v1",
      benchmarkId: fixtureManifest.benchmarkId,
      benchmarkRevision: fixtureManifest.benchmarkRevision,
      offlineManifestDigest: sha256(bytes),
      provider: {
        kind: "ollama",
        model: "qwen3.8:27b",
        baseUrl: "http://127.0.0.1:11434/",
        adapterVersion: "production-ollama-api-chat-v1",
        inputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: null,
      },
      budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 3_600 },
      authorizedEffects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS],
      cases: fixtureManifest.cases.map((entry) => ({
        caseId: entry.id,
        landingProfile: {
          version: 1,
          provider: "github",
          owner: entry.repository.githubOwner,
          repository: entry.repository.githubRepository,
          baseBranch: entry.repository.baseBranch,
          branchNamespace: "icarus/",
          credentialRef: { kind: "environment", name: TOKEN_NAME },
          expectedActor: "measurement-owner",
          commitIdentity: entry.candidate.commitIdentity,
          derivativeEffects: {
            version: 1,
            disposition: "inert-repository",
            evidenceSha256: entry.repository.derivativeEffects.disclosureSha256,
          },
        },
      })),
    };
    const approved = decodeLiveEvidenceProfileV1({
      ...fixtureDraft,
      approval: {
        actor: "kevin",
        approvedAt: "2026-08-23T12:00:00.000Z",
        profileDigestSha256: liveEvidenceProfileApprovalDigest(fixtureDraft),
      },
    });
    const manifestPath = path.join(cliRoot, "manifest.json");
    const profilePath = path.join(cliRoot, "profile.json");
    const runMapPath = path.join(cliRoot, "runs.json");
    writeFileSync(manifestPath, bytes, { mode: 0o600 });
    writeFileSync(profilePath, JSON.stringify(approved), { mode: 0o600 });
    writeFileSync(
      runMapPath,
      JSON.stringify({
        schemaVersion: 1,
        profileId: approved.profileId,
        manifestSha256: sha256(bytes),
        cases: approved.cases.map((entry, index) => ({
          caseId: entry.caseId,
          runId: [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
          ][index],
        })),
      }),
      { mode: 0o600 },
    );
    const cliResult = spawnSync(
      process.execPath,
      [
        path.resolve("packages/cli/dist/main.js"),
        "live-evidence",
        "execute",
        "--input",
        profilePath,
        "--manifest",
        manifestPath,
        "--runs",
        runMapPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          ICARUS_HOME: path.join(cliRoot, "state"),
          [TOKEN_NAME]: "usable-token",
          ICARUS_GITHUB_TOKEN_ALLOWLIST: TOKEN_NAME,
        },
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const cliTerminal = terminal(cliResult.stdout);
    const cliPassed = cliResult.status === 3 && cliTerminal?.outcome === "blocked";
    results.push({
      name: "20 compiled CLI emits blocked NDJSON",
      passed: cliPassed,
      exitCode: cliResult.status ?? 128,
      detail: cliPassed ? "exit and terminal receipt matched" : cliResult.stderr,
    });
    if (!cliPassed) throw new Error(`compiled CLI measurement failed\n${cliResult.stderr}`);

    process.stdout.write(
      `${JSON.stringify({ cases: results.length, passed: results.filter((entry) => entry.passed).length, results }, null, 2)}\n`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--worker") {
  await worker(process.argv[3], process.argv[4], process.argv[5]);
} else {
  orchestrate();
}
