import { describe, expect, it, vi } from "vitest";

import {
  CODEBASE_SECURITY_REVIEW_SCHEMA,
  reviewCodebaseSecurityV1,
} from "../../packages/core/src/index.js";
import { retrieveReadOnlyContextV1 } from "../../packages/core/src/context-retrieval.js";
import type { TreeEntry } from "../../packages/core/src/git.js";
import { createProviderConfig, type ModelGateway } from "../../packages/core/src/provider.js";

const TASK =
  "Review Lantern's configuration loading for source-backed security findings without changing the repository.";
const BASE = "a".repeat(40);

async function retrieval() {
  const blobs = new Map<string, Buffer>([
    ["config", Buffer.from('{\n  "audience": "traveler"\n}\n')],
    [
      "main",
      Buffer.from(
        'import json\nfrom pathlib import Path\n\nconfig = json.loads(Path("config/app.json").read_text())\nprint(config["audience"])\n',
      ),
    ],
  ]);
  const tree: TreeEntry[] = [
    { mode: "100644", type: "blob", objectId: "config", path: "config/app.json" },
    { mode: "100644", type: "blob", objectId: "main", path: "src/main.py" },
  ];
  return retrieveReadOnlyContextV1(
    {
      listTree: vi.fn(async () => tree),
      readBlob: vi.fn(async (_repository: string, objectId: string) => {
        const value = blobs.get(objectId);
        if (value === undefined) throw new Error(`unknown blob ${objectId}`);
        return value;
      }),
    },
    "/repository",
    BASE,
    TASK,
    { maxFiles: 2, maxTotalBytes: 4_096, maxScanBytes: 4_096 },
  );
}

function findingResponse() {
  return {
    assessment: "findings",
    summary: "The configuration shape is trusted before use.",
    findings: [
      {
        id: "unvalidated-config-shape",
        title: "Configuration shape is not validated",
        severity: "medium",
        description: "The entry point indexes a parsed JSON value without validating its shape.",
        exploitCondition: "A malformed or attacker-controlled config omits or changes audience.",
        recommendation: "Validate the object, audience key, and string type before use.",
        citations: [
          { path: "config/app.json", lineStart: 1, lineEnd: 3 },
          { path: "src/main.py", lineStart: 4, lineEnd: 5 },
        ],
      },
    ],
    noFinding: null,
  };
}

function gateway(response: unknown = findingResponse()): ModelGateway {
  return {
    config: createProviderConfig({
      kind: "ollama",
      model: "fixture-security-reviewer",
      baseUrl: "http://127.0.0.1:11434/",
    }),
    generateStructured: vi.fn(async () => ({
      text: JSON.stringify(response),
      usage: { inputTokens: 120, outputTokens: 80, estimatedCostUsd: 0, latencyMs: 12 },
    })),
  };
}

