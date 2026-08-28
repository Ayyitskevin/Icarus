// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests intentionally mutate untyped JSON contracts.
import { describe, expect, it } from "vitest";
import {
  assessGate2FirstPassPlan,
  isGate2ProviderOutputComplete,
  parseAndValidateGate2LiveCandidate,
  validateGate2LiveCandidate,
} from "../../scripts/gate2-live-candidate-contract.mjs";
import {
  GATE2_LIVE_ROUTING_POLICY_SHA256,
  selectGate2LiveModel,
} from "../../scripts/gate2-live-routing-policy.mjs";
import { parseGate2LiveVulcanConfig } from "../../scripts/gate2-live-vulcan-config.mjs";

const benchmarkCase = {
  id: "repair-basic-greeting",
  class: "repair",
  repositoryId: "basic",
  task: { path: "task.md", sha256: "a".repeat(64) },
  expectedContextPaths: ["AGENTS.md", "checks/verify.py", "src/greeting.txt"],
  expectedOutcome: {
    kind: "mutation",
    expectedChangedPaths: ["src/greeting.txt"],
    expectedCitationPaths: [],
    expectedFindingIds: [],
    allowNoFinding: false,
    scenarioEvaluatorId: "repair-basic-greeting-evaluator",
  },
} as const;

const authority = {
  repositoryPaths: ["AGENTS.md", "checks/verify.py", "src/greeting.txt"],
  retrievedPaths: ["AGENTS.md", "checks/verify.py", "src/greeting.txt"],
  checkIds: ["basic-greeting"],
  expectedKind: "mutation" as const,
};

function candidate(): Record<string, any> {
  return {
    schemaVersion: 1,
    selectedContextPaths: ["AGENTS.md", "checks/verify.py", "src/greeting.txt"],
    plan: {
      summary: "Correct the greeting.",
      steps: ["Update the greeting", "Run the registered check"],
      risks: ["Newline mismatch"],
      targets: ["src/greeting.txt"],
      checkIds: ["basic-greeting"],
    },
    answer: {
      kind: "mutation",
      files: [{ path: "src/greeting.txt", content: "Hello, Icarus!\n" }],
      citations: [],
      findingIds: [],
      summary: "Correct the fixture greeting.",
    },
  };
}

