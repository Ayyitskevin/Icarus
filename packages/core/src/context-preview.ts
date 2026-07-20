import { TextDecoder } from "node:util";

import {
  containsSecretShapedContent,
  isWorkspaceContextPathExcluded,
  MAX_TRACKED_TREE_BYTES,
  MAX_TRACKED_TREE_FILE_BYTES,
} from "./context.js";
import { digestJson, sha256 } from "./digest.js";
import { IcarusError, invariant } from "./errors.js";
import type { GitController, TreeEntry } from "./git.js";
import { assertAllowedTarget } from "./policy.js";
import type { ContextEntry, JsonValue } from "./types.js";

const MAX_PREVIEW_MAP_ENTRIES = 2_000;
export interface ContextPreviewEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly reason: ContextEntry["reason"];
}

export interface ContextPreviewCounts {
  readonly trackedEntries: number;
  readonly trackedFiles: number;
  readonly includedFiles: number;
  readonly excludedFiles: number;
  readonly excludedPathFiles: number;
  readonly excludedBinaryFiles: number;
  readonly excludedSecretFiles: number;
  readonly submoduleEntries: number;
  readonly omittedMapFiles: number;
  readonly scannedBytes: number;
  readonly includedBytes: number;
}

export interface ProjectContextPreview {
  readonly baseCommit: string;
  readonly target: string;
  readonly digest: string;
  readonly repositoryDigest: string;
  readonly map: readonly ContextPreviewEntry[];
  readonly selected: readonly ContextPreviewEntry[];
  readonly counts: ContextPreviewCounts;
  readonly warnings: readonly string[];
}

