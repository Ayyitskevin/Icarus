import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_PATH = path.join(".github", "workflows", "native-acceptance.yml");
const MAX_WORKFLOW_BYTES = 32 * 1024;
const EXPECTED_WORKFLOW_SHA256 = "c40aeb0c70a08c3e73b512de257ef36b350542995a4024408e43d4b2ea93694a";
const EXPECTED_NODE_VERSION = "22.23.0";
const EXPECTED_PNPM_VERSION = "9.15.4";

const EXPECTED_ACTIONS = Object.freeze([
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
  "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
]);

const EXPECTED_RUN_COMMANDS = Object.freeze([
  "pnpm exec node scripts/native-acceptance-policy.mjs --host",
  "pnpm workflow:setup",
  "pnpm workflow:lint",
  "pnpm install --frozen-lockfile",
  "pnpm format:check",
  "pnpm lint",
  "pnpm typecheck",
  "pnpm exec vitest run tests/native tests/provider tests/unit/context-preview.test.ts tests/unit/policy.test.ts tests/unit/state-machine.test.ts tests/unit/store.test.ts tests/unit/verification-provenance.test.ts tests/unit/workspace-history-nav.test.ts tests/unit/workspace-live-poll.test.ts tests/unit/workspace-presenter.test.ts tests/unit/workspace-run-page-nav.test.ts tests/unit/workspace-verification-attempts.test.ts --reporter=dot",
  'pnpm exec vitest run tests/unit/service-draft.test.ts --testNamePattern="on (darwin|win32)" --reporter=dot',
  "node scripts/security-check.mjs",
  "pnpm build",
]);

const HOSTS = Object.freeze({
  darwin: { architecture: "arm64", runner: "macos-15" },
  win32: { architecture: "x64", runner: "windows-2025" },
});

function fail(message) {
  throw new Error(message);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function exactMatches(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function requireSource(source, pattern, message) {
  if (!pattern.test(source)) fail(message);
}

export function validateNativeAcceptanceWorkflow(source) {
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes === 0 || bytes > MAX_WORKFLOW_BYTES) {
    fail(`native acceptance workflow must be 1..${MAX_WORKFLOW_BYTES} bytes`);
  }
  if (source.includes("\r") || source.includes("\0")) {
    fail("native acceptance workflow must use canonical LF text without NUL bytes");
  }

  const forbidden = [
    [
      /(^|\n)\s*(pull_request_target|pull_request|push|schedule|workflow_call):/m,
      "automatic or privileged trigger",
    ],
    [/\$\{\{\s*secrets\./, "secret reference"],
    [/(^|\s)(id-token|issues|pull-requests|actions):\s*write\b/m, "write permission"],
    [/(^|\n)\s+cache:\s*/m, "shared cache mutation"],
    [
      /\b(docker|pnpm check|test:integration|pnpm eval|pnpm audit)\b/i,
      "Linux-only or out-of-scope command",
    ],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(source)) fail(`native acceptance contains a forbidden ${label}`);
  }

  requireSource(
    source,
    /^on:\n {2}workflow_dispatch:\n\npermissions:\n {2}contents: read$/m,
    "native acceptance must remain manual and read-only",
  );
  requireSource(
    source,
    /^ {2}group: native-acceptance-\$\{\{ github\.sha \}\}\n {2}cancel-in-progress: true$/m,
    "native acceptance concurrency must be scoped to the exact dispatched commit",
  );
  requireSource(
    source,
    /^ {10}- label: macOS 15 arm64\n {12}os: macos-15\n {12}platform: darwin\n {12}architecture: arm64\n {10}- label: Windows Server 2025 x64\n {12}os: windows-2025\n {12}platform: win32\n {12}architecture: x64$/m,
    "native acceptance must retain the exact macOS and Windows host matrix",
  );
  requireSource(
    source,
    /^ {10}ref: \$\{\{ github\.sha \}\}$/m,
    "checkout must remain pinned to the exact dispatched commit",
  );
  requireSource(
    source,
    /^ {4}timeout-minutes: 20$/m,
    "native acceptance must retain its job timeout",
  );

  const actions = exactMatches(source, /^\s*uses: ([^\s#]+)(?:\s+#.*)?$/gm);
  if (JSON.stringify(actions) !== JSON.stringify(EXPECTED_ACTIONS)) {
    fail("native acceptance actions must match the reviewed immutable commit pins");
  }
  for (const action of actions) {
    if (!/@[0-9a-f]{40}$/.test(action)) {
      fail("native acceptance contains a mutable or malformed action reference");
    }
  }

  const commands = exactMatches(source, /^\s*run: (.+)$/gm);
  if (JSON.stringify(commands) !== JSON.stringify(EXPECTED_RUN_COMMANDS)) {
    fail("native acceptance commands must match the reviewed portable boundary");
  }

  const digest = sha256(source);
  if (digest !== EXPECTED_WORKFLOW_SHA256) {
    fail(
      `native acceptance workflow digest mismatch: expected ${EXPECTED_WORKFLOW_SHA256}, received ${digest}`,
    );
  }

  return {
    actions,
    commands: commands.length,
    digest,
    runners: Object.values(HOSTS).map((host) => host.runner),
  };
}

export async function validateNativeAcceptanceFile(filePath = WORKFLOW_PATH) {
  const resolved = path.resolve(filePath);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink()) {
    fail("native acceptance workflow must be a regular non-symlink file");
  }
  if (info.size === 0 || info.size > MAX_WORKFLOW_BYTES) {
    fail(`native acceptance workflow file must be 1..${MAX_WORKFLOW_BYTES} bytes`);
  }
  return validateNativeAcceptanceWorkflow(await readFile(resolved, "utf8"));
}

export function validateNativeHost(
  input = {
    architecture: process.arch,
    configuredArchitecture: process.env.ICARUS_NATIVE_EXPECTED_ARCHITECTURE,
    configuredPlatform: process.env.ICARUS_NATIVE_EXPECTED_PLATFORM,
    nodeVersion: process.versions.node,
    platform: process.platform,
    userAgent: process.env.npm_config_user_agent ?? "",
  },
) {
  const expected = HOSTS[input.platform];
  if (expected === undefined) {
    fail(`native host execution supports only darwin or win32, received ${input.platform}`);
  }
  if (
    input.configuredPlatform !== input.platform ||
    input.configuredArchitecture !== input.architecture
  ) {
    fail(
      `native host identity mismatch: expected ${input.configuredPlatform}/${input.configuredArchitecture}, received ${input.platform}/${input.architecture}`,
    );
  }
  if (expected.architecture !== input.architecture) {
    fail(
      `native runner architecture drifted: expected ${expected.architecture}, received ${input.architecture}`,
    );
  }
  if (input.nodeVersion !== EXPECTED_NODE_VERSION) {
    fail(
      `native Node.js version drifted: expected ${EXPECTED_NODE_VERSION}, received ${input.nodeVersion}`,
    );
  }
  if (!input.userAgent.startsWith(`pnpm/${EXPECTED_PNPM_VERSION} `)) {
    fail(`native pnpm version drifted: expected ${EXPECTED_PNPM_VERSION}`);
  }
  return { architecture: input.architecture, platform: input.platform, runner: expected.runner };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--host")) {
    fail("usage: node scripts/native-acceptance-policy.mjs [--host]");
  }
  const workflow = await validateNativeAcceptanceFile();
  const host = arguments_[0] === "--host" ? validateNativeHost() : null;
  process.stdout.write(`${JSON.stringify({ host, workflow })}\n`);
}

const invokedPath = process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `native acceptance policy failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
