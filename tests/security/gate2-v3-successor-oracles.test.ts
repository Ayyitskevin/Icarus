import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  GATE2_CURRENT_MANIFEST_PATH,
  parseStrictGate2Json,
  sha256Raw,
  validateGate2BenchmarkManifest,
} from "../../scripts/gate2-benchmark-contract.mjs";
import { GATE2_REFACTOR_ORACLES } from "../../scripts/gate2-refactor-cohort-contract.mjs";
import { GATE2_REPAIR_A_ORACLES } from "../../scripts/gate2-repair-cohort-a-contract.mjs";
import { GATE2_REPAIR_B_ORACLES } from "../../scripts/gate2-repair-cohort-b-contract.mjs";
import { GATE2_SCAFFOLD_A_ORACLES } from "../../scripts/gate2-scaffold-cohort-a-contract.mjs";
import { GATE2_SCHEMA_SUCCESSOR_ORACLES } from "../../scripts/gate2-schema-successor-cohort-contract.mjs";
import { GATE2_V3_SUCCESSOR_ORACLES } from "../../scripts/gate2-v3-successor-oracles.mjs";
import { GATE2_V4_SUCCESSOR_ORACLES } from "../../scripts/gate2-v4-successor-oracles.mjs";

const manifestUrl = new URL(`../../${GATE2_CURRENT_MANIFEST_PATH}`, import.meta.url);

// The live runner resolves a mutation case's registered check and approved targets by case
// id from these six lists. A v3 successor whose oracle disagreed with its manifest entry
// would run the wrong check or fence the wrong targets, and score a benchmark defect as a
// model miss -- the very thing v3 exists to stop.
describe("Gate 2 manifest v3 successor oracles", () => {
  it("covers every v3 mutation case exactly once, and no read-only case", async () => {
    const manifest = validateGate2BenchmarkManifest(
      parseStrictGate2Json(await readFile(manifestUrl, "utf8")),
    );
    const registry = new Map(
      [
        ...GATE2_REPAIR_A_ORACLES,
        ...GATE2_REPAIR_B_ORACLES,
        ...GATE2_REFACTOR_ORACLES,
        ...GATE2_SCAFFOLD_A_ORACLES,
        ...GATE2_SCHEMA_SUCCESSOR_ORACLES,
        ...GATE2_V3_SUCCESSOR_ORACLES,
        ...GATE2_V4_SUCCESSOR_ORACLES,
      ].map((entry) => [entry.caseId, entry] as const),
    );
    expect(registry.size).toBe(25);
    for (const benchmarkCase of manifest.cases) {
      const oracle = registry.get(benchmarkCase.id);
      expect((benchmarkCase.expectedOutcome.kind === "mutation") === (oracle !== undefined)).toBe(
        true,
      );
      if (oracle === undefined) continue;
      expect(oracle.scenarioEvaluatorId).toBe(benchmarkCase.expectedOutcome.scenarioEvaluatorId);
      expect([...oracle.approvedFiles.map((file) => file.path)].sort()).toEqual(
        benchmarkCase.expectedOutcome.expectedChangedPaths,
      );
    }
  });

  it("binds each successor's check to a module among its own approved files, byte-pinned", () => {
    expect(GATE2_V3_SUCCESSOR_ORACLES.map((entry) => entry.caseId)).toEqual([
      "refactor-cart-money-extraction",
      "scaffold-json-output-mode",
      "scaffold-parser-cli-check",
    ]);
    for (const oracle of GATE2_V3_SUCCESSOR_ORACLES) {
      expect(Object.isFrozen(oracle)).toBe(true);
      for (const file of oracle.approvedFiles) {
        expect(sha256Raw(file.content)).toBe(file.sha256);
      }
      const [python, dashM, module] = oracle.check.argv;
      expect([python, dashM]).toEqual(["python", "-m"]);
      expect(module).toBeDefined();
      const modulePath = `${String(module).replaceAll(".", "/")}.py`;
      const approved = new Set(oracle.approvedFiles.map((file) => file.path));
      // The check either is an approved file (scaffold) or exercises the fixture's own check
      // (refactor keeps the existing cart check as its acceptance test).
      expect(approved.has(modulePath) || modulePath === "checks/test_cart.py").toBe(true);
    }
    const parserCli = GATE2_V3_SUCCESSOR_ORACLES.find(
      (entry) => entry.caseId === "scaffold-parser-cli-check",
    );
    expect(parserCli?.check.argv).toEqual(["python", "-m", "checks.test_cli"]);
    // ADR 0073: the successor's check id must not carry the title word that left its check
    // name underdetermined. A review reverted the id to lantern-json-output with this suite green.
    const jsonOutput = GATE2_V3_SUCCESSOR_ORACLES.find(
      (entry) => entry.caseId === "scaffold-json-output-mode",
    );
    expect(jsonOutput?.check).toEqual({
      id: "json-output-mode",
      name: "Text and JSON output modes",
      argv: ["python", "-m", "tests.test_json_output"],
    });
    expect(JSON.stringify(GATE2_V3_SUCCESSOR_ORACLES)).not.toContain("lantern");
    expect(parserCli?.approvedFiles.some((file) => file.path === "tests/test_cli.py")).toBe(false);
  });

  it("leaves the v2 oracles it derives from untouched", () => {
    const v2 = GATE2_SCAFFOLD_A_ORACLES.find((entry) => entry.caseId === "scaffold-parser-cli");
    expect(v2?.check.argv).toEqual(["python", "-m", "tests.test_cli"]);
    expect(v2?.approvedFiles.map((file) => file.path)).toEqual(["src/cli.py", "tests/test_cli.py"]);
  });
});

describe("Gate 2 manifest v4 successor oracles", () => {
  it("re-keys the two mutation successors and relocates only the greeting check", () => {
    expect(GATE2_V4_SUCCESSOR_ORACLES.map((entry) => entry.caseId)).toEqual([
      "repair-lantern-config-contract",
      "scaffold-greeting-command-check",
    ]);
    for (const oracle of GATE2_V4_SUCCESSOR_ORACLES) {
      expect(Object.isFrozen(oracle)).toBe(true);
      for (const file of oracle.approvedFiles) expect(sha256Raw(file.content)).toBe(file.sha256);
    }
    const lantern = GATE2_V4_SUCCESSOR_ORACLES[0];
    const greeting = GATE2_V4_SUCCESSOR_ORACLES[1];
    expect(lantern?.check.id).toBe("lantern-missing-config");
    expect(lantern?.approvedFiles.map((file) => file.path)).toEqual(["src/main.py"]);
    expect(greeting?.check).toEqual({
      id: "greeting-command",
      name: "Greeting source-of-truth command",
      argv: ["python", "-m", "checks.test_greet"],
    });
    expect(greeting?.approvedFiles.map((file) => file.path)).toEqual([
      "src/greet.py",
      "checks/test_greet.py",
    ]);
    expect(JSON.stringify(GATE2_V4_SUCCESSOR_ORACLES)).not.toContain("tests/test_greet");
  });
});
