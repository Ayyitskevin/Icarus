import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { startWorkspaceServer } from "../packages/api/dist/server.js";
import { createIcarusRuntime } from "../packages/core/dist/index.js";

const SANDBOX_IMAGE = `python:3.12-slim@sha256:${"c".repeat(64)}`;

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function fingerprint(repository) {
  const gitDirectory = git(repository, ["rev-parse", "--git-dir"]).trim();
  const worktrees = await readdir(path.resolve(repository, gitDirectory, "worktrees")).catch(
    () => [],
  );
  const index = await readFile(path.resolve(repository, gitDirectory, "index"));
  return {
    head: git(repository, ["rev-parse", "HEAD"]).trim(),
    status: git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    refs: git(repository, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    config: git(repository, ["config", "--local", "--null", "--list"]),
    indexSha256: createHash("sha256").update(index).digest("hex"),
    worktrees: worktrees.sort().join("\n"),
    targetSha256: createHash("sha256")
      .update(await readFile(path.join(repository, "src", "app.txt")))
      .digest("hex"),
  };
}

async function post(url, value) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Workspace HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function startProvider() {
  let requests = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests += 1;
      JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              summary: "Inspect one exact local target before any guarded execution.",
              steps: ["Review the selected target", "Run the registered check only after approval"],
              risks: ["This workspace smoke stops before execution"],
              target: "src/app.txt",
              checkIds: ["verify"],
            }),
          },
          prompt_eval_count: 12,
          eval_count: 8,
        }),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Provider did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests: () => requests,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), "icarus-workspace-smoke-"));
