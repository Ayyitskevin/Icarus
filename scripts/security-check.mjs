import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function collectSources(directory, include) {
  const sources = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await collectSources(entryPath, include)));
    } else if (entry.isFile() && include(entry.name)) {
      sources.push(await readFile(entryPath, "utf8"));
    }
  }
  return sources;
}

const processSource = await readFile("packages/core/src/process.ts", "utf8");
const gitSource = await readFile("packages/core/src/git.ts", "utf8");
const sandboxSource = await readFile("packages/core/src/sandbox.ts", "utf8");
const workspaceServerSource = await readFile("packages/api/src/server.ts", "utf8");
const workspaceUiSources = await collectSources(
  "packages/workspace/src",
  (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
);
const providerSource = await readFile("packages/core/src/providers.ts", "utf8");
const runtimeSource = await readFile("packages/core/src/runtime.ts", "utf8");
const storeSource = await readFile("packages/core/src/store.ts", "utf8");
const actionlintToolSource = await readFile("scripts/actionlint-tool.mjs", "utf8");
const actionlintSetupSource = await readFile("scripts/setup-actionlint.mjs", "utf8");
const workflowLintSource = await readFile("scripts/workflow-lint.mjs", "utf8");
const packageSource = await readFile("package.json", "utf8");
const packageJson = JSON.parse(packageSource);
const ciWorkflowSource = await readFile(".github/workflows/ci.yml", "utf8");
const workflowSetupIndex = ciWorkflowSource.indexOf("run: pnpm workflow:setup");
const workflowLintIndex = ciWorkflowSource.indexOf("run: pnpm workflow:lint");
const frozenInstallIndex = ciWorkflowSource.indexOf("run: pnpm install --frozen-lockfile");
const ignore = await readFile(".gitignore", "utf8");
const testSources = await collectSources("tests", (name) => name.endsWith(".test.ts"));
const historyMethodStart = storeSource.indexOf("  listEventHistoryPage(");
const historyMethodEnd = storeSource.indexOf("\n  #appendEvent(", historyMethodStart);
const historyStoreSource =
  historyMethodStart >= 0 && historyMethodEnd > historyMethodStart
    ? storeSource.slice(historyMethodStart, historyMethodEnd)
    : "";

const assertions = {
  controllerNeverUsesShell:
    processSource.includes("shell: false") && !processSource.includes("shell: true"),
  gitLazyFetchDisabled: gitSource.includes('GIT_NO_LAZY_FETCH: "1"'),
  gitTransportRestricted:
    gitSource.includes('GIT_ALLOW_PROTOCOL: "file"') &&
    gitSource.includes('GIT_PROTOCOL_FROM_USER: "0"') &&
    gitSource.includes('"protocol.allow=never"') &&
    gitSource.includes('"protocol.file.allow=always"'),
  gitUnsafeConfigurationRejected:
    gitSource.includes("UNSAFE_REPOSITORY_CONFIG_PATTERN") &&
    gitSource.includes("clean|smudge|process") &&
    gitSource.includes("core\\\\.alternaterefscommand") &&
    gitSource.includes("hook\\\\..*\\\\.command") &&
    gitSource.includes('"hook.post-checkout.enabled=false"') &&
    gitSource.includes('"--includes"') &&
    gitSource.includes('"--name-only"') &&
    gitSource.includes('"GIT_UNSAFE_CONFIGURATION"'),
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
  workflowBootstrapPinnedAndBounded:
    actionlintToolSource.includes('ACTIONLINT_VERSION = "1.7.12"') &&
    actionlintToolSource.includes("archiveSha256") &&
    actionlintToolSource.includes("binarySha256") &&
    actionlintSetupSource.includes("AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)") &&
    actionlintSetupSource.includes("MAX_ARCHIVE_BYTES") &&
    actionlintSetupSource.includes("constants.COPYFILE_EXCL") &&
    actionlintSetupSource.includes("ensureRealDirectory(path.dirname(binaryPath))"),
  workflowLintFailClosed:
    packageJson.scripts?.["workflow:setup"] === "node scripts/setup-actionlint.mjs" &&
    packageJson.scripts?.["workflow:lint"] === "node scripts/workflow-lint.mjs" &&
    packageJson.scripts?.check?.startsWith("pnpm workflow:lint &&") &&
    workflowSetupIndex >= 0 &&
    workflowSetupIndex < workflowLintIndex &&
    workflowLintIndex < frozenInstallIndex &&
    workflowLintSource.includes('"no GitHub Actions workflow files were found"') &&
    workflowLintSource.includes('"known-invalid.yml"') &&
    workflowLintSource.includes('"actionlint accepted the known-invalid self-test workflow"') &&
    workflowLintSource.includes("verifyDefaultBinaryAncestors") &&
    workflowLintSource.includes('"-shellcheck="') &&
    workflowLintSource.includes('"-pyflakes="'),
  workspaceFixedLoopback:
    workspaceServerSource.includes('server.listen(port, "127.0.0.1"') &&
    !workspaceServerSource.includes('"0.0.0.0"'),
  workspaceNoCorsGrant: !workspaceServerSource
    .toLowerCase()
    .includes("access-control-allow-origin"),
  workspaceBoundedJson:
    workspaceServerSource.includes("MAX_BODY_BYTES") &&
    workspaceServerSource.includes('"application/json"'),
  workspaceNoExecutionRoutes: !/\/(?:approve|execute|checks|commit|push|deploy)/.test(
    workspaceServerSource,
  ),
  workspaceHistoryMetadataOnly:
    historyStoreSource.includes("SELECT sequence, run_id, type, created_at") &&
    historyStoreSource.includes("ORDER BY sequence DESC") &&
    historyStoreSource.includes("RUN_EVENT_PAGE_LIMIT + 1") &&
    !historyStoreSource.includes("payload_json"),
  workspaceNoRawHtml: workspaceUiSources.every(
    (source) => !source.includes("dangerouslySetInnerHTML") && !source.includes("innerHTML"),
  ),
  noFocusedOrSkippedGateTests: testSources.every(
    (source) => !/\.(?:only|skip|todo)(?:\s*\(|\.)/.test(source),
  ),
};

const failed = Object.entries(assertions)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
process.stdout.write(`${JSON.stringify({ assertions, failed }, null, 2)}\n`);
if (failed.length > 0) process.exitCode = 1;
