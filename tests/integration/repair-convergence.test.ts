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
import {
  DEFAULT_CEILING,
  DEFAULT_SANDBOX_LIMITS,
  MAX_SESSION_ITERATIONS,
} from "../../packages/core/src/policy.js";
import { createProviderConfig, type ModelGateway } from "../../packages/core/src/provider.js";
import type { CheckRunInput, CheckRunner } from "../../packages/core/src/sandbox.js";
import { IcarusService } from "../../packages/core/src/service.js";
import { IcarusStore, SESSION_ITERATION_OPERATION_KIND } from "../../packages/core/src/store.js";
import type {
  CheckEvidence,
  JsonValue,
  ProviderConfig,
  SunCeiling,
} from "../../packages/core/src/types.js";

const TARGET = "src/greeting.txt";
const BASELINE = "Hello, world!\n";
/** The first attempt: applies cleanly but fails the registered check. */
const BROKEN = "Hello, Icrus!\n";
/** The revision the repair iteration is expected to converge on. */
const FIXED = "Hello, Icarus!\n";
const BASE_COMMIT = "b".repeat(40);
const IMAGE = `python@sha256:${"c".repeat(64)}`;

// The shipped default tool-call ceiling is deliberately NOT raised here: a run
// that spends the whole repair grant must fit inside it, and measured headroom
// (36 of 40 after three iterations, 37 after a rollback) is only meaningful if
// every run of this suite re-measures it.
const CEILING: SunCeiling = {
  ...DEFAULT_CEILING,
  maxActiveRuntimeMs: 120_000,
  commandTimeoutMs: 5_000,
  providerTimeoutMs: 5_000,
  maxOutputTokensPerCall: 512,
  maxTotalTokens: 50_000,
};

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * The smallest git surface `IcarusService` exercises, backed by a real
 * directory so patch-set application, baseline restoration, and drift
 * detection all run against actual bytes.
 */
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
      if (write.content === null) {
        await rm(absolute, { force: true });
      } else {
        await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
        await writeFile(absolute, write.content, "utf8");
      }
    }
  }

  stageIntentToAdd(): Promise<void> {
    return Promise.resolve();
  }

  resetIndex(): Promise<void> {
    return Promise.resolve();
  }

  async changedPaths(worktreePath: string): Promise<string[]> {
    const current = await this.readRegularUtf8File(worktreePath, TARGET);
    return current === BASELINE ? [] : [TARGET];
  }

  async diff(worktreePath: string): Promise<string> {
    const current = await this.readRegularUtf8File(worktreePath, TARGET);
    if (current === BASELINE) {
      throw new IcarusError("EMPTY_DIFF", "Synthetic worktree is clean");
    }
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

/** Passes only once the private worktree holds the corrected greeting. */
class ConvergingChecks implements CheckRunner {
  readonly observed: string[] = [];

  reconcile(): Promise<void> {
    return Promise.resolve();
  }

  async runChecks(input: CheckRunInput): Promise<readonly CheckEvidence[]> {
    const current = await readFile(path.join(input.worktreePath, TARGET), "utf8");
    this.observed.push(current);
    const passed = current === FIXED;
    return [
      {
        checkId: "verify",
        argv: ["synthetic-check"],
        exitCode: passed ? 0 : 1,
        signal: null,
        durationMs: 1,
        stdout: passed
          ? "ok\n"
          : `expected ${JSON.stringify(FIXED)}, saw ${JSON.stringify(current)}\n`,
        stderr: "",
        truncated: false,
        outcome: passed ? "passed" : "failed",
      },
    ];
  }
}

function patchSetProducing(replaceText: string): JsonValue {
  return {
    summary: "Apply the approved greeting.",
    edits: [
      {
        op: "modify",
        path: TARGET,
        expectedPreimageSha256: sha256(BASELINE),
        replacements: [{ findText: BASELINE, replaceText }],
        content: null,
        rationale: "Replace the operator-selected greeting.",
      },
    ],
  };
}

function planProposal(iterationCeiling: number): JsonValue {
  return {
    summary: "Replace the greeting.",
    steps: ["Apply one exact replacement.", "Run verification."],
    risks: ["The preimage may differ."],
    target: TARGET,
    targets: [TARGET],
    iterationCeiling,
    checkIds: ["verify"],
  };
}

function gatewayFactory(outputs: readonly JsonValue[]): (config: ProviderConfig) => ModelGateway {
  const queue = [...outputs];
  return (config) => ({
    config,
    generateStructured: () => {
      const value = queue.shift();
      if (value === undefined) throw new Error("Synthetic provider queue exhausted");
      return Promise.resolve({
        text: JSON.stringify(value),
        usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, latencyMs: 1 },
      });
    },
  });
}

