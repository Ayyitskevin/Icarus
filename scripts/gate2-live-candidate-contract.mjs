import { parseStrictGate2Json } from "./gate2-benchmark-contract.mjs";

const ROOT_KEYS = Object.freeze(["schemaVersion", "selectedContextPaths", "plan", "answer"]);
const PLAN_KEYS = Object.freeze(["summary", "steps", "risks", "targets", "checkIds"]);
const ANSWER_KEYS = Object.freeze(["kind", "files", "citations", "findingIds", "summary"]);
const FILE_KEYS = Object.freeze(["path", "content"]);
const MAX_CONTEXT_PATHS = 8;
const MAX_FILES = 8;
const MAX_STEPS = 12;
const MAX_TEXT_BYTES = 32 * 1024;

export const GATE2_LIVE_CANDIDATE_CONTRACT_REVISION = 3;

export const GATE2_LIVE_CANDIDATE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ROOT_KEYS,
  properties: {
    schemaVersion: { const: 1 },
    selectedContextPaths: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CONTEXT_PATHS,
      uniqueItems: true,
      items: { type: "string" },
    },
    plan: {
      type: "object",
      additionalProperties: false,
      required: PLAN_KEYS,
      properties: {
        summary: { type: "string" },
        steps: { type: "array", minItems: 1, maxItems: MAX_STEPS, items: { type: "string" } },
        risks: { type: "array", maxItems: MAX_STEPS, items: { type: "string" } },
        targets: {
          type: "array",
          maxItems: MAX_FILES,
          uniqueItems: true,
          items: { type: "string" },
        },
        checkIds: {
          type: "array",
          maxItems: MAX_FILES,
          uniqueItems: true,
          items: { type: "string" },
        },
      },
    },
    answer: {
      type: "object",
      additionalProperties: false,
      required: ANSWER_KEYS,
      properties: {
        kind: { enum: ["mutation", "read_only"] },
        files: {
          type: "array",
          maxItems: MAX_FILES,
          items: {
            type: "object",
            additionalProperties: false,
            required: FILE_KEYS,
            properties: { path: { type: "string" }, content: { type: "string" } },
          },
        },
        citations: {
          type: "array",
          maxItems: MAX_CONTEXT_PATHS,
          uniqueItems: true,
          items: { type: "string" },
        },
        findingIds: {
          type: "array",
          maxItems: MAX_FILES,
          uniqueItems: true,
          items: { type: "string" },
        },
        summary: { type: "string" },
      },
    },
  },
});

function fail(message) {
  throw new Error(`Gate 2 live candidate: ${message}`);
}

function plainRecord(value, label, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const expectedKeys = [...keys].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail(`${label} must contain exactly: ${keys.join(", ")}`);
  }
  return value;
}

function boundedText(value, label, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value !== value.normalize("NFC") ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES
  ) {
    fail(`${label} must be bounded NFC text`);
  }
  return value;
}

function safePath(value, label) {
  boundedText(value, label);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be a safe repository-relative path`);
  }
  return value;
}

function safeToken(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    fail(`${label} must be a bounded safe token`);
  }
  return value;
}

function sortedUniqueArray(value, label, maximum, decoder, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} must contain ${minimum}..${maximum} entries`);
  }
  const decoded = value.map((entry, index) => decoder(entry, `${label}[${index}]`));
  const sorted = [...decoded].sort((left, right) => left.localeCompare(right));
  if (new Set(decoded).size !== decoded.length) fail(`${label} must contain unique entries`);
  return sorted;
}

