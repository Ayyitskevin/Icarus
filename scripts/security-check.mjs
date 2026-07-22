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
const workspacePresenterSource = await readFile("packages/api/src/present.ts", "utf8");
const workspaceApiSource = await readFile("packages/workspace/src/api.ts", "utf8");
const verificationAttemptsUiSource = await readFile(
  "packages/workspace/src/verification-attempts.ts",
  "utf8",
);
const verificationAttemptsPanelSource = await readFile(
  "packages/workspace/src/VerificationAttemptsPanel.tsx",
  "utf8",
);
const workspaceUiSources = await collectSources(
  "packages/workspace/src",
  (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
);
const providerSource = await readFile("packages/core/src/providers.ts", "utf8");
const runtimeSource = await readFile("packages/core/src/runtime.ts", "utf8");
const storeSource = await readFile("packages/core/src/store.ts", "utf8");
const verificationProjectionSource = await readFile(
  "packages/core/src/verification-provenance.ts",
  "utf8",
);
const compactVerificationProjectionSource = verificationProjectionSource.replace(/\s+/g, " ");
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
const eventPageMethodStart = storeSource.indexOf("  listEventPage(");
const historyMethodStart = storeSource.indexOf("  listEventHistoryPage(");
const historyMethodEnd = storeSource.indexOf("\n  #appendEvent(", historyMethodStart);
const eventPageStoreSource =
  eventPageMethodStart >= 0 && historyMethodStart > eventPageMethodStart
    ? storeSource.slice(eventPageMethodStart, historyMethodStart)
    : "";
const historyStoreSource =
  historyMethodStart >= 0 && historyMethodEnd > historyMethodStart
    ? storeSource.slice(historyMethodStart, historyMethodEnd)
    : "";
const workspaceRunPageStart = storeSource.indexOf("  #workspaceRunPage(");
const workspaceRunPageEnd = storeSource.indexOf("\n  transition(", workspaceRunPageStart);
const workspaceRunPageSource =
  workspaceRunPageStart >= 0 && workspaceRunPageEnd > workspaceRunPageStart
    ? storeSource.slice(workspaceRunPageStart, workspaceRunPageEnd)
    : "";
const workspaceSnapshotStart = workspaceServerSource.indexOf("function workspaceSnapshot(");
const workspaceSnapshotEnd = workspaceServerSource.indexOf(
  "\nasync function routeApi(",
  workspaceSnapshotStart,
);
const workspaceSnapshotSource =
  workspaceSnapshotStart >= 0 && workspaceSnapshotEnd > workspaceSnapshotStart
    ? workspaceServerSource.slice(workspaceSnapshotStart, workspaceSnapshotEnd)
    : "";
const verificationRouteStart = workspaceServerSource.indexOf("  const runVerificationAttempts =");
const verificationRouteEnd = workspaceServerSource.indexOf(
  '  if (method === "GET" && runEventHistory !== null)',
  verificationRouteStart,
);
const verificationRouteSource =
  verificationRouteStart >= 0 && verificationRouteEnd > verificationRouteStart
    ? workspaceServerSource.slice(verificationRouteStart, verificationRouteEnd)
    : "";
const verificationPresenterStart = workspacePresenterSource.indexOf(
  "export function presentRunVerificationAttempts(",
);
const verificationPresenterEnd = workspacePresenterSource.indexOf(
  "\nexport function presentWorkspaceRunPage(",
  verificationPresenterStart,
);
const verificationPresenterSource =
  verificationPresenterStart >= 0 && verificationPresenterEnd > verificationPresenterStart
    ? workspacePresenterSource.slice(verificationPresenterStart, verificationPresenterEnd)
    : "";
const verificationApiRequestStart = workspaceApiSource.indexOf(
  "export function getRunVerificationAttempts(",
);
const verificationApiRequestEnd = workspaceApiSource.indexOf(
  "\nfunction normalizeContextPreview(",
  verificationApiRequestStart,
);
const verificationApiRequestSource =
  verificationApiRequestStart >= 0 && verificationApiRequestEnd > verificationApiRequestStart
    ? workspaceApiSource.slice(verificationApiRequestStart, verificationApiRequestEnd)
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
  workspaceRecentEventsMetadataOnly:
    eventPageStoreSource.includes("SELECT sequence, run_id, type, created_at") &&
    eventPageStoreSource.includes("ORDER BY sequence") &&
    eventPageStoreSource.includes("RUN_EVENT_PAGE_LIMIT + 1") &&
    !eventPageStoreSource.includes("payload_json"),
  workspaceVerificationProjectionBounded:
    verificationProjectionSource.includes(
      "export const RUN_VERIFICATION_ATTEMPT_EVENT_LIMIT = 200",
    ) &&
    verificationProjectionSource.includes("export const RUN_VERIFICATION_ATTEMPT_LIMIT = 8") &&
    verificationProjectionSource.includes("snapshot - RUN_VERIFICATION_ATTEMPT_EVENT_LIMIT + 1") &&
    verificationProjectionSource.includes("sequence >= ? AND sequence <= ?") &&
    (verificationProjectionSource.match(/LIMIT 200/g)?.length ?? 0) === 2 &&
    verificationProjectionSource.includes("anchors.slice(-RUN_VERIFICATION_ATTEMPT_LIMIT)") &&
    verificationProjectionSource.includes(
      "attemptAnchorsTruncatedWithinCoverage: anchors.length > RUN_VERIFICATION_ATTEMPT_LIMIT",
    ),
  workspaceVerificationProjectionSafeColumns:
    compactVerificationProjectionSource.includes(
      "SELECT id, CASE WHEN typeof(state) = 'text' AND octet_length(state) <= 32 THEN state ELSE NULL END AS state, CASE WHEN resume_state IS NULL THEN NULL WHEN typeof(resume_state) = 'text' AND octet_length(resume_state) <= 32 THEN resume_state ELSE 1 END AS resume_state FROM runs WHERE id = ?",
    ) &&
    compactVerificationProjectionSource.includes(
      "SELECT run_id, checkpoint_sha256, created_at FROM checkpoints WHERE run_id = ?",
    ) &&
    compactVerificationProjectionSource.includes(
      "SELECT sequence, run_id, type, created_at FROM run_events",
    ) &&
    !verificationProjectionSource.includes("SELECT *") &&
    !/(?:provider_json|base_commit|context_json|context_artifact_path|context_sha256|plan_json|plan_sha256|edit_json|cache_path|worktree_path|baseline_base64|approved_base64|verification_json|tool_calls|input_tokens|output_tokens|active_runtime_ms|estimated_cost_usd|reserved_cost_usd|error_code|error_message)/.test(
      verificationProjectionSource,
    ) &&
    !/(?:getRun|getCheckpoint|listEvents|getRunHistory)\(/.test(verificationProjectionSource),
  workspaceVerificationPayloadPreflighted:
    compactVerificationProjectionSource.includes(
      "SELECT sequence, typeof(payload_json) AS storage_type, octet_length(payload_json) AS payload_bytes FROM run_events WHERE run_id = ? AND sequence = ?",
    ) &&
    verificationProjectionSource.includes("const COMPLETION_PAYLOAD_LIMIT = 8 * 1024 * 1024") &&
    verificationProjectionSource.includes("const TRANSITION_PAYLOAD_LIMIT = 16 * 1024") &&
    verificationProjectionSource.includes("const CHECKPOINT_EVENT_PAYLOAD_LIMIT = 1024") &&
    verificationProjectionSource.includes(
      "preflightPayload(database, runId, event.sequence, COMPLETION_PAYLOAD_LIMIT)",
    ) &&
    verificationProjectionSource.includes(
      "preflightPayload(database, runId, event.sequence, TRANSITION_PAYLOAD_LIMIT)",
    ) &&
    verificationProjectionSource.includes(
      "preflightPayload(database, runId, event.sequence, CHECKPOINT_EVENT_PAYLOAD_LIMIT)",
    ) &&
    verificationProjectionSource.includes("json_valid(payload_json, 1)"),
  workspaceVerificationPayloadStaysInSql:
    !verificationProjectionSource.includes("JSON.parse(") &&
    !verificationProjectionSource.includes("JSON.stringify(") &&
    !/SELECT\s+payload_json(?:\s|,)/i.test(compactVerificationProjectionSource) &&
    !/payload_json\s+AS\s+payload_json/i.test(compactVerificationProjectionSource) &&
    !verificationPresenterSource.includes("payload") &&
    !verificationApiRequestSource.includes("JSON.parse(") &&
    !verificationAttemptsUiSource.includes("JSON.parse("),
  workspaceVerificationPresenterAllowlists:
    [
      "runId: snapshot.runId",
      "snapshot: snapshot.snapshot",
      "firstSequence: snapshot.coverage.firstSequence",
      "attemptAnchorsTruncatedWithinCoverage:",
      "identity: attempt.identity",
      "anchorSequence: attempt.anchorSequence",
      "startSequence: attempt.startSequence",
      "startedAt: attempt.startedAt",
      "startProvenance: attempt.startProvenance",
      "status: attempt.status",
      "endSequence: attempt.endSequence",
      "endedAt: attempt.endedAt",
      "diffSha256: attempt.diffSha256",
      "checkpointSha256: attempt.checkpointSha256",
      "checkpointProvenance: attempt.checkpointProvenance",
      "laterAttemptObservedWithinCoverage: attempt.laterAttemptObservedWithinCoverage",
    ].every((field) => verificationPresenterSource.includes(field)) &&
    !/\.\.\.(?:snapshot|attempt|checkpoint)/.test(verificationPresenterSource) &&
    !/(?:payloadJson|rawPayload|baselineBase64|approvedBase64|checks|argv|stdout|stderr|actor|error)/.test(
      verificationPresenterSource,
    ),
  workspaceVerificationRouteReadOnly:
    verificationRouteSource.includes('if (method === "GET" && runVerificationAttempts !== null)') &&
    verificationRouteSource.includes("runVerificationAttemptsQuery(searchParams)") &&
    verificationRouteSource.includes("presentRunVerificationAttempts(") &&
    verificationRouteSource.includes("service.getRunVerificationAttempts(runId, snapshot)") &&
    !/(?:POST|PUT|PATCH|DELETE|readJson|approve|execute|commit|push|deploy)/.test(
      verificationRouteSource,
    ) &&
    verificationApiRequestSource.includes("requestJson<unknown>(") &&
    verificationApiRequestSource.includes("/verification-attempts?snapshot=") &&
    !/(?:method:|body:|JSON\.stringify|postJson)/.test(verificationApiRequestSource),
  workspaceVerificationUiHasNoUnsafeSinks:
    [verificationAttemptsUiSource, verificationAttemptsPanelSource].every(
      (source) =>
        !/(?:dangerouslySetInnerHTML|innerHTML|window\.open|window\.location|location\.(?:assign|replace)|<a\b|href\s*=|<form\b|formAction|onSubmit)/.test(
          source,
        ),
    ) &&
    !/(?:postJson|createProject|createRun|planRun|approve|execute|commit|push|deploy)\(/.test(
      verificationAttemptsPanelSource,
    ),
  workspaceRunSummaryMetadataOnly:
    workspaceRunPageSource.includes("SELECT CAST(rowid AS TEXT) AS cursor") &&
    workspaceRunPageSource.includes(
      "id, project_id, task, target, state, created_at, updated_at",
    ) &&
    workspaceRunPageSource.includes("WHERE rowid < ? AND rowid <= ?") &&
    workspaceRunPageSource.includes("ORDER BY rowid DESC") &&
    workspaceRunPageSource.includes("LIMIT 13") &&
    !/(?:provider_json|resume_state|base_commit|context_json|context_artifact_path|context_sha256|plan_json|plan_sha256|edit_json|cache_path|worktree_path|baseline_base64|approved_base64|diff|verification_json|tool_calls|input_tokens|output_tokens|active_runtime_ms|estimated_cost_usd|reserved_cost_usd|error_code|error_message|version)/.test(
      workspaceRunPageSource,
    ),
  workspaceBootstrapUsesBoundedRunPage:
    workspaceSnapshotSource.includes("openWorkspaceRunPage()") &&
    workspaceSnapshotSource.includes("presentWorkspaceRunPage") &&
    workspaceSnapshotSource.includes("runPage:") &&
    !workspaceSnapshotSource.includes("listRuns(") &&
    !workspaceSnapshotSource.includes("presentationSnapshot(") &&
    !workspaceSnapshotSource.includes("presentRun("),
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
