import { describe, expect, it } from "vitest";

import { sha256 } from "../../packages/core/src/digest.js";
import {
  type LiveEvidenceCaseDriver,
  type LiveEvidenceExecutionJournalV1,
  type LiveEvidenceJournalStore,
  runLiveEvidenceExecutor,
} from "../../packages/core/src/live-evidence-executor.js";
import {
  decodeLiveEvidenceProfileV1,
  LIVE_EVIDENCE_AUTHORIZED_EFFECTS,
  liveEvidenceProfileApprovalDigest,
} from "../../packages/core/src/live-evidence-profile.js";

const CASE_IDS = ["case-b", "case-a", "case-c"] as const;

function manifestBytes(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      benchmarkId: "gate1-live-executor",
      benchmarkRevision: "v1",
      cases: CASE_IDS.map((id) => ({
        id,
        repository: {
          githubOwner: "owner",
          githubRepository: `repo-${id}`,
          baseBranch: "main",
        },
        modelAdapter: {
          provider: "ollama",
          model: "fixture",
          adapterVersion: "fixture-v1",
          transport: "loopback",
          inputUsdPerMillionTokens: 0,
          outputUsdPerMillionTokens: 0,
          expectedRequests: 2,
          paid: false,
          credentials: false,
        },
        budgets: { maxCostUsd: 0 },
      })),
    }),
  );
}

