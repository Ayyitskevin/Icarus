import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  validateCiWorkflowSupplyChain,
  validateWorkflowAttributes,
} from "../../scripts/ci-workflow-policy.mjs";

const workflowPath = new URL("../../.github/workflows/ci.yml", import.meta.url);
const attributesPath = new URL("../../.gitattributes", import.meta.url);

async function workflow(): Promise<string> {
  return readFile(workflowPath, "utf8");
}

describe("CI workflow supply-chain policy", () => {
  it("accepts the reviewed immutable action pins and checkout boundary", async () => {
    const result = validateCiWorkflowSupplyChain(await workflow());
    expect(result.actions).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
      "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
    ]);
    expect(result.sha256).toBe("baedc1de20c4b9f4e1c4e70d3ee93c4c8f6865ea42a03568192fd36b1060ec91");
  });

  it("rejects a CRLF workflow instead of weakening the byte policy", async () => {
    const changed = (await workflow()).replaceAll("\n", "\r\n");

    expect(() => validateCiWorkflowSupplyChain(changed)).toThrow(
      "CI workflow must use repository-pinned LF line endings",
    );
  });

  it("rejects mutable and alternate action references", async () => {
    const source = await workflow();
    const mutable = source.replace(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/checkout@v7",
    );
    const alternate = source.replace(
      "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
      `actions/setup-node@${"0".repeat(40)}`,
    );

    for (const changed of [mutable, alternate]) {
      expect(() => validateCiWorkflowSupplyChain(changed)).toThrow(
        "CI actions must match the reviewed immutable commit pins",
      );
    }
  });

  it("rejects an added action", async () => {
    const changed = (await workflow()).replace(
      "      - name: Install Node.js",
      "      - uses: example/unreviewed@1111111111111111111111111111111111111111\n\n" +
        "      - name: Install Node.js",
    );

    expect(() => validateCiWorkflowSupplyChain(changed)).toThrow(
      "CI actions must match the reviewed immutable commit pins",
    );
  });

  it.each([
    ['"uses": example/unreviewed@1111111111111111111111111111111111111111'],
    ["'uses': example/unreviewed@1111111111111111111111111111111111111111"],
    ["uses : example/unreviewed@1111111111111111111111111111111111111111"],
  ])("rejects a YAML key-spelling bypass: %s", async (usesLine) => {
    const changed = (await workflow()).replace(
      "      - name: Install Node.js",
      `      - name: Unreviewed action\n        ${usesLine}\n\n      - name: Install Node.js`,
    );

    expect(() => validateCiWorkflowSupplyChain(changed)).toThrow(
      "CI workflow digest must match the reviewed definition",
    );
  });

  it("rejects checkout credential or history drift", async () => {
    const source = await workflow();
    for (const changed of [
      source.replace("persist-credentials: false", "persist-credentials: true"),
      source.replace("          persist-credentials: false\n", ""),
      source.replace("fetch-depth: 0", "fetch-depth: 1"),
    ]) {
      expect(() => validateCiWorkflowSupplyChain(changed)).toThrow(
        "CI checkout must retain full history without persisted credentials",
      );
    }
  });
});

describe("workflow line-ending attributes", () => {
  it("pins every workflow YAML file to LF", async () => {
    expect(validateWorkflowAttributes(await readFile(attributesPath, "utf8"))).toEqual({
      rule: "* text=auto eol=lf\n.gitattributes text eol=lf",
    });
  });

  it.each([
    [""],
    [".gitattributes text eol=lf\n"],
    ["* text=auto eol=lf\n"],
    ["*.yml text eol=lf\n.gitattributes text eol=lf\n"],
    ["* text=auto eol=crlf\n.gitattributes text eol=lf\n"],
    ["* text=auto eol=lf\n" + ".gitattributes text eol=lf\n" + "*.ts text eol=crlf\n"],
  ])("rejects missing, narrowed, or overridden workflow attributes", (source) => {
    expect(() => validateWorkflowAttributes(source)).toThrow(
      "Git attributes must pin repository text and the attribute file to LF",
    );
  });
});
