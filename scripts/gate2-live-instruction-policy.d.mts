export const GATE2_LIVE_INSTRUCTION_POLICY_REVISION: 10;
export const GATE2_LIVE_INSTRUCTION_POLICY: Readonly<{
  generation: Readonly<{ temperature: number; maxTokens: number; think: boolean }>;
}> &
  Readonly<Record<string, unknown>>;
export const GATE2_LIVE_INSTRUCTION_POLICY_SHA256: string;
/** The two answer templates as data; the policy's template strings equal their serialisation byte for byte. */
export const GATE2_LIVE_TEMPLATES: Readonly<{
  mutation: Readonly<Record<string, unknown>>;
  readOnly: Readonly<Record<string, unknown>>;
}>;
/** Validates one canonical template object: key tree, answer kind, decoded-leaf ASCII, placeholder-only values. */
export function validateGate2LiveTemplate(template: unknown, kind: "mutation" | "readOnly"): void;
/** The exact key tree of an answer template at every level; a template must match it exactly. */
export const GATE2_LIVE_TEMPLATE_SKELETON: Readonly<Record<string, unknown>>;
/** Benchmark class → answer kind; bound to the manifest by test. The assembler refuses other pairs. */
export const GATE2_LIVE_BENCHMARK_CLASS_KINDS: Readonly<Record<string, "mutation" | "read_only">>;
/** The benchmark classes the policy is written for; bound to the manifest's classes by test. */
export const GATE2_LIVE_BENCHMARK_CLASSES: readonly string[];
/**
 * Turns a policy source into the plain data the digest, the leak scan, and the assembler read:
 * JSON round-trip (every property access happens in that one pass; non-JSON dropped), shape
 * asserted, deep-frozen. Later consumers read the snapshot, never the source.
 */
export function snapshotGate2LivePolicy(source: unknown): typeof GATE2_LIVE_INSTRUCTION_POLICY;
/** Pure assembly from a policy object; reads class rules as own properties only. */
export function assembleGate2LiveInstructions(
  policy: typeof GATE2_LIVE_INSTRUCTION_POLICY,
  benchmarkClass: string,
  expectedKind: "mutation" | "read_only",
): string;
export function buildGate2LiveInstructions(
  benchmarkClass: string,
  expectedKind: "mutation" | "read_only",
): string;
export function buildGate2LiveCandidateInput(input: {
  task: string;
  repositoryPaths: string[];
  registeredCheckIds: string[];
  sources: Array<{ path: string; sha256: string; content: string }>;
}): string;
