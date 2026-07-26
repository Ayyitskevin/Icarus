import {
  containsSecretShapedContent,
  decodeTextOrNull,
  isIntrinsicallySecretPath,
  isWorkspaceContextPathExcluded,
} from "./context.js";
import { sha256 } from "./digest.js";
import { invariant } from "./errors.js";
import type { GitController } from "./git.js";
import { assertReadableManifest, MAX_READABLE_FILES } from "./policy.js";
import type { ReadableManifest, ReadableManifestEntry, SunCeiling } from "./types.js";

/**
 * Why a path a grant's scope named is absent from the resolved manifest. The
 * operator approves the enumerated result, so an exclusion is visible in what
 * they are asked to approve rather than inferred from a shorter list.
 */
export type ReadExclusionReason =
  | "context_excluded"
  | "intrinsically_secret"
  | "symlink"
  | "not_utf8_text"
  | "secret_shaped_content";

export interface ReadExclusion {
  readonly path: string;
  readonly reason: ReadExclusionReason;
}

export interface ResolvedReadableManifest {
  readonly manifest: ReadableManifest;
  readonly excluded: readonly ReadExclusion[];
}

/**
 * Matches a repository-relative path against one scope entry. Scope syntax is
 * deliberately not glob: a trailing slash is a directory prefix, anything else
 * is an exact path or a directory named without its slash. Wildcards would put
 * a pattern in front of the operator whose expansion they cannot see, which is
 * the failure mode the readable manifest exists to prevent — and here the
 * expansion is enumerated anyway, so patterns buy nothing.
 */
export function pathMatchesScopeEntry(candidate: string, entry: string): boolean {
  if (entry.endsWith("/")) return candidate.startsWith(entry);
  return candidate === entry || candidate.startsWith(`${entry}/`);
}

function inScope(candidate: string, scope: readonly string[]): boolean {
  return scope.some((entry) => pathMatchesScopeEntry(candidate, entry));
}

/**
 * Resolves a `read.manifest` grant scope against the pinned base commit into
 * the enumerated set of files it admits, each pinned by the sha256 of its
 * contents there (ADR 0026).
 *
 * The whole-repository secret and snapshot invariants are enforced during
 * context assembly, which has already run for this run. This pass therefore
 * reads only in-scope blobs rather than re-scanning every tracked file, and
 * re-verifies each candidate against the same predicates instead of trusting
 * the earlier phase — a read sends bytes to a provider, so it re-checks rather
 * than inherits.
 */
export async function resolveReadableManifest(
  git: GitController,
  repositoryPath: string,
  baseCommit: string,
  scope: readonly string[],
  ceiling: SunCeiling,
  signal?: AbortSignal,
): Promise<ResolvedReadableManifest> {
  const tree = await git.listTree(repositoryPath, baseCommit, signal);
  invariant(
    tree.every((entry) => entry.type !== "commit"),
    "SUBMODULE_DENIED",
    "Icarus does not support repositories containing submodules",
  );

  const candidates = tree
    .filter((entry) => entry.type === "blob" && inScope(entry.path, scope))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  // Bounded before any blob is read: a scope that admits too much is refused
  // rather than truncated, and refusing early avoids paying for reads whose
  // result could never be approved.
  invariant(
    candidates.length <= MAX_READABLE_FILES,
    "READ_SCOPE_TOO_LARGE",
    `Read scope admits ${candidates.length} files, above the ${MAX_READABLE_FILES} ceiling`,
  );

  const entries: ReadableManifestEntry[] = [];
  const excluded: ReadExclusion[] = [];

  for (const candidate of candidates) {
    if (isWorkspaceContextPathExcluded(candidate.path)) {
      excluded.push({ path: candidate.path, reason: "context_excluded" });
      continue;
    }
    if (isIntrinsicallySecretPath(candidate.path)) {
      excluded.push({ path: candidate.path, reason: "intrinsically_secret" });
      continue;
    }
    if (candidate.mode === "120000") {
      // A symlink's bytes are its target path; admitting one would let a read
      // follow it somewhere the manifest never enumerated.
      excluded.push({ path: candidate.path, reason: "symlink" });
      continue;
    }

    const bytes = await git.readBlob(
      repositoryPath,
      candidate.objectId,
      ceiling.maxFileBytes,
      signal,
    );
    if (decodeTextOrNull(bytes) === null) {
      excluded.push({ path: candidate.path, reason: "not_utf8_text" });
      continue;
    }
    if (containsSecretShapedContent(bytes)) {
      excluded.push({ path: candidate.path, reason: "secret_shaped_content" });
      continue;
    }
    entries.push({ path: candidate.path, sha256: sha256(bytes) });
  }

  const manifest: ReadableManifest = { baseCommit, entries };
  // Defense in depth: the validator owns the manifest's invariants, so a
  // resolver bug cannot produce a manifest an approval would then bind.
  assertReadableManifest(manifest);
  return { manifest, excluded };
}
