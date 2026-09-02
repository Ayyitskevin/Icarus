export interface Gate2FrozenArmFigures {
  readonly mode: "baseline" | "routed";
  readonly modelIds: readonly string[];
  readonly taskCount: number;
  readonly successes: number;
  /** null only when the arm holds no records; never 0 standing in for absence. */
  readonly firstPlanAcceptance: number | null;
  readonly classes: Readonly<Record<string, { successes: number; count: number }>>;
  readonly buckets: Readonly<{
    passed: number;
    planRejectedBeforeAnyCheck: number;
    unparseable: number;
    executedAndFailed: number;
  }>;
  readonly failureCount: number;
  readonly markdownFencedFailures: number;
  readonly failureShapes: Readonly<Record<string, number>>;
  readonly unparseableShapes: Readonly<{
    /** Keyed "null" where the record's own error names no shape. */
    recordedInError: Readonly<Record<string, number>>;
    derivedFromRawCandidate: Readonly<Record<string, number>>;
  }>;
  readonly recordedRetrieval: Readonly<{
    macroRecall: number | null;
    macroPrecision: number | null;
    digestProvenanceCoverage: number | null;
  }>;
  readonly recordedIncorrectEdits: number | null;
  readonly recordedThresholdsPassed: boolean | null;
  readonly recordedAssessment: string | null;
}

export interface Gate2FrozenEvidenceFigures {
  readonly set: string;
  readonly verified: true;
  readonly frozenManifest: Readonly<Record<string, unknown>>;
  readonly benchmarkManifest: Readonly<{ path: string; sha256: string }>;
  readonly thresholds: Readonly<Record<string, unknown>>;
  readonly arms: Readonly<{ baseline: Gate2FrozenArmFigures; routed: Gate2FrozenArmFigures }>;
  readonly comparison: Readonly<Record<string, unknown>>;
  readonly agreesWithCommittedResults: boolean;
  readonly disagreements: readonly string[];
}

/**
 * Recompute a frozen set's figures from its committed bytes. Rejects before reading any
 * figure when `verifyFrozenEvidence` reports a problem: a figure taken from a directory
 * whose manifest is not true of its bytes is what this exists to prevent.
 */
export function computeGate2FrozenEvidenceFigures(
  setDirectory: string,
  options?: { repositoryRoot?: string; manifestPath?: string },
): Promise<Gate2FrozenEvidenceFigures>;

export function renderMarkdown(figures: Gate2FrozenEvidenceFigures): string;
export const STRICT_JSON_SHAPES: readonly string[];
