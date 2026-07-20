import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../../packages/core/src/artifacts.js";
import type {
  GitController,
  RepositoryInspection,
  TreeEntry,
} from "../../packages/core/src/git.js";
import type { ModelGateway } from "../../packages/core/src/provider.js";
import type { CheckRunner } from "../../packages/core/src/sandbox.js";
import { IcarusService } from "../../packages/core/src/service.js";
import type { IcarusStore } from "../../packages/core/src/store.js";
import {
  createUnitStore,
  UNIT_BASE_COMMIT,
  UNIT_CEILING,
  UNIT_PLAN,
  UNIT_PROVIDER,
  UNIT_RUN_ID,
  UNIT_SANDBOX,
} from "../support/unit-fixtures.js";

const TARGET = "src/greeting.txt";
const BASELINE = "Hello, world!\n";
const cleanupRoots: string[] = [];
const cleanupStores: IcarusStore[] = [];

class DraftGit {
  inspectCalls = 0;
  resolveCalls = 0;
  assertCleanCalls = 0;
  listTreeCalls = 0;
  readBlobCalls = 0;
  createWorkspaceCalls = 0;

  inspectRepository(): Promise<RepositoryInspection> {
    this.inspectCalls += 1;
    return Promise.resolve({
      canonicalPath: "/tmp/unit-repository",
      device: 1,
      inode: 2,
      head: UNIT_BASE_COMMIT,
    });
  }

  resolveCommit(): Promise<string> {
    this.resolveCalls += 1;
    return Promise.resolve(UNIT_BASE_COMMIT);
  }

  assertCleanAtCommit(): Promise<void> {
    this.assertCleanCalls += 1;
    return Promise.resolve();
  }

  listTree(): Promise<TreeEntry[]> {
    this.listTreeCalls += 1;
    return Promise.resolve([
      {
        mode: "100644",
        type: "blob",
        objectId: "d".repeat(40),
        path: TARGET,
      },
    ]);
  }

  readBlob(): Promise<Buffer> {
    this.readBlobCalls += 1;
    return Promise.resolve(Buffer.from(BASELINE, "utf8"));
  }

  createPrivateWorkspace(): Promise<never> {
    this.createWorkspaceCalls += 1;
    return Promise.reject(new Error("Draft planning must not create a private worktree"));
  }

  totalSourceCalls(): number {
    return (
      this.inspectCalls +
      this.resolveCalls +
      this.assertCleanCalls +
      this.listTreeCalls +
      this.readBlobCalls +
      this.createWorkspaceCalls
    );
  }
}

afterEach(async () => {
  for (const store of cleanupStores.splice(0)) {
    store.close();
  }
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("atomic repository and project registration", () => {
  it("rolls back a new repository when project insertion conflicts", () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    cleanupStores.push(fixture.store);
    const existing = fixture.store.addRepository({
      name: "existing-repository",
      path: "/tmp/existing-repository",
      device: 1,
      inode: 2,
    });
    fixture.store.addProject({
      name: "duplicate-project",
      repositoryId: existing.id,
      baseRef: "main",
      checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }],
      sandbox: UNIT_SANDBOX,
      ceiling: UNIT_CEILING,
    });

    expect(() =>
      fixture.store.addRepositoryAndProject({
        repository: {
          name: "must-roll-back",
          path: "/tmp/must-roll-back",
          device: 3,
          inode: 4,
        },
        project: {
          name: "duplicate-project",
          baseRef: "main",
          checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }],
          sandbox: UNIT_SANDBOX,
          ceiling: UNIT_CEILING,
        },
      }),
    ).toThrow();
    expect(fixture.store.listRepositories().map((repository) => repository.name)).toEqual([
      "existing-repository",
    ]);
    expect(fixture.store.listProjects().map((project) => project.name)).toEqual([
      "duplicate-project",
    ]);
  });
});

describe("run drafts", () => {
  it("persists only the preparing draft before planning it through the existing guard", async () => {
    const fixture = createUnitStore();
    cleanupRoots.push(fixture.root);
    cleanupStores.push(fixture.store);
    const repository = fixture.store.addRepository({
      name: "unit-repository",
      path: "/tmp/unit-repository",
      device: 1,
      inode: 2,
    });
    fixture.store.addProject({
      name: "unit-project",
      repositoryId: repository.id,
      baseRef: "main",
      checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }],
      sandbox: UNIT_SANDBOX,
      ceiling: { ...UNIT_CEILING, maxTotalTokens: 10_000 },
    });
    const stateRoot = path.join(fixture.root, "state");
    const git = new DraftGit();
    const checks: CheckRunner = {
      reconcile: async () => undefined,
      runChecks: async () => [],
    };
    let gatewayFactoryCalls = 0;
    let generationCalls = 0;
    const gatewayFactory = (config: typeof UNIT_PROVIDER): ModelGateway => {
      gatewayFactoryCalls += 1;
      return {
        config,
        generateStructured: async () => {
          generationCalls += 1;
          return {
            text: JSON.stringify(UNIT_PLAN),
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              estimatedCostUsd: 0,
              latencyMs: 1,
            },
          };
        },
      };
    };
    const service = new IcarusService({
      stateRoot,
      store: fixture.store,
      artifacts: new ArtifactStore(stateRoot),
      git: git as unknown as GitController,
      checks,
      gatewayFactory,
      id: () => UNIT_RUN_ID,
    });
    await service.initialize();

    const draft = service.createRunDraft({
      projectName: "unit-project",
      task: "Replace the greeting.",
      target: TARGET,
      provider: UNIT_PROVIDER,
    });

    expect(draft).toMatchObject({
      id: UNIT_RUN_ID,
      state: "preparing",
      baseCommit: "",
      contextArtifactPath: "",
      contextSha256: "",
      plan: null,
      worktreePath: null,
      cachePath: null,
    });
    expect(draft.context).toMatchObject({
      baseCommit: "",
      target: TARGET,
      repositoryMap: [],
      entries: [],
      totalBytes: 0,
    });
    expect(fixture.store.listEvents(draft.id).map((event) => event.type)).toEqual(["run.created"]);
    expect(git.totalSourceCalls()).toBe(0);
    expect(gatewayFactoryCalls).toBe(0);
    expect(generationCalls).toBe(0);
    expect(await readdir(path.join(stateRoot, "artifacts"))).toEqual([]);
    expect(await readdir(path.join(stateRoot, "runs"))).toEqual([]);

    const planned = await service.planDraftRun(draft.id);

    expect(planned.state).toBe("awaiting_approval");
    expect(planned.baseCommit).toBe(UNIT_BASE_COMMIT);
    expect(planned.plan).toEqual(UNIT_PLAN);
    expect(planned.context.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: TARGET, reason: "target", bytes: BASELINE.length }),
      ]),
    );
    expect(git.inspectCalls).toBe(1);
    expect(git.resolveCalls).toBe(1);
    expect(git.assertCleanCalls).toBe(0);
    expect(git.listTreeCalls).toBe(1);
    expect(git.readBlobCalls).toBe(2);
    expect(git.createWorkspaceCalls).toBe(0);
    expect(gatewayFactoryCalls).toBe(1);
    expect(generationCalls).toBe(1);
    expect(await readdir(path.join(stateRoot, "artifacts", draft.id))).toEqual(["context.json"]);
    expect(fixture.store.listEvents(draft.id).map((event) => event.type)).toEqual(
      expect.arrayContaining(["run.created", "base.pinned", "context.assembled", "plan.created"]),
    );

    await expect(service.planDraftRun(draft.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(service.getRun(draft.id).state).toBe("awaiting_approval");
  });
});
