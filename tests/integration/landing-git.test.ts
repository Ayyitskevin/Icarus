import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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

import { sha256 } from "../../packages/core/src/digest.js";
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
        GIT_AUTHOR_DATE: "1699999000 +0000",
        GIT_COMMITTER_NAME: "Fixture Author",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_DATE: "1699999000 +0000",
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
  await writeFile(path.join(review, "src", "empty.txt"), "");
  await writeFile(path.join(review, "src", "greeting.txt"), "Hello, landing!\n");
  await writeFile(path.join(review, "src", "newline-sensitive.txt"), "first\n\nlast");
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
    "src/empty.txt",
    "src/greeting.txt",
    "src/newline-sensitive.txt",
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
      path: "src/empty.txt",
      op: "create",
      baselineBase64: null,
      approvedBase64: "",
    },
    {
      path: "src/greeting.txt",
      op: "modify",
      baselineBase64: base64("Hello, base!\n"),
      approvedBase64: base64("Hello, landing!\n"),
    },
    {
      path: "src/newline-sensitive.txt",
      op: "create",
      baselineBase64: null,
      approvedBase64: base64("first\n\nlast"),
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

interface LoggedGitController {
  readonly controller: LandingGitController;
  readonly environmentLogPath: string;
  readonly logPath: string;
  readonly protocolLogPath: string;
}

async function createLoggedGitController(
  fixture: LandingFixture,
  behaviorSource = "",
): Promise<LoggedGitController> {
  const wrapperPath = path.join(fixture.root, "git-wrapper.mjs");
  const logPath = path.join(fixture.root, "git-argv.jsonl");
  const environmentLogPath = path.join(fixture.root, "git-environment.jsonl");
  const protocolLogPath = path.join(fixture.root, "git-stdin.bin");
  const source = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + "\\n");
const relevantKeys = Object.keys(process.env)
  .filter(
    (key) =>
      key === "PATH" ||
      key === "HOME" ||
      key === "XDG_CONFIG_HOME" ||
      key === "LANG" ||
      key === "LC_ALL" ||
      key.startsWith("GIT_") ||
      key.startsWith("ICARUS_"),
  )
  .sort()
  .slice(0, 64);
const snapshot = Object.fromEntries(relevantKeys.map((key) => [key, process.env[key]]));
appendFileSync(${JSON.stringify(environmentLogPath)}, JSON.stringify(snapshot) + "\\n");
const gitDirIndex = argv.lastIndexOf("--git-dir");
const command = gitDirIndex === -1 ? [] : argv.slice(gitDirIndex + 2);
${behaviorSource}
const child = spawn("git", argv, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
process.stdin.on("data", (chunk) => {
  appendFileSync(${JSON.stringify(protocolLogPath)}, chunk);
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => undefined);
child.once("error", () => {
  process.exitCode = 127;
});
child.once("close", (status, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = status ?? 128;
});
`;
  await writeFile(wrapperPath, source);
  await chmod(wrapperPath, 0o700);
  return {
    controller: new LandingGitController(fixture.controlHome, fixture.runsRoot, wrapperPath),
    environmentLogPath,
    logPath,
    protocolLogPath,
  };
}

async function readLoggedGitArgv(logPath: string): Promise<readonly (readonly string[])[]> {
  const text = await readFile(logPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function gitCommand(argv: readonly string[]): readonly string[] {
  const gitDirIndex = argv.lastIndexOf("--git-dir");
  if (gitDirIndex === -1) throw new Error("Missing fixed --git-dir argument");
  return argv.slice(gitDirIndex + 2);
}

function expectedControllerArgv(cachePath: string, command: readonly string[]): readonly string[] {
  return [
    "--no-pager",
    "--no-replace-objects",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.logAllRefUpdates=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "core.quotePath=true",
    "-c",
    "credential.helper=",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "diff.external=",
    "-c",
    "diff.renames=false",
    "-c",
    "diff.algorithm=myers",
    "-c",
    "diff.indentHeuristic=false",
    "-c",
    "color.ui=false",
    "-c",
    "core.pager=cat",
    "-c",
    "pager.diff=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "protocol.git.allow=never",
    "-c",
    "protocol.http.allow=never",
    "-c",
    "protocol.https.allow=never",
    "-c",
    "protocol.ssh.allow=never",
    "--git-dir",
    cachePath,
    ...command,
  ];
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
    expect(first).toMatchObject({
      candidateCommitSha1: "1e9ede841f2dc72025287ad49466d2e2448093d8",
      candidateTreeSha1: "2b69bda7c6a0ab6f616326e73c96773e7c8de855",
      candidateCommitPayloadSha256:
        "220932247bbc76925f4e18788a7261fde9a27f9f8b281f2a4c1d9ce81d3fbbf9",
      candidateObjectManifestSha256:
        "3777bd89e52d9bbbec26186b97aa8fafab129149224a8f629a871cd943a79945",
    });
    const reviewedDiffText = Buffer.from(fixture.input.reviewedDiffBytes).toString("utf8");
    expect(reviewedDiffText).toContain(
      `diff --git a/${PATHSPEC_MAGIC_PATH} b/${PATHSPEC_MAGIC_PATH}`,
    );
    expect(reviewedDiffText).toContain("\\ No newline at end of file");
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
        path: "src/empty.txt",
        op: "create",
        mode: "100644",
        blobSha1: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
        contentBytes: 0,
        contentSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      }),
      expect.objectContaining({
        path: "src/greeting.txt",
        op: "modify",
        mode: "100644",
        contentBytes: Buffer.byteLength("Hello, landing!\n"),
      }),
      expect.objectContaining({
        path: "src/newline-sensitive.txt",
        op: "create",
        mode: "100644",
        contentBytes: Buffer.byteLength("first\n\nlast"),
        contentSha256: sha256(Buffer.from("first\n\nlast", "utf8")),
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
      await gitBytes(fixture.root, [
        "--git-dir",
        fixture.cachePath,
        "show",
        `${first.candidateCommitSha1}:src/empty.txt`,
      ]),
    ).toEqual(Buffer.alloc(0));
    expect(
      await gitText(fixture.root, [
        "--git-dir",
        fixture.cachePath,
        "show",
        `${first.candidateCommitSha1}:src/greeting.txt`,
      ]),
    ).toBe("Hello, landing!");
    expect(
      await gitBytes(fixture.root, [
        "--git-dir",
        fixture.cachePath,
        "show",
        `${first.candidateCommitSha1}:src/newline-sensitive.txt`,
      ]),
    ).toEqual(Buffer.from("first\n\nlast", "utf8"));
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
    expect(tree).toContain("src/empty.txt");
    expect(tree).toContain("src/greeting.txt");
    expect(tree).toContain("src/newline-sensitive.txt");
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

  test("removes a run-owned interrupted candidate index before deterministic replay", async () => {
    const fixture = await createLandingFixture();
    cleanups.push(fixture.cleanup);

    const ownPrefix = `.icarus-landing-index-${RUN_ID}-`;
    const ownStale = path.join(fixture.controlHome, `${ownPrefix}interrupted`);
    const otherStale = path.join(
      fixture.controlHome,
      `.icarus-landing-index-${OTHER_RUN_ID}-active`,
    );
    await mkdir(ownStale, { mode: 0o700 });
    await mkdir(otherStale, { mode: 0o700 });
    await writeFile(path.join(ownStale, "index"), "interrupted-index");
    await writeFile(path.join(otherStale, "index"), "other-run-index");

    await prepare(fixture);

    await expect(access(ownStale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(otherStale, "index"), "utf8")).resolves.toBe("other-run-index");
    expect(
      (await readdir(fixture.controlHome)).filter((entry) => entry.startsWith(ownPrefix)),
    ).toEqual([]);
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
    await configure("core.logAllRefUpdates", "true");
    await configure("protocol.allow", "always");
    await configure("remote.origin.url", `http://127.0.0.1:${address.port}/should-not-run.git`);

    const actual = await prepare(fixture);
    expect(actual).toEqual(expected);
    expect(
      await fixture.controller.createAbsentLocalRef({
        cachePath: fixture.cachePath,
        runId: RUN_ID,
        candidateCommitSha1: actual.candidateCommitSha1,
      }),
    ).toMatchObject({
      outcome: "succeeded",
      localRefOutcome: "created",
      updateRefExitCode: 0,
    });
    await expect(
      access(path.join(fixture.cachePath, "logs", "refs", "heads", "icarus", RUN_ID)),
    ).rejects.toMatchObject({ code: "ENOENT" });
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

  test("inspects the exact base tree read-only before candidate intent", async () => {
    const fixture = await createLandingFixture();
    cleanups.push(fixture.cleanup);

    await expect(
      fixture.controller.inspectBase({
        cachePath: fixture.cachePath,
        runId: RUN_ID,
        baseCommitSha1: fixture.baseCommitSha1,
      }),
    ).resolves.toEqual({
      objectFormat: "sha1",
      baseCommitSha1: fixture.baseCommitSha1,
      baseTreeSha1: fixture.baseTreeSha1,
    });
    expect(await readdir(fixture.controlHome)).toEqual([]);
    expect(await repositoryFingerprint(fixture.source)).toEqual(fixture.sourceFingerprint);
  });

  test("refuses a SHA-256 repository before candidate intent", async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "icarus-landing-git-sha256-")),
    );
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const controlHome = path.join(root, "controller-home");
    const runsRoot = path.join(root, "runs");
    const runRoot = path.join(runsRoot, RUN_ID);
    const cachePath = path.join(runRoot, "git-cache.git");
    await mkdir(controlHome, { mode: 0o700 });
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    await gitBytes(root, ["init", "--bare", "--object-format=sha256", cachePath]);
    await Promise.all(
      [cachePath, path.join(cachePath, "objects"), path.join(cachePath, "refs")].map((directory) =>
        chmod(directory, 0o700),
      ),
    );
    expect(await gitText(root, ["--git-dir", cachePath, "rev-parse", "--show-object-format"])).toBe(
      "sha256",
    );

    const controller = new LandingGitController(controlHome, runsRoot);
    const error = await capturedError(
      controller.inspectBase({
        cachePath,
        runId: RUN_ID,
        baseCommitSha1: "0".repeat(40),
      }),
    );

    expect(error).toMatchObject({
      code: "UNSUPPORTED_GIT_OBJECT_FORMAT",
      message: "GitHub landing v1 requires the SHA-1 Git object format",
      details: {},
    });
    expect(await readdir(controlHome)).toEqual([]);
  });

  test("separates durable observation, absent-only CAS, and mandatory post-observation", async () => {
    const fixture = await createLandingFixture();
    cleanups.push(fixture.cleanup);
    const candidate = await prepare(fixture);
    const headRef = `refs/heads/icarus/${RUN_ID}`;
    const input = {
      cachePath: fixture.cachePath,
      runId: RUN_ID,
      candidateCommitSha1: candidate.candidateCommitSha1,
    };

    await expect(fixture.controller.observeLocalRef(input)).resolves.toEqual({
      outcome: "definitive",
      headRef,
      fact: { state: "absent", objectSha1: null, symbolicTargetSha256: null },
    });
    await expect(fixture.controller.createAbsentLocalRef(input)).resolves.toEqual({
      outcome: "succeeded",
      headRef,
      candidateCommitSha1: candidate.candidateCommitSha1,
      localRefOutcome: "created",
      updateRefExitCode: 0,
    });
    await expect(fixture.controller.observeLocalRef(input)).resolves.toEqual({
      outcome: "definitive",
      headRef,
      fact: {
        state: "direct",
        objectSha1: candidate.candidateCommitSha1,
        symbolicTargetSha256: null,
      },
    });
    await expect(fixture.controller.createAbsentLocalRef(input)).resolves.toEqual({
      outcome: "failed",
      headRef,
      candidateCommitSha1: candidate.candidateCommitSha1,
      errorCode: "LANDING_LOCAL_REF_CONFLICT",
    });

    await gitBytes(fixture.root, [
      "--git-dir",
      fixture.cachePath,
      "update-ref",
      headRef,
      fixture.baseCommitSha1,
    ]);
    await expect(fixture.controller.createAbsentLocalRef(input)).resolves.toEqual({
      outcome: "failed",
      headRef,
      candidateCommitSha1: candidate.candidateCommitSha1,
      errorCode: "LANDING_LOCAL_REF_CONFLICT",
    });
    expect(
      await gitText(fixture.root, ["--git-dir", fixture.cachePath, "show-ref", "--hash", headRef]),
    ).toBe(fixture.baseCommitSha1);
    expect(await repositoryFingerprint(fixture.source)).toEqual(fixture.sourceFingerprint);
  });

  test("the zero-old CAS refuses a ref created after durable absence observation", async () => {
    const fixture = await createLandingFixture(OTHER_RUN_ID);
    cleanups.push(fixture.cleanup);
    const candidate = await prepare(fixture);
    const headRef = `refs/heads/icarus/${OTHER_RUN_ID}`;
    const input = {
      cachePath: fixture.cachePath,
      runId: OTHER_RUN_ID,
      candidateCommitSha1: candidate.candidateCommitSha1,
    };

    await expect(fixture.controller.observeLocalRef(input)).resolves.toMatchObject({
      outcome: "definitive",
      fact: { state: "absent" },
    });
    await gitBytes(fixture.root, [
      "--git-dir",
      fixture.cachePath,
      "update-ref",
      headRef,
      fixture.baseCommitSha1,
    ]);
    await expect(fixture.controller.createAbsentLocalRef(input)).resolves.toEqual({
      outcome: "failed",
      headRef,
      candidateCommitSha1: candidate.candidateCommitSha1,
      errorCode: "LANDING_LOCAL_REF_CONFLICT",
    });
    await expect(fixture.controller.observeLocalRef(input)).resolves.toEqual({
      outcome: "definitive",
      headRef,
      fact: {
        state: "direct",
        objectSha1: fixture.baseCommitSha1,
        symbolicTargetSha256: null,
      },
    });
  });

  test("rejects an injected symbolic ref before the transaction can commit", async () => {
    const fixture = await createLandingFixture(OTHER_RUN_ID);
    cleanups.push(fixture.cleanup);
    const candidate = await prepare(fixture);
    const headRef = `refs/heads/icarus/${OTHER_RUN_ID}`;
    const input = {
      cachePath: fixture.cachePath,
      runId: OTHER_RUN_ID,
      candidateCommitSha1: candidate.candidateCommitSha1,
    };
    await expect(fixture.controller.observeLocalRef(input)).resolves.toMatchObject({
      outcome: "definitive",
      fact: { state: "absent" },
    });
    const mainBefore = await gitText(fixture.root, [
      "--git-dir",
      fixture.cachePath,
      "show-ref",
      "--hash",
      "refs/heads/main",
    ]);
    const behaviorSource = [
      'if (command[0] === "update-ref") {',
      '  const injection = spawnSync("git", ' +
        JSON.stringify([
          "--git-dir",
          fixture.cachePath,
          "symbolic-ref",
          headRef,
          "refs/heads/main",
        ]) +
        ', { stdio: "pipe" });',
      "  if (injection.status !== 0) process.exit(125);",
      "}",
    ].join("\n");
    const logged = await createLoggedGitController(fixture, behaviorSource);
    const sentinelKey = "ICARUS_TEST_GITHUB_TOKEN";
    const sentinelValue = "icarus-parent-token-sentinel-4d2f78e6";
    const previousSentinel = process.env[sentinelKey];
    let result: unknown;
    let observedError: unknown;
    try {
      process.env[sentinelKey] = sentinelValue;
      result = await logged.controller.createAbsentLocalRef(input);
    } catch (error) {
      observedError = error;
    } finally {
      if (previousSentinel === undefined) delete process.env[sentinelKey];
      else process.env[sentinelKey] = previousSentinel;
    }

    expect(observedError).toBeUndefined();
    expect(result).toEqual({
      outcome: "failed",
      headRef,
      candidateCommitSha1: candidate.candidateCommitSha1,
      errorCode: "LANDING_LOCAL_REF_CONFLICT",
    });
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

    const protocol = await readFile(logged.protocolLogPath, "utf8");
    const preparedProtocol = [
      "start",
      "option no-deref",
      ["update", headRef, candidate.candidateCommitSha1, "0".repeat(40)].join(" "),
      "prepare",
      "",
    ].join("\n");
    expect(protocol).toBe(preparedProtocol);
    const loggedSurfaces = [
      await readFile(logged.logPath, "utf8"),
      await readFile(logged.environmentLogPath, "utf8"),
      protocol,
      JSON.stringify(result) ?? "",
      observedError instanceof Error
        ? observedError.name + observedError.message + (observedError.stack ?? "")
        : String(observedError ?? ""),
    ];
    for (const surface of loggedSurfaces) {
      expect(surface).not.toContain(sentinelKey);
      expect(surface).not.toContain(sentinelValue);
    }
    expect(await repositoryFingerprint(fixture.source)).toEqual(fixture.sourceFingerprint);
  });

  test("returns bounded direct and dangling symbolic facts without mutating targets", async () => {
    const fixture = await createLandingFixture(OTHER_RUN_ID);
    cleanups.push(fixture.cleanup);
    const candidate = await prepare(fixture);
    const headRef = `refs/heads/icarus/${OTHER_RUN_ID}`;
    const input = {
      cachePath: fixture.cachePath,
      runId: OTHER_RUN_ID,
      candidateCommitSha1: candidate.candidateCommitSha1,
    };
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
    await expect(fixture.controller.observeLocalRef(input)).resolves.toEqual({
      outcome: "definitive",
      headRef,
      fact: {
        state: "symbolic",
        objectSha1: null,
        symbolicTargetSha256: sha256(Buffer.from("refs/heads/main", "utf8")),
      },
    });
    await expect(fixture.controller.createAbsentLocalRef(input)).resolves.toMatchObject({
      outcome: "failed",
      errorCode: "LANDING_LOCAL_REF_CONFLICT",
    });
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
    await expect(fixture.controller.observeLocalRef(input)).resolves.toEqual({
      outcome: "definitive",
      headRef,
      fact: {
        state: "symbolic",
        objectSha1: null,
        symbolicTargetSha256: sha256(Buffer.from("refs/heads/does-not-exist", "utf8")),
      },
    });
    await expect(fixture.controller.createAbsentLocalRef(input)).resolves.toMatchObject({
      outcome: "failed",
      errorCode: "LANDING_LOCAL_REF_CONFLICT",
    });
    expect(
      await gitText(fixture.root, ["--git-dir", fixture.cachePath, "symbolic-ref", headRef]),
    ).toBe("refs/heads/does-not-exist");
    expect(await repositoryFingerprint(fixture.source)).toEqual(fixture.sourceFingerprint);
  });

  test("fails closed without inventing an invalid fact for non-commit or malformed refs", async () => {
    const fixture = await createLandingFixture();
    cleanups.push(fixture.cleanup);
    const candidate = await prepare(fixture);
    const headRef = `refs/heads/icarus/${RUN_ID}`;
    const observationInput = { cachePath: fixture.cachePath, runId: RUN_ID };
    const blobSha1 = (
      await gitBytes(
        fixture.root,
        ["--git-dir", fixture.cachePath, "hash-object", "-w", "--stdin"],
        Buffer.from("not a commit\n", "utf8"),
      )
    )
      .toString("utf8")
      .trim();
    const namespace = path.join(fixture.cachePath, "refs", "heads", "icarus");
    await mkdir(namespace, { recursive: true });
    await writeFile(path.join(namespace, RUN_ID), `${blobSha1}\n`);
    await expect(fixture.controller.observeLocalRef(observationInput)).resolves.toEqual({
      outcome: "conflict",
      headRef,
      errorCode: "LANDING_LOCAL_REF_CONFLICT",
    });

    await gitBytes(fixture.root, ["--git-dir", fixture.cachePath, "update-ref", "-d", headRef]);
    const malformed = await createLoggedGitController(
      fixture,
      `if (command[0] === "show-ref") {
  process.stdout.write("malformed\\n");
  process.exit(0);
}`,
    );
    await expect(malformed.controller.observeLocalRef(observationInput)).resolves.toEqual({
      outcome: "ambiguous",
      headRef,
      errorCode: "LANDING_LOCAL_REF_OBSERVATION_AMBIGUOUS",
    });
    expect(candidate.candidateCommitSha1).toMatch(/^[a-f0-9]{40}$/);
  });

  test("bounds killed observation and CAS commands as ambiguous", async () => {
    const fixture = await createLandingFixture();
    cleanups.push(fixture.cleanup);
    const candidate = await prepare(fixture);
    const headRef = `refs/heads/icarus/${RUN_ID}`;
    const observationInput = { cachePath: fixture.cachePath, runId: RUN_ID };
    const updateInput = {
      ...observationInput,
      candidateCommitSha1: candidate.candidateCommitSha1,
    };

    const killedObservation = await createLoggedGitController(
      fixture,
      'if (command[0] === "show-ref") process.kill(process.pid, "SIGKILL");',
    );
    await expect(killedObservation.controller.observeLocalRef(observationInput)).resolves.toEqual({
      outcome: "ambiguous",
      headRef,
      errorCode: "LANDING_LOCAL_REF_OBSERVATION_AMBIGUOUS",
    });

    const killedUpdate = await createLoggedGitController(
      fixture,
      'if (command[0] === "update-ref") process.kill(process.pid, "SIGKILL");',
    );
    await expect(killedUpdate.controller.createAbsentLocalRef(updateInput)).resolves.toEqual({
      outcome: "ambiguous",
      headRef,
      candidateCommitSha1: candidate.candidateCommitSha1,
      errorCode: "LANDING_LOCAL_REF_OUTCOME_AMBIGUOUS",
    });
    await expect(fixture.controller.observeLocalRef(observationInput)).resolves.toMatchObject({
      outcome: "definitive",
      fact: { state: "absent" },
    });
  });

  test("uses exact fixed argv and performs no hidden post-CAS observation", async () => {
    const fixture = await createLandingFixture();
    cleanups.push(fixture.cleanup);
    const candidate = await prepare(fixture);
    const headRef = `refs/heads/icarus/${RUN_ID}`;
    const observationInput = { cachePath: fixture.cachePath, runId: RUN_ID };
    const updateInput = {
      ...observationInput,
      candidateCommitSha1: candidate.candidateCommitSha1,
    };
    const logged = await createLoggedGitController(fixture);

    await expect(logged.controller.observeLocalRef(observationInput)).resolves.toMatchObject({
      outcome: "definitive",
      fact: { state: "absent" },
    });
    const observationArgv = await readLoggedGitArgv(logged.logPath);
    const expectedObservationCommands = [
      ["rev-parse", "--is-bare-repository"],
      ["rev-parse", "--show-object-format"],
      ["symbolic-ref", "--quiet", "--no-recurse", headRef],
      ["show-ref", "--verify", "--quiet", "--", headRef],
      ["symbolic-ref", "--quiet", "--no-recurse", headRef],
      ["show-ref", "--verify", "--quiet", "--", headRef],
    ];
    expect(observationArgv.map(gitCommand)).toEqual(expectedObservationCommands);
    observationArgv.forEach((argv, index) => {
      expect(argv).toEqual(
        expectedControllerArgv(fixture.cachePath, expectedObservationCommands[index] ?? []),
      );
    });

    await writeFile(logged.logPath, "");
    await writeFile(logged.protocolLogPath, "");
    await expect(logged.controller.createAbsentLocalRef(updateInput)).resolves.toMatchObject({
      outcome: "succeeded",
      updateRefExitCode: 0,
    });
    const updateArgv = await readLoggedGitArgv(logged.logPath);
    const expectedUpdateCommands = [
      ["rev-parse", "--is-bare-repository"],
      ["rev-parse", "--show-object-format"],
      ["cat-file", "-t", candidate.candidateCommitSha1],
      ["update-ref", "--stdin"],
      ["symbolic-ref", "--quiet", "--no-recurse", headRef],
    ];
    expect(updateArgv.map(gitCommand)).toEqual(expectedUpdateCommands);
    updateArgv.forEach((argv, index) => {
      expect(argv).toEqual(
        expectedControllerArgv(fixture.cachePath, expectedUpdateCommands[index] ?? []),
      );
    });
    expect(await readFile(logged.protocolLogPath, "utf8")).toBe(
      [
        "start",
        "option no-deref",
        ["update", headRef, candidate.candidateCommitSha1, "0".repeat(40)].join(" "),
        "prepare",
        "commit",
        "",
      ].join("\n"),
    );

    await expect(fixture.controller.observeLocalRef(observationInput)).resolves.toMatchObject({
      outcome: "definitive",
      fact: { state: "direct", objectSha1: candidate.candidateCommitSha1 },
    });
    expect(await repositoryFingerprint(fixture.source)).toEqual(fixture.sourceFingerprint);
  });
});
