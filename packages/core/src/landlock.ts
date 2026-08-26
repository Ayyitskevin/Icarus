import path from "node:path";
import { fileURLToPath } from "node:url";

import { digestJson } from "./digest.js";
import { invariant } from "./errors.js";
import type { JsonValue } from "./types.js";

// ADR 0062: kernel-enforced Landlock sandbox profiles beneath the grant
// pipeline. Grants remain the policy layer; a profile is the kernel backstop
// that makes policy violations impossible rather than refused. The module is
// pure mapping and detection logic: compiling the helper, re-executing the
// CLI under it, and resolving host paths live in the CLI composition root.

export const LANDLOCK_SANDBOX_SPEC_SCHEMA = "icarus.landlock-sandbox.v1";
export const LANDLOCK_NOTICE_SCHEMA = "icarus.landlock-notice.v1";
/** Set on the re-executed process so the sandbox is applied exactly once. */
export const LANDLOCK_APPLIED_ENV = "ICARUS_LANDLOCK_APPLIED";
/** Optional operator default; the --sandbox-profile flag wins over it. */
export const LANDLOCK_PROFILE_ENV = "ICARUS_SANDBOX_PROFILE";

export const LANDLOCK_PROFILE_NAMES = ["workspace", "read-only", "strict"] as const;
export type LandlockProfileName = (typeof LANDLOCK_PROFILE_NAMES)[number];

/** The conservative default: writes confined to Icarus state, host read-only. */
export const LANDLOCK_DEFAULT_PROFILE: LandlockProfileName = "workspace";

export function isLandlockProfileName(value: string): value is LandlockProfileName {
  return (LANDLOCK_PROFILE_NAMES as readonly string[]).includes(value);
}

/**
 * Rule access classes, mapped to kernel rights by the helper:
 * - `ro`: read and execute only.
 * - `rw`: every filesystem right the kernel ABI handles.
 * - `meta`: `ro` plus directory-entry lifecycle (create/remove regular files
 *   and directories) WITHOUT file-content writes; it exists so SQLite WAL
 *   sidecars and state directories can appear and disappear while file
 *   contents stay confined to explicit `rw` paths.
 */
export type LandlockRuleAccess = "ro" | "rw" | "meta";

export interface LandlockRuleV1 {
  readonly path: string;
  readonly access: LandlockRuleAccess;
}

export interface LandlockSandboxContextV1 {
  readonly stateRoot: string;
  /** Required by the strict profile to scope the current run's scratch. */
  readonly runId?: string;
  /** Registered source checkout the run clones from; read-only when present. */
  readonly sourceRepository?: string;
  /** realpath of the node executable, which must stay executable post-exec. */
  readonly executablePath: string;
  /**
   * Extra read-only roots the confined profiles must admit: the Icarus
   * installation tree itself (the re-executed CLI reads its own modules) and
   * any host paths a test probe loads.
   */
  readonly extraReadOnlyPaths?: readonly string[];
}

export interface LandlockSandboxSpecV1 {
  readonly schema: typeof LANDLOCK_SANDBOX_SPEC_SCHEMA;
  readonly profile: LandlockProfileName;
  readonly rules: readonly LandlockRuleV1[];
  readonly digestSha256: string;
}

const RUN_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Minimal read surface for confined profiles: runtime, toolchain, and pseudo filesystems. */
const SYSTEM_READ_PATHS = [
  "/bin",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/proc",
  "/sbin",
  "/sys",
  "/usr",
] as const;

const ACCESS_RANK: Record<LandlockRuleAccess, number> = { ro: 0, meta: 1, rw: 2 };

function isAncestorOrSame(ancestor: string, candidate: string): boolean {
  return ancestor === candidate || candidate.startsWith(ancestor === "/" ? "/" : `${ancestor}/`);
}

/** Drops rules fully subsumed by an ancestor-or-equal rule of equal or broader access. */
function pruneRules(rules: readonly LandlockRuleV1[]): readonly LandlockRuleV1[] {
  return rules.filter(
    (rule, index) =>
      !rules.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          ACCESS_RANK[other.access] >= ACCESS_RANK[rule.access] &&
          isAncestorOrSame(other.path, rule.path),
      ),
  );
}

function sortRules(rules: readonly LandlockRuleV1[]): readonly LandlockRuleV1[] {
  return [...rules].sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return ACCESS_RANK[left.access] - ACCESS_RANK[right.access];
  });
}

