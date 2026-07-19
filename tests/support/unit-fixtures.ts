import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { digestJson } from "../../packages/core/src/digest.js";
import { DEFAULT_CEILING } from "../../packages/core/src/policy.js";
import { createProviderConfig } from "../../packages/core/src/provider.js";
import { IcarusStore } from "../../packages/core/src/store.js";
import type {
  ContextManifest,
  JsonValue,
  PlanProposal,
  SandboxProfile,
  SunCeiling,
} from "../../packages/core/src/types.js";

export const UNIT_RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const UNIT_BASE_COMMIT = "b".repeat(40);

export const UNIT_PROVIDER = createProviderConfig({
  kind: "ollama",
  model: "unit-model",
  baseUrl: "http://127.0.0.1:11434",
});

export const UNIT_SANDBOX: SandboxProfile = {
  image: `python@sha256:${"c".repeat(64)}`,
  cpus: 1,
  memoryMb: 256,
  pids: 32,
  tmpfsMb: 64,
};

export const UNIT_CEILING: SunCeiling = {
  ...DEFAULT_CEILING,
  maxToolCalls: 4,
  maxActiveRuntimeMs: 10_000,
  maxOutputTokensPerCall: 200,
  maxTotalTokens: 1_000,
  maxCostUsd: 1,
  providerTimeoutMs: 1_000,
  commandTimeoutMs: 1_000,
};

export const UNIT_PLAN: PlanProposal = {
  summary: "Replace the greeting.",
  steps: ["Replace one exact string.", "Run the registered check."],
  risks: ["The expected text may have changed."],
  target: "src/greeting.txt",
  checkIds: ["unit"],
};

export function makeUnitIdGenerator(): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
  };
}

export function createUnitStore(): {
  readonly root: string;
  readonly databasePath: string;
  readonly store: IcarusStore;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "icarus-unit-store-"));
  mkdirSync(path.join(root, "state"), { mode: 0o700 });
  const databasePath = path.join(root, "state", "icarus.sqlite3");
  return {
    root,
    databasePath,
    store: new IcarusStore(databasePath, {
      now: () => "2026-07-19T12:00:00.000Z",
      id: makeUnitIdGenerator(),
    }),
  };
}

export function seedUnitProject(store: IcarusStore): {
  readonly repositoryId: string;
  readonly projectId: string;
} {
  const repository = store.addRepository({
    name: "unit-repository",
    path: "/tmp/unit-repository",
    device: 1,
    inode: 2,
  });
  const project = store.addProject({
    name: "unit-project",
    repositoryId: repository.id,
    baseRef: "main",
    checks: [{ id: "unit", name: "Unit check", argv: ["node", "--test"] }],
    sandbox: UNIT_SANDBOX,
    ceiling: UNIT_CEILING,
  });
  return { repositoryId: repository.id, projectId: project.id };
}

export function unitContextManifest(): ContextManifest {
  return {
    baseCommit: UNIT_BASE_COMMIT,
    target: "src/greeting.txt",
    repositoryMap: ["src/greeting.txt"],
    entries: [
      {
        path: "src/greeting.txt",
        reason: "target",
        bytes: 6,
        sha256: "d".repeat(64),
      },
    ],
    totalBytes: 6,
  };
}

export function unitContextDigest(context: ContextManifest): string {
  return digestJson(context as unknown as JsonValue);
}
