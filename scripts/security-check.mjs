import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function collectTestSources(directory) {
  const sources = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await collectTestSources(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      sources.push(await readFile(entryPath, "utf8"));
    }
  }
  return sources;
}

const processSource = await readFile("packages/core/src/process.ts", "utf8");
const sandboxSource = await readFile("packages/core/src/sandbox.ts", "utf8");
const providerSource = await readFile("packages/core/src/providers.ts", "utf8");
const runtimeSource = await readFile("packages/core/src/runtime.ts", "utf8");
const ignore = await readFile(".gitignore", "utf8");
const testSources = await collectTestSources("tests");

const assertions = {
  controllerNeverUsesShell:
    processSource.includes("shell: false") && !processSource.includes("shell: true"),
  dockerNetworkDisabled: sandboxSource.includes('"--network"') && sandboxSource.includes('"none"'),
  dockerRootReadOnly: sandboxSource.includes('"--read-only"'),
  dockerCapabilitiesDropped:
    sandboxSource.includes('"--cap-drop"') && sandboxSource.includes('"ALL"'),
  dockerNoPrivilegeEscalation: sandboxSource.includes('"no-new-privileges:true"'),
  dockerNeverPulls: sandboxSource.includes('"--pull"') && sandboxSource.includes('"never"'),
  providerRedirectsManual: providerSource.includes('redirect: "manual"'),
  openaiDoesNotStore: providerSource.includes("store: false"),
  providersExposeNoTools:
    providerSource.includes("tools: []") && providerSource.includes('tool_choice: "none"'),
  dedicatedStateMarker: runtimeSource.includes(".icarus-state-v1"),
  environmentFilesIgnored: ignore.split(/\r?\n/).includes(".env") && ignore.includes(".env.*"),
  noFocusedOrSkippedGateTests: testSources.every(
    (source) => !/\.(?:only|skip|todo)(?:\s*\(|\.)/.test(source),
  ),
};

const failed = Object.entries(assertions)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
process.stdout.write(`${JSON.stringify({ assertions, failed }, null, 2)}\n`);
if (failed.length > 0) process.exitCode = 1;
