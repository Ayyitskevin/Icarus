import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { GithubGatewayError } from "../../packages/github-gateway/src/errors.js";
import { GithubGateway } from "../../packages/github-gateway/src/gateway.js";
import { ICARUS_REF_NAMESPACE } from "../../packages/github-gateway/src/identifiers.js";
import {
  type CapturedProviderRequest,
  type ProviderHttpServer,
  parseProviderRequestBody,
  sendProviderJson,
  startProviderHttpServer,
} from "../support/provider-http.js";

const token = "ghp-test-only-token-value-0123456789";
const runId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const ref = `${ICARUS_REF_NAMESPACE}${runId}`;
const coordinates = { owner: "ayyitskevin", repository: "icarus" } as const;
const commitSha = "1".repeat(40);
const treeSha = "2".repeat(40);
const blobSha = "3".repeat(40);
const GIT_INSTANT = "2026-07-19T12:00:00Z";

/** A complete GitHub pull-request response entry; tests override what they vary. */
function pullRequestEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 9,
    draft: true,
    state: "open",
    merged_at: null,
    title: "Icarus candidate",
    body: "evidence",
    maintainer_can_modify: false,
    head: { ref: `icarus/${runId}`, sha: commitSha },
    base: { ref: "main", sha: treeSha },
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<GithubGatewayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GithubGatewayError);
    expect((error as GithubGatewayError).code).toBe(code);
    return error as GithubGatewayError;
  }
  throw new Error(`Expected ${code}`);
}