function approvedProfile(bytes: Uint8Array) {
  const draft = {
    schemaVersion: 1 as const,
    profileId: "gate1-live-executor-v1",
    benchmarkId: "gate1-live-executor",
    benchmarkRevision: "v1",
    offlineManifestDigest: sha256(bytes),
    provider: {
      kind: "ollama" as const,
      model: "qwen3.8:27b",
      baseUrl: "http://127.0.0.1:11434/",
      adapterVersion: "ollama-adapter-v1",
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
    },
    budgets: { maxSpendUsd: 0, maxRuntimeSeconds: 3600 },
    authorizedEffects: [...LIVE_EVIDENCE_AUTHORIZED_EFFECTS],
    cases: CASE_IDS.map((caseId) => ({
      caseId,
      landingProfile: {
        version: 1 as const,
        provider: "github" as const,
        owner: "owner",
        repository: `repo-${caseId}`,
        baseBranch: "main",
        branchNamespace: "icarus/" as const,
        credentialRef: { kind: "environment" as const, name: "ICARUS_GITHUB_TOKEN_GATE1" },
        expectedActor: "owner",
        commitIdentity: { name: "Icarus", email: "icarus@example.invalid" },
        derivativeEffects: {
          version: 1 as const,
          disposition: "inert-repository" as const,
          evidenceSha256: "b".repeat(64),
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

class MemoryJournalStore implements LiveEvidenceJournalStore {
  journal: LiveEvidenceExecutionJournalV1 | null = null;

  load(resumeId: string): LiveEvidenceExecutionJournalV1 | null {
    return this.journal?.resumeId === resumeId ? structuredClone(this.journal) : null;
  }

  create(journal: LiveEvidenceExecutionJournalV1): void {
    if (this.journal !== null) throw new Error("duplicate journal");
    this.journal = structuredClone(journal);
  }

  save(journal: LiveEvidenceExecutionJournalV1): void {
    this.journal = structuredClone(journal);
  }
}

class SimulatedGatewayDriver implements LiveEvidenceCaseDriver {
  readonly stages = new Map<string, number>();
  readonly calls: string[] = [];
  ambiguousCase: string | null = null;

  observe({ caseId }: { readonly caseId: string }) {
    const stage = this.stages.get(caseId) ?? 0;
    const effects = LIVE_EVIDENCE_AUTHORIZED_EFFECTS.slice(0, Math.min(stage, 4));
    if (this.ambiguousCase === caseId) {
      return Promise.resolve({
        caseId,
        durableStage: "github.ref.reconciliation_required",
        outcome: "blocked" as const,
        effects,
        nextEffects: [],
        spendUsd: 0,
        elapsedSeconds: stage,
        receipt: null,
        errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
      });
    }
    if (stage === 4) {
      return Promise.resolve({
        caseId,
        durableStage: "landed",
        outcome: "complete" as const,
        effects,
        nextEffects: [],
        spendUsd: 0,
        elapsedSeconds: stage,
        receipt: { caseId, pullRequestNumber: stage },
        errorCode: null,
      });
    }
    const nextEffect = LIVE_EVIDENCE_AUTHORIZED_EFFECTS[stage];
    if (nextEffect === undefined) throw new Error("simulated stage has no next effect");
    return Promise.resolve({
      caseId,
      durableStage: `stage-${stage}`,
      outcome: "ready" as const,
      effects,
      nextEffects: [nextEffect],
      spendUsd: 0,
      elapsedSeconds: stage,
      receipt: null,
      errorCode: null,
    });
  }

  advance({ caseId }: { readonly caseId: string }): Promise<void> {
    this.calls.push(caseId);
    const stage = this.stages.get(caseId) ?? 0;
    if (caseId === "case-a" && stage === 1 && this.ambiguousCase === null) {
      this.stages.set(caseId, stage + 1);
      this.ambiguousCase = caseId;
      return Promise.reject(new Error("simulated lost response after durable admission"));
    }
    this.stages.set(caseId, stage + 1);
    return Promise.resolve();
  }
}

describe("live-evidence headless executor", () => {
  it("durably blocks before driver observation when credentials are unavailable", async () => {
    const bytes = manifestBytes();
    const store = new MemoryJournalStore();
    const driver = new SimulatedGatewayDriver();
    const result = await runLiveEvidenceExecutor({
      mode: "start",
      profile: approvedProfile(bytes),
      manifestBytes: bytes,
      environment: {},
      journalStore: store,
      driver,
      eventSink: () => undefined,
      createResumeId: () => "33333333-3333-4333-8333-333333333333",
      now: () => "2026-08-23T12:00:00.000Z",
    });

    expect(result).toMatchObject({
      outcome: "blocked",
      stage: "authority.preflight",
      code: "LIVE_EVIDENCE_REFUSED",
    });
    expect(driver.calls).toEqual([]);
    expect(store.journal?.terminalReceipt).toEqual(result);
  });

  it("runs cases serially in manifest order and ends with one authoritative receipt", async () => {
    const bytes = manifestBytes();
    const store = new MemoryJournalStore();
    const driver = new SimulatedGatewayDriver();
    driver.ambiguousCase = "never";
    const events: unknown[] = [];

    const result = await runLiveEvidenceExecutor({
      mode: "start",
      profile: approvedProfile(bytes),
      manifestBytes: bytes,
      environment: { ICARUS_GITHUB_TOKEN_GATE1: "usable-token" },
      journalStore: store,
      driver,
      eventSink: (event) => events.push(event),
      createResumeId: () => "11111111-1111-4111-8111-111111111111",
      now: () => "2026-08-23T12:00:00.000Z",
    });

    expect(result.outcome).toBe("succeeded");
    expect(driver.calls).toEqual([
      "case-b",
      "case-b",
      "case-b",
      "case-b",
      "case-a",
      "case-a",
      "case-a",
      "case-a",
      "case-c",
      "case-c",
      "case-c",
      "case-c",
    ]);
    expect(events.at(-1)).toEqual(result);
    expect(store.journal?.terminalReceipt).toEqual(result);
  });

  it("persists ambiguity as blocked, then resumes without repeating the admitted effect", async () => {
    const bytes = manifestBytes();
    const store = new MemoryJournalStore();
    const driver = new SimulatedGatewayDriver();
    const start = await runLiveEvidenceExecutor({
      mode: "start",
      profile: approvedProfile(bytes),
      manifestBytes: bytes,
      environment: { ICARUS_GITHUB_TOKEN_GATE1: "usable-token" },
      journalStore: store,
      driver,
      eventSink: () => undefined,
      createResumeId: () => "22222222-2222-4222-8222-222222222222",
      now: () => "2026-08-23T12:00:00.000Z",
    });
    expect(start).toMatchObject({
      outcome: "blocked",
      caseId: "case-a",
      code: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    const callsBeforeResume = driver.calls.length;
    driver.ambiguousCase = null;

    const resumed = await runLiveEvidenceExecutor({
      mode: "resume",
      resumeId: start.resumeId,
      profile: approvedProfile(bytes),
      manifestBytes: bytes,
      environment: { ICARUS_GITHUB_TOKEN_GATE1: "usable-token" },
      journalStore: store,
      driver,
      eventSink: () => undefined,
      createResumeId: () => "unused",
      now: () => "2026-08-23T12:01:00.000Z",
    });

    expect(resumed.outcome).toBe("succeeded");
    expect(driver.calls.slice(callsBeforeResume).filter((id) => id === "case-a")).toHaveLength(2);
  });

  it("blocks ambiguity created during resume until another explicit resume", async () => {
    const bytes = manifestBytes();
    const store = new MemoryJournalStore();
    let admitted = false;
    const driver: LiveEvidenceCaseDriver = {
      observe(context) {
        if (context.mode === "start") {
          return Promise.resolve({
            caseId: context.caseId,
            durableStage: "github.reconciliation_required",
            outcome: "blocked",
            effects: admitted ? (["github.objects.upload"] as const) : [],
            nextEffects: [],
            spendUsd: 0,
            elapsedSeconds: 0,
            receipt: null,
            errorCode: "GITHUB_OUTCOME_AMBIGUOUS",
          });
        }
        return Promise.resolve({
          caseId: context.caseId,
          durableStage: admitted ? "github.reconciliation_required" : "landing.ready",
          outcome: "ready",
          effects: admitted ? (["github.objects.upload"] as const) : [],
          nextEffects: admitted ? [] : (["github.objects.upload"] as const),
          spendUsd: 0,
          elapsedSeconds: 0,
          receipt: null,
          errorCode: null,
        });
      },
      advance() {
        admitted = true;
        return Promise.reject(new Error("simulated lost response during resume"));
      },
    };

    const start = await runLiveEvidenceExecutor({
      mode: "start",
      profile: approvedProfile(bytes),
      manifestBytes: bytes,
      environment: { ICARUS_GITHUB_TOKEN_GATE1: "usable-token" },
      journalStore: store,
      driver,
      eventSink: () => undefined,
      createResumeId: () => "55555555-5555-4555-8555-555555555555",
      now: () => "2026-08-23T12:00:00.000Z",
    });
    expect(start.outcome).toBe("blocked");

    const resumed = await runLiveEvidenceExecutor({
      mode: "resume",
      resumeId: start.resumeId,
      profile: approvedProfile(bytes),
      manifestBytes: bytes,
      environment: { ICARUS_GITHUB_TOKEN_GATE1: "usable-token" },
      journalStore: store,
      driver,
      eventSink: () => undefined,
      now: () => "2026-08-23T12:01:00.000Z",
    });

    expect(resumed).toMatchObject({
      outcome: "blocked",
      code: "GITHUB_OUTCOME_AMBIGUOUS",
    });
    expect(store.journal?.terminalReceipt).toEqual(resumed);
  });

  it("replays persisted success without credentials but refuses an incomplete ledger", async () => {
    const bytes = manifestBytes();
    const store = new MemoryJournalStore();
    const driver = new SimulatedGatewayDriver();
    driver.ambiguousCase = "never";
    const profile = approvedProfile(bytes);

    const succeeded = await runLiveEvidenceExecutor({
      mode: "start",
      profile,
      manifestBytes: bytes,
      environment: { ICARUS_GITHUB_TOKEN_GATE1: "usable-token" },
      journalStore: store,
      driver,
      eventSink: () => undefined,
      createResumeId: () => "44444444-4444-4444-8444-444444444444",
      now: () => "2026-08-23T12:00:00.000Z",
    });
    expect(succeeded.outcome).toBe("succeeded");

    await expect(
      runLiveEvidenceExecutor({
        mode: "resume",
        resumeId: succeeded.resumeId,
        profile,
        manifestBytes: bytes,
        environment: {},
        journalStore: store,
        driver,
        eventSink: () => undefined,
        now: () => "2026-08-23T12:01:00.000Z",
      }),
    ).resolves.toEqual(succeeded);

    const persisted = store.journal;
    if (persisted === null) throw new Error("journal was not persisted");
    const first = persisted.completedCases[0];
    if (first === undefined) throw new Error("completed case was not persisted");
    store.journal = {
      ...persisted,
      completedCases: [
        { ...first, effects: first.effects.slice(0, -1) },
        ...persisted.completedCases.slice(1),
      ],
    };

    await expect(
      runLiveEvidenceExecutor({
        mode: "resume",
        resumeId: succeeded.resumeId,
        profile,
        manifestBytes: bytes,
        environment: {},
        journalStore: store,
        driver,
        eventSink: () => undefined,
        now: () => "2026-08-23T12:02:00.000Z",
      }),
    ).rejects.toThrow();
  });
});
