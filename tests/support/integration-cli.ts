import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const PYTHON_IMAGE =
  "python:3.12-slim@sha256:c3d81d25b3154142b0b42eb1e61300024426268edeb5b5a26dd7ddf64d9daf28";

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const limit = 10 * 1024 * 1024;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= limit) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= limit) stderr.push(chunk);
    });
    child.once("error", reject);
    const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (stdoutBytes > limit || stderrBytes > limit) {
        reject(new Error("Test subprocess exceeded its output ceiling"));
        return;
      }
      resolve({
        exitCode: code ?? 128,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await run("git", args, { cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ""} failed: ${result.stderr}`);
  }
  return result.stdout;
}

export async function createFixtureRepository(): Promise<{
  readonly root: string;
  readonly repository: string;
  readonly stateRoot: string;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "icarus-integration-"));
  const repository = path.join(root, "repository");
  const stateRoot = path.join(root, "state");
  await cp(path.resolve("fixtures/evals/repos/basic"), repository, { recursive: true });
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.name", "Icarus Test"]);
  await git(repository, ["config", "user.email", "icarus@example.invalid"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "fixture"]);
  return {
    root,
    repository,
    stateRoot,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function runCli(
  stateRoot: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return run(process.execPath, [path.resolve("packages/cli/dist/main.js"), ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, ...extraEnv, ICARUS_HOME: stateRoot },
    timeoutMs: 180_000,
  });
}

export function jsonOutput<T>(result: ProcessResult): T {
  if (result.exitCode !== 0) {
    throw new Error(`CLI failed (${result.exitCode}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as T;
}

export async function repositoryFingerprint(repository: string): Promise<Record<string, string>> {
  const gitDirectory = (await git(repository, ["rev-parse", "--git-dir"])).trim();
  const worktrees = await readdir(path.resolve(repository, gitDirectory, "worktrees")).catch(
    () => [],
  );
  const index = await readFile(path.resolve(repository, gitDirectory, "index"));
  return {
    head: (await git(repository, ["rev-parse", "HEAD"])).trim(),
    status: await git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    refs: await git(repository, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    config: await git(repository, ["config", "--local", "--null", "--list"]),
    index: createHash("sha256").update(index).digest("hex"),
    worktrees: worktrees.sort().join("\n"),
  };
}

export interface OllamaRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

export interface QueuedProviderResponse {
  readonly content?: Record<string, unknown>;
  readonly status?: number;
  readonly rawBody?: string;
}

export async function startOllamaQueue(initial: readonly QueuedProviderResponse[]): Promise<{
  readonly baseUrl: string;
  readonly requests: OllamaRequest[];
  enqueue(...responses: readonly QueuedProviderResponse[]): void;
  close(): Promise<void>;
}> {
  const queue = [...initial];
  const requests: OllamaRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push({ url: request.url ?? "", body });
      const next = queue.shift();
      if (next === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"error":"provider queue exhausted"}');
        return;
      }
      response.writeHead(next.status ?? 200, { "content-type": "application/json" });
      response.end(
        next.rawBody ??
          JSON.stringify({
            message: { content: JSON.stringify(next.content ?? {}) },
            prompt_eval_count: 12,
            eval_count: 8,
          }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing provider address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    enqueue: (...responses) => queue.push(...responses),
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

export function planResponse(): QueuedProviderResponse {
  return {
    content: {
      summary: "Replace the operator-selected greeting.",
      steps: ["Apply one exact replacement", "Run the registered verification check"],
      risks: ["The exact preimage may have changed"],
      target: "src/greeting.txt",
      checkIds: ["verify"],
    },
  };
}

export function editResponse(preimageSha256: string): QueuedProviderResponse {
  return {
    content: {
      path: "src/greeting.txt",
      expectedPreimageSha256: preimageSha256,
      findText: "Hello, world!\n",
      replaceText: "Hello, Icarus!\n",
      rationale: "Implement the approved greeting change only.",
    },
  };
}
