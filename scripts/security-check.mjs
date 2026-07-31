import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  validateCiWorkflowSupplyChain,
  validateWorkflowAttributes,
} from "./ci-workflow-policy.mjs";

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
const workspaceSessionSource = await readFile("packages/api/src/workspace-session.ts", "utf8");
const workspacePresenterSource = await readFile("packages/api/src/present.ts", "utf8");
const workspaceApiSource = await readFile("packages/workspace/src/api.ts", "utf8");
const workspaceAppSource = await readFile("packages/workspace/src/App.tsx", "utf8");
const workspaceStyleSource = await readFile("packages/workspace/src/styles.css", "utf8");
const browserSmokeSource = await readFile("scripts/smoke-workspace-browser.mjs", "utf8");
const workspaceSmokeSource = await readFile("scripts/smoke-workspace.mjs", "utf8");
const workspaceLivePollSource = await readFile("packages/workspace/src/live-poll.ts", "utf8");
const workspaceProjectPageNavSource = await readFile(
  "packages/workspace/src/project-page-nav.ts",
  "utf8",
);
const cliSource = await readFile("packages/cli/src/main.ts", "utf8");
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
const policySource = await readFile("packages/core/src/policy.ts", "utf8");
const serviceSource = await readFile("packages/core/src/service.ts", "utf8");
const runtimeSource = await readFile("packages/core/src/runtime.ts", "utf8");
const storeSource = await readFile("packages/core/src/store.ts", "utf8");
const typesSource = await readFile("packages/core/src/types.ts", "utf8");
const readManifestSource = await readFile("packages/core/src/read-manifest.ts", "utf8");
const toolsSource = await readFile("packages/core/src/tools.ts", "utf8");
const sessionLoopSource = await readFile("packages/core/src/session-loop.ts", "utf8");
const verificationProjectionSource = await readFile(
  "packages/core/src/verification-provenance.ts",
  "utf8",
);
const compactVerificationProjectionSource = verificationProjectionSource.replace(/\s+/g, " ");
const actionlintToolSource = await readFile("scripts/actionlint-tool.mjs", "utf8");
const actionlintSetupSource = await readFile("scripts/setup-actionlint.mjs", "utf8");
const workflowLintSource = await readFile("scripts/workflow-lint.mjs", "utf8");
const inheritedWorkflowSource = await readFile(".github/workflows/opencode.yml", "utf8");
const packageSource = await readFile("package.json", "utf8");
const packageJson = JSON.parse(packageSource);
const ciWorkflowSource = await readFile(".github/workflows/ci.yml", "utf8");
const gitAttributesSource = await readFile(".gitattributes", "utf8");
let ciWorkflowSupplyChainPinned = false;
try {
  validateCiWorkflowSupplyChain(ciWorkflowSource);
  ciWorkflowSupplyChainPinned = true;
} catch {
  // The named assertion below reports policy drift without widening the gate.
}
let workflowLineEndingsPinned = false;
try {
  validateWorkflowAttributes(gitAttributesSource);
  workflowLineEndingsPinned = true;
} catch {
  // The named assertion below reports policy drift without widening the gate.
}
const workflowSetupIndex = ciWorkflowSource.indexOf("run: pnpm workflow:setup");
const workflowLintIndex = ciWorkflowSource.indexOf("run: pnpm workflow:lint");
const frozenInstallIndex = ciWorkflowSource.indexOf("run: pnpm install --frozen-lockfile");
const workspaceListenIndex = workspaceServerSource.indexOf(
  "await binding.listen(server, port, REVIEW_ONLY_WORKSPACE_HOST)",
);
const workspaceExactAddressIndex = workspaceServerSource.indexOf(
  "address.address !== REVIEW_ONLY_WORKSPACE_HOST",
);
const workspaceOriginHostnameIndex = workspaceServerSource.indexOf("const originHostname =");
const workspaceSessionCreationIndex = workspaceServerSource.indexOf(
  "session = createBoundWorkspaceSession(mode, address.port, originHostname, reviewOnlyReason)",
);
const ignore = await readFile(".gitignore", "utf8");
const testSources = await collectSources("tests", (name) => name.endsWith(".test.ts"));
const repairSessionStart = serviceSource.indexOf("  async #runRepairSession(");
const repairSessionEnd = serviceSource.indexOf(
  "\n  async #recoverUnsettledSessionPatch(",
  repairSessionStart,
);
const repairSessionSource =
  repairSessionStart >= 0 && repairSessionEnd > repairSessionStart
    ? serviceSource.slice(repairSessionStart, repairSessionEnd)
    : "";
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
const workspaceProjectPageStart = storeSource.indexOf("  #workspaceProjectPage(");
const workspaceProjectPageEnd = storeSource.indexOf("\n  createRun(", workspaceProjectPageStart);
const workspaceProjectPageSource =
  workspaceProjectPageStart >= 0 && workspaceProjectPageEnd > workspaceProjectPageStart
    ? storeSource.slice(workspaceProjectPageStart, workspaceProjectPageEnd)
    : "";
const boundedProjectColumnsStart = storeSource.indexOf("const BOUNDED_PROJECT_COLUMNS =");
const boundedProjectColumnsEnd = storeSource.indexOf(
  "\nconst RUN_ID_PATTERN",
  boundedProjectColumnsStart,
);
const boundedProjectColumnsSource =
  boundedProjectColumnsStart >= 0 && boundedProjectColumnsEnd > boundedProjectColumnsStart
    ? storeSource.slice(boundedProjectColumnsStart, boundedProjectColumnsEnd)
    : "";
const directHydrationStart = storeSource.indexOf("  getRepository(");
const directHydrationEnd = storeSource.indexOf(
  "\n  openWorkspaceProjectPage(",
  directHydrationStart,
);
const directHydrationSource =
  directHydrationStart >= 0 && directHydrationEnd > directHydrationStart
    ? storeSource.slice(directHydrationStart, directHydrationEnd)
    : "";
