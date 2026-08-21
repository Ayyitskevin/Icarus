import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ArtifactStore } from "../../packages/core/src/artifacts.js";
import { sha256 } from "../../packages/core/src/digest.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import type {
  GitController,
  PrivateWorkspace,
  RepositoryInspection,
  TreeEntry,
} from "../../packages/core/src/git.js";
import type { HeadlessProfileV1 } from "../../packages/core/src/headless-profile.js";
import { DEFAULT_CEILING, DEFAULT_SANDBOX_LIMITS } from "../../packages/core/src/policy.js";
import {
  createProviderConfig,
  type ModelGateway,
  type StructuredGenerationRequest,
} from "../../packages/core/src/provider.js";
import type { CheckRunInput, CheckRunner } from "../../packages/core/src/sandbox.js";
import { IcarusService } from "../../packages/core/src/service.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import type {
  CheckEvidence,
  JsonValue,
  ProviderConfig,
  SunCeiling,
} from "../../packages/core/src/types.js";

const TARGET = "src/greeting.txt";
const BASELINE = "Hello, world!\n";
const BROKEN = "Hello, Icrus!\n";
const FIXED = "Hello, Icarus!\n";
const BASE_COMMIT = "b".repeat(40);
const IMAGE = `python@sha256:${"c".repeat(64)}`;
const cleanupRoots: string[] = [];

const CEILING: SunCeiling = {
  ...DEFAULT_CEILING,
  maxActiveRuntimeMs: 120_000,
  commandTimeoutMs: 5_000,
  providerTimeoutMs: 5_000,
  maxOutputTokensPerCall: 512,
  maxTotalTokens: 50_000,
};

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

class ControlledGit {
  constructor(readonly repositoryPath: string) {}

  inspectRepository(): Promise<RepositoryInspection> {
    return Promise.resolve({
      canonicalPath: this.repositoryPath,
      device: 1,
      inode: 2,
      head: BASE_COMMIT,
    });
  }
  resolveCommit(): Promise<string> {
    return Promise.resolve(BASE_COMMIT);
  }
  assertCleanAtCommit(): Promise<void> {
    return Promise.resolve();
  }
  listTree(): Promise<TreeEntry[]> {
    return Promise.resolve([
      { mode: "100644", type: "blob", objectId: "d".repeat(40), path: TARGET },
    ]);
  }
  readBlob(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(BASELINE, "utf8"));
  }
  async createPrivateWorkspace(
    _sourceRepository: string,
    _commit: string,
    runRoot: string,
  ): Promise<PrivateWorkspace> {
    const cachePath = path.join(runRoot, "git-cache.git");
    const worktreePath = path.join(runRoot, "worktree");
    await mkdir(cachePath, { recursive: true, mode: 0o700 });
    await mkdir(path.join(worktreePath, "src"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(worktreePath, TARGET), BASELINE, "utf8");
    return { cachePath, worktreePath };
  }
  readRegularUtf8File(worktreePath: string, target: string): Promise<string> {
    return readFile(path.join(worktreePath, target), "utf8");
  }
  async readOptionalRegularUtf8File(worktreePath: string, target: string): Promise<string | null> {
    try {
      return await readFile(path.join(worktreePath, target), "utf8");
    } catch {
      return null;
    }
  }
  atomicWriteUtf8(worktreePath: string, target: string, value: string): Promise<void> {
    return writeFile(path.join(worktreePath, target), value, "utf8");
  }
  async applyFileWrites(
    worktreePath: string,
    writes: readonly { readonly path: string; readonly content: string | null }[],
  ): Promise<void> {
    for (const write of writes) {
      const absolute = path.join(worktreePath, write.path);
      if (write.content === null) await rm(absolute, { force: true });
      else await writeFile(absolute, write.content, "utf8");
    }
  }
  stageIntentToAdd(): Promise<void> {
    return Promise.resolve();
  }
  resetIndex(): Promise<void> {
    return Promise.resolve();
  }
  async changedPaths(worktreePath: string): Promise<string[]> {
    return (await this.readRegularUtf8File(worktreePath, TARGET)) === BASELINE ? [] : [TARGET];
  }
  async diff(worktreePath: string): Promise<string> {
    const current = await this.readRegularUtf8File(worktreePath, TARGET);
    if (current === BASELINE) throw new IcarusError("EMPTY_DIFF", "Synthetic worktree is clean");
    return [
      `diff --git a/${TARGET} b/${TARGET}`,
      `--- a/${TARGET}`,
      `+++ b/${TARGET}`,
      `-${BASELINE.trimEnd()}`,
      `+${current.trimEnd()}`,
      "",
    ].join("\n");
  }
}