function boundedTextArray(value, label, maximum, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} must contain ${minimum}..${maximum} entries`);
  }
  return value.map((entry, index) => boundedText(entry, `${label}[${index}]`));
}

function exactArray(actual, expected, label) {
  return JSON.stringify(actual) === JSON.stringify(expected) || fail(`${label} does not match`);
}

/**
 * Decode one model-authored solution envelope against host-owned case,
 * retrieval, and check authority. This function validates shape and authority;
 * it deliberately does not decide whether the proposed solution is correct.
 */
export function validateGate2LiveCandidate(value, authority) {
  const root = plainRecord(value, "root", ROOT_KEYS);
  if (root.schemaVersion !== 1) fail("schemaVersion must equal 1");
  const repositoryPaths = new Set(authority.repositoryPaths);
  const retrievedPaths = new Set(authority.retrievedPaths);
  const selectedContextPaths = sortedUniqueArray(
    root.selectedContextPaths,
    "selectedContextPaths",
    MAX_CONTEXT_PATHS,
    safePath,
    1,
  );
  for (const selectedPath of selectedContextPaths) {
    if (!repositoryPaths.has(selectedPath) || !retrievedPaths.has(selectedPath)) {
      fail("selectedContextPaths must stay inside the host retrieval receipt");
    }
  }

  const planValue = plainRecord(root.plan, "plan", PLAN_KEYS);
  const plan = {
    summary: boundedText(planValue.summary, "plan.summary"),
    steps: boundedTextArray(planValue.steps, "plan.steps", MAX_STEPS, 1),
    risks: boundedTextArray(planValue.risks, "plan.risks", MAX_STEPS),
    targets: sortedUniqueArray(planValue.targets, "plan.targets", MAX_FILES, safePath),
    checkIds: sortedUniqueArray(planValue.checkIds, "plan.checkIds", MAX_FILES, safeToken),
  };
  for (const checkId of plan.checkIds) {
    if (!authority.checkIds.includes(checkId)) fail("plan.checkIds exceeds registered checks");
  }

  const answerValue = plainRecord(root.answer, "answer", ANSWER_KEYS);
  if (answerValue.kind !== "mutation" && answerValue.kind !== "read_only") {
    fail("answer.kind is invalid");
  }
  const files = Array.isArray(answerValue.files)
    ? answerValue.files.map((entry, index) => {
        const file = plainRecord(entry, `answer.files[${index}]`, FILE_KEYS);
        return {
          path: safePath(file.path, `answer.files[${index}].path`),
          content: boundedText(file.content, `answer.files[${index}].content`, true),
        };
      })
    : fail("answer.files must be an array");
  if (files.length > MAX_FILES) fail(`answer.files must contain 0..${MAX_FILES} entries`);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const filePaths = files.map((file) => file.path);
  if (new Set(filePaths).size !== filePaths.length) fail("answer.files paths must be unique");
  const answer = {
    kind: answerValue.kind,
    files,
    citations: sortedUniqueArray(
      answerValue.citations,
      "answer.citations",
      MAX_CONTEXT_PATHS,
      safePath,
    ),
    findingIds: sortedUniqueArray(
      answerValue.findingIds,
      "answer.findingIds",
      MAX_FILES,
      safeToken,
    ),
    summary: boundedText(answerValue.summary, "answer.summary"),
  };

  if (answer.kind !== authority.expectedKind) fail("answer.kind does not match the benchmark case");
  if (answer.kind === "mutation") {
    if (files.length < 1) fail("mutation answer must propose at least one file");
    exactArray(filePaths, plan.targets, "mutation file paths and plan targets");
  } else if (files.length !== 0 || plan.targets.length !== 0 || plan.checkIds.length !== 0) {
    fail("read-only answer must not request mutation or check authority");
  }
  for (const citation of answer.citations) {
    if (!selectedContextPaths.includes(citation)) {
      fail("answer.citations must name selected retrieved context");
    }
  }
  return { schemaVersion: 1, selectedContextPaths, plan, answer };
}

export function parseAndValidateGate2LiveCandidate(source, authority) {
  return validateGate2LiveCandidate(parseStrictGate2Json(source), authority);
}

export function isGate2ProviderOutputComplete(finishReason) {
  return finishReason === "stop" || finishReason === "legacy-stop";
}

/** Objective benchmark policy for whether an operator could accept the first
 * submitted plan without correction. Scenario success remains a separate act. */
export function assessGate2FirstPassPlan(candidate, benchmarkCase, registeredCheckIds) {
  const expectedTargets = benchmarkCase.expectedOutcome.expectedChangedPaths;
  if (benchmarkCase.expectedOutcome.kind === "mutation") {
    return (
      JSON.stringify(candidate.plan.targets) === JSON.stringify(expectedTargets) &&
      JSON.stringify(candidate.plan.checkIds) === JSON.stringify(registeredCheckIds)
    );
  }
  return candidate.plan.targets.length === 0 && candidate.plan.checkIds.length === 0;
}
