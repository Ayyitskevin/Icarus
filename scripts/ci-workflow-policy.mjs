import { createHash } from "node:crypto";

const EXPECTED_ACTIONS = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
  "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
];
const EXPECTED_WORKFLOW_SHA256 = "baedc1de20c4b9f4e1c4e70d3ee93c4c8f6865ea42a03568192fd36b1060ec91";
const EXPECTED_WORKFLOW_ATTRIBUTES = "* text=auto eol=lf\n.gitattributes text eol=lf\n";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateCiWorkflowSupplyChain(source) {
  invariant(typeof source === "string", "CI workflow source must be text");
  invariant(!source.includes("\r"), "CI workflow must use repository-pinned LF line endings");
  const actions = [...source.matchAll(/^\s*(?:-\s*)?uses:\s+([^\s#]+)/gm)].map((match) => match[1]);
  invariant(
    JSON.stringify(actions) === JSON.stringify(EXPECTED_ACTIONS),
    "CI actions must match the reviewed immutable commit pins",
  );
  invariant(
    source.includes(
      "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n" +
        "        with:\n" +
        "          fetch-depth: 0\n" +
        "          persist-credentials: false",
    ),
    "CI checkout must retain full history without persisted credentials",
  );
  const sha256 = createHash("sha256").update(source, "utf8").digest("hex");
  invariant(
    sha256 === EXPECTED_WORKFLOW_SHA256,
    "CI workflow digest must match the reviewed definition",
  );
  return { actions, sha256 };
}

export function validateWorkflowAttributes(source) {
  invariant(
    source === EXPECTED_WORKFLOW_ATTRIBUTES,
    "Git attributes must pin repository text and the attribute file to LF",
  );
  return { rule: EXPECTED_WORKFLOW_ATTRIBUTES.trimEnd() };
}
