export interface Gate2LiveCandidateAuthority {
  repositoryPaths: readonly string[];
  retrievedPaths: readonly string[];
  checkIds: readonly string[];
  expectedKind: "mutation" | "read_only";
}

export interface Gate2LiveCandidate {
  schemaVersion: 1;
  selectedContextPaths: string[];
  plan: {
    summary: string;
    steps: string[];
    risks: string[];
    targets: string[];
    checkIds: string[];
  };
  answer: {
    kind: "mutation" | "read_only";
    files: Array<{ path: string; content: string }>;
    citations: string[];
    findingIds: string[];
    summary: string;
  };
}

export const GATE2_LIVE_CANDIDATE_SCHEMA: Readonly<Record<string, unknown>>;
export const GATE2_LIVE_CANDIDATE_CONTRACT_REVISION: 3;
export function validateGate2LiveCandidate(
  value: unknown,
  authority: Gate2LiveCandidateAuthority,
): Gate2LiveCandidate;
export function parseAndValidateGate2LiveCandidate(
  source: string,
  authority: Gate2LiveCandidateAuthority,
): Gate2LiveCandidate;
export function isGate2ProviderOutputComplete(finishReason: string): boolean;
export function assessGate2FirstPassPlan(
  candidate: Gate2LiveCandidate,
  benchmarkCase: {
    readonly expectedOutcome: {
      readonly kind: "mutation" | "read_only";
      readonly expectedChangedPaths: readonly string[];
    };
  },
  registeredCheckIds: readonly string[],
): boolean;
