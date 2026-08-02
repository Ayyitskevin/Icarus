import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { IcarusError } from "../../packages/core/src/errors.js";
import {
  type LandingCandidateInput,
  type LandingCandidateResult,
  LandingGitController,
} from "../../packages/core/src/landing-git.js";
import type { CheckpointFile } from "../../packages/core/src/types.js";
import { repositoryFingerprint } from "../support/integration-cli.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN_ID = "22222222-2222-4222-8222-222222222222";
const COMMIT_EPOCH_SECONDS = 1_700_000_000;
const PATHSPEC_MAGIC_PATH = ":(exclude)secret.txt";

interface GitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

interface LandingFixture {
  readonly root: string;
  readonly source: string;
  readonly controlHome: string;
  readonly runsRoot: string;
  readonly cachePath: string;
  readonly baseCommitSha1: string;
  readonly baseTreeSha1: string;
  readonly sourceFingerprint: Record<string, string>;
  readonly input: LandingCandidateInput;
  readonly controller: LandingGitController;
  cleanup(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function runGit(
  cwd: string,
  args: readonly string[],
  stdinBytes?: Uint8Array,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture Author",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture Author",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_TERMINAL_PROMPT: "0",
      },
      shell: false,
      stdio: [stdinBytes === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (childStdout === null || childStderr === null) {
      child.kill();
      reject(new Error("Git fixture process did not expose configured output pipes"));
      return;
    }
    childStdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    childStderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 128,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    if (stdinBytes !== undefined) {
      const childStdin = child.stdin;
      if (childStdin === null) {
        child.kill();
        reject(new Error("Git fixture process did not expose the configured input pipe"));
        return;
      }
      childStdin.end(stdinBytes);
    }
  });
}

