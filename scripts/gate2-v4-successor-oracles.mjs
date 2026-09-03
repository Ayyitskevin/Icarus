import { GATE2_REPAIR_A_ORACLES } from "./gate2-repair-cohort-a-contract.mjs";
import { GATE2_SCAFFOLD_A_ORACLES } from "./gate2-scaffold-cohort-a-contract.mjs";

// Deterministic oracles for the two mutation successors of manifest v4 (ADR 0076). Each is
// derived from the oracle it replaces -- the same approved bytes, re-keyed to the successor
// id. The lantern successor keeps its check unchanged: the task now states the contract the
// check always demanded. The greeting successor moves its check beside the fixture's existing
// check (checks/test_greet.py, so the invoked module becomes checks.test_greet); the check
// file's bytes are unchanged because it calls src.greet by module name, which does not move.
// The third v4 successor, explain-task-schema-contract, is read-only and has no oracle.

function fail(message) {
  throw new Error(`Gate 2 v4 successor oracles: ${message}`);
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

const lantern = predecessor(GATE2_REPAIR_A_ORACLES, "repair-lantern-missing-config");
const greeting = predecessor(GATE2_SCAFFOLD_A_ORACLES, "scaffold-greeting-command");

const greetingCheckFiles = greeting.approvedFiles.map((file) =>
  file.path === "tests/test_greet.py" ? { ...file, path: "checks/test_greet.py" } : file,
);
if (greetingCheckFiles.filter((file) => file.path === "checks/test_greet.py").length !== 1) {
  fail("scaffold-greeting-command-check must relocate exactly one check file");
}

export const GATE2_V4_SUCCESSOR_ORACLES = deepFreeze([
  successorOf(lantern, "repair-lantern-config-contract"),
  successorOf(greeting, "scaffold-greeting-command-check", {
    check: { ...greeting.check, argv: ["python", "-m", "checks.test_greet"] },
    approvedFiles: greetingCheckFiles,
  }),
]);