describe("Gate 2 read-only codebase security review", () => {
  it("returns digest-bound findings whose citations resolve to selected source lines", async () => {
    const context = await retrieval();
    const provider = gateway();

    const result = await reviewCodebaseSecurityV1(provider, context, TASK);

    expect(result).toMatchObject({
      schema: CODEBASE_SECURITY_REVIEW_SCHEMA,
      baseCommit: BASE,
      taskSha256: context.querySha256,
      retrievalDigestSha256: context.digestSha256,
      assessment: "findings",
      findings: [expect.objectContaining({ id: "unvalidated-config-shape", severity: "medium" })],
      noFinding: null,
      usage: { inputTokens: 120, outputTokens: 80, estimatedCostUsd: 0, latencyMs: 12 },
    });
    expect(result.digestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(provider.generateStructured).toHaveBeenCalledOnce();
    expect(provider.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaName: "codebase_security_review_v1",
        input: expect.stringContaining('"path":"src/main.py"'),
        maxOutputTokens: 1_536,
      }),
      undefined,
    );
  });

  it("accepts an explicit source-backed no-finding assessment", async () => {
    const context = await retrieval();
    const provider = gateway({
      assessment: "no_finding",
      summary: "No source-backed security finding is established by the selected files.",
      findings: [],
      noFinding: {
        rationale: "The selected fixture shows fixed local paths and no attacker-controlled input.",
        citations: [{ path: "src/main.py", lineStart: 4, lineEnd: 5 }],
      },
    });

    const result = await reviewCodebaseSecurityV1(provider, context, TASK);

    expect(result.assessment).toBe("no_finding");
    expect(result.findings).toEqual([]);
    expect(result.noFinding?.citations).toEqual([
      { path: "src/main.py", lineStart: 4, lineEnd: 5 },
    ]);
  });

  it("refuses changed retrieval content before the provider can observe it", async () => {
    const context = await retrieval();
    const provider = gateway();
    const changed = {
      ...context,
      entries: context.entries.map((entry, index) =>
        index === 0 ? { ...entry, content: "forged after retrieval\n" } : entry,
      ),
    };

    await expect(reviewCodebaseSecurityV1(provider, changed, TASK)).rejects.toMatchObject({
      code: "INVALID_CODEBASE_SECURITY_REVIEW",
    });
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it("refuses a task that differs from the retrieval query before provider access", async () => {
    const context = await retrieval();
    const provider = gateway();

    await expect(
      reviewCodebaseSecurityV1(provider, context, `${TASK} Also run the repository checks.`),
    ).rejects.toMatchObject({ code: "INVALID_CODEBASE_SECURITY_REVIEW" });
    expect(provider.generateStructured).not.toHaveBeenCalled();
  });

  it.each([
    [
      "findings without a finding",
      {
        assessment: "findings",
        summary: "A finding exists.",
        findings: [],
        noFinding: null,
      },
    ],
    [
      "findings with no-finding evidence",
      { ...findingResponse(), noFinding: { rationale: "Conflicting result.", citations: [] } },
    ],
    [
      "no-finding with a finding",
      {
        ...findingResponse(),
        assessment: "no_finding",
        noFinding: {
          rationale: "Conflicting result.",
          citations: [{ path: "src/main.py", lineStart: 4, lineEnd: 5 }],
        },
      },
    ],
  ])("refuses inconsistent assessment cardinality: %s", async (_label, response) => {
    const context = await retrieval();

    await expect(reviewCodebaseSecurityV1(gateway(response), context, TASK)).rejects.toMatchObject({
      code: "INVALID_CODEBASE_SECURITY_REVIEW",
    });
  });

  it("refuses duplicate finding identifiers", async () => {
    const context = await retrieval();
    const finding = findingResponse().findings[0];
    const provider = gateway({ ...findingResponse(), findings: [finding, finding] });

    await expect(reviewCodebaseSecurityV1(provider, context, TASK)).rejects.toMatchObject({
      code: "INVALID_CODEBASE_SECURITY_REVIEW",
    });
  });

  it.each([
    ["an unselected path", { path: "secrets.env", lineStart: 1, lineEnd: 1 }],
    ["an out-of-bounds range", { path: "src/main.py", lineStart: 4, lineEnd: 99 }],
    ["an empty line", { path: "src/main.py", lineStart: 3, lineEnd: 3 }],
  ])("refuses a citation to %s", async (_label, citation) => {
    const context = await retrieval();
    const response = findingResponse();
    const finding = response.findings[0];
    if (finding === undefined) throw new Error("finding fixture missing");
    finding.citations = [citation];

    await expect(reviewCodebaseSecurityV1(gateway(response), context, TASK)).rejects.toMatchObject({
      code: "INVALID_CODEBASE_SECURITY_REVIEW",
    });
  });

  it("refuses repeated citations within one finding", async () => {
    const context = await retrieval();
    const response = findingResponse();
    const finding = response.findings[0];
    const citation = finding?.citations[0];
    if (finding === undefined || citation === undefined)
      throw new Error("citation fixture missing");
    finding.citations = [citation, citation];

    await expect(reviewCodebaseSecurityV1(gateway(response), context, TASK)).rejects.toMatchObject({
      code: "INVALID_CODEBASE_SECURITY_REVIEW",
    });
  });

  it.each([
    ["an invalid identifier", { id: "Not Safe" }],
    ["an invalid severity", { severity: "urgent" }],
    ["an unexpected property", { modelConfidence: 0.99 }],
  ])("refuses %s", async (_label, mutation) => {
    const context = await retrieval();
    const response = findingResponse();
    const finding = response.findings[0];
    if (finding === undefined) throw new Error("finding fixture missing");
    response.findings[0] = { ...finding, ...mutation };

    await expect(reviewCodebaseSecurityV1(gateway(response), context, TASK)).rejects.toMatchObject({
      code: "INVALID_CODEBASE_SECURITY_REVIEW",
    });
  });

  it("refuses non-strict provider JSON", async () => {
    const context = await retrieval();
    const provider = gateway();
    vi.mocked(provider.generateStructured).mockResolvedValueOnce({
      text: '{"assessment":"findings","assessment":"no_finding"}',
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, latencyMs: 1 },
    });

    await expect(reviewCodebaseSecurityV1(provider, context, TASK)).rejects.toMatchObject({
      code: "INVALID_CODEBASE_SECURITY_REVIEW",
    });
  });

  it("refuses secret-shaped provider text", async () => {
    const context = await retrieval();
    const response = findingResponse();
    response.summary = `Leaked credential sk-${"a".repeat(24)}`;

    await expect(reviewCodebaseSecurityV1(gateway(response), context, TASK)).rejects.toMatchObject({
      code: "INVALID_CODEBASE_SECURITY_REVIEW",
    });
  });

  it("refuses provider output above the byte ceiling before parsing", async () => {
    const context = await retrieval();
    const provider = gateway();
    vi.mocked(provider.generateStructured).mockResolvedValueOnce({
      text: "x".repeat(128 * 1024 + 1),
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, latencyMs: 1 },
    });

    await expect(reviewCodebaseSecurityV1(provider, context, TASK)).rejects.toMatchObject({
      code: "INVALID_CODEBASE_SECURITY_REVIEW",
    });
  });

  it("refuses invalid provider usage", async () => {
    const context = await retrieval();
    const provider = gateway();
    vi.mocked(provider.generateStructured).mockResolvedValueOnce({
      text: JSON.stringify(findingResponse()),
      usage: { inputTokens: -1, outputTokens: 1, estimatedCostUsd: 0, latencyMs: 1 },
    });

    await expect(reviewCodebaseSecurityV1(provider, context, TASK)).rejects.toMatchObject({
      code: "INVALID_CODEBASE_SECURITY_REVIEW",
    });
  });
});
