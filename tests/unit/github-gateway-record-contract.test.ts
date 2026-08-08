import { describe, expect, it } from "vitest";

import {
  GITHUB_API_VERSION,
  MAX_COMMIT_MESSAGE_BYTES,
  MAX_PULL_REQUEST_BODY_BYTES,
  MAX_PULL_REQUEST_TITLE_BYTES,
} from "../../packages/core/src/landing-records.js";
import { GithubGatewayError } from "../../packages/github-gateway/src/errors.js";
import { GithubGateway } from "../../packages/github-gateway/src/gateway.js";
import {
  assertOwner,
  assertRepository,
  ICARUS_REF_NAMESPACE,
  MAX_COMMIT_MESSAGE_BYTES as GATEWAY_MAX_COMMIT_MESSAGE_BYTES,
  MAX_PULL_REQUEST_BODY_BYTES as GATEWAY_MAX_PULL_REQUEST_BODY_BYTES,
  MAX_PULL_REQUEST_TITLE_BYTES as GATEWAY_MAX_PULL_REQUEST_TITLE_BYTES,
} from "../../packages/github-gateway/src/identifiers.js";

const token = "ghp-test-only-token-value-0123456789";
const runId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const ref = `${ICARUS_REF_NAMESPACE}${runId}`;
const coordinates = { owner: "ayyitskevin", repository: "icarus" } as const;

/**
 * `@icarus/github-gateway` cannot import `@icarus/core` without inverting the
 * dependency direction the landing coordinator needs, so its copies of the ADR
 * 0027 record-contract constants are checked against core's here. If either
 * side is edited alone, this fails rather than letting the wire format drift
 * away from the contract the landing digest binds.
 */
describe("gateway agreement with the ADR 0027 record contract", () => {
  it("pins the same GitHub API version core's landing digest binds", async () => {
    const requests: string[] = [];
    const gateway = new GithubGateway({
      baseUrl: "https://api.github.com",
      token,
      fetchImplementation: async (_url, init = {}) => {
        requests.push(String((init.headers as Record<string, string>)["x-github-api-version"]));
        return new Response(JSON.stringify({ login: "ayyitskevin" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await gateway.readActor("ayyitskevin");

    expect(requests).toEqual([GITHUB_API_VERSION]);
  });

  it("uses the same UTF-8 byte ceilings as the record contract", () => {
    expect(GATEWAY_MAX_COMMIT_MESSAGE_BYTES).toBe(MAX_COMMIT_MESSAGE_BYTES);
    expect(GATEWAY_MAX_PULL_REQUEST_TITLE_BYTES).toBe(MAX_PULL_REQUEST_TITLE_BYTES);
    expect(GATEWAY_MAX_PULL_REQUEST_BODY_BYTES).toBe(MAX_PULL_REQUEST_BODY_BYTES);
  });

  it("accepts the lowercase identities core validates and refuses mixed case", () => {
    expect(assertOwner("ayyitskevin")).toBe("ayyitskevin");
    expect(assertRepository("icarus")).toBe("icarus");
    for (const owner of ["Ayyitskevin", "AYYITSKEVIN", "a--b"]) {
      expect(() => assertOwner(owner)).toThrow(GithubGatewayError);
    }
    expect(() => assertRepository("Icarus")).toThrow(GithubGatewayError);
  });

  it("counts ceilings in UTF-8 bytes rather than UTF-16 code units", async () => {
    const gateway = new GithubGateway({ baseUrl: "https://api.github.com", token });
    // 2049 four-byte characters is under the UTF-16 length ceiling but far over
    // the 4 KiB byte ceiling the record contract states.
    const overByBytes = "😀".repeat(2_049);

    await expect(
      gateway.createCommit(coordinates, {
        message: overByBytes,
        treeSha: "a".repeat(40),
        parentShas: [],
      }),
    ).rejects.toMatchObject({ code: "GITHUB_COMMIT_MESSAGE_INVALID" });

    await expect(
      gateway.createDraftPullRequest(coordinates, {
        title: "ok",
        body: "😀".repeat(10_241),
        headRef: ref,
        baseBranch: "main",
      }),
    ).rejects.toMatchObject({ code: "GITHUB_BODY_INVALID" });
  });
});
