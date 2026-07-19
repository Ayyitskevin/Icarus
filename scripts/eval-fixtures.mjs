import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { IcarusError } from "../packages/core/dist/errors.js";
import { GitController } from "../packages/core/dist/git.js";
import {
  applyExactReplacement,
  assertAllowedTarget,
  DEFAULT_CEILING,
  DEFAULT_SANDBOX_LIMITS,
} from "../packages/core/dist/policy.js";
import { DockerSandboxRunner } from "../packages/core/dist/sandbox.js";

const root = path.resolve(".");
const fixtureRoot = path.join(root, "fixtures", "evals");
const pythonImage =
  "python:3.12-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28";
const manifest = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases)) {
  throw new Error("Evaluation manifest has an unsupported schema");
}

const requiredClasses = new Set([
  "add_feature",
  "fix_bug",
  "refactor_module",
  "update_schema",
  "repair_failing_test",
  "review_security_issue",
  "explain_codebase",
  "reject_forbidden_change",
  "recover_failed_provider",
  "resume_interrupted_run",
]);
const seenIds = new Set();
const seenClasses = new Set();
const results = [];
const vitestFiles = new Set();

function within(base, relative) {
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Fixture path escapes its root: ${relative}`);
  }
  return resolved;
}

async function snapshotTree(directory) {
  const snapshot = new Map();
  async function visit(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (prefix === "" && entry.name === ".git") continue;
      const entryPath = path.join(current, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(entryPath, relative);
      } else if (entry.isFile()) {
        snapshot.set(
          relative,
          createHash("sha256")
            .update(await readFile(entryPath))
            .digest("hex"),
        );
      } else {
        throw new Error(`Evaluation fixtures cannot contain special paths: ${relative}`);
      }
    }
  }
  await visit(directory, "");
  return snapshot;
}

function changedPaths(before, after) {
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  return [...allPaths]
    .filter((filePath) => before.get(filePath) !== after.get(filePath))
    .sort((left, right) => left.localeCompare(right));
}

function fixtureGit(cwd, controlHome, args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.ext.allow=never",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 10_000,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: controlHome,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        GIT_SSH_COMMAND: "false",
        GIT_PAGER: "cat",
        GIT_AUTHOR_NAME: "Icarus Eval",
        GIT_AUTHOR_EMAIL: "icarus-eval@example.invalid",
        GIT_COMMITTER_NAME: "Icarus Eval",
        GIT_COMMITTER_EMAIL: "icarus-eval@example.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `fixture git ${args[0] ?? "command"} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

async function initializeFixtureRepository(workspace, temporaryRoot) {
  const controlHome = path.join(temporaryRoot, "controller-home");
  await mkdir(controlHome, { recursive: true, mode: 0o700 });
  fixtureGit(workspace, controlHome, ["init", "--initial-branch=main"]);
  fixtureGit(workspace, controlHome, ["add", "--all"]);
  fixtureGit(workspace, controlHome, ["commit", "--no-gpg-sign", "-m", "fixture baseline"]);
  const baseCommit = fixtureGit(workspace, controlHome, ["rev-parse", "HEAD"]);
  return {
    baseCommit,
    git: new GitController(controlHome, path.join(temporaryRoot, "managed-runs")),
  };
}

function assertEvidence(scenario, actual) {
  if (JSON.stringify(actual) !== JSON.stringify(scenario.requiredEvidence)) {
    throw new Error(
      `Measured evidence did not match the manifest for ${scenario.id}: ${JSON.stringify(actual)}`,
    );
  }
}

async function withFixtureWorkspace(scenario, action) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "icarus-eval-"));
  const source = within(fixtureRoot, scenario.repository);
  const workspace = path.join(temporaryRoot, "workspace");
  const sourceBefore = await snapshotTree(source);
  try {
    await cp(source, workspace, { recursive: true });
    return await action({ source, sourceBefore, temporaryRoot, workspace });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

for (const scenario of manifest.cases) {
  if (typeof scenario.id !== "string" || seenIds.has(scenario.id)) {
    throw new Error("Evaluation IDs must be unique strings");
  }
  seenIds.add(scenario.id);
  seenClasses.add(scenario.class);
  if (
    !requiredClasses.has(scenario.class) ||
    !Array.isArray(scenario.requiredEvidence) ||
    scenario.requiredEvidence.length === 0 ||
    !Number.isInteger(scenario.minimumMilestone)
  ) {
    throw new Error(`Evaluation metadata is incomplete: ${scenario.id}`);
  }
  await access(within(fixtureRoot, scenario.repository));
  await access(within(fixtureRoot, scenario.task));

  if (!scenario.supported) {
    if (scenario.expectedOutcome !== "unsupported" || !scenario.unsupportedReason) {
      throw new Error(`Unsupported evaluation lacks an honest reason: ${scenario.id}`);
    }
    results.push({ id: scenario.id, outcome: "unsupported", reason: scenario.unsupportedReason });
    continue;
  }

  try {
    if (scenario.evaluator === "exact_replacement") {
      const evidence = await withFixtureWorkspace(
        scenario,
        async ({ source, sourceBefore, temporaryRoot, workspace }) => {
          const { baseCommit, git } = await initializeFixtureRepository(workspace, temporaryRoot);
          const workspaceBefore = await snapshotTree(workspace);
          const targetPath = within(workspace, scenario.target);
          const baseline = await readFile(targetPath, "utf8");
          if (baseline !== scenario.baseline) throw new Error("fixture baseline did not match");
          const digest = createHash("sha256").update(baseline).digest("hex");
          const actual = applyExactReplacement(
            baseline,
            {
              path: scenario.target,
              expectedPreimageSha256: digest,
              findText: scenario.baseline,
              replaceText: scenario.approved,
              rationale: "Evaluation fixture",
            },
            256 * 1024,
          );
          await writeFile(targetPath, actual, "utf8");
          const runner = new DockerSandboxRunner(temporaryRoot, git);
          const [check] = await runner.runChecks({
            runId: "11111111-1111-4111-8111-111111111111",
            worktreePath: workspace,
            baseCommit,
            target: scenario.target,
            checks: [
              {
                id: "verify",
                name: "Fixture verification",
                argv: ["python", "checks/verify.py"],
              },
            ],
            sandbox: { image: pythonImage, ...DEFAULT_SANDBOX_LIMITS },
            ceiling: { ...DEFAULT_CEILING, commandTimeoutMs: 10_000 },
          });
          if (check?.outcome !== "passed") {
            throw new Error(
              `sandboxed fixture check failed: ${check?.stderr || check?.stdout || "no evidence"}`,
            );
          }
          const workspaceAfterCheck = await snapshotTree(workspace);
          const measured = [];
          if ((await readFile(targetPath, "utf8")) === scenario.approved) {
            measured.push("exact_bytes");
          }
          if (
            JSON.stringify(changedPaths(workspaceBefore, workspaceAfterCheck)) ===
            JSON.stringify([scenario.target])
          ) {
            measured.push("one_changed_path");
          }
          measured.push("passing_check");
          if (changedPaths(sourceBefore, await snapshotTree(source)).length === 0) {
            measured.push("source_unchanged");
          }
          assertEvidence(scenario, measured);
          return measured;
        },
      );
      results.push({ id: scenario.id, outcome: "passed", evidence });
    } else if (scenario.evaluator === "forbidden_target") {
      const evidence = await withFixtureWorkspace(scenario, async ({ workspace }) => {
        const before = await snapshotTree(workspace);
        let code;
        try {
          assertAllowedTarget(scenario.target);
        } catch (error) {
          if (error instanceof IcarusError) code = error.code;
          else throw error;
        }
        const measured = [];
        if (code === "PROTECTED_PATH") measured.push("protected_path_error");
        else if (code === "INVALID_PATH") measured.push("invalid_path_error");
        else throw new Error("forbidden target was not rejected by the expected policy");
        if (changedPaths(before, await snapshotTree(workspace)).length === 0) {
          measured.push("zero_workspace_writes");
        }
        assertEvidence(scenario, measured);
        return measured;
      });
      results.push({ id: scenario.id, outcome: "passed", evidence });
    } else if (scenario.evaluator === "vitest" && typeof scenario.testFile === "string") {
      const testFile = within(root, scenario.testFile);
      await access(testFile);
      vitestFiles.add(scenario.testFile);
    } else {
      throw new Error("unknown supported evaluator");
    }
  } catch (error) {
    results.push({
      id: scenario.id,
      outcome: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

if (
  seenClasses.size !== requiredClasses.size ||
  [...requiredClasses].some((name) => !seenClasses.has(name))
) {
  throw new Error("Evaluation manifest does not cover all required scenario classes");
}

if (vitestFiles.size > 0) {
  const vitest = spawnSync(
    path.join(root, "node_modules", ".bin", "vitest"),
    ["run", ...[...vitestFiles].sort()],
    { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: false },
  );
  const outcome = vitest.status === 0 ? "passed" : "failed";
  for (const scenario of manifest.cases.filter((entry) => entry.evaluator === "vitest")) {
    results.push({
      id: scenario.id,
      outcome,
      evidence: outcome === "passed" ? scenario.requiredEvidence : undefined,
      reason: outcome === "failed" ? (vitest.stderr || vitest.stdout).slice(0, 4_096) : undefined,
    });
  }
}

const report = {
  schemaVersion: 1,
  fixtureManifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  generatedAt: new Date().toISOString(),
  counts: {
    passed: results.filter(({ outcome }) => outcome === "passed").length,
    failed: results.filter(({ outcome }) => outcome === "failed").length,
    unsupported: results.filter(({ outcome }) => outcome === "unsupported").length,
  },
  results,
};
await mkdir(path.join(root, ".local"), { recursive: true, mode: 0o700 });
await writeFile(
  path.join(root, ".local", "eval-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  {
    mode: 0o600,
  },
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.counts.failed > 0) process.exitCode = 1;