class ControlledChecks implements CheckRunner {
  reconcile(): Promise<void> {
    return Promise.resolve();
  }
  async runChecks(input: CheckRunInput): Promise<readonly CheckEvidence[]> {
    const current = await readFile(path.join(input.worktreePath, TARGET), "utf8");
    const passed = current === FIXED;
    return input.checks.map((check) => ({
      checkId: check.id,
      argv: check.argv,
      exitCode: passed ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdout: passed ? "ok\n" : "not fixed\n",
      stderr: "",
      truncated: false,
      outcome: passed ? "passed" : "failed",
    }));
  }
}

function patchSet(value: string): JsonValue {
  return {
    summary: "Apply the approved greeting.",
    edits: [
      {
        op: "modify",
        path: TARGET,
        expectedPreimageSha256: sha256(BASELINE),
        replacements: [{ findText: BASELINE, replaceText: value }],
        content: null,
        rationale: "Replace one operator-selected file.",
      },
    ],
  };
}

function plan(iterations: number): JsonValue {
  return {
    summary: "Replace the greeting.",
    steps: ["Apply one exact replacement.", "Run verification."],
    risks: ["The preimage may differ."],
    target: TARGET,
    targets: [TARGET],
    iterationCeiling: iterations,
    checkIds: ["verify"],
    grants: iterations === 0 ? [] : [{ kind: "mutation.patchset", scope: [TARGET], maxCalls: 2 }],
  };
}

function gatewayFactory(
  outputs: readonly JsonValue[],
  hook?: (request: StructuredGenerationRequest) => void,
): (config: ProviderConfig) => ModelGateway {
  const queue = [...outputs];
  return (config) => ({
    config,
    generateStructured: (request) => {
      hook?.(request);
      const output = queue.shift();
      if (output === undefined) throw new Error("Synthetic provider queue exhausted");
      return Promise.resolve({
        text: JSON.stringify(output),
        usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, latencyMs: 1 },
      });
    },
  });
}

interface Fixture {
  readonly service: IcarusService;
  readonly store: IcarusStore;
  readonly provider: ProviderConfig;
  close(): void;
}

