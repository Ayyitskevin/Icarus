export const GATE2_LIVE_INSTRUCTION_POLICY_REVISION: 10;
export const GATE2_LIVE_INSTRUCTION_POLICY: Readonly<{
  generation: Readonly<{ temperature: number; maxTokens: number; think: boolean }>;
}> &
  Readonly<Record<string, unknown>>;
export const GATE2_LIVE_INSTRUCTION_POLICY_SHA256: string;
/** The benchmark classes the policy is written for; bound to the manifest's classes by test. */
export const GATE2_LIVE_BENCHMARK_CLASSES: readonly string[];
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
