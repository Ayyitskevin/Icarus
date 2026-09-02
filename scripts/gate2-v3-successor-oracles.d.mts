import type { Gate2RefactorOracle } from "./gate2-refactor-cohort-contract.d.mts";

// The successor oracles share the refactor cohort's oracle shape; the name says what the
// registry holds (one refactor, two scaffolds), not where the shape was first declared.
export type Gate2SuccessorOracle = Gate2RefactorOracle;

export const GATE2_V3_SUCCESSOR_ORACLES: readonly Gate2SuccessorOracle[];
