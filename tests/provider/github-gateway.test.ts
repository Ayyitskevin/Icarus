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
    return new GithubGateway({ baseUrl: target.baseUrl, token, timeoutMs: 2_000 });
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
      [{ path: "src/greeting.txt", mode: "100644", blobSha }],
      treeSha,
    );

    const request = server.requests[0] as CapturedProviderRequest;
    expect(request.url).toBe("/repos/ayyitskevin/icarus/git/trees");
    expect(parseProviderRequestBody(request)).toEqual({
      tree: [{ path: "src/greeting.txt", mode: "100644", type: "blob", sha: blobSha }],
      base_tree: treeSha,
    });
  });

  it("creates a commit with its declared parents", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, { sha: commitSha });
    });

    const receipt = await gatewayFor(server).createCommit(coordinates, {
      message: "Icarus candidate",
      treeSha,
      parentShas: [blobSha],
    });

    expect(receipt.sha).toBe(commitSha);
    expect(parseProviderRequestBody(server.requests[0] as CapturedProviderRequest)).toEqual({
      message: "Icarus candidate",
      tree: treeSha,
      parents: [blobSha],
    });
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
      sendProviderJson(response, 201, { number: 42, draft: true, state: "open" });
    });

    const receipt = await gatewayFor(server).createDraftPullRequest(coordinates, {
      title: "Icarus candidate",
      body: "evidence",
      headRef: ref,
      baseBranch: "main",
    });

    expect(receipt).toMatchObject({ number: 42, isDraft: true, state: "open" });
    expect(receipt.htmlUrl).toBe("https://github.com/ayyitskevin/icarus/pull/42");
    expect(parseProviderRequestBody(server.requests[0] as CapturedProviderRequest)).toEqual({
      title: "Icarus candidate",
      body: "evidence",
      head: `icarus/${runId}`,
      base: "main",
      draft: true,
      maintainer_can_modify: false,
    });
  });

  it("refuses a pull request GitHub did not record as a draft", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 201, { number: 42, draft: false, state: "open" });
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
      sendProviderJson(response, 201, {
        number: 7,
        draft: true,
        state: "open",
        html_url: "https://evil.test/phish",
      });
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
      sendProviderJson(response, 200, [
        {
          number: 9,
          draft: true,
          state: "open",
          base: { ref: "main" },
          head: { ref: `icarus/${runId}` },
          merged_at: null,
        },
      ]);
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
      sendProviderJson(response, 200, [
        {
          number: 11,
          draft: false,
          state: "open",
          base: { ref: "main" },
          head: { ref: `icarus/${runId}` },
          merged_at: null,
        },
      ]);
    });

    const receipt = await gatewayFor(server).readPullRequestByHead(coordinates, ref, "main");

    expect(receipt).toMatchObject({ number: 11, isDraft: false });
  });

  it("refuses a listed pull request whose head or base is not the one requested", async () => {
    for (const entry of [
      { base: { ref: "release" }, head: { ref: `icarus/${runId}` } },
      { base: { ref: "main" }, head: { ref: "someone-elses-branch" } },
    ]) {
      await server?.close();
      server = await startProviderHttpServer((_request, response) => {
        sendProviderJson(response, 200, [
          { number: 3, draft: true, state: "open", merged_at: null, ...entry },
        ]);
      });

      await expectCode(
        gatewayFor(server).readPullRequestByHead(coordinates, ref, "main"),
        "GITHUB_PROTOCOL_ERROR",
      );
    }
  });

  it("distinguishes a merged pull request from an abandoned one", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(response, 200, [
        {
          number: 12,
          draft: false,
          state: "closed",
          base: { ref: "main" },
          head: { ref: `icarus/${runId}` },
          merged_at: "2026-08-08T04:00:00Z",
        },
      ]);
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
    });

    const error = await expectCode(
      unreachable.readReference(coordinates, ref),
      "GITHUB_TRANSPORT_ERROR",
    );

    expect(`${error.message} ${JSON.stringify(error.details)}`).not.toContain(token);
  });

  it("fails closed when a full pull request page makes absence unprovable", async () => {
    server = await startProviderHttpServer((_request, response) => {
      sendProviderJson(
        response,
        200,
        Array.from({ length: 100 }, (_value, index) => ({
          number: index + 1,
          draft: true,
          state: "open",
          base: { ref: "main" },
          head: { ref: `icarus/${runId}` },
          merged_at: null,
        })),
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
        {
          number: 1,
          draft: true,
          state: "open",
          base: { ref: "main" },
          head: { ref: `icarus/${runId}` },
          merged_at: null,
        },
        {
          number: 2,
          draft: true,
          state: "open",
          base: { ref: "main" },
          head: { ref: `icarus/${runId}` },
          merged_at: null,
        },
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
});
