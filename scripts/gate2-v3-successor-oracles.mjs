import { GATE2_REFACTOR_ORACLES } from "./gate2-refactor-cohort-contract.mjs";
import { GATE2_SCAFFOLD_A_ORACLES } from "./gate2-scaffold-cohort-a-contract.mjs";

// Deterministic oracles for the three manifest v3 successor cases. Each is derived from the
// v2 oracle it replaces -- the same approved bytes, re-keyed to the successor id -- and two
// re-key their check as well: scaffold-parser-cli-check moves its check beside the fixture's
// existing checks (checks/test_cli.py, argv to match) instead of a tests/ directory the
// fixture never had, and scaffold-json-output-mode drops the "lantern" check id. The module
// each check invokes is unchanged, so the bytes are too.

function fail(message) {
  throw new Error(`Gate 2 v3 successor oracles: ${message}`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function predecessor(oracles, caseId) {
  const entry = oracles.find((candidate) => candidate.caseId === caseId);
  if (entry === undefined) fail(`predecessor oracle ${caseId} is missing`);
  return entry;
}

function successorOf(
  base,
  caseId,
  { check = base.check, approvedFiles = base.approvedFiles } = {},
) {
  return {
    ...structuredClone(base),
    caseId,
    scenarioEvaluatorId: `${caseId}-evaluator`,
    check: structuredClone(check),
    approvedFiles: structuredClone(approvedFiles),
  };
}

const cartMoney = predecessor(GATE2_REFACTOR_ORACLES, "refactor-cart-money-module");
const parserCli = predecessor(GATE2_SCAFFOLD_A_ORACLES, "scaffold-parser-cli");
const lanternJson = predecessor(GATE2_SCAFFOLD_A_ORACLES, "scaffold-lantern-json-output");

const parserCliCheckFiles = parserCli.approvedFiles.map((file) =>
  file.path === "tests/test_cli.py" ? { ...file, path: "checks/test_cli.py" } : file,
);
if (parserCliCheckFiles.filter((file) => file.path === "checks/test_cli.py").length !== 1) {
  fail("scaffold-parser-cli-check must relocate exactly one check file");
}

export const GATE2_V3_SUCCESSOR_ORACLES = deepFreeze([
  successorOf(cartMoney, "refactor-cart-money-extraction"),
  // The predecessor's check id said "lantern", the very title word that left its check name
  // underdetermined; the successor's id names the mode instead. Rule 1 forbids deriving a
  // filename from a check id either way, but a signal pointing at the rejected name goes.
  successorOf(lanternJson, "scaffold-json-output-mode", {
    check: { ...lanternJson.check, id: "json-output-mode", name: "Text and JSON output modes" },
  }),
  successorOf(parserCli, "scaffold-parser-cli-check", {
    check: { ...parserCli.check, argv: ["python", "-m", "checks.test_cli"] },
    approvedFiles: parserCliCheckFiles,
  }),
]);