export function buildLandlockSandboxSpec(
  profile: LandlockProfileName,
  context: LandlockSandboxContextV1,
): LandlockSandboxSpecV1 {
  const stateRoot = path.resolve(context.stateRoot);
  const executablePath = path.resolve(context.executablePath);
  const sourceRepository =
    context.sourceRepository === undefined ? undefined : path.resolve(context.sourceRepository);
  const rules: LandlockRuleV1[] = [];
  if (profile === "workspace") {
    // Writes confined to Icarus state; the whole host stays readable so the
    // run can clone its registered source and execute toolchains.
    rules.push(
      { path: stateRoot, access: "rw" },
      { path: "/", access: "ro" },
      { path: "/dev/null", access: "rw" },
      { path: executablePath, access: "ro" },
    );
  } else if (profile === "read-only") {
    // Same write confinement, but the read surface shrinks to an explicit
    // allowlist: nothing outside it (home directories, /tmp, /var, other
    // projects, other mounts) is even readable.
    rules.push({ path: stateRoot, access: "rw" }, { path: "/dev/null", access: "rw" });
    for (const systemPath of SYSTEM_READ_PATHS) {
      rules.push({ path: systemPath, access: "ro" });
    }
    rules.push({ path: executablePath, access: "ro" });
    if (sourceRepository !== undefined) {
      rules.push({ path: sourceRepository, access: "ro" });
    }
    for (const extra of context.extraReadOnlyPaths ?? []) {
      rules.push({ path: path.resolve(extra), access: "ro" });
    }
  } else {
    // strict: file-content writes confined to the current run's scratch, the
    // event store, snapshots, and the controller home. The state root itself
    // is meta-only: WAL sidecars and run directories can come and go, but no
    // file contents outside the explicit rw paths can change. Read surface as
    // read-only.
    invariant(
      typeof context.runId === "string" && RUN_ID_PATTERN.test(context.runId),
      "INVALID_LANDLOCK_SANDBOX",
      "The strict Landlock profile requires a canonical run ID",
    );
    const databasePath = path.join(stateRoot, "icarus.sqlite3");
    rules.push(
      { path: databasePath, access: "rw" },
      { path: `${databasePath}-wal`, access: "rw" },
      { path: `${databasePath}-shm`, access: "rw" },
      { path: path.join(stateRoot, "snapshots"), access: "rw" },
      { path: path.join(stateRoot, "artifacts"), access: "rw" },
      { path: path.join(stateRoot, "controller-home"), access: "rw" },
      { path: path.join(stateRoot, "tmp"), access: "rw" },
      { path: path.join(stateRoot, "locks"), access: "rw" },
      { path: path.join(stateRoot, "runs", context.runId), access: "rw" },
      { path: stateRoot, access: "meta" },
      { path: "/dev/null", access: "rw" },
    );
    for (const systemPath of SYSTEM_READ_PATHS) {
      rules.push({ path: systemPath, access: "ro" });
    }
    rules.push({ path: executablePath, access: "ro" });
    if (sourceRepository !== undefined) {
      rules.push({ path: sourceRepository, access: "ro" });
    }
    for (const extra of context.extraReadOnlyPaths ?? []) {
      rules.push({ path: path.resolve(extra), access: "ro" });
    }
  }
  const pruned = sortRules(pruneRules(rules));
  const digestSha256 = digestJson({
    schema: LANDLOCK_SANDBOX_SPEC_SCHEMA,
    profile,
    rules: pruned,
  } as unknown as JsonValue);
  return { schema: LANDLOCK_SANDBOX_SPEC_SCHEMA, profile, rules: pruned, digestSha256 };
}

/** The first kernel release with the Landlock filesystem ABI (v1). */
export const LANDLOCK_MINIMUM_KERNEL = { major: 5, minor: 13 } as const;

export function parseKernelMajorMinor(release: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)/.exec(release);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export type LandlockSupportV1 =
  | { readonly status: "supported"; readonly abi: number }
  | { readonly status: "unsupported"; readonly reason: string };

export function detectLandlockSupport(input: {
  readonly platform: NodeJS.Platform;
  readonly kernelRelease: string;
  /** ABI reported by the helper probe, or null when the helper cannot run. */
  readonly abi: number | null;
}): LandlockSupportV1 {
  if (input.platform !== "linux") {
    return {
      status: "unsupported",
      reason: `Landlock is Linux-only; platform is ${input.platform}`,
    };
  }
  const kernel = parseKernelMajorMinor(input.kernelRelease);
  if (
    kernel === null ||
    kernel.major < LANDLOCK_MINIMUM_KERNEL.major ||
    (kernel.major === LANDLOCK_MINIMUM_KERNEL.major && kernel.minor < LANDLOCK_MINIMUM_KERNEL.minor)
  ) {
    return {
      status: "unsupported",
      reason: `Landlock requires kernel >= ${LANDLOCK_MINIMUM_KERNEL.major}.${LANDLOCK_MINIMUM_KERNEL.minor}; release is ${input.kernelRelease}`,
    };
  }
  if (input.abi === null) {
    return {
      status: "unsupported",
      reason: "the Landlock sandbox helper could not be built or run",
    };
  }
  if (!Number.isSafeInteger(input.abi) || input.abi < 1) {
    return { status: "unsupported", reason: "the kernel reports no Landlock ABI" };
  }
  return { status: "supported", abi: input.abi };
}

/** Canonical stderr notice for the documented no-op path (ADR 0062). */
export function landlockUnavailableNotice(profile: LandlockProfileName, reason: string): JsonValue {
  return {
    schema: LANDLOCK_NOTICE_SCHEMA,
    status: "unavailable",
    profile,
    reason,
  } as unknown as JsonValue;
}

/** argv for the compiled helper: rules in spec order, then the wrapped command. */
export function landlockHelperArgv(
  helperPath: string,
  spec: LandlockSandboxSpecV1,
  command: readonly string[],
): readonly string[] {
  invariant(command.length > 0, "INVALID_LANDLOCK_SANDBOX", "Sandboxed command is empty");
  const argv: string[] = [helperPath];
  for (const rule of spec.rules) {
    argv.push(`--${rule.access}`, rule.path);
  }
  argv.push("--", ...command);
  return argv;
}

/** Source of the helper, compiled on demand by the CLI; path works from src and dist. */
export function defaultLandlockHelperSourcePath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "native",
    "landlock-sandbox.c",
  );
}
