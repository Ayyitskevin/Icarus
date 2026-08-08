import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { GithubGatewayError } from "../../packages/github-gateway/src/errors.js";
import { GithubGateway } from "../../packages/github-gateway/src/gateway.js";
import {
  assertIcarusRef,
  branchNameForRef,
  ICARUS_REF_NAMESPACE,
  icarusRefForRun,
} from "../../packages/github-gateway/src/identifiers.js";
import { GITHUB_OPERATIONS } from "../../packages/github-gateway/src/operations.js";
import { resolveGithubOrigin } from "../../packages/github-gateway/src/origin.js";

const token = "ghp-test-only-token-value-0123456789";
const runId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const ref = `${ICARUS_REF_NAMESPACE}${runId}`;
const coordinates = { owner: "ayyitskevin", repository: "icarus" } as const;

const GATEWAY_SOURCE_DIRECTORY = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "packages",
  "github-gateway",
  "src",
);

/**
 * Comments name the forbidden effects in order to explain why they are absent,
 * so the executable-source assertions below read code only. Block comments and
 * whole-line comments are removed; nothing else is touched, so a string
 * containing `://` survives intact.
 */
function executableSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .join("\n");
}

async function readGatewaySources(): Promise<readonly { name: string; source: string }[]> {
  const entries = await readdir(GATEWAY_SOURCE_DIRECTORY, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      const raw = await readFile(path.join(GATEWAY_SOURCE_DIRECTORY, entry.name), "utf8");
      sources.push({ name: entry.name, source: executableSource(raw) });
    }
  }
  return sources;
}

function expectCode(call: () => unknown, code: string): GithubGatewayError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(GithubGatewayError);
    expect((error as GithubGatewayError).code).toBe(code);
    return error as GithubGatewayError;
  }
  throw new Error(`Expected ${code}`);
}

describe("GitHub gateway authority boundary", () => {
  it("exposes exactly the eight operations Packet 4 authorizes", () => {
    expect(Object.keys(GITHUB_OPERATIONS).toSorted()).toEqual([
      "create_absent_ref",
      "create_blob",
      "create_commit",
      "create_draft_pull_request",
      "create_tree",
      "read_actor",
      "read_pull_requests",
      "read_reference",
    ]);
  });

  it("emits no method other than GET and POST, so updates and deletions are inexpressible", () => {
    for (const descriptor of Object.values(GITHUB_OPERATIONS)) {
      expect(["GET", "POST"]).toContain(descriptor.method);
    }
  });

  it("contains no forbidden HTTP method anywhere in the package source", async () => {
    for (const { name, source } of await readGatewaySources()) {
      // A reference update, force update, or deletion requires one of these
      // methods. Their absence is the structural guarantee, not a convention.
      expect(source, `${name} must not name PUT`).not.toMatch(/"PUT"|'PUT'|`PUT`/);
      expect(source, `${name} must not name PATCH`).not.toMatch(/"PATCH"|'PATCH'|`PATCH`/);
      expect(source, `${name} must not name DELETE`).not.toMatch(/"DELETE"|'DELETE'|`DELETE`/);
    }
  });

  it("names no merge, force, deployment, or workflow-dispatch endpoint", async () => {
    for (const { name, source } of await readGatewaySources()) {
      expect(source, `${name} must not reach a merge endpoint`).not.toMatch(
        /\/merges?\b|"merge"|merge_method/,
      );
      expect(source, `${name} must not express a force update`).not.toMatch(/\bforce\b/i);
      expect(source, `${name} must not reach deployments`).not.toMatch(/\bdeployments?\b/i);
      expect(source, `${name} must not dispatch workflows`).not.toMatch(/workflow|dispatches/i);
    }
  });

  it("refuses every reference outside the Icarus namespace", () => {
    expectCode(() => assertIcarusRef("refs/heads/main"), "GITHUB_REF_DENIED");
    expectCode(() => assertIcarusRef("refs/heads/icarus/../main"), "GITHUB_REF_DENIED");
    expectCode(() => assertIcarusRef("refs/tags/v1"), "GITHUB_REF_DENIED");
    expectCode(() => assertIcarusRef(`${ICARUS_REF_NAMESPACE}not-a-run-id`), "GITHUB_REF_DENIED");
    expect(assertIcarusRef(ref)).toBe(ref);
  });

  it("derives a branch name only from a validated Icarus reference", () => {
    expect(branchNameForRef(ref)).toBe(`icarus/${runId}`);
    expectCode(() => branchNameForRef("refs/heads/main"), "GITHUB_REF_DENIED");
  });

  it("builds an Icarus reference only for an exact run identifier", () => {
    expect(icarusRefForRun(runId)).toBe(ref);
    expectCode(() => icarusRefForRun("../../main"), "GITHUB_REF_DENIED");
  });
});