describe("GithubGateway HTTP contract", () => {
  let server: ProviderHttpServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function gatewayFor(target: ProviderHttpServer): GithubGateway {
    return new GithubGateway({
      baseUrl: target.baseUrl,
      token,
      timeoutMs: 2_000,
      allowLoopback: true,
    });
  }

  it("uploads a blob to the exact endpoint with the pinned API version", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, { sha: blobSha, url: "ignored" });
    });

    const receipt = await gatewayFor(server).createBlob(coordinates, "aGVsbG8=");

    expect(receipt.sha).toBe(blobSha);
    const request = server.requests[0] as CapturedProviderRequest;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/repos/ayyitskevin/icarus/git/blobs");
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    expect(request.headers["x-github-api-version"]).toBe("2026-03-10");
    expect(parseProviderRequestBody(request)).toEqual({
      content: "aGVsbG8=",
      encoding: "base64",
    });
  });

  it("records the digest of the exact response bytes on every receipt", async () => {
    const body = { sha: blobSha };
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, body);
    });

    const receipt = await gatewayFor(server).createBlob(coordinates, "aGVsbG8=");

    expect(receipt.responseSha256).toBe(
      createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
    );
  });

  it("creates a tree of regular files and forwards a base tree", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, { sha: treeSha });
    });

    await gatewayFor(server).createTree(
      coordinates,
      [
        { path: "src/greeting.txt", mode: "100644", blobSha },
        { path: "src/removed.txt", mode: "100644", blobSha: null },
      ],
      treeSha,
    );

    const request = server.requests[0] as CapturedProviderRequest;
    expect(request.url).toBe("/repos/ayyitskevin/icarus/git/trees");
    expect(parseProviderRequestBody(request)).toEqual({
      tree: [
        { path: "src/greeting.txt", mode: "100644", type: "blob", sha: blobSha },
        { path: "src/removed.txt", mode: "100644", type: "blob", sha: null },
      ],
      base_tree: treeSha,
    });
  });

  it("creates a commit with its declared parents and exact landing identity", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, { sha: commitSha });
    });

    const receipt = await gatewayFor(server).createCommit(coordinates, {
      message: "Icarus candidate",
      treeSha,
      parentShas: [blobSha],
      author: { name: "Icarus Landing", email: "landing@example.invalid", date: GIT_INSTANT },
      committer: { name: "Icarus Landing", email: "landing@example.invalid", date: GIT_INSTANT },
    });

    expect(receipt.sha).toBe(commitSha);
    expect(parseProviderRequestBody(server.requests[0] as CapturedProviderRequest)).toEqual({
      message: "Icarus candidate",
      tree: treeSha,
      parents: [blobSha],
      author: { name: "Icarus Landing", email: "landing@example.invalid", date: GIT_INSTANT },
      committer: { name: "Icarus Landing", email: "landing@example.invalid", date: GIT_INSTANT },
    });
  });

  it("serializes every mutation body in the record contract's canonical key order", async () => {
    // The landing ledger binds each admitted body with a SHA-256 over the
    // canonical ascending-ASCII serialization. If the gateway's wire bytes ever
    // drift from that byte order, the durable digest stops binding the actual
    // effect — so the raw captured body is compared, not a parsed value.
    const expected = new Map<string, string>([
      ["blobs", `{"content":"aGVsbG8=","encoding":"base64"}`],
      [
        "trees",
        `{"base_tree":"${treeSha}","tree":[{"mode":"100644","path":"src/greeting.txt","sha":"${blobSha}","type":"blob"}]}`,
      ],
      [
        "commits",
        `{"author":{"date":"${GIT_INSTANT}","email":"landing@example.invalid","name":"Icarus Landing"},"committer":{"date":"${GIT_INSTANT}","email":"landing@example.invalid","name":"Icarus Landing"},"message":"Icarus candidate","parents":["${blobSha}"],"tree":"${treeSha}"}`,
      ],
      ["refs", `{"ref":"${ref}","sha":"${commitSha}"}`],
    ]);
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, {
        sha: commitSha,
        ref,
        object: { sha: commitSha, type: "commit" },
      });
    });

    await gatewayFor(server).createBlob(coordinates, "aGVsbG8=");
    await gatewayFor(server).createTree(
      coordinates,
      [{ path: "src/greeting.txt", mode: "100644", blobSha }],
      treeSha,
    );
    await gatewayFor(server).createCommit(coordinates, {
      message: "Icarus candidate",
      treeSha,
      parentShas: [blobSha],
      author: { name: "Icarus Landing", email: "landing@example.invalid", date: GIT_INSTANT },
      committer: { name: "Icarus Landing", email: "landing@example.invalid", date: GIT_INSTANT },
    });
    await gatewayFor(server).createAbsentRef(coordinates, ref, commitSha);

    for (const request of server.requests) {
      const endpoint = request.url?.split("/").at(-1) ?? "";
      expect(request.body, endpoint).toBe(expected.get(endpoint));
    }
  });

  it("creates the reference with POST so an existing reference cannot be overwritten", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, { ref, object: { sha: commitSha, type: "commit" } });
    });

    const receipt = await gatewayFor(server).createAbsentRef(coordinates, ref, commitSha);

    expect(receipt).toMatchObject({ ref, sha: commitSha });
    const request = server.requests[0] as CapturedProviderRequest;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/repos/ayyitskevin/icarus/git/refs");
    expect(parseProviderRequestBody(request)).toEqual({ ref, sha: commitSha });
  });

  it("reports a refused reference creation without claiming why", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 422, { message: "Reference already exists" });
    });

    const error = await expectCode(
      gatewayFor(server).createAbsentRef(coordinates, ref, commitSha),
      "GITHUB_REF_CREATE_REFUSED",
    );

    expect(server.requests).toHaveLength(1);
    expect(error.details).toMatchObject({ status: 422, ref });
  });

  it("refuses a reference response that names a different reference", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, {
        ref: "refs/heads/main",
        object: { sha: commitSha, type: "commit" },
      });
    });

    await expectCode(
      gatewayFor(server).createAbsentRef(coordinates, ref, commitSha),
      "GITHUB_PROTOCOL_ERROR",
    );
  });

  it("always opens the pull request as a draft", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, pullRequestEntry({ number: 42 }));
    });

    const receipt = await gatewayFor(server).createDraftPullRequest(coordinates, {
      title: "Icarus candidate",
      body: "evidence",
      headRef: ref,
      baseBranch: "main",
    });

    expect(receipt).toMatchObject({
      number: 42,
      isDraft: true,
      state: "open",
      headSha1: commitSha,
      baseSha1: treeSha,
      markerCount: 0,
      maintainerCanModify: false,
    });
    expect(receipt.htmlUrl).toBe("https://github.com/ayyitskevin/icarus/pull/42");
    // The owner-qualified head is the record contract's exact wire form.
    expect(parseProviderRequestBody(server.requests[0] as CapturedProviderRequest)).toEqual({
      title: "Icarus candidate",
      body: "evidence",
      head: `ayyitskevin:icarus/${runId}`,
      base: "main",
      draft: true,
      maintainer_can_modify: false,
    });
  });

  it("refuses a pull request GitHub did not record as a draft", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, pullRequestEntry({ number: 42, draft: false }));
    });

    await expectCode(
      gatewayFor(server).createDraftPullRequest(coordinates, {
        title: "t",
        body: "b",
        headRef: ref,
        baseBranch: "main",
      }),
      "GITHUB_DRAFT_NOT_HONORED",
    );
  });

  it("reconstructs the pull request URL instead of echoing the response", async () => {
    server = await startProviderHttpServer((_request, response) => {
sendProviderJson(response, 201, pullRequestEntry({ number: 7, html_url: "https://evil.test/phish" }));
    });

    const receipt = await gatewayFor(server).createDraftPullRequest(coordinates, {
      title: "t",
      body: "b",
      headRef: ref,
      baseBranch: "main",
    });

    expect(receipt.htmlUrl).toBe("https://github.com/ayyitskevin/icarus/pull/7");
  });

  it("reads an absent reference as null so a retry can reconcile", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 404, { message: "Not Found" });
    });

    expect(await gatewayFor(server).readReference(coordinates, ref)).toBeNull();
    expect((server.requests[0] as CapturedProviderRequest).url).toBe(
      `/repos/ayyitskevin/icarus/git/ref/heads/icarus/${runId}`,
    );
  });

  it("reads an existing reference for reconciliation", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, { ref, object: { sha: commitSha, type: "commit" } });
    });

    expect(await gatewayFor(server).readReference(coordinates, ref)).toMatchObject({
      ref,
      sha: commitSha,
    });
  });

  it("finds an existing draft pull request by head for idempotent retry", async () => {
    server = await startProviderHttpServer((_request, response) => {
sendProviderJson(response, 200, [pullRequestEntry({ number: 9 })]);
    });

    const receipt = await gatewayFor(server).readPullRequestByHead(coordinates, ref, "main");

    expect(receipt).toMatchObject({ number: 9, isDraft: true, baseBranch: "main" });
    const request = server.requests[0] as CapturedProviderRequest;
    expect(request.method).toBe("GET");
    expect(request.url).toBe(
      `/repos/ayyitskevin/icarus/pulls?head=ayyitskevin%3Aicarus%2F${runId}` +
        "&base=main&state=all&page=1&per_page=100",
    );
    expect(request.body).toBe("");
  });

  it("still finds an Icarus pull request a human marked ready for review", async () => {
    // Reconciliation must locate the existing pull request rather than refuse
    // it, or an interrupted attempt would open a second one.
    server = await startProviderHttpServer((_request, response) => {
sendProviderJson(response, 200, [pullRequestEntry({ number: 11, draft: false })]);
    });

    const receipt = await gatewayFor(server).readPullRequestByHead(coordinates, ref, "main");

    expect(receipt).toMatchObject({ number: 11, isDraft: false });
  });

  it("refuses a listed pull request whose head or base is not the one requested", async () => {
    for (const entry of [
      { base: { ref: "release", sha: treeSha } },
      { head: { ref: "someone-elses-branch", sha: commitSha } },
    ]) {
      await server?.close();
      server = await startProviderHttpServer((_request, response) => {
        sendProviderJson(response, 200, [pullRequestEntry({ number: 3, ...entry })]);
      });

      await expectCode(
        gatewayFor(server).readPullRequestByHead(coordinates, ref, "main"),
        "GITHUB_PROTOCOL_ERROR",
      );
    }
  });

  it("distinguishes a merged pull request from an abandoned one", async () => {
    server = await startProviderHttpServer((_request, response) => {
sendProviderJson(response, 200, [pullRequestEntry({ number: 12, draft: false, state: "closed", merged_at: "2026-08-08T04:00:00Z" })]);
    });

    const receipt = await gatewayFor(server).readPullRequestByHead(coordinates, ref, "main");

    expect(receipt).toMatchObject({ number: 12, state: "closed", isMerged: true });
  });

  it("reports no existing pull request as null", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, []);
    });

    expect(await gatewayFor(server).readPullRequestByHead(coordinates, ref, "main")).toBeNull();
  });

  it("never follows a redirect that could move the credential off the pinned origin", async () => {
    server = await startProviderHttpServer((_request, response) => {
      response.writeHead(302, { location: "https://evil.test/steal" });
      response.end();
    });

    await expectCode(
      gatewayFor(server).createBlob(coordinates, "aGVsbG8="),
      "GITHUB_REDIRECT_DENIED",
    );
  });

  it("keeps upstream response bytes out of the error surface", async () => {
    const upstream = "ghs_leaked_looking_value_and_prose_from_upstream";
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 500, { message: upstream });
    });

    const error = await expectCode(
      gatewayFor(server).createBlob(coordinates, "aGVsbG8="),
      "GITHUB_HTTP_ERROR",
    );

    const serialized = `${error.message} ${JSON.stringify(error.details)}`;
    expect(serialized).not.toContain(upstream);
    expect(serialized).not.toContain(token);
    expect(error.details).toMatchObject({ status: 500, operation: "create_blob" });
    expect(typeof error.details.responseSha256).toBe("string");
  });

  it("refuses a response body that exceeds the ceiling", async () => {
    server = await startProviderHttpServer((_request, response) => {
      response.writeHead(201, {
        "content-type": "application/json",
        "content-length": String(8 * 1024 * 1024),
      });
      response.end(JSON.stringify({ sha: blobSha }));
    });

    await expectCode(
      gatewayFor(server).createBlob(coordinates, "aGVsbG8="),
      "GITHUB_RESPONSE_TOO_LARGE",
    );
  });

  it("refuses a non-JSON response", async () => {
    server = await startProviderHttpServer((_request, response) => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end("<html>not json</html>");
    });

    await expectCode(
      gatewayFor(server).createBlob(coordinates, "aGVsbG8="),
      "GITHUB_PROTOCOL_ERROR",
    );
  });

  it("stops before the request when the caller has already cancelled", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, { sha: blobSha });
    });
    const controller = new AbortController();
    controller.abort();

    await expectCode(
      gatewayFor(server).createBlob(coordinates, "aGVsbG8=", { signal: controller.signal }),
      "GITHUB_CANCELLED",
    );
    expect(server.requests).toHaveLength(0);
  });

  it("reports an interrupted mutation as ambiguous rather than failed", async () => {
    // The host cannot know whether GitHub applied the effect, so ADR 0027
    // forbids inferring failure from an absent response.
    const unreachable = new GithubGateway({
      baseUrl: "http://127.0.0.1:1/",
      token,
      timeoutMs: 1_000,
      allowLoopback: true,
    });

    const error = await expectCode(
      unreachable.createBlob(coordinates, "aGVsbG8="),
      "GITHUB_OUTCOME_AMBIGUOUS",
    );

    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain(token);
  });

  it("reports an interrupted read as an ordinary transport failure", async () => {
    const unreachable = new GithubGateway({
      baseUrl: "http://127.0.0.1:1/",
      token,
      timeoutMs: 1_000,
      allowLoopback: true,
    });

    const error = await expectCode(
      unreachable.readReference(coordinates, ref),
      "GITHUB_TRANSPORT_ERROR",
    );

    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain(token);
  });

  it("accepts a full page that GitHub did not mark as truncated", async () => {
    // A full page is only a hint; the Link header is the real signal. One open
    // entry among many closed ones is still unambiguous.
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, [
        pullRequestEntry({ number: 1 }),
        ...Array.from({ length: 99 }, (_value, index) =>
          pullRequestEntry({ number: index + 2, state: "closed" }),
        ),
      ]);
    });

    const receipt = await gatewayFor(server).readPullRequestByHead(coordinates, ref, "main");

    expect(receipt).toMatchObject({ number: 1, state: "open" });
  });

  it("fails closed when GitHub signals a further page", async () => {
    server = await startProviderHttpServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        link: '<https://api.github.com/repositories/1/pulls?page=2>; rel="next"',
      });
      response.end(JSON.stringify([]));
    });

    await expectCode(
      gatewayFor(server).readPullRequestByHead(coordinates, ref, "main"),
      "GITHUB_RECONCILIATION_AMBIGUOUS",
    );
  });

  it("still reconciles after a human closed and reopened the pull request", async () => {
    // GitHub permits many pull requests on one head so long as at most one is
    // open. Requiring exactly one would deadlock the run permanently.
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, [
        pullRequestEntry({ number: 5, state: "closed" }),
        pullRequestEntry({ number: 6 }),
      ]);
    });

    const receipt = await gatewayFor(server).readPullRequestByHead(coordinates, ref, "main");

    expect(receipt).toMatchObject({ number: 6, state: "open" });
  });

  it("reports a refused pull request creation without attributing a cause", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 422, {
        message: "A pull request already exists for ayyitskevin:icarus/x.",
      });
    });

    await expectCode(
      gatewayFor(server).createDraftPullRequest(coordinates, {
        title: "t",
        body: "b",
        headRef: ref,
        baseBranch: "main",
      }),
      "GITHUB_PULL_REQUEST_CREATE_REFUSED",
    );
  });

  it("refuses a loopback origin unless it is explicitly allowed", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {});
    });
    const target = server;

    expect(() => new GithubGateway({ baseUrl: target.baseUrl, token, timeoutMs: 2_000 })).toThrow(
      GithubGatewayError,
    );
    expect(target.requests).toHaveLength(0);
  });

  it("refuses undecodable base64 before dispatching a mutation", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, { sha: blobSha });
    });

    await expectCode(gatewayFor(server).createBlob(coordinates, "abcde"), "GITHUB_CONTENT_INVALID");
    expect(server.requests).toHaveLength(0);
  });

  it("fails closed when more than one open pull request matches", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(
        response,
        200,
Array.from({ length: 2 }, (_value, index) => pullRequestEntry({ number: index + 1 })),
      );
    });

    await expectCode(
      gatewayFor(server).readPullRequestByHead(coordinates, ref, "main"),
      "GITHUB_RECONCILIATION_AMBIGUOUS",
    );
  });

  it("fails closed when more than one pull request matches the exact head", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, [
        pullRequestEntry({ number: 1 }),
        pullRequestEntry({ number: 2 }),
      ]);
    });

    await expectCode(
      gatewayFor(server).readPullRequestByHead(coordinates, ref, "main"),
      "GITHUB_RECONCILIATION_AMBIGUOUS",
    );
  });

  it("verifies the credential belongs to the expected actor", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, { login: "someone-else" });
    });

    await expectCode(gatewayFor(server).readActor("ayyitskevin"), "GITHUB_ACTOR_MISMATCH");
    expect((server.requests[0] as CapturedProviderRequest).url).toBe("/user");
  });

  it("reads the base branch the candidate commit parents from", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {
        ref: "refs/heads/main",
        object: { sha: commitSha, type: "commit" },
      });
    });

    const receipt = await gatewayFor(server).readBaseReference(coordinates, "refs/heads/main");

    expect(receipt).toMatchObject({ ref: "refs/heads/main", sha: commitSha });
    const request = server.requests[0] as CapturedProviderRequest;
    expect(request.method).toBe("GET");
    expect(request.url).toBe("/repos/ayyitskevin/icarus/git/ref/heads/main");
  });

  it("reports an absent base branch as null rather than an error", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 404, { message: "Not Found" });
    });

    await expect(
      gatewayFor(server).readBaseReference(coordinates, "refs/heads/main"),
    ).resolves.toBeNull();
  });

  it("refuses to read an Icarus-namespaced reference as a base branch", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, { ref, object: { sha: commitSha } });
    });

    // The base read is the only operation that may name a reference outside the
    // Icarus namespace; it must not become a second way to observe the one the
    // create path owns.
    await expectCode(
      gatewayFor(server).readBaseReference(coordinates, ref),
      "GITHUB_BASE_BRANCH_INVALID",
    );
    expect(server.requests).toHaveLength(0);
  });

  it("refuses a base reference that is not fully qualified", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {});
    });

    await expectCode(
      gatewayFor(server).readBaseReference(coordinates, "main"),
      "GITHUB_BASE_BRANCH_INVALID",
    );
    expect(server.requests).toHaveLength(0);
  });

  it("carries throttling signals as bounded integers beside a refusal", async () => {
    server = await startProviderHttpServer((_request, response) => {
      response.writeHead(403, {
        "content-type": "application/json",
        "retry-after": "60",
        "x-ratelimit-remaining": "0",
      });
      response.end(JSON.stringify({ message: "rate limited" }));
    });

    const error = await expectCode(
      gatewayFor(server).readBaseReference(coordinates, "refs/heads/main"),
      "GITHUB_HTTP_ERROR",
    );

    // A secondary rate limit and an authorization failure are both 403, so the
    // coordinator needs these to tell a wait-and-retry refusal from a terminal
    // one.
    expect(error.details).toMatchObject({ retryAfterSeconds: 60, rateLimitRemaining: 0 });
  });

  it("reduces unparsable throttling headers to null instead of carrying their text", async () => {
    server = await startProviderHttpServer((_request, response) => {
      response.writeHead(403, {
        "content-type": "application/json",
        "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT",
        "x-ratelimit-remaining": "not-a-number",
      });
      response.end(JSON.stringify({ message: "rate limited" }));
    });

    const error = await expectCode(
      gatewayFor(server).readBaseReference(coordinates, "refs/heads/main"),
      "GITHUB_HTTP_ERROR",
    );

    expect(error.details).toMatchObject({ retryAfterSeconds: null, rateLimitRemaining: null });
    expect(JSON.stringify(error.details)).not.toContain("Oct");
    expect(JSON.stringify(error.details)).not.toContain("not-a-number");
  });

  it("refuses a tree with no entries before dispatching", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, { sha: treeSha });
    });

    await expectCode(
      gatewayFor(server).createTree(coordinates, [], undefined),
      "GITHUB_TREE_INVALID",
    );
    expect(server.requests).toHaveLength(0);
  });

  it("refuses a commit declaring more parents than a candidate can have", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, { sha: commitSha });
    });

    await expectCode(
      gatewayFor(server).createCommit(coordinates, {
        message: "candidate",
        treeSha,
        parentShas: [commitSha, blobSha, treeSha],
        author: { name: "Icarus Landing", email: "landing@example.invalid", date: GIT_INSTANT },
        committer: { name: "Icarus Landing", email: "landing@example.invalid", date: GIT_INSTANT },
      }),
      "GITHUB_COMMIT_PARENTS_INVALID",
    );
    expect(server.requests).toHaveLength(0);
  });

  it("classifies a read that exceeds its timeout as a timeout, not an ambiguous outcome", async () => {
    server = await startProviderHttpServer(() => {
      // Never responds: the request outlives the gateway's timeout.
    });
    const gateway = new GithubGateway({
      baseUrl: server.baseUrl,
      token,
      timeoutMs: 50,
      allowLoopback: true,
    });

    const error = await expectCode(
      gateway.readBaseReference(coordinates, "refs/heads/main"),
      "GITHUB_TIMEOUT",
    );

    expect(error.details).toMatchObject({ reason: "timeout" });
  });

  it("names the loopback opt-in exactly when a local origin is not opted into", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, {});
    });
    const target = server.baseUrl;

    await expectCode(
      Promise.resolve().then(() => new GithubGateway({ baseUrl: target, token })),
      "GITHUB_LOOPBACK_NOT_ALLOWED",
    );
  });
});
