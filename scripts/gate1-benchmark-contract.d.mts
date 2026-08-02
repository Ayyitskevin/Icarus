export type Gate1BenchmarkManifest = Record<string, unknown>;

export const GATE1_REQUIRED_STACKS: readonly string[];
export const GATE1_DERIVATIVE_GITHUB_EVENTS: readonly string[];
export const GATE1_DERIVATIVE_EFFECTS: readonly string[];
export const GATE1_DERIVATIVE_ALLOWED_DISPOSITIONS: readonly string[];
export const GATE1_RELEASE_SUCCESS_CONDITIONS: readonly string[];
export const GATE1_RELEASE_FAILURE_CONDITIONS: readonly string[];
export const GATE1_CASE_CI_SUCCESS_CONDITIONS: readonly string[];
export const GATE1_CASE_RELEASE_SUCCESS_CONDITIONS: readonly string[];
export const GATE1_CASE_FAILURE_CONDITIONS: readonly string[];
export const GATE1_RECEIPT_REQUIRED_FIELDS: readonly string[];
export const GATE1_RECEIPT_FORBIDDEN_FIELDS: readonly string[];
export const GATE1_DRAFT_PULL_REQUEST_IDENTITY_FIELDS: readonly string[];

export function validateGate1BenchmarkManifest(value: unknown): Gate1BenchmarkManifest;
