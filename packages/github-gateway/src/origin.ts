import { invariant } from "./errors.js";

/** The only remote origin this gateway may send a credential to. */
export const GITHUB_API_HOST = "api.github.com";

export type GithubOriginLocality = "remote" | "loopback";

export interface ResolvedGithubOrigin {
  readonly url: URL;
  readonly locality: GithubOriginLocality;
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Mirrors the provider-adapter rule in `@icarus/core`: a credential may travel
 * only to the exact pinned remote origin, or to a loopback origin used by
 * offline tests and the deterministic benchmark transport. Any other host is
 * refused before a request is built, so a redirected, injected, or
 * misconfigured base URL cannot exfiltrate the token.
 */
export function resolveGithubOrigin(baseUrl: string): ResolvedGithubOrigin {
  const parsed = URL.parse(baseUrl);
  invariant(parsed !== null, "GITHUB_ORIGIN_DENIED", "GitHub base URL is not a valid absolute URL");
  const url = parsed;
  invariant(
    url.username === "" && url.password === "" && url.search === "" && url.hash === "",
    "GITHUB_ORIGIN_DENIED",
    "GitHub base URL must carry no credentials, query, or fragment",
  );
  // The base URL must be root. A pathname beginning with `//` would make the
  // relative request path a scheme-relative reference, and resolving it would
  // silently replace the authority — sending the credential to a host that
  // passed every check above.
  invariant(
    url.pathname === "/",
    "GITHUB_ORIGIN_DENIED",
    "GitHub base URL must address the origin root",
  );
  const hostname = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    invariant(
      url.protocol === "http:" || url.protocol === "https:",
      "GITHUB_ORIGIN_DENIED",
      "A loopback GitHub base URL must use HTTP or HTTPS",
    );
    return { url, locality: "loopback" };
  }
  invariant(
    url.protocol === "https:" &&
      hostname === GITHUB_API_HOST &&
      (url.port === "" || url.port === "443"),
    "GITHUB_ORIGIN_DENIED",
    "Remote GitHub credentials may only be sent to api.github.com over HTTPS",
  );
  return { url, locality: "remote" };
}