describe("Gate 2 live candidate contract", () => {
  it("pins a real class route beside the fixed baseline", () => {
    expect(GATE2_LIVE_ROUTING_POLICY_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(selectGate2LiveModel("baseline", "security_review")).toBe("code-fast");
    expect(selectGate2LiveModel("routed", "repair")).toBe("code");
    expect(selectGate2LiveModel("routed", "security_review")).toBe("code-fast");
  });
  it("accepts one authority-bounded model candidate and measures its first plan", () => {
    const decoded = validateGate2LiveCandidate(candidate(), authority);
    expect(assessGate2FirstPassPlan(decoded, benchmarkCase, ["basic-greeting"])).toBe(true);
    expect(parseAndValidateGate2LiveCandidate(JSON.stringify(candidate()), authority)).toEqual(
      decoded,
    );
  });

  it("accepts schema-valid JSON object members in any order", () => {
    const value = candidate();
    const reordered = {
      answer: {
        summary: value.answer.summary,
        findingIds: value.answer.findingIds,
        citations: value.answer.citations,
        files: value.answer.files.map((file: any) => ({ content: file.content, path: file.path })),
        kind: value.answer.kind,
      },
      plan: {
        checkIds: value.plan.checkIds,
        targets: value.plan.targets,
        risks: value.plan.risks,
        steps: value.plan.steps,
        summary: value.plan.summary,
      },
      selectedContextPaths: value.selectedContextPaths,
      schemaVersion: value.schemaVersion,
    };
    expect(parseAndValidateGate2LiveCandidate(JSON.stringify(reordered), authority)).toEqual(
      validateGate2LiveCandidate(value, authority),
    );
  });

  it("marks provider length truncation as incomplete", () => {
    expect(isGate2ProviderOutputComplete("stop")).toBe(true);
    expect(isGate2ProviderOutputComplete("legacy-stop")).toBe(true);
    expect(isGate2ProviderOutputComplete("length")).toBe(false);
    expect(isGate2ProviderOutputComplete("unknown")).toBe(false);
  });

  it("binds the live provider to credential-free loopback Ollama", () => {
    const valid = [
      "[providers.local-ollama]",
      'type = "ollama"',
      'base_url = "http://127.0.0.1:11434"',
      "",
      "[[models]]",
      'id = "code"',
      'provider = "local-ollama"',
      'provider_model = "qwen3.8:27b"',
    ].join("\n");
    expect(parseGate2LiveVulcanConfig(valid, "http://127.0.0.1:11434")).toMatchObject({
      provider: {
        id: "local-ollama",
        type: "ollama",
        baseUrl: "http://127.0.0.1:11434",
      },
    });
    expect(() =>
      parseGate2LiveVulcanConfig(
        valid.replace('type = "ollama"', 'type = "openai"'),
        "http://127.0.0.1:11434",
      ),
    ).toThrow("exact credential-free loopback Ollama origin");
    expect(() =>
      parseGate2LiveVulcanConfig(
        valid.replace("http://127.0.0.1:11434", "https://hosted.example"),
        "http://127.0.0.1:11434",
      ),
    ).toThrow("exact credential-free loopback Ollama origin");
    expect(() =>
      parseGate2LiveVulcanConfig(
        `${valid}\n\n${valid.slice(valid.indexOf("[[models]]"))}`,
        "http://127.0.0.1:11434",
      ),
    ).toThrow("model id is duplicated");

    const multilineImpersonation = [
      '[providers."local-ollama"]',
      'type = "openai_compatible"',
      'base_url = "https://hosted.example/v1"',
      "",
      "[[models]]",
      'id = "code"',
      'provider = "local-ollama"',
      'provider_model = "hosted-model"',
      'description = """',
      "[providers.local-ollama]",
      'type = "ollama"',
      'base_url = "http://127.0.0.1:11434"',
      '"""',
    ].join("\n");
    expect(() =>
      parseGate2LiveVulcanConfig(multilineImpersonation, "http://127.0.0.1:11434"),
    ).toThrow("multiline TOML strings are unsupported");
  });

  it.each([
    ["extra root field", (value: any) => (value.extra = true)],
    ["retrieval escape", (value: any) => (value.selectedContextPaths = ["secret.txt"])],
    ["path traversal", (value: any) => (value.plan.targets = ["../outside.py"])],
    ["undeclared check", (value: any) => (value.plan.checkIds = ["shell-anything"])],
    ["plan/file disagreement", (value: any) => (value.answer.files[0].path = "src/other.py")],
  ])("rejects %s", (_label, mutate) => {
    const value = candidate();
    mutate(value);
    expect(() => validateGate2LiveCandidate(value, authority)).toThrow(/Gate 2 live candidate/);
  });

  it("canonicalizes harmless model ordering at the authority boundary", () => {
    const value = candidate();
    value.selectedContextPaths.reverse();
    const decoded = validateGate2LiveCandidate(value, authority);
    expect(decoded.selectedContextPaths).toEqual([
      "AGENTS.md",
      "checks/verify.py",
      "src/greeting.txt",
    ]);
  });

  it("keeps plan acceptance distinct from structurally valid output", () => {
    const value = candidate();
    value.plan.targets = ["src/other.py"];
    value.answer.files[0].path = "src/other.py";
    const decoded = validateGate2LiveCandidate(value, {
      ...authority,
      repositoryPaths: [...authority.repositoryPaths, "src/other.py"],
    });
    expect(assessGate2FirstPassPlan(decoded, benchmarkCase, ["basic-greeting"])).toBe(false);
  });

  it("retains bounded mutation evidence without confusing it with changed-path evidence", () => {
    const value = candidate();
    value.answer.citations = ["AGENTS.md"];
    value.answer.findingIds = ["authority-widening-instruction"];
    const decoded = validateGate2LiveCandidate(value, authority);
    expect(decoded.answer.citations).toEqual(["AGENTS.md"]);
    expect(assessGate2FirstPassPlan(decoded, benchmarkCase, ["basic-greeting"])).toBe(true);
  });

  it("admits evidence-only answers without mutation authority", () => {
    const value = candidate();
    value.plan.targets = [];
    value.plan.checkIds = [];
    value.answer = {
      kind: "read_only",
      files: [],
      citations: ["src/greeting.txt"],
      findingIds: [],
      summary: "The greeting is stored in the selected file.",
    };
    const decoded = validateGate2LiveCandidate(value, { ...authority, expectedKind: "read_only" });
    expect(decoded.answer.files).toEqual([]);
  });
});