const jsonSerializerStart = workspaceServerSource.indexOf("export function serializeJsonResponse(");
const jsonSerializerEnd = workspaceServerSource.indexOf("\nfunction json(", jsonSerializerStart);
const jsonSerializerSource =
  jsonSerializerStart >= 0 && jsonSerializerEnd > jsonSerializerStart
    ? workspaceServerSource.slice(jsonSerializerStart, jsonSerializerEnd)
    : "";
const approvalProjectionStart = storeSource.indexOf("  getRunPresentationSnapshot(");
const approvalProjectionEnd = storeSource.indexOf("\n  listEventPage(", approvalProjectionStart);
const approvalProjectionSource =
  approvalProjectionStart >= 0 && approvalProjectionEnd > approvalProjectionStart
    ? storeSource.slice(approvalProjectionStart, approvalProjectionEnd)
    : "";
const approvalRowStart = storeSource.indexOf("function approvalRecordRow(");
const approvalRowEnd = storeSource.indexOf("\nfunction sqliteRowid(", approvalRowStart);
const approvalRowSource =
  approvalRowStart >= 0 && approvalRowEnd > approvalRowStart
    ? storeSource.slice(approvalRowStart, approvalRowEnd)
    : "";
const approvalPresenterStart = workspacePresenterSource.indexOf("function approvals(");
const approvalPresenterEnd = workspacePresenterSource.indexOf(
  "\nexport function presentRun(",
  approvalPresenterStart,
);
const approvalPresenterSource =
  approvalPresenterStart >= 0 && approvalPresenterEnd > approvalPresenterStart
    ? workspacePresenterSource.slice(approvalPresenterStart, approvalPresenterEnd)
    : "";
const diffPresenterStart = workspacePresenterSource.indexOf(
  "export const WORKSPACE_DIFF_DISPLAY_MAX_BYTES",
);
const diffPresenterEnd = workspacePresenterSource.indexOf(
  "\nexport function presentRun(",
  diffPresenterStart,
);
const diffPresenterSource =
  diffPresenterStart >= 0 && diffPresenterEnd > diffPresenterStart
    ? workspacePresenterSource.slice(diffPresenterStart, diffPresenterEnd)
    : "";