interface Fixture {
  readonly service: IcarusService;
  readonly store: IcarusStore;
  readonly provider: ProviderConfig;
  readonly checks: ConvergingChecks;
  readonly stateRoot: string;
  close(): void;
}

async function fixtureWith(outputs: readonly JsonValue[]): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-repair-"));
  cleanupRoots.push(root);
  const stateRoot = path.join(root, "state");
  const repositoryPath = path.join(root, "repository");
  await mkdir(stateRoot, { mode: 0o700 });
  await mkdir(repositoryPath, { mode: 0o700 });
  const store = new IcarusStore(path.join(stateRoot, "icarus.sqlite3"));
  const checks = new ConvergingChecks();
  const service = new IcarusService({
    stateRoot,
    store,
    artifacts: new ArtifactStore(stateRoot),
    git: new ControlledGit(repositoryPath) as unknown as GitController,
    checks,
    gatewayFactory: gatewayFactory(outputs),
  });
  await service.initialize();
  await service.registerRepository("fixture", repositoryPath);
  service.createProject({
    name: "repair-test",
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
  return { service, store, provider, checks, stateRoot, close: () => store.close() };
}

describe("bounded repair loop end to end", () => {
  test("converges on a passing revision without a second human approval", async () => {
    const fixture = await fixtureWith([
      planProposal(2),
      patchSetProducing(BROKEN),
      patchSetProducing(FIXED),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      expect(planned.state).toBe("awaiting_approval");
      expect(planned.plan?.iterationCeiling).toBe(2);

      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification?.outcome).toBe("passed");
      // The check saw the defect first and the revision second.
      expect(fixture.checks.observed).toEqual([BROKEN, FIXED]);
      expect(await readFile(path.join(settled.worktreePath ?? "", TARGET), "utf8")).toBe(FIXED);

      // Exactly one grant was spent, from the durable operation ledger.
      expect(fixture.store.countSessionIterations(planned.id)).toBe(1);
      expect(fixture.store.remainingIterationBudget(planned.id)).toBe(1);

      const events = fixture.store.listEvents(planned.id);
      const types = events.map((event) => event.type);
      // Both attempts stay in the append-only log; the failure is not erased.
      expect(types.filter((type) => type === "verification.completed")).toHaveLength(2);
      expect(types.filter((type) => type === "repair.requested")).toHaveLength(1);
      expect(types.filter((type) => type === "patch_set.superseded")).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event.type === "operation.finished" &&
            (event.payload as Record<string, unknown>).kind === SESSION_ITERATION_OPERATION_KIND &&
            (event.payload as Record<string, unknown>).outcome === "succeeded",
        ),
      ).toBe(true);
      // No second human gate was opened for the revision.
      expect(fixture.store.listApprovals(planned.id)).toHaveLength(1);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("lands an exhausted grant as a failing review rather than a pass", async () => {
    const fixture = await fixtureWith([
      planProposal(1),
      patchSetProducing(BROKEN),
      patchSetProducing(BROKEN.replace("Icrus", "Icruss")),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification?.outcome).toBe("failed");
      expect(fixture.checks.observed).toHaveLength(2);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(1);
      expect(fixture.store.remainingIterationBudget(planned.id)).toBe(0);
      expect(
        fixture.store
          .listEvents(planned.id)
          .filter((event) => event.type === "verification.completed"),
      ).toHaveLength(2);
    } finally {
      fixture.close();
    }
  }, 60_000);

  test("spending the whole grant, then rolling back, fits inside the shipped ceiling", async () => {
    // Derived from the constant so raising the host ceiling cannot leave this
    // test quietly spending less than the whole budget it claims to spend:
    // one initial attempt, then a failing revision per iteration, then a fix.
    const fixture = await fixtureWith([
      planProposal(MAX_SESSION_ITERATIONS),
      patchSetProducing(BROKEN),
      ...Array.from({ length: MAX_SESSION_ITERATIONS - 1 }, (_unused, index) =>
        patchSetProducing(`Hello, Icrus${index + 2}!\n`),
      ),
      patchSetProducing(FIXED),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.verification?.outcome).toBe("passed");
      expect(fixture.store.countSessionIterations(planned.id)).toBe(MAX_SESSION_ITERATIONS);
      expect(settled.usage.toolCalls).toBeLessThanOrEqual(CEILING.maxToolCalls);

      // Recovery must still be affordable after the grant is fully spent —
      // an operator who cannot roll back is worse off than one who never ran.
      const rolled = await fixture.service.rollback(
        planned.id,
        settled.verification?.diffSha256 ?? "",
        "integration-test",
      );
      expect(rolled.state).toBe("rolled_back");
      expect(rolled.usage.toolCalls).toBeLessThanOrEqual(CEILING.maxToolCalls);
      expect(await readFile(path.join(rolled.worktreePath ?? "", TARGET), "utf8")).toBe(BASELINE);
    } finally {
      fixture.close();
    }
  }, 120_000);

  test("never repairs a run whose plan carries no grant", async () => {
    const fixture = await fixtureWith([planProposal(0), patchSetProducing(BROKEN)]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );

      expect(settled.state).toBe("awaiting_review");
      expect(settled.verification?.outcome).toBe("failed");
      // The provider was never asked for a revision, so the queue still holds none.
      expect(fixture.checks.observed).toEqual([BROKEN]);
      expect(fixture.store.countSessionIterations(planned.id)).toBe(0);
      expect(
        fixture.store.listEvents(planned.id).some((event) => event.type === "repair.requested"),
      ).toBe(false);
    } finally {
      fixture.close();
    }
  }, 60_000);
});

describe("the iteration ceiling is reachable, not decorative", () => {
  test("sessionIterationsFitTheToolCallCeiling", async () => {
    // A ceiling the tool-call budget cannot reach would make budget exhaustion
    // the observed stop instead of the honest iteration landing. This pins the
    // arithmetic behind MAX_SESSION_ITERATIONS: spending the whole budget must
    // stay inside maxToolCalls, and one more iteration must not fit.
    const fixture = await fixtureWith([
      planProposal(MAX_SESSION_ITERATIONS),
      patchSetProducing(BROKEN),
      ...Array.from({ length: MAX_SESSION_ITERATIONS - 1 }, (_unused, index) =>
        patchSetProducing(`Hello, Icrus${index + 2}!\n`),
      ),
      patchSetProducing(FIXED),
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });
      const settled = await fixture.service.approvePlan(
        planned.id,
        planned.planSha256 ?? "",
        "integration-test",
      );
      expect(fixture.store.countSessionIterations(planned.id)).toBe(MAX_SESSION_ITERATIONS);
      expect(settled.usage.toolCalls).toBeLessThanOrEqual(CEILING.maxToolCalls);
      // The measured per-iteration cost: one more iteration would not fit, which
      // is why the ceiling sits where it does.
      expect(settled.usage.toolCalls + 8).toBeGreaterThan(CEILING.maxToolCalls);
    } finally {
      fixture.close();
    }
  }, 60_000);
});

