export function buildGate2ChatRequestBody(input: {
  modelId: string;
  instructions: string;
  input: string;
  generation: { temperature: number; maxTokens: number; think: boolean };
}): {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  max_tokens: number;
  think: boolean;
  stream: boolean;
  seat: string;
};
export interface Gate2GeneratedCandidate {
  /** Assistant content exactly as the gateway returned it; "" only when the model returned nothing. */
  readonly text: string;
  /**
   * Size of the reasoning the gateway returned alongside the content, in characters.
   *
   * `null` means no reasoning size was reported: either the provider surfaced no
   * `thinking` member (which Vulcan does whenever a request sends `think: false`), or it
   * surfaced a malformed one, or the record is a replayed prior one that predates
   * measurement. In every case it must not be read as zero — asserting a fact the run
   * never observed is the failure
   * this field exists to prevent.
   */
  readonly thinkingChars: number | null;
  readonly finishReason: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedCostUsd: number | null;
    readonly latencyMs: number;
  };
}

/**
 * Describe why a candidate failed to parse, distinguishing an absent answer from a
 * discarded one. Returns `reason` unchanged when the model actually produced content.
 */
export function describeGate2CandidateFailure(
  reason: string,
  generated: Gate2GeneratedCandidate,
): string;
