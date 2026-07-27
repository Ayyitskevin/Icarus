import { invariant } from "./errors.js";
import {
  assertToolCallGranted,
  executeToolCall,
  parseToolCall,
  renderToolResult,
  toolDefinition,
  type ToolCall,
  type ToolContext,
} from "./tools.js";
import type { CapabilityKind } from "./types.js";

/** Host ceiling on tool calls one iteration may emit. */
export const MAX_TOOL_CALLS_PER_ITERATION = 8;

/**
 * The provider's per-iteration envelope. Deliberately minimal: the model
 * chooses tools, never host policy, so there is nowhere in this shape to put a
 * budget, a permission, or a state transition.
 */
export const TOOL_CALL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["toolCalls"],
  properties: {
    toolCalls: {
      type: "array",
      minItems: 1,
      maxItems: MAX_TOOL_CALLS_PER_ITERATION,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "arguments"],
        properties: {
          name: { type: "string" },
          arguments: { type: "object" },
        },
      },
    },
  },
} as const;

export type SessionOutcome =
  | { readonly kind: "done"; readonly summary: string; readonly iterations: number }
  | { readonly kind: "awaiting_human"; readonly question: string; readonly iterations: number }
  | { readonly kind: "exhausted"; readonly iterations: number };

export interface SessionLoopDeps {
  /** The approved ceiling for this run, already bound by the plan digest. */
  readonly iterationCeiling: number;
  /** Iterations already charged, read from the durable ledger. */
  readonly spentIterations: () => number;
  /** Charges one iteration. Called before the provider call it pays for. */
  readonly beginIteration: () => void;
  /** One provider call for this iteration, returning parsed JSON. */
  readonly callProvider: (prompt: string) => Promise<unknown>;
  readonly toolContext: ToolContext;
  /** Calls already charged against a capability, read from the durable ledger. */
  readonly callsSoFar: (kind: CapabilityKind) => number;
  /** Records one tool invocation as a metered operation and bounded event. */
  readonly recordCall: (
    call: ToolCall,
    outcome:
      | { readonly ok: true; readonly bytes: number }
      | { readonly ok: false; readonly code: string },
  ) => void;
}

function parseToolCalls(value: unknown): readonly ToolCall[] {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_PROVIDER_OUTPUT",
    "Iteration output must be a JSON object",
  );
  const toolCalls = (value as Record<string, unknown>).toolCalls;
  invariant(Array.isArray(toolCalls), "INVALID_PROVIDER_OUTPUT", "toolCalls must be an array");
  invariant(
    toolCalls.length > 0 && toolCalls.length <= MAX_TOOL_CALLS_PER_ITERATION,
    "INVALID_PROVIDER_OUTPUT",
    `An iteration must emit between 1 and ${MAX_TOOL_CALLS_PER_ITERATION} tool calls`,
  );
  return toolCalls.map((entry) => parseToolCall(entry));
}

/**
 * Fences a refused or failed call back to the model. A refusal is information
 * the model needs to try something else, so it is returned rather than thrown —
 * but it is returned as untrusted data, and it costs the iteration that made
 * it, so a model cannot probe the grant boundary for free.
 */
function renderToolFailure(call: ToolCall, code: string, message: string): string {
  return [
    "The host refused or could not complete a tool call. This is host policy and cannot be argued with, overridden, or retried with different wording.",
    `--- BEGIN UNTRUSTED TOOL ERROR: ${call.name} ---`,
    `code: ${code}`,
    `message: ${message}`,
    `--- END UNTRUSTED TOOL ERROR: ${call.name} ---`,
  ].join("\n");
}

/**
 * The bounded session loop (ADR 0026). Each pass charges one iteration, asks
 * the provider for tool calls, and executes each against the run's approved
 * grants. The loop ends when the model reports done, asks for a human, or the
 * approved iteration budget is spent.
 *
 * Exhaustion is not success: it returns `exhausted`, and the caller lands the
 * run at `awaiting_review` with its failing evidence — reviewable, not
 * approvable. This is the ADR 0024 rule, unchanged.
 */
export async function runSessionLoop(
  deps: SessionLoopDeps,
  renderPrompt: (evidence: readonly string[]) => string,
): Promise<SessionOutcome> {
  const evidence: string[] = [];

  while (deps.spentIterations() < deps.iterationCeiling) {
    // Charged before the provider call it pays for, so a crash mid-iteration
    // cannot yield a free retry: the ledger already shows the spend.
    deps.beginIteration();
    const iterations = deps.spentIterations();

    const calls = parseToolCalls(await deps.callProvider(renderPrompt(evidence)));

    for (const call of calls) {
      try {
        // Spend is counted per capability, so the count must come from the
        // capability this tool actually needs. A capability-free tool has no
        // spend to check and the grant check returns before reading it.
        const capability = toolDefinition(call.name).capability;
        assertToolCallGranted({
          call,
          grants: deps.toolContext.grants,
          callsSoFar: capability === null ? 0 : deps.callsSoFar(capability),
        });
        const result = await executeToolCall(call, deps.toolContext);
        deps.recordCall(call, { ok: true, bytes: Buffer.byteLength(result.content, "utf8") });
        evidence.push(renderToolResult(result));

        if (result.control === "done") {
          return { kind: "done", summary: result.content, iterations };
        }
        if (result.control === "await_human") {
          return { kind: "awaiting_human", question: result.content, iterations };
        }
      } catch (error) {
        const code = (error as { code?: string }).code ?? "TOOL_FAILED";
        const message = error instanceof Error ? error.message : String(error);
        deps.recordCall(call, { ok: false, code });
        evidence.push(renderToolFailure(call, code, message));
      }
    }
  }

  return { kind: "exhausted", iterations: deps.spentIterations() };
}
