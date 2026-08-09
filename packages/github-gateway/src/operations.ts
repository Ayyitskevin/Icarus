import type { GithubHttpMethod } from "./http.js";
import { invariant } from "./errors.js";
import { assertOwner, assertRepository } from "./identifiers.js";

/**
 * The closed set of remote effects Packet 4 authorizes. A caller names one of
 * these kinds; it never supplies a URL, a path, a method, or a Git argument.
 * Adding a capability means editing this table under its own ADR, which is the
 * point: the authority surface is one reviewable constant.
 *
 * Deliberately absent, and therefore not expressible anywhere in this package:
 * reference updates (force or otherwise), reference deletion, pull request
 * merge, branch deletion, workflow dispatch, release publication, and any
 * deployment endpoint.
 */
export type GithubOperationKind =
  | "read_actor"
  | "create_blob"
  | "create_tree"
  | "create_commit"
  | "create_absent_ref"
  | "create_draft_pull_request"
  | "read_reference"
  | "read_base_reference"
  | "read_pull_requests";

export interface GithubOperationDescriptor {
  readonly method: GithubHttpMethod;
  /**
   * Path segments appended after `repos/{owner}/{repository}/`, or the complete
   * path when `repositoryScoped` is false.
   */
  readonly segments: readonly string[];
  readonly mutating: boolean;
  /**
   * `read_actor` is the one authorized endpoint outside a repository path: ADR
   * 0027 requires the credential's login to be verified against the profile's
   * expected actor before any other call in a sequence.
   */
  readonly repositoryScoped: boolean;
}

export const GITHUB_OPERATIONS: Readonly<Record<GithubOperationKind, GithubOperationDescriptor>> =
  Object.freeze({
    read_actor: Object.freeze({
      method: "GET",
      segments: Object.freeze(["user"]),
      mutating: false,
      repositoryScoped: false,
    }),
    create_blob: Object.freeze({
      method: "POST",
      segments: Object.freeze(["git", "blobs"]),
      mutating: true,
      repositoryScoped: true,
    }),
    create_tree: Object.freeze({
      method: "POST",
      segments: Object.freeze(["git", "trees"]),
      mutating: true,
      repositoryScoped: true,
    }),
    create_commit: Object.freeze({
      method: "POST",
      segments: Object.freeze(["git", "commits"]),
      mutating: true,
      repositoryScoped: true,
    }),
    // POST to git/refs creates a reference and fails when it already exists.
    // Updating one would require a PATCH to git/refs/{ref}, which this package
    // cannot emit.
    create_absent_ref: Object.freeze({
      method: "POST",
      segments: Object.freeze(["git", "refs"]),
      mutating: true,
      repositoryScoped: true,
    }),
    create_draft_pull_request: Object.freeze({
      method: "POST",
      segments: Object.freeze(["pulls"]),
      mutating: true,
      repositoryScoped: true,
    }),
    read_reference: Object.freeze({
      method: "GET",
      segments: Object.freeze(["git", "ref"]),
      mutating: false,
      repositoryScoped: true,
    }),
    // Reads the base branch the candidate commit will parent from. It is the
    // same read-only endpoint as `read_reference` but a separate kind, because
    // it is the only operation that may name a reference outside the Icarus
    // namespace and the record contract records it as its own HTTP kind
    // (`github.base_ref.get`). Keeping the kinds distinct means the namespace
    // restriction on the Icarus reference stays exact.
    read_base_reference: Object.freeze({
      method: "GET",
      segments: Object.freeze(["git", "ref"]),
      mutating: false,
      repositoryScoped: true,
    }),
    read_pull_requests: Object.freeze({
      method: "GET",
      segments: Object.freeze(["pulls"]),
      mutating: false,
      repositoryScoped: true,
    }),
  });

export interface GithubRepositoryCoordinates {
  readonly owner: string;
  readonly repository: string;
}

/**
 * Builds the only URL shapes this package can produce. Every dynamic component
 * is validated before it arrives and percent-encoded on the way in, so no
 * caller input can escape the `repos/{owner}/{repository}/…` prefix — or, for
 * the single unscoped kind, the fixed `user` path.
 */
export function buildOperationUrl(
  baseUrl: URL,
  kind: GithubOperationKind,
  coordinates: GithubRepositoryCoordinates | null,
  trailingSegments: readonly string[] = [],
  query: Readonly<Record<string, string>> = {},
): URL {
  const descriptor = GITHUB_OPERATIONS[kind];
  // Absent coordinates for a repository-scoped kind must throw, never silently
  // build a different URL with the prefix dropped.
  invariant(
    descriptor.repositoryScoped === (coordinates !== null),
    "GITHUB_PROTOCOL_ERROR",
    "Repository coordinates must be present for exactly the repository-scoped operations",
  );
  const prefix =
    coordinates === null
      ? []
      : ["repos", assertOwner(coordinates.owner), assertRepository(coordinates.repository)];
  const segments = [...prefix, ...descriptor.segments, ...trailingSegments].map((segment) =>
    encodeURIComponent(segment),
  );
  const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
  const url = new URL(`${basePath}${segments.join("/")}`, baseUrl);
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return url;
}