describe("read grant resolution end to end", () => {
  test("resolves the requested scope and binds the enumerated set into the approval", async () => {
    const fixture = await fixtureWith([
      {
        ...(planProposal(0) as Record<string, JsonValue>),
        grants: [{ kind: "read.manifest", scope: ["src/"], maxCalls: 4 }],
      } as JsonValue,
    ]);
    try {
      const planned = await fixture.service.planRun({
        projectName: "repair-test",
        task: "Replace the greeting.",
        targets: [TARGET],
        provider: fixture.provider,
      });

      expect(planned.state).toBe("awaiting_approval");
      expect(planned.plan?.grants).toEqual([
        { kind: "read.manifest", scope: ["src/"], maxCalls: 4 },
      ]);

      // The operator is asked to approve an enumerated file list pinned by
      // content digest, not the scope string the model requested.
      const manifest = fixture.store.readableManifest(planned.id);
      expect(manifest?.baseCommit).toBe(BASE_COMMIT);
      expect(manifest?.entries).toEqual([{ path: TARGET, sha256: sha256(BASELINE) }]);
    } finally {
      fixture.close();
    }
  });

  test("refuses to record a plan whose read scope escapes the repository", async () => {
    const fixture = await fixtureWith([
      {
        ...(planProposal(0) as Record<string, JsonValue>),
        grants: [{ kind: "read.manifest", scope: ["../outside/"], maxCalls: 1 }],
      } as JsonValue,
    ]);
    try {
      await expect(
        fixture.service.planRun({
          projectName: "repair-test",
          task: "Replace the greeting.",
          targets: [TARGET],
          provider: fixture.provider,
        }),
      ).rejects.toBeInstanceOf(IcarusError);
    } finally {
      fixture.close();
    }
  });
});
