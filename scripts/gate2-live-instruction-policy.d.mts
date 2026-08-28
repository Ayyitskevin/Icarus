export const GATE2_LIVE_INSTRUCTION_POLICY_REVISION: 7;
export const GATE2_LIVE_INSTRUCTION_POLICY: Readonly<Record<string, unknown>>;
export const GATE2_LIVE_INSTRUCTION_POLICY_SHA256: string;
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