type PreviewGit = Pick<GitController, "listTree" | "readBlob">;

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function comparePaths(left: { readonly path: string }, right: { readonly path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function selectedReasons(target: string): ReadonlyMap<string, ContextEntry["reason"]> {
  const reasons = new Map<string, ContextEntry["reason"]>([[target, "target"]]);
  const targetDirectory = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
  const components = targetDirectory.length === 0 ? [] : targetDirectory.split("/");
  const rulePaths = ["AGENTS.md"];
  for (let index = 1; index <= components.length; index += 1) {
    rulePaths.push(`${components.slice(0, index).join("/")}/AGENTS.md`);
  }
  for (const rulePath of rulePaths) {
    if (!reasons.has(rulePath)) {
      reasons.set(rulePath, rulePath === "AGENTS.md" ? "root_rules" : "target_rules");
    }
  }
  for (const seedPath of ["README.md", "README", "package.json", "pyproject.toml", "Cargo.toml"]) {
    if (!reasons.has(seedPath)) {
      reasons.set(seedPath, "seed");
    }
  }
  return reasons;
}

function targetExcluded(reason: string): never {
  throw new IcarusError(
    "CONTEXT_PREVIEW_TARGET_EXCLUDED",
    `Selected target is excluded from the context preview: ${reason}`,
  );
}

function decodePreviewText(bytes: Uint8Array): string | null {
  if (Buffer.from(bytes).includes(0)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export async function createContextPreview(
  git: PreviewGit,
  repositoryPath: string,
  baseCommit: string,
  requestedTarget: string,
  signal?: AbortSignal,
): Promise<ProjectContextPreview> {
  const target = assertAllowedTarget(requestedTarget);
  const tree = await git.listTree(repositoryPath, baseCommit, signal);
  const targetEntry = tree.find((entry) => entry.path === target);
  invariant(
    targetEntry?.type === "blob",
    "TARGET_NOT_TRACKED",
    "Preview target is not a tracked file",
  );
  if (targetEntry.mode !== "100644") {
    targetExcluded("target must be a non-executable regular file");
  }
  if (isWorkspaceContextPathExcluded(target)) {
    targetExcluded("target path is hidden by preview policy");
  }

  const blobs = tree
    .filter((entry): entry is TreeEntry & { readonly type: "blob" } => entry.type === "blob")
    .sort(comparePaths);
  const reasons = selectedReasons(target);
  const included: ContextPreviewEntry[] = [];
  let scannedBytes = 0;
  let includedBytes = 0;
  let excludedPathFiles = 0;
  let excludedBinaryFiles = 0;
  let excludedSecretFiles = 0;

  for (const entry of blobs) {
    signal?.throwIfAborted();
    if (entry.mode === "120000" || isWorkspaceContextPathExcluded(entry.path)) {
      if (entry.path === target) targetExcluded("target path is hidden by preview policy");
      excludedPathFiles += 1;
      continue;
    }

    const bytes = await git.readBlob(
      repositoryPath,
      entry.objectId,
      MAX_TRACKED_TREE_FILE_BYTES,
      signal,
    );
    scannedBytes += bytes.length;
    invariant(
      scannedBytes <= MAX_TRACKED_TREE_BYTES,
      "REPOSITORY_SNAPSHOT_BUDGET_EXCEEDED",
      "Tracked repository exceeds the context preview byte ceiling",
    );
    const text = decodePreviewText(bytes);
    if (text === null) {
      if (entry.path === target) targetExcluded("target is binary or invalid UTF-8");
      excludedBinaryFiles += 1;
      continue;
    }
    if (containsSecretShapedContent(Buffer.from(text, "utf8"))) {
      if (entry.path === target) targetExcluded("target contains secret-shaped material");
      excludedSecretFiles += 1;
      continue;
    }

    includedBytes += bytes.length;
    included.push({
      path: entry.path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      reason: reasons.get(entry.path) ?? "repository_map",
    });
  }

  invariant(
    included.some((entry) => entry.path === target && entry.reason === "target"),
    "CONTEXT_PREVIEW_TARGET_EXCLUDED",
    "Selected target is absent from the filtered context preview",
  );

  const submoduleEntries = tree.filter((entry) => entry.type === "commit").length;
  const mapEntries = included.map((entry) => ({ ...entry, reason: "repository_map" as const }));
  const map = mapEntries.slice(0, MAX_PREVIEW_MAP_ENTRIES);
  const selected = included.filter((entry) => entry.reason !== "repository_map");
  const omittedMapFiles = mapEntries.length - map.length;
  const excludedFiles = excludedPathFiles + excludedBinaryFiles + excludedSecretFiles;
  const counts: ContextPreviewCounts = {
    trackedEntries: tree.length,
    trackedFiles: blobs.length,
    includedFiles: included.length,
    excludedFiles,
    excludedPathFiles,
    excludedBinaryFiles,
    excludedSecretFiles,
    submoduleEntries,
    omittedMapFiles,
    scannedBytes,
    includedBytes,
  };
  const warnings: string[] = [];
  if (excludedPathFiles > 0) {
    warnings.push(
      `${excludedPathFiles} tracked file(s) were hidden by context preview path policy.`,
    );
  }
  if (excludedBinaryFiles > 0) {
    warnings.push(`${excludedBinaryFiles} binary or invalid UTF-8 file(s) were omitted.`);
  }
  if (excludedSecretFiles > 0) {
    warnings.push(`${excludedSecretFiles} file(s) with secret-shaped content were omitted.`);
  }
  if (submoduleEntries > 0) {
    warnings.push(`${submoduleEntries} submodule entry or entries were omitted.`);
  }
  if (omittedMapFiles > 0) {
    warnings.push(`${omittedMapFiles} eligible file(s) were omitted from the bounded map.`);
  }

  const repositoryDigest = digestJson(
    asJsonValue({ schemaVersion: 1, baseCommit, files: included }),
  );
  const unsigned = {
    schemaVersion: 1,
    baseCommit,
    target,
    repositoryDigest,
    map,
    selected,
    counts,
    warnings,
  };
  return {
    baseCommit,
    target,
    repositoryDigest,
    map,
    selected,
    counts,
    warnings,
    digest: digestJson(asJsonValue(unsigned)),
  };
}