async function fixture(
  outputs: readonly JsonValue[],
  hook?: (request: StructuredGenerationRequest) => void,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-headless-worker-"));
  cleanupRoots.push(root);
  const stateRoot = path.join(root, "state");
  const repositoryPath = path.join(root, "repository");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(path.join(repositoryPath, "src"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(repositoryPath, TARGET), BASELINE, "utf8");
  const store = new IcarusStore(path.join(stateRoot, "icarus.sqlite3"));
  const service = new IcarusService({
    stateRoot,
    store,
    artifacts: new ArtifactStore(stateRoot),
    git: new ControlledGit(repositoryPath) as unknown as GitController,
    checks: new ControlledChecks(),
    gatewayFactory: gatewayFactory(outputs, hook),
  });
  await service.initialize();
  await service.registerRepository("fixture", repositoryPath);
  service.createProject({
    name: "headless-test",
    repositoryName: "fixture",
    baseRef: "main",
    checks: [{ id: "verify", name: "Synthetic verification", argv: ["synthetic-check"] }],
    sandbox: { image: IMAGE, ...DEFAULT_SANDBOX_LIMITS },
    ceiling: CEILING,
  });
  const provider = createProviderConfig({
    kind: "ollama",
    model: "synthetic-model",
    baseUrl: "http://127.0.0.1:11434/",
  });
  return { service, store, provider, close: () => store.close() };
}

function profile(
  iterationCeiling: number,
  toolIds: HeadlessProfileV1["toolIds"] = [],
): HeadlessProfileV1 {
  return {
    schemaVersion: 1,
    profileId: "local-headless",
    providerProfileId: "local-provider",
    toolIds,
    budgets: { ...CEILING, iterationCeiling },
    output: { format: "jsonl" },
    worker: { mode: "one_task", maxConcurrency: 1, childRuns: "deny", scheduledRuns: "deny" },
  };
}

const PROVIDER_CATALOG = [
  {
    id: "local-provider",
    kind: "ollama" as const,
    model: "synthetic-model",
    baseUrl: "http://127.0.0.1:11434/",
    inputUsdPerMillionTokens: null,
    outputUsdPerMillionTokens: null,
  },
];

async function plannedRun(current: Fixture, iterations: number) {
  return current.service
    .planRun({
      projectName: "headless-test",
      task: "Replace the greeting.",
      targets: [TARGET],
      provider: current.provider,
    })
    .then((run) => {
      expect(run.plan?.iterationCeiling).toBe(iterations);
      return run;
    });
}

describe("bounded headless worker", () => {
  test("binds before effects and settles a passing task review-ready", async () => {
    const current = await fixture([plan(0), patchSet(FIXED)]);
    try {
      const planned = await plannedRun(current, 0);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(0),
        PROVIDER_CATALOG,
      );
      expect(result.settlement).toMatchObject({ outcome: "review_ready", exitCode: 0 });
      expect(result.run.state).toBe("awaiting_review");
      const events = current.store.listEvents(planned.id);
      expect(events.findIndex((event) => event.type === "headless.worker.started")).toBeLessThan(
        events.findIndex((event) => event.type === "workspace.created"),
      );
      expect(events.at(-1)?.type).toBe("headless.worker.settled");
    } finally {
      current.close();
    }
  });

  test("settles failed initial checks durably with exit 1", async () => {
    const current = await fixture([plan(0), patchSet(BROKEN)]);
    try {
      const planned = await plannedRun(current, 0);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(0),
        PROVIDER_CATALOG,
      );
      expect(result.run.state).toBe("awaiting_review");
      expect(result.run.verification?.outcome).toBe("failed");
      expect(result.run.lastError).toBeNull();
      expect(result.settlement).toMatchObject({
        outcome: "failed",
        exitCode: 1,
        error: { code: "HEADLESS_VERIFICATION_FAILED" },
      });
      expect(current.store.listEvents(planned.id).at(-1)).toMatchObject({
        type: "headless.worker.settled",
        payload: {
          outcome: "failed",
          exitCode: 1,
          error: { code: "HEADLESS_VERIFICATION_FAILED" },
        },
      });
    } finally {
      current.close();
    }
  });

  test("enforces a tighter profile operation ceiling", async () => {
    const current = await fixture([plan(0), patchSet(FIXED)]);
    try {
      const planned = await plannedRun(current, 0);
      const constrained = profile(0);
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          { ...constrained, budgets: { ...constrained.budgets, maxToolCalls: 1 } },
          PROVIDER_CATALOG,
        ),
      ).rejects.toMatchObject({ code: "HEADLESS_PROFILE_ALREADY_EXHAUSTED" });
      expect(current.store.getRun(planned.id).state).toBe("awaiting_approval");
      expect(
        current.store
          .listEvents(planned.id)
          .some((event) => event.type === "headless.worker.started"),
      ).toBe(false);
    } finally {
      current.close();
    }
  });

  test("meters and refuses a session tool disabled by the profile", async () => {
    const current = await fixture([
      plan(1),
      patchSet(BROKEN),
      { toolCalls: [{ name: "apply_patchset", arguments: { patchSet: patchSet(FIXED) } }] },
    ]);
    try {
      const planned = await plannedRun(current, 1);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(1, ["report_done"]),
        PROVIDER_CATALOG,
      );
      expect(result.settlement).toMatchObject({ outcome: "exhausted", exitCode: 2 });
      expect(result.run.state).toBe("awaiting_review");
      expect(current.store.listEvents(planned.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "session.exhausted" }),
          expect.objectContaining({ type: "headless.worker.settled" }),
        ]),
      );
    } finally {
      current.close();
    }
  });

  test("lands signal cancellation and settles with exit 130", async () => {
    const controller = new AbortController();
    const current = await fixture([plan(0), patchSet(FIXED)], (request) => {
      if (request.schemaName === "icarus_patch_set") controller.abort();
    });
    try {
      const planned = await plannedRun(current, 0);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(0),
        PROVIDER_CATALOG,
        controller.signal,
      );
      expect(result.settlement).toMatchObject({ outcome: "cancelled", exitCode: 130 });
      expect(result.run.state).toBe("cancelled");
      expect(current.store.listEvents(planned.id).at(-1)?.type).toBe("headless.worker.settled");
    } finally {
      current.close();
    }
  });

  test("refuses provider remapping before the first worker effect", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      const selectedProvider = PROVIDER_CATALOG[0];
      if (selectedProvider === undefined) throw new Error("test provider catalog is empty");
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          profile(0),
          [{ ...selectedProvider, model: "remapped-model" }],
        ),
      ).rejects.toMatchObject({ code: "HEADLESS_BINDING_AUTHORITY_DENIED" });
      expect(
        current.store.listEvents(planned.id).some((event) => event.type === "workspace.created"),
      ).toBe(false);
      expect(
        current.store
          .listEvents(planned.id)
          .some((event) => event.type === "headless.worker.started"),
      ).toBe(false);
    } finally {
      current.close();
    }
  });

  test("refuses a profile tool without its approved-plan capability", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          profile(0, ["run_checks"]),
          PROVIDER_CATALOG,
        ),
      ).rejects.toMatchObject({ code: "HEADLESS_PROFILE_AUTHORITY_DENIED" });
      expect(current.store.getRun(planned.id).state).toBe("awaiting_approval");
    } finally {
      current.close();
    }
  });

  test("refuses a profile budget above the persisted project ceiling", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      const selected = profile(0);
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          { ...selected, budgets: { ...selected.budgets, maxCostUsd: CEILING.maxCostUsd + 1 } },
          PROVIDER_CATALOG,
        ),
      ).rejects.toMatchObject({ code: "HEADLESS_PROFILE_AUTHORITY_DENIED" });
    } finally {
      current.close();
    }
  });

  test("refuses malformed profile fields rather than ignoring them", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          { ...profile(0), providerUrl: "http://example.invalid" },
          PROVIDER_CATALOG,
        ),
      ).rejects.toMatchObject({ code: "INVALID_HEADLESS_PROFILE" });
    } finally {
      current.close();
    }
  });

  test("rejects the wrong plan digest before approval or worker lifecycle", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          "0".repeat(64),
          "headless-operator",
          profile(0),
          PROVIDER_CATALOG,
        ),
      ).rejects.toMatchObject({ code: "STALE_APPROVAL" });
      expect(current.store.getRun(planned.id).state).toBe("awaiting_approval");
      expect(
        current.store
          .listEvents(planned.id)
          .some((event) => event.type.startsWith("headless.worker.")),
      ).toBe(false);
    } finally {
      current.close();
    }
  });

  test("does not admit a second worker for a settled run", async () => {
    const current = await fixture([plan(0), patchSet(FIXED)]);
    try {
      const planned = await plannedRun(current, 0);
      await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(0),
        PROVIDER_CATALOG,
      );
      await expect(
        current.service.approveHeadlessPlan(
          planned.id,
          planned.planSha256 ?? "",
          "headless-operator",
          profile(0),
          PROVIDER_CATALOG,
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect(
        current.store
          .listEvents(planned.id)
          .filter((event) => event.type === "headless.worker.started"),
      ).toHaveLength(1);
    } finally {
      current.close();
    }
  });

  test("settles a provider failure durably instead of reporting success", async () => {
    const current = await fixture([plan(0)]);
    try {
      const planned = await plannedRun(current, 0);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(0),
        PROVIDER_CATALOG,
      );
      expect(result.settlement).toMatchObject({ outcome: "failed", exitCode: 1 });
      expect(result.settlement.error?.code).toBe("RUN_STEP_FAILED");
      expect(current.store.listEvents(planned.id).at(-1)?.type).toBe("headless.worker.settled");
    } finally {
      current.close();
    }
  });

  test("settles a human-input request as incomplete with exit 3", async () => {
    const current = await fixture([
      plan(1),
      patchSet(BROKEN),
      { toolCalls: [{ name: "request_human_input", arguments: { question: "Which greeting?" } }] },
    ]);
    try {
      const planned = await plannedRun(current, 1);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        profile(1, ["request_human_input"]),
        PROVIDER_CATALOG,
      );
      expect(result.settlement).toMatchObject({
        outcome: "awaiting_human",
        exitCode: 3,
        error: null,
      });
      expect(result.run.state).toBe("awaiting_review");
    } finally {
      current.close();
    }
  });

  test("applies a tiny context ceiling to the first headless provider call", async () => {
    const current = await fixture([plan(0), patchSet(FIXED)]);
    try {
      const planned = await plannedRun(current, 0);
      const selected = profile(0);
      const result = await current.service.approveHeadlessPlan(
        planned.id,
        planned.planSha256 ?? "",
        "headless-operator",
        { ...selected, budgets: { ...selected.budgets, maxContextBytes: 1 } },
        PROVIDER_CATALOG,
      );
      expect(result.settlement).toMatchObject({ outcome: "failed", exitCode: 1 });
      expect(result.run.lastError?.code).toBe("CONTEXT_BUDGET_EXCEEDED");
    } finally {
      current.close();
    }
  });
});