async function gitBytes(
  cwd: string,
  args: readonly string[],
  stdinBytes?: Uint8Array,
): Promise<Buffer> {
  const result = await runGit(cwd, args, stdinBytes);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ""} failed: ${result.stderr.toString("utf8")}`);
  }
  return result.stdout;
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await gitBytes(cwd, args)).toString("utf8").trim();
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

async function writeRepositoryFiles(repository: string): Promise<void> {
  await mkdir(path.join(repository, "docs"), { recursive: true });
  await mkdir(path.join(repository, "src"), { recursive: true });
  await writeFile(path.join(repository, "README.md"), "fixture\n");
  await writeFile(path.join(repository, PATHSPEC_MAGIC_PATH), "secret base\n");
  await writeFile(path.join(repository, "docs", "remove.txt"), "remove me\n");
  await writeFile(path.join(repository, "src", "greeting.txt"), "Hello, base!\n");
}

async function reviewedDiff(source: string, root: string, baseCommitSha1: string): Promise<Buffer> {
  const review = path.join(root, "review");
  await gitBytes(root, ["clone", "--no-local", source, review]);
  await writeFile(path.join(review, PATHSPEC_MAGIC_PATH), "secret landing\n");
  await writeFile(path.join(review, "src", "created.txt"), "created bytes\n");
  await writeFile(path.join(review, "src", "greeting.txt"), "Hello, landing!\n");
  await unlink(path.join(review, "docs", "remove.txt"));
  await gitBytes(review, ["add", "-A"]);
  return gitBytes(review, [
    "--literal-pathspecs",
    "-c",
    "diff.algorithm=myers",
    "-c",
    "diff.indentHeuristic=false",
    "-c",
    "color.ui=false",
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--no-color",
    "--no-indent-heuristic",
    "--diff-algorithm=myers",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    baseCommitSha1,
    "--",
    PATHSPEC_MAGIC_PATH,
    "docs/remove.txt",
    "src/created.txt",
    "src/greeting.txt",
  ]);
}

async function createLandingFixture(runId = RUN_ID): Promise<LandingFixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "icarus-landing-git-")));
  const source = path.join(root, "source");
  const controlHome = path.join(root, "controller-home");
  const runsRoot = path.join(root, "runs");
  const runRoot = path.join(runsRoot, runId);
  const cachePath = path.join(runRoot, "git-cache.git");
  await mkdir(source);
  await mkdir(controlHome, { mode: 0o700 });
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await gitBytes(source, ["init", "-b", "main"]);
  await gitBytes(source, ["config", "user.name", "Fixture Author"]);
  await gitBytes(source, ["config", "user.email", "fixture@example.invalid"]);
  await writeRepositoryFiles(source);
  await gitBytes(source, ["add", "."]);
  await gitBytes(source, ["commit", "-m", "root"]);
  await writeFile(path.join(source, "README.md"), "fixture base\n");
  await gitBytes(source, ["add", "README.md"]);
  await gitBytes(source, ["commit", "-m", "base"]);
  const baseCommitSha1 = await gitText(source, ["rev-parse", "HEAD"]);
  const baseTreeSha1 = await gitText(source, ["rev-parse", "HEAD^{tree}"]);
  const diffBytes = await reviewedDiff(source, root, baseCommitSha1);
  await gitBytes(root, ["clone", "--bare", "--no-local", "--no-hardlinks", source, cachePath]);
  await Promise.all(
    [cachePath, path.join(cachePath, "objects"), path.join(cachePath, "refs")].map((directory) =>
      chmod(directory, 0o700),
    ),
  );
  const checkpointFiles = [
    {
      path: PATHSPEC_MAGIC_PATH,
      op: "modify",
      baselineBase64: base64("secret base\n"),
      approvedBase64: base64("secret landing\n"),
    },
    {
      path: "docs/remove.txt",
      op: "delete",
      baselineBase64: base64("remove me\n"),
      approvedBase64: null,
    },
    {
      path: "src/created.txt",
      op: "create",
      baselineBase64: null,
      approvedBase64: base64("created bytes\n"),
    },
    {
      path: "src/greeting.txt",
      op: "modify",
      baselineBase64: base64("Hello, base!\n"),
      approvedBase64: base64("Hello, landing!\n"),
    },
  ] as const satisfies readonly CheckpointFile[];
  const input: LandingCandidateInput = {
    cachePath,
    runId,
    baseCommitSha1,
    baseTreeSha1,
    checkpointFiles,
    reviewedDiffBytes: diffBytes,
    commitIdentity: { name: "Icarus Landing", email: "icarus@example.invalid" },
    commitEpochSeconds: COMMIT_EPOCH_SECONDS,
    commitMessage: "Icarus deterministic landing\n",
  };
  return {
    root,
    source,
    controlHome,
    runsRoot,
    cachePath,
    baseCommitSha1,
    baseTreeSha1,
    sourceFingerprint: await repositoryFingerprint(source),
    input,
    controller: new LandingGitController(controlHome, runsRoot),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function capturedError(action: Promise<unknown>): Promise<IcarusError> {
  try {
    await action;
    throw new Error("Expected IcarusError");
  } catch (error) {
    expect(error).toBeInstanceOf(IcarusError);
    return error as IcarusError;
  }
}

async function prepare(fixture: LandingFixture): Promise<LandingCandidateResult> {
  return fixture.controller.prepareCandidate(fixture.input);
}

describe("ADR 0027 credential-free local landing Git boundary", () => {
  test("constructs create/modify/delete from checkpoint bytes with a stable exact commit", async () => {
    const fixture = await createLandingFixture();
    cleanups.push(fixture.cleanup);

    const first = await prepare(fixture);
    const second = await prepare(fixture);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      objectFormat: "sha1",
      baseCommitSha1: fixture.baseCommitSha1,
      baseTreeSha1: fixture.baseTreeSha1,
      diffByteEqual: true,
    });
    expect(first.candidateCommitSha1).toMatch(/^[a-f0-9]{40}$/);
    expect(first.candidateTreeSha1).toMatch(/^[a-f0-9]{40}$/);
    expect(first.candidateCommitPayloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.candidateObjectManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(fixture.input.reviewedDiffBytes).toString("utf8")).toContain(
      `diff --git a/${PATHSPEC_MAGIC_PATH} b/${PATHSPEC_MAGIC_PATH}`,
    );
    expect(first.candidateObjectManifest.entries).toEqual([
      expect.objectContaining({
        path: PATHSPEC_MAGIC_PATH,
        op: "modify",
        mode: "100644",
        contentBytes: Buffer.byteLength("secret landing\n"),
      }),
      {
        path: "docs/remove.txt",
        op: "delete",
        mode: "100644",
        blobSha1: null,
        contentBytes: null,
        contentSha256: null,
      },
      expect.objectContaining({
        path: "src/created.txt",
        op: "create",
        mode: "100644",
        contentBytes: Buffer.byteLength("created bytes\n"),
      }),
      expect.objectContaining({
        path: "src/greeting.txt",
        op: "modify",
        mode: "100644",
        contentBytes: Buffer.byteLength("Hello, landing!\n"),
      }),
    ]);

    expect(
      await gitText(fixture.root, [
        "--git-dir",
        fixture.cachePath,
        "show",
        `${first.candidateCommitSha1}:${PATHSPEC_MAGIC_PATH}`,
      ]),
    ).toBe("secret landing");
    expect(
      await gitText(fixture.root, [
        "--git-dir",
        fixture.cachePath,
        "rev-parse",
        `${first.candidateCommitSha1}^`,
      ]),
    ).toBe(fixture.baseCommitSha1);
    expect(
      await gitText(fixture.root, [
        "--git-dir",
        fixture.cachePath,
        "rev-parse",
        `${first.candidateCommitSha1}^{tree}`,
      ]),
    ).toBe(first.candidateTreeSha1);
    expect(
      await gitText(fixture.root, [
        "--git-dir",
        fixture.cachePath,
        "show",
        `${first.candidateCommitSha1}:src/created.txt`,
      ]),
    ).toBe("created bytes");
    expect(
      await gitText(fixture.root, [
        "--git-dir",
        fixture.cachePath,
        "show",
        `${first.candidateCommitSha1}:src/greeting.txt`,
      ]),
    ).toBe("Hello, landing!");
    const tree = await gitText(fixture.root, [
      "--git-dir",
      fixture.cachePath,
      "ls-tree",
      "-r",
      first.candidateCommitSha1,
    ]);
    expect(tree).not.toContain("docs/remove.txt");
    expect(tree).toContain("100644 blob");
    expect(tree).toContain("src/created.txt");
    expect(tree).toContain("src/greeting.txt");
    expect(
      await gitText(fixture.root, [
        "--git-dir",
        fixture.cachePath,
        "cat-file",
        "-p",
        first.candidateCommitSha1,
      ]),
    ).toContain(`author Icarus Landing <icarus@example.invalid> ${COMMIT_EPOCH_SECONDS} +0000`);
    expect(await readdir(fixture.controlHome)).toEqual([]);
    expect(await repositoryFingerprint(fixture.source)).toEqual(fixture.sourceFingerprint);
  });

  test("fails closed on unsorted checkpoints, stale diff, unsafe cache identity, and base drift", async () => {
    const fixture = await createLandingFixture();
    cleanups.push(fixture.cleanup);

    expect(
      await capturedError(
        fixture.controller.prepareCandidate({
          ...fixture.input,
          checkpointFiles: [...fixture.input.checkpointFiles].reverse(),
        }),
      ),
    ).toMatchObject({ code: "LANDING_CHECKPOINT_INVALID" });
    expect(
      await capturedError(
        fixture.controller.prepareCandidate({
          ...fixture.input,
          reviewedDiffBytes: Buffer.from("not the reviewed diff\n"),
        }),
      ),
    ).toMatchObject({ code: "LANDING_DIFF_MISMATCH" });
    expect(
      await capturedError(
        fixture.controller.prepareCandidate({
          ...fixture.input,
          baseTreeSha1: "0".repeat(40),
        }),
      ),
    ).toMatchObject({ code: "LANDING_BASE_INVALID" });

    await chmod(fixture.cachePath, 0o777);
    expect(await capturedError(prepare(fixture))).toMatchObject({ code: "LANDING_CACHE_INVALID" });
    await chmod(fixture.cachePath, 0o755);

    const refsPath = path.join(fixture.cachePath, "refs");
    await chmod(refsPath, 0o777);
    const unsafeRefs = await capturedError(prepare(fixture));
    expect(unsafeRefs).toMatchObject({
      code: "LANDING_CACHE_INVALID",
      message: "Private Git refs directory is unsafe",
      details: {},
    });
    expect(JSON.stringify(unsafeRefs)).not.toContain(fixture.root);
    await chmod(refsPath, 0o700);

    const alias = path.join(fixture.root, "cache-alias.git");
    await symlink(fixture.cachePath, alias);
    expect(
      await capturedError(
        fixture.controller.prepareCandidate({ ...fixture.input, cachePath: alias }),
      ),
    ).toMatchObject({ code: "LANDING_CACHE_INVALID" });
    expect(await readdir(fixture.controlHome)).toEqual([]);
    expect(await repositoryFingerprint(fixture.source)).toEqual(fixture.sourceFingerprint);
  });

  test("ignores hostile local Git execution config and never contacts a configured remote", async () => {
    const fixture = await createLandingFixture();
    cleanups.push(fixture.cleanup);
    const expected = await prepare(fixture);
    const marker = path.join(fixture.root, "git-execution-marker");
    const hookRoot = path.join(fixture.root, "hooks");
    const hook = path.join(hookRoot, "post-index-change");
    const attributes = path.join(fixture.root, "hostile-attributes");
    await mkdir(hookRoot);
    await writeFile(hook, `#!/bin/sh\nprintf invoked > "${marker}"\n`);
    await chmod(hook, 0o700);
    await writeFile(attributes, "*.txt filter=landing diff=landing\n");

    let networkRequests = 0;
    const server = http.createServer((_request, response) => {
      networkRequests += 1;
      response.writeHead(500);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test server");
    const configure = async (key: string, value: string): Promise<void> => {
      await gitBytes(fixture.root, ["--git-dir", fixture.cachePath, "config", key, value]);
    };
    await configure("user.name", "Hostile Identity");
    await configure("user.email", "hostile@example.invalid");
    await configure("commit.gpgSign", "true");
    await configure("tag.gpgSign", "true");
    await configure("credential.helper", `!printf invoked > "${marker}"`);
    await configure("core.hooksPath", hookRoot);
    await configure("core.attributesFile", attributes);
    await configure("filter.landing.clean", `sh -c 'printf invoked > "${marker}"; cat'`);
    await configure("filter.landing.smudge", `sh -c 'printf invoked > "${marker}"; cat'`);
    await configure("diff.landing.command", `sh -c 'printf invoked > "${marker}"'`);
    await configure("diff.landing.textconv", `sh -c 'printf invoked > "${marker}"'`);
    await configure("core.sshCommand", `sh -c 'printf invoked > "${marker}"'`);
    await configure("protocol.allow", "always");
    await configure("remote.origin.url", `http://127.0.0.1:${address.port}/should-not-run.git`);

    const actual = await prepare(fixture);
    expect(actual).toEqual(expected);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(networkRequests).toBe(0);
    expect(await repositoryFingerprint(fixture.source)).toEqual(fixture.sourceFingerprint);

    await writeFile(
      path.join(fixture.cachePath, "objects", "info", "alternates"),
      path.join(fixture.source, ".git", "objects"),
    );
    expect(await capturedError(prepare(fixture))).toMatchObject({ code: "LANDING_CACHE_INVALID" });
    expect(networkRequests).toBe(0);
  });

  test("creates only the fixed absent direct ref and refuses existing or conflicting refs", async () => {
    const fixture = await createLandingFixture();
    cleanups.push(fixture.cleanup);
    const candidate = await prepare(fixture);
    const headRef = `refs/heads/icarus/${RUN_ID}`;

    await expect(
      fixture.controller.createAbsentLocalRef({
        cachePath: fixture.cachePath,
        runId: RUN_ID,
        candidateCommitSha1: candidate.candidateCommitSha1,
      }),
    ).resolves.toEqual({
      headRef,
      candidateCommitSha1: candidate.candidateCommitSha1,
      localRefOutcome: "created",
      updateRefExitCode: 0,
    });
    expect(
      await gitText(fixture.root, ["--git-dir", fixture.cachePath, "show-ref", "--hash", headRef]),
    ).toBe(candidate.candidateCommitSha1);
    expect(
      await capturedError(
        fixture.controller.createAbsentLocalRef({
          cachePath: fixture.cachePath,
          runId: RUN_ID,
          candidateCommitSha1: candidate.candidateCommitSha1,
        }),
      ),
    ).toMatchObject({ code: "LANDING_LOCAL_REF_CONFLICT" });
    await gitBytes(fixture.root, [
      "--git-dir",
      fixture.cachePath,
      "update-ref",
      headRef,
      fixture.baseCommitSha1,
    ]);
    expect(
      await capturedError(
        fixture.controller.createAbsentLocalRef({
          cachePath: fixture.cachePath,
          runId: RUN_ID,
          candidateCommitSha1: candidate.candidateCommitSha1,
        }),
      ),
    ).toMatchObject({ code: "LANDING_LOCAL_REF_CONFLICT" });
    expect(await repositoryFingerprint(fixture.source)).toEqual(fixture.sourceFingerprint);
  });

  test("refuses direct and dangling symbolic refs without mutating their targets", async () => {
    const fixture = await createLandingFixture(OTHER_RUN_ID);
    cleanups.push(fixture.cleanup);
    const candidate = await prepare(fixture);
    const headRef = `refs/heads/icarus/${OTHER_RUN_ID}`;
    await gitBytes(fixture.root, [
      "--git-dir",
      fixture.cachePath,
      "symbolic-ref",
      headRef,
      "refs/heads/main",
    ]);
    const mainBefore = await gitText(fixture.root, [
      "--git-dir",
      fixture.cachePath,
      "show-ref",
      "--hash",
      "refs/heads/main",
    ]);
    expect(
      await capturedError(
        fixture.controller.createAbsentLocalRef({
          cachePath: fixture.cachePath,
          runId: OTHER_RUN_ID,
          candidateCommitSha1: candidate.candidateCommitSha1,
        }),
      ),
    ).toMatchObject({ code: "LANDING_LOCAL_REF_CONFLICT" });
    expect(
      await gitText(fixture.root, ["--git-dir", fixture.cachePath, "symbolic-ref", headRef]),
    ).toBe("refs/heads/main");
    expect(
      await gitText(fixture.root, [
        "--git-dir",
        fixture.cachePath,
        "show-ref",
        "--hash",
        "refs/heads/main",
      ]),
    ).toBe(mainBefore);

    await gitBytes(fixture.root, [
      "--git-dir",
      fixture.cachePath,
      "symbolic-ref",
      "--delete",
      headRef,
    ]);
    await gitBytes(fixture.root, [
      "--git-dir",
      fixture.cachePath,
      "symbolic-ref",
      headRef,
      "refs/heads/does-not-exist",
    ]);
    expect(
      await capturedError(
        fixture.controller.createAbsentLocalRef({
          cachePath: fixture.cachePath,
          runId: OTHER_RUN_ID,
          candidateCommitSha1: candidate.candidateCommitSha1,
        }),
      ),
    ).toMatchObject({ code: "LANDING_LOCAL_REF_CONFLICT" });
    expect(
      await gitText(fixture.root, ["--git-dir", fixture.cachePath, "symbolic-ref", headRef]),
    ).toBe("refs/heads/does-not-exist");
    expect(await repositoryFingerprint(fixture.source)).toEqual(fixture.sourceFingerprint);
  });
});