let runtime;
let workspace;
let provider;
try {
  const repository = path.join(root, "repository");
  const stateRoot = path.join(root, "state");
  await mkdir(path.join(repository, "src"), { recursive: true });
  await writeFile(path.join(repository, "README.md"), "# Workspace smoke fixture\n");
  await writeFile(path.join(repository, "src", "app.txt"), "local state stays untouched\n");
  await writeFile(path.join(repository, ".gitignore"), "ignored.txt\nnode_modules/\n");
  await writeFile(path.join(repository, "ignored.txt"), "never enters context\n");
  await mkdir(path.join(repository, "node_modules"));
  await writeFile(path.join(repository, "node_modules", "ignored.js"), "ignored\n");
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.name", "Icarus Smoke"]);
  git(repository, ["config", "user.email", "icarus@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  const before = await fingerprint(repository);

  provider = await startProvider();
  runtime = await createIcarusRuntime(stateRoot);
  workspace = await startWorkspaceServer(
    {
      runtime,
      stateRoot,
      workspaceDist: path.resolve("packages/workspace/dist"),
    },
    0,
  );
  const project = await post(`${workspace.url}/api/projects`, {
    repository: { name: "smoke-repository", path: repository },
    project: {
      name: "smoke-project",
      baseRef: "main",
      sandboxImage: SANDBOX_IMAGE,
      checks: [{ id: "verify", name: "Verify", argv: ["node", "--test"] }],
    },
  });
  const preview = await post(`${workspace.url}/api/projects/${project.id}/context-preview`, {
    target: "src/app.txt",
  });
  const repeatedPreview = await post(
    `${workspace.url}/api/projects/${project.id}/context-preview`,
    { target: "src/app.txt" },
  );
  if (
    JSON.stringify(preview) !== JSON.stringify(repeatedPreview) ||
    !preview.selected.some((entry) => entry.path === "src/app.txt") ||
    JSON.stringify(preview).includes("local state stays untouched")
  ) {
    throw new Error("Context preview was not deterministic metadata-only evidence");
  }
  const draft = await post(`${workspace.url}/api/runs`, {
    projectId: project.id,
    task: "Inspect a bounded local change request.",
    target: "src/app.txt",
    provider: { model: "smoke-contract", baseUrl: provider.baseUrl },
  });
  if (draft.state !== "preparing" || draft.phase !== "draft" || provider.requests() !== 0) {
    throw new Error("Draft was not persisted before provider work");
  }
  const provenanceResponse = await fetch(
    `${workspace.url}/api/runs/${draft.id}/verification-attempts?snapshot=${String(draft.eventCursor)}`,
  );
  const provenance = await provenanceResponse.json();
  if (
    !provenanceResponse.ok ||
    provenance.runId !== draft.id ||
    provenance.snapshot !== draft.eventCursor ||
    provenance.coverage?.eventLimit !== 200 ||
    provenance.attemptLimit !== 8 ||
    provenance.checkpoint?.status !== "not_saved" ||
    provenance.attempts?.length !== 0
  ) {
    throw new Error("Bounded verification provenance did not preserve the empty evidence state");
  }
  await workspace.close();
  workspace = undefined;
  runtime.close();
  runtime = undefined;

  runtime = await createIcarusRuntime(stateRoot);
  workspace = await startWorkspaceServer(
    { runtime, stateRoot, workspaceDist: path.resolve("packages/workspace/dist") },
    0,
  );
  const draftResponse = await fetch(`${workspace.url}/api/runs/${draft.id}`);
  const persistedDraft = await draftResponse.json();
  if (
    !draftResponse.ok ||
    persistedDraft.state !== "preparing" ||
    persistedDraft.phase !== "draft" ||
    provider.requests() !== 0
  ) {
    throw new Error("Draft was not recovered before planning after restart");
  }
  const planned = await post(`${workspace.url}/api/runs/${draft.id}/plan`, {});
  if (
    planned.state !== "awaiting_approval" ||
    planned.verification?.outcome !== "not_run" ||
    provider.requests() !== 1
  ) {
    throw new Error("Plan did not stop truthfully at the approval gate");
  }
  await workspace.close();
  workspace = undefined;
  runtime.close();
  runtime = undefined;

  runtime = await createIcarusRuntime(stateRoot);
  workspace = await startWorkspaceServer(
    { runtime, stateRoot, workspaceDist: path.resolve("packages/workspace/dist") },
    0,
  );
  const persistedResponse = await fetch(`${workspace.url}/api/runs/${draft.id}`);
  const persisted = await persistedResponse.json();
  if (!persistedResponse.ok || persisted.state !== "awaiting_approval") {
    throw new Error("Persisted run was not recovered after restart");
  }
  const indexResponse = await fetch(workspace.url);
  const indexHtml = await indexResponse.text();
  if (
    !indexResponse.ok ||
    !indexHtml.includes("Icarus") ||
    indexResponse.headers.get("content-security-policy") === null ||
    indexResponse.headers.has("access-control-allow-origin")
  ) {
    throw new Error("Production workspace entry was not served with the local security headers");
  }
  const assetPaths = Array.from(
    indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g),
    (match) => match[1],
  );
  if (assetPaths.length === 0 || !assetPaths.some((assetPath) => assetPath.endsWith(".js"))) {
    throw new Error("Production workspace entry did not reference its compiled module asset");
  }
  for (const assetPath of assetPaths) {
    const assetResponse = await fetch(`${workspace.url}${assetPath}`);
    const contentType = assetResponse.headers.get("content-type") ?? "";
    const expectedType = assetPath.endsWith(".js")
      ? "text/javascript"
      : assetPath.endsWith(".css")
        ? "text/css"
        : "";
    if (
      !assetResponse.ok ||
      (expectedType.length > 0 && !contentType.startsWith(expectedType)) ||
      assetResponse.headers.get("content-security-policy") === null ||
      assetResponse.headers.has("access-control-allow-origin") ||
      (await assetResponse.arrayBuffer()).byteLength === 0
    ) {
      throw new Error(`Production workspace asset was not served safely: ${assetPath}`);
    }
  }
  const after = await fingerprint(repository);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Imported source repository changed during workspace smoke");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        binding: workspace.host,
        projectId: project.id,
        contextDigest: preview.digest,
        runId: draft.id,
        state: persisted.state,
        verification: persisted.verification.outcome,
        providerRequests: provider.requests(),
        assetsServed: assetPaths.length,
        sourceUnchanged: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await workspace?.close();
  runtime?.close();
  await provider?.close();
  await rm(root, { recursive: true, force: true });
}