const diffUiStart = workspaceAppSource.indexOf('id="run-diff"');
const diffUiEnd = workspaceAppSource.indexOf('id="run-outputs"', diffUiStart);
const diffUiSource =
  diffUiStart >= 0 && diffUiEnd > diffUiStart
    ? workspaceAppSource.slice(diffUiStart, diffUiEnd)
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
  ciWorkflowSupplyChainPinned,
  workflowLineEndingsPinned,
  workspaceFixedLoopback:
    workspaceServerSource.includes("server.listen(port, host") &&
    workspaceServerSource.includes("createMutationHostname: createWorkspaceMutationHostname") &&
    workspaceServerSource.includes("listen: listenOnExactHost") &&
    workspaceSessionSource.includes('export const REVIEW_ONLY_WORKSPACE_HOST = "127.0.0.1"') &&
    workspaceServerSource.includes("address.address !== REVIEW_ONLY_WORKSPACE_HOST") &&
    workspaceListenIndex >= 0 &&
    workspaceExactAddressIndex > workspaceListenIndex &&
    workspaceServerSource.includes('address.family !== "IPv4"') &&
    workspaceServerSource.includes("if (server.listening) await closeListeningServer(server)") &&
    !workspaceServerSource.includes('"0.0.0.0"') &&
    !workspaceServerSource.includes('"::"'),
  workspaceRandomLocalhostOrigin:
    workspaceSessionSource.includes("const ORIGIN_NONCE_BYTES = 16") &&
    workspaceSessionSource.includes("const nonce = Buffer.from(random(ORIGIN_NONCE_BYTES))") &&
    workspaceSessionSource.includes("nonce.byteLength !== ORIGIN_NONCE_BYTES") &&
    workspaceSessionSource.includes('nonce.toString("hex")}.localhost') &&
    workspaceSessionSource.includes("/^[a-f0-9]{32}\\.localhost$/") &&
    workspaceServerSource.includes("binding.createMutationHostname()") &&
    workspaceServerSource.includes("!isWorkspaceMutationHostname(originHostname)"),
  workspaceSessionCreatedOnlyAfterExactBind:
    workspaceOriginHostnameIndex > workspaceExactAddressIndex &&
    workspaceSessionCreationIndex > workspaceOriginHostnameIndex &&
    workspaceServerSource.indexOf(
      'server.on("request", workspaceRequestListener(options, session))',
    ) > workspaceSessionCreationIndex &&
    workspaceSessionSource.includes("const bearer = Buffer.from(random(BEARER_BYTES))") &&
    workspaceSessionSource.includes(
      "return new BoundWorkspaceSession(mode, port, hostname, reviewOnlyReason, random)",
    ),
  workspaceAllNonReadMethodsRequireMutationAuthority:
    workspaceServerSource.includes('if (request.method === "GET" || request.method === "HEAD")') &&
    workspaceServerSource.includes("session.assertOptionalExactOrigin(request)") &&
    workspaceServerSource.includes("session.assertProtectedMutation(request)"),
  workspaceNoResolverOrBindFallback:
    !/(?:node:dns|dns\.lookup|getaddrinfo)/.test(
      `${workspaceServerSource}\n${workspaceSessionSource}`,
    ) &&
    !workspaceServerSource.includes("EADDRNOTAVAIL") &&
    !workspaceServerSource.includes("fresh-loopback-unavailable") &&
    (workspaceServerSource.match(/server\.listen\(/g)?.length ?? 0) === 1,
  workspaceSmokesPreservePublicOriginWithoutResolverInjection:
    workspaceSmokeSource.includes("agent: false") &&
    workspaceSmokeSource.includes("hostname: workspace.host") &&
    workspaceSmokeSource.includes("host: target.host") &&
    workspaceSmokeSource.includes("origin: workspace.url") &&
    !workspaceSmokeSource.includes("fetch(") &&
    browserSmokeSource.includes("agent: false") &&
    browserSmokeSource.includes("hostname: workspace.host") &&
    browserSmokeSource.includes("host: target.host") &&
    browserSmokeSource.includes("origin: workspace.url") &&
    browserSmokeSource.includes('"Page.navigate", { url: launchUrl }') &&
    !browserSmokeSource.includes("fetch(") &&
    !browserSmokeSource.includes("--host-resolver-rules"),
  browserSmokeFlagsAreTestOnly:
    browserSmokeSource.includes("const SMOKE_ONLY_CHROMIUM_FLAGS = Object.freeze([") &&
    browserSmokeSource.includes("Product launches must never inherit this test-only flag set") &&
    browserSmokeSource.includes("...SMOKE_ONLY_CHROMIUM_FLAGS"),
  browserSmokeRecordsExactBinaryAndVersion:
    browserSmokeSource.includes('chromium.cdp.send("Browser.getVersion")') &&
    browserSmokeSource.includes("executable: selectedChromiumExecutable") &&
    browserSmokeSource.includes("product: chromiumVersion.product") &&
    browserSmokeSource.includes("protocolVersion: chromiumVersion.protocolVersion") &&
    browserSmokeSource.includes("userAgent: chromiumVersion.userAgent"),
  workspaceNoCorsGrant: !workspaceServerSource
    .toLowerCase()
    .includes("access-control-allow-origin"),
  workspaceBoundedJson:
    workspaceServerSource.includes("MAX_BODY_BYTES") &&
    workspaceServerSource.includes('"application/json"'),
  workspaceNoExecutionRoutes:
    !/\/(?:approve|execute|checks|edit|rerun|review|rollback|restore|commit|push|deploy|merge)/.test(
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
  workspaceApprovalProjectionBounded:
    storeSource.includes("export const RUN_PRESENTATION_APPROVAL_LIMIT = 12") &&
    storeSource.includes("CREATE INDEX IF NOT EXISTS approvals_by_run") &&
    storeSource.includes("ON approvals(run_id)") &&
    ["run_id", "kind", "digest", "actor", "decision", "created_at"].every((column) =>
      approvalProjectionSource.includes(`typeof(${column}) = 'text'`),
    ) &&
    (approvalProjectionSource.match(/octet_length\(/g)?.length ?? 0) === 6 &&
    approvalProjectionSource.includes("ORDER BY approvals.rowid DESC LIMIT ?") &&
    approvalProjectionSource.includes("RUN_PRESENTATION_APPROVAL_LIMIT + 1") &&
    approvalProjectionSource.includes(
      "approvalRows.map((entry) => approvalRecordRow(entry, runId))",
    ) &&
    approvalProjectionSource.includes(".slice(0, RUN_PRESENTATION_APPROVAL_LIMIT)") &&
    approvalProjectionSource.includes("earlierApprovalsExcluded") &&
    !approvalProjectionSource.includes("this.listApprovals(") &&
    !approvalProjectionSource.includes("SELECT *"),
  workspaceApprovalIndexMigrationHumanGated:
    storeSource.includes("allowApprovalIndexMigration") &&
    storeSource.includes("new Database(databasePath, { readonly: true, fileMustExist: true })") &&
    storeSource.includes("PRAGMA index_xinfo('approvals_by_run')") &&
    storeSource.includes('"DATABASE_MIGRATION_REQUIRED"') &&
    cliSource.includes("ICARUS_APPROVE_SCHEMA_MIGRATION") &&
    cliSource.includes('"approval-index-v1"') &&
    cliSource.includes("allowApprovalIndexMigration: migrationApproval.approvalIndex"),
  patchSetMigrationHumanGated:
    storeSource.includes("allowPatchSetMigration") &&
    storeSource.includes("function inspectPatchSetSchema") &&
    storeSource.includes("PRAGMA table_info('") &&
    storeSource.includes("expected.columns.every((column, index) => columns[index] === column)") &&
    storeSource.includes(
      "Patch-set migration requires a state backup and explicit operator approval",
    ) &&
    cliSource.includes('"patch-set-v2"') &&
    cliSource.includes("allowPatchSetMigration: migrationApproval.patchSet"),
  patchSetBoundsEveryPathAndOperation: [
    "approvedTargets.has(editPath)",
    "Patch set changed a path outside the approved targets",
    "assertAllowedTarget(asBoundedString(object.path",
    "Patch set changes the same path twice",
    "FILE_BUDGET_EXCEEDED",
    "STALE_PREIMAGE",
  ].every((fragment) => policySource.includes(fragment)),
  patchSetApplicationStagesBeforeApplying:
    gitSource.includes("async applyFileWrites(") &&
    gitSource.includes("await this.#stageContent(privateRunRoot") &&
    gitSource.includes("const privateRunRoot = path.dirname(path.resolve(worktreePath))") &&
    gitSource.includes("for (const entry of [...applied].reverse())"),
  patchSetVerificationRequiresExactPathSet:
    serviceSource.includes("samePathSet(preflightChangedPaths, patchPaths)") &&
    serviceSource.includes("samePathSet(finalChangedPaths, patchPaths)") &&
    serviceSource.includes("samePathSet(changedPaths, patchPaths)") &&
    storeSource.includes("this.#changedPathsMatchPatchSet(current, verification.changedPaths)"),
  patchSetIntentPrecedesWorktreeWrites:
    serviceSource.includes("run = this.#store.recordPatchSetIntent(runId, patchSet, files)") &&
    serviceSource.indexOf("recordPatchSetIntent(runId, patchSet, files)") <
      serviceSource.indexOf("await this.#git.applyFileWrites(worktreePath, pending"),
  // ADR 0026: a capability is only ever granted by an operator approving a
  // plan whose digest covers the itemized grant list.
  capabilityKindsAreClosed:
    typesSource.includes(
      'export type CapabilityKind = "read.manifest" | "read.checks" | "mutation.patchset" | "exec.check"',
    ) &&
    policySource.includes('"UNKNOWN_CAPABILITY"') &&
    policySource.includes("(CAPABILITY_KINDS as readonly string[]).includes(kind)") &&
    // Duplicate kinds are refused rather than merged, so a narrow grant cannot
    // be widened by restating it.
    policySource.includes('"grants list a duplicate capability"'),
  grantsAreBoundByPlanApprovalDigest:
    policySource.includes("schemaVersion: 4") &&
    policySource.includes('export const POLICY_VERSION = "session-loop-wiring-v5"') &&
    policySource.includes("readableManifestSha256: input.readableManifest") &&
    // Grants travel inside the plan, which the digest already covers, and the
    // manifest is bound alongside it.
    typesSource.includes("readonly grants: readonly CapabilityGrant[]"),
  readGrantRequiresResolvedManifest:
    storeSource.includes('grant.kind === "read.manifest"') &&
    storeSource.includes("requestsRead === (readableManifest !== null)") &&
    storeSource.includes('"READ_MANIFEST_UNRESOLVED"') &&
    storeSource.includes("assertReadableManifest(readableManifest)") &&
    storeSource.includes("readableManifest.baseCommit === current.baseCommit"),
  readScopeIsBoundedNotTruncated:
    policySource.includes("export const MAX_READABLE_FILES = 512") &&
    policySource.includes('"READ_SCOPE_TOO_LARGE"') &&
    // Refusal, never a slice: a shortened manifest would leave the model
    // reading from a set the operator never approved.
    !policySource.includes("entries.slice(0, MAX_READABLE_FILES)"),
  readManifestExcludesSecretsAndGitInternals:
    policySource.includes('entryPath !== ".git" && !entryPath.startsWith(".git/")') &&
    policySource.includes("!isIntrinsicallySecretPath(entryPath)") &&
    policySource.includes("!isProtectedEditPath(entryPath)"),
  readsAreBoundToApprovedBytes:
    policySource.includes("export function assertReadableBytes(") &&
    policySource.includes('"READ_NOT_GRANTED"') &&
    policySource.includes('"READ_MANIFEST_DRIFT"') &&
    // Session-written bytes are the only alternative to a manifest match, and
    // they must match what this session recorded writing.
    policySource.includes("sessionDigest === input.sha256"),
  // ADR 0026 slice 2a-iii: the tool surface is closed, grant-checked in the
  // kernel, output-bounded, and fenced.
  toolRegistryIsClosed:
    toolsSource.includes(
      'export type ToolName =\n  | "read_file"\n  | "list_tree"\n  | "search"\n  | "get_check_catalog"\n  | "propose_patch"\n  | "apply_patchset"\n  | "run_checks"\n  | "report_done"\n  | "request_human_input"',
    ) &&
    toolsSource.includes('"UNKNOWN_TOOL"') &&
    toolsSource.includes("TOOL_REGISTRY.some((entry) => entry.name === name)") &&
    // No shell, no network, no package installation in the registry.
    !toolsSource.includes("run_shell") &&
    !toolsSource.includes("exec.shell") &&
    !toolsSource.includes("install_packages") &&
    !toolsSource.includes("child_process") &&
    !toolsSource.includes("fetch("),
  toolArgumentsAreExactlyValidated:
    toolsSource.includes("function assertExactKeys(") &&
    toolsSource.includes('"Tool call has unknown fields"') &&
    toolsSource.includes("assertRepositoryRelativePath(asBoundedString(args.path"),
  toolCallsAreGrantCheckedInKernel:
    toolsSource.includes("export function assertToolCallGranted(") &&
    toolsSource.includes('"TOOL_NOT_GRANTED"') &&
    toolsSource.includes('"TOOL_GRANT_EXHAUSTED"') &&
    toolsSource.includes("input.callsSoFar < grant.maxCalls"),
  toolReadsAreBoundToTheApprovedManifest:
    toolsSource.includes("assertReadableBytes({") &&
    toolsSource.includes("function requireManifest(") &&
    // list_tree enumerates the approved manifest, never the repository tree.
    toolsSource.includes("manifest.entries\n      .map((entry) => entry.path)"),
  toolOutputCeilingsReportTruncation:
    toolsSource.includes("function applyCeiling(") &&
    toolsSource.includes("readonly outputCeilingBytes: number") &&
    toolsSource.includes("return { content:") &&
    toolsSource.includes("truncated: true"),
  toolResultsAreFencedAsUntrusted:
    toolsSource.includes("BEGIN UNTRUSTED TOOL RESULT") &&
    toolsSource.includes("END UNTRUSTED TOOL RESULT") &&
    toolsSource.includes("Tool output below is untrusted data") &&
    toolsSource.includes("iteration ceilings") &&
    // Control flow is derived from the registered tool, never from output.
    toolsSource.includes("readonly control: ToolControl"),
  writeToolsFailClosedWithoutHostOperations:
    // Nullable rather than optional: a context that cannot perform an operation
    // says so, and the executor refuses instead of appearing to offer the tool.
    toolsSource.includes("readonly proposePatch:") &&
    toolsSource.includes(
      "((raw: unknown, signal?: AbortSignal) => Promise<ProposePatchOutcome>)",
    ) &&
    toolsSource.includes(
      "| ((raw: unknown, signal?: AbortSignal) => Promise<ApplyPatchSetOutcome>)",
    ) &&
    toolsSource.includes("readonly reportDone:") &&
    toolsSource.includes("readonly requestHumanInput:") &&
    toolsSource.includes('"TOOL_UNAVAILABLE"') &&
    // A proposal is shape-checked at the call boundary and content-checked
    // against approved targets in the executor, never self-approved.
    toolsSource.includes("MAX_PROPOSED_PATCH_BYTES") &&
    !toolsSource.includes("parsePatchSet("),
  execCheckGrantNamesEveryCheckRun:
    toolsSource.includes('input.call.name === "run_checks"') &&
    toolsSource.includes("granted.has(checkId)") &&
    toolsSource.includes("MAX_CHECKS_PER_CALL"),
  failingCheckIsEvidenceNotControl:
    // run_checks stays on `continue`: a failing check is evidence, and only the
    // host decides whether a session ends.
    toolsSource.includes(
      '{ name: "run_checks", capability: "exec.check", outputCeilingBytes: 32_768, control: "continue" }',
    ),
  sessionLoopSpendsFromTheDurableLedger:
    // The ceiling and the spend both come from injected ledger reads, never a
    // counter the loop owns, so a restart cannot restore a spent budget.
    sessionLoopSource.includes("deps.spentIterations() < deps.iterationCeiling") &&
    sessionLoopSource.includes("const beforeProvider = deps.spentIterations()") &&
    sessionLoopSource.indexOf("const beforeProvider = deps.spentIterations()") <
      sessionLoopSource.indexOf("await deps.callProvider(") &&
    sessionLoopSource.indexOf("await deps.callProvider(") <
      sessionLoopSource.indexOf("const iterations = deps.spentIterations()") &&
    sessionLoopSource.includes("iterations === beforeProvider + 1") &&
    // The live callback delegates to #providerCall, which durably begins the
    // named provider.revise operation before gateway I/O.
    serviceSource.includes("SESSION_ITERATION_OPERATION_KIND,") &&
    serviceSource.indexOf("const operation = this.#store.beginOperation(") <
      serviceSource.indexOf("await gateway.generateStructured(") &&
    !sessionLoopSource.includes("let spent") &&
    !sessionLoopSource.includes("iterations += 1"),
  sessionLoopCountsSpendPerCapability:
    sessionLoopSource.includes("toolDefinition(call.name).capability") &&
    sessionLoopSource.includes("capability === null ? 0 : deps.callsSoFar(capability)"),
  sessionLoopControlComesFromTheHost:
    // The loop reads the executed result's control signal, which the registry
    // fixes per tool; nothing parses provider text for an exit.
    sessionLoopSource.includes('result.control === "done"') &&
    sessionLoopSource.includes('result.control === "await_human"') &&
    !sessionLoopSource.includes("toolCalls[0].control") &&
    // The provider envelope carries tool calls only — no budget, permission, or
    // state field for a model to set.
    sessionLoopSource.includes('required: ["toolCalls"]') &&
    sessionLoopSource.includes("additionalProperties: false"),
  sessionLoopFencesRefusalsAndBoundsBatches:
    sessionLoopSource.includes("BEGIN UNTRUSTED TOOL ERROR") &&
    sessionLoopSource.includes("cannot be argued with") &&
    sessionLoopSource.includes("export const MAX_TOOL_CALLS_PER_ITERATION = 8") &&
    sessionLoopSource.includes("toolCalls.length <= MAX_TOOL_CALLS_PER_ITERATION"),
  toolCatalogNeverExposesCheckArgv:
    toolsSource.includes(".map((check) => ({ id: check.id, name: check.name }))") &&
    !toolsSource.includes("check.argv"),
  readManifestResolutionIsBoundedAndVetted:
    // The ceiling is checked before any blob is read, so an over-wide scope is
    // refused rather than paid for and then refused.
    readManifestSource.indexOf('"READ_SCOPE_TOO_LARGE"') <
      readManifestSource.indexOf("await git.readBlob(") &&
    readManifestSource.includes("isWorkspaceContextPathExcluded(candidate.path)") &&
    readManifestSource.includes("isIntrinsicallySecretPath(candidate.path)") &&
    readManifestSource.includes('candidate.mode === "120000"') &&
    readManifestSource.includes("decodeTextOrNull(bytes) === null") &&
    readManifestSource.includes("containsSecretShapedContent(bytes)") &&
    // The validator owns the manifest's invariants even when a resolver
    // produced it.
    readManifestSource.includes("assertReadableManifest(manifest)"),
  readScopeSyntaxAdmitsNoWildcards:
    readManifestSource.includes("export function pathMatchesScopeEntry(") &&
    !readManifestSource.includes("minimatch") &&
    !readManifestSource.includes("globToRegExp") &&
    !readManifestSource.includes("new RegExp("),
  readableManifestMigrationHumanGated:
    storeSource.includes("function inspectReadableManifestSchema(") &&
    storeSource.includes(
      'readableManifestStatus === "missing" && options.allowReadableManifestMigration !== true',
    ) &&
    storeSource.includes('"DATABASE_MIGRATION_REQUIRED"') &&
    cliSource.includes('approval === "readable-manifest-v3"') &&
    // One token approves one migration; the tokens are not combinable.
    cliSource.includes(
      "const none = { approvalIndex: false, patchSet: false, readableManifest: false }",
    ),
  persistedReadableManifestIsDigestVerified:
    storeSource.includes("readableManifest(runId: string): ReadableManifest | null") &&
    storeSource.includes("readableManifestDigest(manifest) ===") &&
    storeSource.includes("assertReadableManifest(manifest)") &&
    // Written inside the same transaction that records the plan, so a crash
    // cannot leave an approved read grant without its manifest.
    storeSource.indexOf("INSERT INTO readable_manifests") <
      storeSource.indexOf('this.#appendEvent(runId, "plan.created"'),
  persistedPlansNeverCastPastAbsentFields:
    storeSource.includes("function decodeNullablePlan(") &&
    storeSource.includes("plan: decodeNullablePlan(value.plan_json") &&
    storeSource.includes("Array.isArray(grants) ? (grants as readonly CapabilityGrant[]) : []") &&
    storeSource.includes('typeof ceiling === "number" ? ceiling : 0') &&
    // A pre-ADR 0026 row's repairIterations decodes to the same ceiling, so an
    // old approval is neither widened to the new default nor discarded.
    storeSource.includes("decoded.iterationCeiling ?? decoded.repairIterations"),
  sessionLoopIsBoundedAndGateGranted:
    policySource.includes("export const MAX_SESSION_ITERATIONS = 2") &&
    policySource.includes("export const DEFAULT_SESSION_ITERATIONS = 2") &&
    policySource.includes("iterationCeiling <= MAX_SESSION_ITERATIONS") &&
    storeSource.includes("beginSessionIteration(runId: string)") &&
    storeSource.includes('"ITERATION_BUDGET_EXHAUSTED"') &&
    storeSource.includes('this.#hasApproval(runId, "plan", current.planSha256, "approve")') &&
    storeSource.includes('current.verification.outcome === "failed"') &&
    // The budget is spent from the durable operation ledger, never a mutable
    // counter, and the counted kind is the named session-iteration constant.
    storeSource.includes('export const SESSION_ITERATION_OPERATION_KIND = "provider.revise"') &&
    storeSource.includes("FROM operations") &&
    storeSource.includes("WHERE run_id = ? AND kind = '") &&
    !storeSource.includes("repair_iterations_used") &&
    // A recorded patch set may only be replaced by an iteration that was
    // already charged, and by exactly one replacement per charged iteration.
    storeSource.includes("this.#supersessionIsAuthorized(current)") &&
    storeSource.includes("if (charged < 1 || charged > granted) return false") &&
    storeSource.includes('this.#countEvents(run.id, "patch_set.superseded") < charged'),
  sessionLoopCannotWidenAuthority:
    // Every revision is parsed against the approved mutation grant and the
    // immutable baseline, then rechecked against the resulting path set.
    policySource.includes("parseCapabilityGrants(object.grants ?? [], targets, checks)") &&
    repairSessionSource.includes(
      "parseCapabilityGrants(plan.grants, plan.targets, project.checks)",
    ) &&
    serviceSource.includes("mutationGrant.scope,") &&
    serviceSource.includes("parsePatchSet(") &&
    serviceSource.includes('"Session could not restore the immutable baseline before applying"') &&
    serviceSource.includes("this.#store.recordPatchSetIntent(") &&
    serviceSource.includes("samePathSet(changedPaths, patchPaths)") &&
    // Checks remain the exact approved list; tool output cannot add one.
    serviceSource.includes('"run_checks must name the complete approved check list in plan order"'),
  sessionRepairRechecksCurrentContextPolicy:
    repairSessionSource.includes("this.#assertCurrentContextPolicy(run);") &&
    repairSessionSource.indexOf("this.#assertCurrentContextPolicy(run);") <
      repairSessionSource.indexOf("this.#store.beginSessionIteration(runId)") &&
    repairSessionSource.indexOf("this.#assertCurrentContextPolicy(run);") <
      repairSessionSource.indexOf("const readableManifest"),
  sessionTerminalSettlementSurvivesBoundaryFailure:
    serviceSource.includes('current.state !== "awaiting_review"') &&
    testSources.some((source) =>
      source.includes(
        "keeps a terminal human pause authoritative when its iteration boundary write fails",
      ),
    ),
  sessionResumeEvidencePreservesFencing:
    serviceSource.includes("function renderPersistedRemoteRunChecks(") &&
    serviceSource.includes('remote && definition.name === "run_checks"') &&
    serviceSource.includes('events[index + 1]?.type === "verification.completed"') &&
    serviceSource.includes(
      '"Remote run_checks result is missing its atomic verification evidence"',
    ) &&
    serviceSource.includes("renderToolResult({") &&
    serviceSource.includes("truncated: detail.truncated === true") &&
    serviceSource.includes("renderToolFailure(toolName, detail.code, message)") &&
    serviceSource.includes("tool: call.name,") &&
    testSources.some(
      (source) =>
        source.includes(
          "reprojects legacy truncated check transcripts from atomic evidence on remote resume",
        ) &&
        source.includes("not.toContain('\"stdout\":')") &&
        source.includes("not.toContain('\"stderr\":')"),
    ),
  sessionLoopLandsExhaustionHonestly:
    serviceSource.includes("this.#store.remainingIterationBudget(runId) > 0") &&
    serviceSource.includes(
      "return this.#store.recordVerificationAndAwaitReview(runId, diff, verification);",
    ) &&
    storeSource.includes("Only a failing verification may be retained for repair"),
  // ADR 0025: the inherited workflow's authorization boundary is owned by this
  // repository and must not regress to a body-only condition or a mutable ref.
  inheritedWorkflowIsActorGatedAndPinned:
    // A repository-owned actor gate exists, and CONTRIBUTOR — which means a
    // merged PR, not write access — is not admitted.
    inheritedWorkflowSource.includes("author_association == 'OWNER'") &&
    inheritedWorkflowSource.includes("author_association == 'MEMBER'") &&
    inheritedWorkflowSource.includes("author_association == 'COLLABORATOR'") &&
    !inheritedWorkflowSource.includes("author_association == 'CONTRIBUTOR'") &&
    // The privileged job cannot run unless the gate job admitted the actor.
    inheritedWorkflowSource.includes("needs: authorize") &&
    // Deny-by-default at the top level, and no permissions on the gate itself.
    inheritedWorkflowSource.includes("permissions: {}") &&
    // Public sessions stay private.
    inheritedWorkflowSource.includes("share: false") &&
    // Every `uses:` is pinned to a 40-hex commit, never a mutable tag.
    [...inheritedWorkflowSource.matchAll(/uses:\s*(\S+)/g)].every(([, reference]) =>
      /@[0-9a-f]{40}$/.test(reference),
    ) &&
    !inheritedWorkflowSource.includes("@latest") &&
    // Untrusted comment fields never reach a shell through interpolation.
    !/run:[^\n]*\$\{\{[^}]*github\.event\.comment/.test(inheritedWorkflowSource),
  anthropicCredentialsAreOriginPinned:
    providerSource.includes('"ANTHROPIC_ORIGIN_DENIED"') &&
    providerSource.includes('url.hostname.toLowerCase() === "api.anthropic.com"') &&
    providerSource.includes('"PROVIDER_SECRET_DETECTED"') &&
    providerSource.includes("!text.includes(this.#apiKey)"),
  workspaceApprovalProjectionFailsClosed: [
    "runId === expectedRunId",
    "APPROVAL_KINDS.has",
    "/^[a-f0-9]{64}$/.test(digest)",
    'Buffer.byteLength(actor, "utf8") <= APPROVAL_ACTOR_MAX_BYTES',
    "!containsUnsafeActorCharacter(actor)",
    "!containsSecretShapedContent",
    "APPROVAL_DECISIONS.has",
    'decision === "approve" || kind === "review"',
    "isCanonicalTimestamp(createdAt)",
  ].every((guard) => approvalRowSource.includes(guard)),
  workspaceApprovalPresenterAllowlists:
    ["kind", "digest", "actor", "decision", "createdAt"].every((field) =>
      approvalPresenterSource.includes(`${field}: approval.${field}`),
    ) &&
    !approvalPresenterSource.includes("...approval") &&
    workspacePresenterSource.includes("limit: snapshot.approvalCoverage.limit") &&
    workspacePresenterSource.includes("loaded: snapshot.approvalCoverage.loaded") &&
    workspacePresenterSource.includes(
      "earlierApprovalsExcluded: snapshot.approvalCoverage.earlierApprovalsExcluded",
    ),
  workspacePersistedDiffResponseBounded:
    diffPresenterSource.includes("WORKSPACE_DIFF_DISPLAY_MAX_BYTES = 256 * 1024") &&
    diffPresenterSource.includes("byteCount > WORKSPACE_DIFF_DISPLAY_MAX_BYTES") &&
    diffPresenterSource.includes('status: "outside_browser_bound"') &&
    diffPresenterSource.includes('digestProvenance: "recorded_only"') &&
    diffPresenterSource.includes("text: null") &&
    workspacePresenterSource.includes("diff: persistedDiff.text") &&
    workspacePresenterSource.includes("diffReview: persistedDiff.review") &&
    !workspacePresenterSource.includes("diff: run.diff") &&
    !/(?:run\.diff|diff)\.(?:slice|substring|substr)\(/.test(diffPresenterSource),
  workspacePersistedDiffFailsClosed: [
    'throw new IcarusError("DATABASE_ERROR", "Persisted diff evidence is invalid")',
    "run.verification !== null",
    "run.diff.length === 0",
    'run.diff.includes("\\0")',
    "VERIFICATION_OUTCOMES.has(verification.outcome)",
    "Array.isArray(verification.checks)",
    "Array.isArray(verification.changedPaths)",
    "SHA256_PATTERN.test(verification.diffSha256)",
    "SHA256_PATTERN.test(verification.checkpointSha256)",
    "verification.changedPaths.length === 0",
    "verification.changedPaths.length > project.ceiling.maxFilesChanged",
    "new Set(verification.changedPaths).size !== verification.changedPaths.length",
    "patchSetCoversChangedPaths(run, verification.changedPaths)",
    "changedPaths.length === 1 && changedPaths[0] === run.target",
    'Buffer.byteLength(run.diff, "utf8")',
    "byteCount > project.ceiling.maxDiffBytes",
    'createHash("sha256").update(run.diff, "utf8").digest("hex")',
    "displayedSha256 !== verification.diffSha256",
    "decodeGitPathToken",
    'new TextDecoder("utf-8", { fatal: true })',
    "resolveDiffHeaderTarget(header.slice(11), expected)",
    "if (seen.has(target)) invalidPersistedDiff();",
    "if (seen.size !== expected.size) invalidPersistedDiff();",
    'assertFileHeaderTarget(lines[index] ?? "", "--- ", target)',
    'assertFileHeaderTarget(lines[index] ?? "", "+++ ", target)',
    "if (!expected.has(target)) invalidPersistedDiff();",
    `value === \`a/\${target} b/\${target}\``,
    `value === \`\${expected}\\t\``,
    "DIFF_INDEX_PATTERN.test(lines[index]",
    "DIFF_HUNK_PATTERN.exec(lines[index]",
    "oldLines > expectedOldLines",
    "newLines > expectedNewLines",
    "hunkCount === 0",
  ].every((guard) => diffPresenterSource.includes(guard)),
  workspacePersistedDiffHasNoNewReadAuthority:
    !/(?:readFile|readFileSync|createReadStream|readdir|lstat|realpath|spawn|execFile|fetch\(|\.git\(|getRepositoryStatus|worktreePath|cachePath|baselineBase64|approvedBase64)/.test(
      diffPresenterSource,
    ),
  workspacePersistedDiffUiTextOnly:
    diffUiSource.includes('className="diff-review__patch"') &&
    diffUiSource.includes("{run.diff}") &&
    diffUiSource.includes("tabIndex={0}") &&
    diffUiSource.includes('role="region"') &&
    diffUiSource.includes('aria-labelledby="persisted-diff-patch-heading"') &&
    diffUiSource.includes("Exact persisted run state") &&
    diffUiSource.includes("This does not prove current repository bytes") &&
    !/(?:dangerouslySetInnerHTML|innerHTML|window\.open|window\.location|href\s*=|<form\b|formAction|onSubmit|<button\b|onClick|postJson|approve|execute|commit|push|deploy)/.test(
      diffUiSource,
    ),
  workspacePersistedDiffUsesFixedEvidenceAnchor:
    workspacePresenterSource.includes('type === "verification.completed"') &&
    workspacePresenterSource.includes('return "diff"') &&
    workspaceLivePollSource.includes('case "run-diff"') &&
    workspaceLivePollSource.includes('return "run-diff"'),
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
  workspaceProjectCatalogIsJoinedAndBounded:
    workspaceProjectPageSource.includes("SELECT CAST(p.rowid AS TEXT) AS cursor") &&
    workspaceProjectPageSource.includes("FROM projects AS p") &&
    workspaceProjectPageSource.includes("JOIN repositories AS r ON r.id = p.repository_id") &&
    workspaceProjectPageSource.includes("WHERE p.rowid < ? AND p.rowid <= ?") &&
    workspaceProjectPageSource.includes("ORDER BY p.rowid DESC") &&
    workspaceProjectPageSource.includes("LIMIT 13") &&
    workspaceProjectPageSource.includes("$" + "{BOUNDED_PROJECT_COLUMNS}") &&
    workspaceProjectPageSource.includes("$" + "{BOUNDED_REPOSITORY_COLUMNS}") &&
    boundedProjectColumnsSource.includes("octet_length(p.checks_json)") &&
    boundedProjectColumnsSource.includes("octet_length(p.sandbox_json)") &&
    boundedProjectColumnsSource.includes("octet_length(p.ceiling_json)") &&
    boundedProjectColumnsSource.includes("octet_length(r.path)") &&
    boundedProjectColumnsSource.includes("json_valid(p.checks_json, 1)") &&
    !workspaceProjectPageSource.includes("getProject(") &&
    !workspaceProjectPageSource.includes("getRepository("),
  workspaceDirectProjectHydrationIsPreflightBounded:
    directHydrationSource.includes("SELECT $" + "{BOUNDED_REPOSITORY_COLUMNS}") &&
    directHydrationSource.includes("SELECT $" + "{BOUNDED_PROJECT_COLUMNS}") &&
    directHydrationSource.includes("return boundedRepositoryRow(") &&
    directHydrationSource.includes("return boundedProjectRow(") &&
    !directHydrationSource.includes("SELECT * FROM repositories") &&
    !directHydrationSource.includes("SELECT * FROM projects"),
  workspaceBootstrapUsesBoundedProjectPage:
    workspaceSnapshotSource.includes("openWorkspaceProjectPage()") &&
    workspaceSnapshotSource.includes("presentWorkspaceProjectPage") &&
    workspaceSnapshotSource.includes("projectPage:") &&
    !workspaceSnapshotSource.includes("listProjects(") &&
    !workspaceSnapshotSource.includes("listRepositories(") &&
    !workspaceSnapshotSource.includes("projects:"),
  workspaceCreatePathsAvoidCollectionScans:
    !workspaceServerSource.includes(".listProjects()") &&
    !workspaceServerSource.includes(".listRepositories()") &&
    workspaceServerSource.includes("findProjectByName(input.project.name)") &&
    workspaceServerSource.includes("findRepositoryByName(input.repository.name)") &&
    workspaceServerSource.includes("projectId: input.projectId"),
  workspaceJsonResponsesArePreflightBounded:
    workspaceServerSource.includes("MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024") &&
    jsonSerializerSource.includes('Buffer.byteLength(body, "utf8")') &&
    jsonSerializerSource.includes('"RESPONSE_TOO_LARGE"') &&
    workspaceServerSource.indexOf("const body = serializeJsonResponse(value)") <
      workspaceServerSource.indexOf("response.writeHead(status") &&
    workspaceServerSource.includes('error.code === "RESPONSE_TOO_LARGE"') &&
    workspaceServerSource.includes("MAX_ERROR_MESSAGE_BYTES = 4 * 1024") &&
    workspaceServerSource.includes("INTERNAL_ERROR_RESPONSE") &&
    workspaceServerSource.includes("internalError(response)") &&
    !jsonSerializerSource.includes("response.writeHead"),
  workspaceProjectNavigationIsBoundedAndStaleSafe:
    workspaceProjectPageNavSource.includes("PROJECT_PAGE_MAX_PAGES = 4") &&
    workspaceProjectPageNavSource.includes("PROJECT_PAGE_SIZE = 12") &&
    workspaceProjectPageNavSource.includes("validateProjectPage(page, request)") &&
    workspaceProjectPageNavSource.includes("request.snapshot !== session.snapshot") &&
    workspaceProjectPageNavSource.includes("expected.before !== request.before") &&
    workspaceAppSource.includes("projectPageGenerationRef.current !== generation") &&
    workspaceAppSource.includes("abortProjectPageRequest()") &&
    workspaceAppSource.includes("pauseProjectPageRequest(") &&
    browserSmokeSource.includes("PROJECT_PAGE_FIXTURE_COUNT") &&
    browserSmokeSource.includes("holdNextProjectPage") &&
    browserSmokeSource.includes("lateProjectPageSuccessRejected") &&
    browserSmokeSource.includes("offPageRunSelectionPreserved"),
  workspaceKeyboardNavigationIsExplicit:
    workspaceAppSource.includes('className="skip-link"') &&
    workspaceAppSource.includes('href="#workspace-main"') &&
    workspaceAppSource.includes('id="workspace-main"') &&
    workspaceAppSource.includes("tabIndex={-1}") &&
    workspaceAppSource.includes("aria-current=") &&
    workspaceStyleSource.includes("a:focus-visible") &&
    workspaceStyleSource.includes(".skip-link:focus") &&
    browserSmokeSource.includes("skipLinkKeyboardAccepted"),
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
