import { describe, expect, it } from "vitest";

import * as gateway from "../../packages/github-gateway/src/index.js";

/**
 * Every other gateway suite imports deep source paths, so the published export
 * surface is not otherwise exercised: a symbol could be dropped from `index.ts`
 * and every test would still pass while `@icarus/core` failed to import it.
 * This suite imports only the package entry point.
 */
describe("gateway published export surface", () => {
  it("exports exactly the runtime values the landing coordinator may use", () => {
    expect(Object.keys(gateway).toSorted()).toEqual([
      "GITHUB_API_HOST",
      "GITHUB_OPERATIONS",
      "GithubGateway",
      "GithubGatewayError",
      "ICARUS_REF_NAMESPACE",
      "assertBaseBranch",
      "assertBaseRef",
      "assertIcarusRef",
      "branchNameForRef",
      "icarusRefForRun",
    ]);
  });

  it("constructs a gateway and derives references through the entry point alone", () => {
    const runId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const ref = gateway.icarusRefForRun(runId);

    expect(ref).toBe(`${gateway.ICARUS_REF_NAMESPACE}${runId}`);
    expect(gateway.branchNameForRef(ref)).toBe(`icarus/${runId}`);
    expect(gateway.assertBaseRef("refs/heads/main")).toBe("refs/heads/main");
    expect(
      new gateway.GithubGateway({
        baseUrl: `https://${gateway.GITHUB_API_HOST}`,
        token: "ghp-test-only-token-value-0123456789",
      }).locality,
    ).toBe("remote");
  });

  it("refuses an Icarus-namespaced base reference through the entry point", () => {
    expect(() =>
      gateway.assertBaseRef(`${gateway.ICARUS_REF_NAMESPACE}3f2504e0-4f89-11d3-9a0c-0305e82c3301`),
    ).toThrow(gateway.GithubGatewayError);
  });

  it("publishes every operation kind the authority table declares", () => {
    for (const descriptor of Object.values(gateway.GITHUB_OPERATIONS)) {
      expect(["GET", "POST"]).toContain(descriptor.method);
    }
    expect(Object.keys(gateway.GITHUB_OPERATIONS)).toContain("read_base_reference");
  });
});