describe("GitHub gateway origin pinning", () => {
  it("accepts the pinned remote origin", () => {
    expect(resolveGithubOrigin("https://api.github.com").locality).toBe("remote");
  });

  it("accepts a loopback origin for offline transports", () => {
    expect(resolveGithubOrigin("http://127.0.0.1:8080/").locality).toBe("loopback");
  });

  it("refuses every other origin a credential could otherwise reach", () => {
    for (const denied of [
      "https://api.github.com.evil.test",
      "http://api.github.com",
      "https://raw.githubusercontent.com",
      "https://api.github.com:8443",
      "https://user:pass@api.github.com",
      "https://api.github.com/?redirect=1",
      "file:///etc/passwd",
      "not-a-url",
    ]) {
      expectCode(() => resolveGithubOrigin(denied), "GITHUB_ORIGIN_DENIED");
    }
  });
});

describe("GitHub gateway origin escape regressions", () => {
  // A base URL whose path begins with `//` makes the built request path a
  // scheme-relative reference, so resolving it replaces the authority and the
  // credential travels to an attacker-chosen host. Both the origin check and a
  // second check at dispatch must refuse it.
  const ESCAPES = [
    "https://api.github.com//evil.example.com/",
    "https://api.github.com//evil.example.com",
    "https://api.github.com/\\evil.example.com/",
    "https://api.github.com//",
    "http://127.0.0.1:8080//evil.example.com/",
    "https://api.github.com/api/v3/",
  ];

  it("refuses a base URL that is not the origin root", () => {
    for (const candidate of ESCAPES) {
      expectCode(() => resolveGithubOrigin(candidate), "GITHUB_ORIGIN_DENIED");
    }
  });

  it("never dispatches a request to a host other than the pinned origin", async () => {
    for (const candidate of ESCAPES) {
      let contacted: string | null = null;
      expect(() => {
        const gateway = new GithubGateway({
          baseUrl: candidate,
          token,
          fetchImplementation: async (url) => {
            contacted = String(url);
            return new Response("{}", {
              status: 201,
              headers: { "content-type": "application/json" },
            });
          },
        });
        return gateway;
      }).toThrow(GithubGatewayError);
      expect(contacted).toBeNull();
    }
  });

  it("sends the credential to the pinned host and nowhere else", async () => {
    const contacted: string[] = [];
    const gateway = new GithubGateway({
      baseUrl: "https://api.github.com",
      token,
      fetchImplementation: async (url, init = {}) => {
        contacted.push(new URL(String(url)).host);
        expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
        return new Response(JSON.stringify({ sha: "a".repeat(40) }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await gateway.createBlob(coordinates, "aGk=");

    expect(contacted).toEqual(["api.github.com"]);
  });
});

describe("GitHub gateway credential containment", () => {
  it("refuses blob content carrying its own credential, which base64 would hide", async () => {
    let contacted = false;
    const gateway = new GithubGateway({
      baseUrl: "https://api.github.com",
      token,
      fetchImplementation: async () => {
        contacted = true;
        return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
      },
    });
    const staged = Buffer.from(`ICARUS_GITHUB_TOKEN=${token}\n`, "utf8").toString("base64");

    await expect(gateway.createBlob(coordinates, staged)).rejects.toMatchObject({
      code: "GITHUB_SECRET_DETECTED",
    });
    expect(contacted).toBe(false);
  });

  it("keeps a caller-controlled error name out of evidence", async () => {
    const hostile = new Error("boom");
    hostile.name = `LEAK:${token}`;
    const gateway = new GithubGateway({
      baseUrl: "https://api.github.com",
      token,
      fetchImplementation: async () => {
        throw hostile;
      },
    });

    const error = await gateway
      .createBlob(coordinates, "aGk=")
      .then(() => null)
      .catch((thrown: GithubGatewayError) => thrown);

    expect(error).toBeInstanceOf(GithubGatewayError);
    const serialized = `${(error as GithubGatewayError).message} ${JSON.stringify((error as GithubGatewayError).details)}`;
    expect(serialized).not.toContain(token);
    expect((error as GithubGatewayError).details.cause).toBe("UnknownError");
  });
});

describe("GitHub gateway construction", () => {
  it("requires a credential", () => {
    expectCode(
      () => new GithubGateway({ baseUrl: "https://api.github.com", token: "" }),
      "GITHUB_TOKEN_REQUIRED",
    );
  });

  it("refuses a credential that could inject a header", () => {
    for (const invalid of ["short", "with space in it", "line\nbreak", "tab\tcharacter"]) {
      expectCode(
        () => new GithubGateway({ baseUrl: "https://api.github.com", token: invalid }),
        invalid.length < 8 ? "GITHUB_TOKEN_INVALID" : "GITHUB_TOKEN_INVALID",
      );
    }
  });

  it("accepts an ordinary token and reports its locality", () => {
    const gateway = new GithubGateway({ baseUrl: "https://api.github.com", token });
    expect(gateway.locality).toBe("remote");
  });

  it("refuses an out-of-range timeout", () => {
    expectCode(
      () => new GithubGateway({ baseUrl: "https://api.github.com", token, timeoutMs: 500_000 }),
      "GITHUB_TIMEOUT_INVALID",
    );
  });

  it("never exposes the credential on the instance", () => {
    const gateway = new GithubGateway({ baseUrl: "https://api.github.com", token });
    expect(JSON.stringify(gateway)).not.toContain(token);
    expect(Object.values(gateway).join(" ")).not.toContain(token);
    expect(Reflect.ownKeys(gateway).join(" ")).not.toContain(token);
  });
});

describe("GitHub gateway input validation", () => {
  const gateway = new GithubGateway({ baseUrl: "https://api.github.com", token });

  it("refuses a traversal or absolute tree path before any request", async () => {
    for (const badPath of ["../escape", "/etc/passwd", "a/../../b", "with space"]) {
      await expect(
        gateway.createTree(
          coordinates,
          [{ path: badPath, mode: "100644", blobSha: "a".repeat(40) }],
          undefined,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_PATH_INVALID" });
    }
  });

  it("refuses a symlink, submodule, or executable-escalating file mode", async () => {
    for (const mode of ["120000", "160000", "040000", "100777"]) {
      await expect(
        gateway.createTree(
          coordinates,
          [{ path: "a.txt", mode, blobSha: "a".repeat(40) }],
          undefined,
        ),
      ).rejects.toMatchObject({ code: "GITHUB_FILE_MODE_DENIED" });
    }
  });

  it("refuses a malformed object name", async () => {
    await expect(
      gateway.createTree(
        coordinates,
        [{ path: "a.txt", mode: "100644", blobSha: "zz" }],
        undefined,
      ),
    ).rejects.toMatchObject({ code: "GITHUB_OBJECT_SHA_INVALID" });
  });

  it("refuses an owner or repository that could escape the path prefix", async () => {
    await expect(
      gateway.readReference({ owner: "../..", repository: "icarus" }, ref),
    ).rejects.toMatchObject({ code: "GITHUB_OWNER_INVALID" });
    await expect(
      gateway.readReference({ owner: "ayyitskevin", repository: "a/../b" }, ref),
    ).rejects.toMatchObject({ code: "GITHUB_REPOSITORY_INVALID" });
  });

  it("refuses a base branch that is not an ordinary branch name", async () => {
    for (const base of ["../main", "main..dev", "-main", "main.lock", "refs//heads"]) {
      await expect(
        gateway.createDraftPullRequest(coordinates, {
          title: "t",
          body: "b",
          headRef: ref,
          baseBranch: base,
        }),
      ).rejects.toMatchObject({ code: "GITHUB_BASE_BRANCH_INVALID" });
    }
  });

  it("refuses a multi-line pull request title", async () => {
    await expect(
      gateway.createDraftPullRequest(coordinates, {
        title: "line\nsecond",
        body: "b",
        headRef: ref,
        baseBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "GITHUB_TITLE_INVALID" });
  });
});
