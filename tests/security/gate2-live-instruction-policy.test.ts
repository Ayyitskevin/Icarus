import { describe, expect, it } from "vitest";
import {
  buildGate2LiveCandidateInput,
  buildGate2LiveInstructions,
  GATE2_LIVE_INSTRUCTION_POLICY,
  GATE2_LIVE_INSTRUCTION_POLICY_SHA256,
} from "../../scripts/gate2-live-instruction-policy.mjs";

describe("Gate 2 live instruction policy", () => {
  it("binds one target-independent policy for every case in a class", () => {
    expect(GATE2_LIVE_INSTRUCTION_POLICY_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(GATE2_LIVE_INSTRUCTION_POLICY.generation).toEqual({
      temperature: 0,
      maxTokens: 8192,
      // ADR 0070: digest-bound, so a rerun cannot silently restore the combined
      // reasoning-plus-content budget the recorded thresholds were never measured under.
      think: false,
    });
    expect(buildGate2LiveInstructions("scaffold", "mutation")).toBe(
      buildGate2LiveInstructions("scaffold", "mutation"),
    );
    expect(buildGate2LiveInstructions("security_review", "read_only")).not.toContain(
      "src/files.py",
    );
    expect(buildGate2LiveInstructions("scaffold", "mutation")).not.toContain(
      "tests/test_json_output.py",
    );
    const combined = [
      buildGate2LiveInstructions("scaffold", "mutation"),
      buildGate2LiveInstructions("refactor", "mutation"),
      buildGate2LiveInstructions("repair", "mutation"),
      buildGate2LiveInstructions("security_review", "read_only"),
    ].join("\n");
    for (const benchmarkShapedFragment of [
      "../outside",
      "src/",
      "tests/",
      "checks/",
      ".py",
      ".sql",
      "expected-answer",
      "configuration trust",
      "dynamic execution",
      "schema-versus-live-state",
      "concrete source-code vulnerability",
      "evaluator/check files",
    ]) {
      expect(combined).not.toContain(benchmarkShapedFragment);
    }
    expect(buildGate2LiveInstructions("scaffold", "mutation")).toContain(
      "Do not repair unrelated defects",
    );
    expect(buildGate2LiveInstructions("security_review", "read_only")).toContain(
      "Follow only the implemented data or control flow relevant to the task",
    );
    expect(buildGate2LiveInstructions("scaffold", "mutation")).not.toContain('"steps"');
    // Revision 10: the two classes that scored 0/5 in both revision-9 arms had no class
    // guidance at all; six of their ten misses were target selection, not capability.
    expect(buildGate2LiveInstructions("refactor", "mutation")).toContain(
      "creates that module as a new file",
    );
    expect(buildGate2LiveInstructions("repair", "mutation")).toContain(
      "the deliverable is the check that proves it",
    );
    expect(buildGate2LiveInstructions("explanation", "read_only")).not.toContain(
      "creates that module as a new file",
    );
    // Output boundary, on every class: 27 of 30 baseline failures were a code fence.
    for (const [cls, kind] of [
      ["repair", "mutation"],
      ["security_review", "read_only"],
    ] as const) {
      expect(buildGate2LiveInstructions(cls, kind)).toContain("its first character is {");
    }
  });

  it("gives the model the complete repository inventory without expected outcomes", () => {
    const input = JSON.parse(
      buildGate2LiveCandidateInput({
        task: "Add a command.",
        repositoryPaths: ["README.md", "src/greeting.txt"],
        registeredCheckIds: ["greeting-command"],
        sources: [{ path: "README.md", sha256: "a".repeat(64), content: "Fixture" }],
      }),
    );
    expect(input).toEqual({
      task: "Add a command.",
      repositoryPaths: ["README.md", "src/greeting.txt"],
      registeredCheckIds: ["greeting-command"],
      sources: [{ path: "README.md", sha256: "a".repeat(64), content: "Fixture" }],
    });
    expect(JSON.stringify(input)).not.toContain("expectedChangedPaths");
    expect(JSON.stringify(input)).not.toContain("expectedCitationPaths");
    expect(JSON.stringify(input)).not.toContain("expectedFindingIds");
  });
});
