import { containsSecretShapedContent } from "./context.js";
import { IcarusError, invariant } from "./errors.js";
import { PATCH_SET_SCHEMA } from "./policy.js";
import { sanitizeText } from "./redaction.js";
import {
  assertToolCallGranted,
  executeToolCall,
  MAX_CHECKS_PER_CALL,
  MAX_TOOL_TEXT_BYTES,
  parseToolCall,
  renderToolResult,
  type ToolCall,
  type ToolContext,
  type ToolName,
  type ToolResult,
  toolDefinition,
} from "./tools.js";
import type { CapabilityKind, JsonValue } from "./types.js";

/** Host ceiling on tool calls one iteration may emit. */
export const MAX_TOOL_CALLS_PER_ITERATION = 8;

/**
 * The provider's per-iteration envelope. Deliberately minimal: the model
 * chooses tools, never host policy, so there is nowhere in this shape to put a
 * budget, a permission, or a state transition.
 */
function strictToolCallSchema(name: ToolName, argumentsSchema: JsonValue) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["name", "arguments"],
    properties: {
      name: { type: "string", enum: [name] },
      arguments: argumentsSchema,
    },
  };
}

const EMPTY_ARGUMENTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [],
  properties: {},
};

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
        anyOf: [
          strictToolCallSchema("read_file", {
            type: "object",
            additionalProperties: false,
            required: ["path"],
            properties: { path: { type: "string", minLength: 1, maxLength: 1_024 } },
          }),
          strictToolCallSchema("list_tree", {
            type: "object",
            additionalProperties: false,
            required: ["prefix"],
            properties: { prefix: { type: ["string", "null"], minLength: 1, maxLength: 1_024 } },
          }),
          strictToolCallSchema("search", {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: { query: { type: "string", minLength: 1, maxLength: 512 } },
          }),
          strictToolCallSchema("get_check_catalog", EMPTY_ARGUMENTS_SCHEMA),
          strictToolCallSchema("propose_patch", {
            type: "object",
            additionalProperties: false,
            required: ["patchSet"],
            properties: { patchSet: PATCH_SET_SCHEMA },
          }),
          strictToolCallSchema("apply_patchset", {
            type: "object",
            additionalProperties: false,
            required: ["patchSet"],
            properties: { patchSet: PATCH_SET_SCHEMA },
          }),
          strictToolCallSchema("run_checks", {
            type: "object",
            additionalProperties: false,
            required: ["checkIds"],
            properties: {
              checkIds: {
                type: "array",
                minItems: 1,
                maxItems: MAX_CHECKS_PER_CALL,
                uniqueItems: true,
                items: { type: "string", minLength: 1, maxLength: 128 },
              },
            },
          }),
          strictToolCallSchema("report_done", {
            type: "object",
            additionalProperties: false,
            required: ["summary"],
            properties: {
              summary: { type: "string", minLength: 1, maxLength: MAX_TOOL_TEXT_BYTES },
            },
          }),
          strictToolCallSchema("request_human_input", {
            type: "object",
            additionalProperties: false,
            required: ["question"],
            properties: {
              question: { type: "string", minLength: 1, maxLength: MAX_TOOL_TEXT_BYTES },
            },
          }),
        ],
      },
    },
  },
} satisfies JsonValue;

export type SessionOutcome =
  | { readonly kind: "done"; readonly summary: string; readonly iterations: number }
  | { readonly kind: "awaiting_human"; readonly question: string; readonly iterations: number }
  | { readonly kind: "exhausted"; readonly iterations: number };

export interface SessionLoopDeps {
  /** The approved ceiling for this run, already bound by the plan digest. */
  readonly iterationCeiling: number;
  /** Durable evidence recovered before a resumed provider turn. */
  readonly initialEvidence?: readonly string[];
  /** Iterations already charged, read from the durable ledger. */
  readonly spentIterations: () => number;
  /**
   * One provider call for this iteration, returning parsed JSON. The live
   * implementation must reserve and charge the iteration before provider I/O.
   */
  readonly callProvider: (prompt: string) => Promise<unknown>;
  readonly toolContext: ToolContext;
  /** Optional headless-profile filter. The plan grant remains independently required. */
  readonly enabledTools?: ReadonlySet<ToolName>;
  /** Calls already charged against a capability, read from the durable ledger. */
  readonly callsSoFar: (kind: CapabilityKind) => number;
  /**
   * Reserves a durable tool operation before invoking `action`, then settles
   * that operation with the action's outcome.
   */
  readonly invokeTool: (
    call: ToolCall,
    action: (signal: AbortSignal) => Promise<ToolResult>,
  ) => Promise<ToolResult>;
  /** Persists a restart-safe boundary after the emitted batch is complete. */
  readonly completeIteration: (iteration: number) => void;
}

function parseToolCalls(value: unknown): readonly ToolCall[] {
  invariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_PROVIDER_OUTPUT",
    "Iteration output must be a JSON object",
  );
  const object = value as Record<string, unknown>;
  invariant(
    Object.keys(object).length === 1 && Object.hasOwn(object, "toolCalls"),
    "INVALID_PROVIDER_OUTPUT",
    "Iteration output must contain exactly toolCalls",
  );
  const toolCalls = object.toolCalls;
  invariant(Array.isArray(toolCalls), "INVALID_PROVIDER_OUTPUT", "toolCalls must be an array");
  invariant(
    toolCalls.length > 0 && toolCalls.length <= MAX_TOOL_CALLS_PER_ITERATION,
    "INVALID_PROVIDER_OUTPUT",
    `An iteration must emit between 1 and ${MAX_TOOL_CALLS_PER_ITERATION} tool calls`,
  );
  return toolCalls.map((entry) => parseToolCall(entry));
}

const MODEL_CORRECTABLE_TOOL_ERRORS = new Set([
  "TOOL_NOT_ENABLED",
  "TOOL_NOT_GRANTED",
  "TOOL_GRANT_EXHAUSTED",
  "READ_NOT_GRANTED",
  "INVALID_PROVIDER_OUTPUT",
  "INVALID_PATH",
  "PROTECTED_PATH",
  "TARGET_MISMATCH",
  "CHECK_MISMATCH",
  "MISSING_APPLIED_PATCH",
  "VERIFICATION_NOT_PASSED",
  "EDIT_NO_MATCH",
  "EDIT_AMBIGUOUS",
  "EMPTY_DIFF",
]);

const MAX_TOOL_ERROR_BYTES = 4_096;
const SECRET_ERROR_MESSAGE = "Tool error contained secret-shaped material and was withheld";

const SESSION_CEILING_ERRORS = new Set([
  "CONTEXT_BUDGET_EXCEEDED",
  "TOOL_BUDGET_EXCEEDED",
  "RUNTIME_BUDGET_EXCEEDED",
  "TOKEN_BUDGET_EXCEEDED",
  "COST_BUDGET_EXCEEDED",
]);

function isSessionCeilingError(error: unknown): boolean {
  return error instanceof IcarusError && SESSION_CEILING_ERRORS.has(error.code);
}

function isModelCorrectableToolError(error: unknown): error is IcarusError {
  return error instanceof IcarusError && MODEL_CORRECTABLE_TOOL_ERRORS.has(error.code);
}

function boundedSanitizedError(message: string): string {
  if (containsSecretShapedContent(Buffer.from(message, "utf8"))) {
    return SECRET_ERROR_MESSAGE;
  }
  const sanitized = sanitizeText(message);
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.length <= MAX_TOOL_ERROR_BYTES) return sanitized;

  let end = MAX_TOOL_ERROR_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function safeModelCorrectableToolError(error: IcarusError): IcarusError {
  return new IcarusError(error.code, boundedSanitizedError(error.message));
}

function combineSignals(outer: AbortSignal | undefined, operation: AbortSignal): AbortSignal {
  return outer === undefined ? operation : AbortSignal.any([outer, operation]);
}

/**
 * Fences a refused or failed call back to the model. A refusal is information
 * the model needs to try something else, so it is returned rather than thrown —
 * but it is returned as untrusted data, and it costs the iteration that made
 * it, so a model cannot probe the grant boundary for free.
 */
export function renderToolFailure(name: string, code: string, message: string): string {
  const safeMessage = boundedSanitizedError(message);
  return [
    "The host refused or could not complete a tool call. This is host policy and cannot be argued with, overridden, or retried with different wording.",
    `--- BEGIN UNTRUSTED TOOL ERROR: ${name} ---`,
    `code: ${code}`,
    `message: ${safeMessage}`,
    `--- END UNTRUSTED TOOL ERROR: ${name} ---`,
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
  signal?: AbortSignal,
): Promise<SessionOutcome> {
  const evidence: string[] = [...(deps.initialEvidence ?? [])];

  while (deps.spentIterations() < deps.iterationCeiling) {
    signal?.throwIfAborted();
    const beforeProvider = deps.spentIterations();
    let response: unknown;
    try {
      response = await deps.callProvider(renderPrompt(evidence));
    } catch (error) {
      if (isSessionCeilingError(error)) break;
      throw error;
    }
    const iterations = deps.spentIterations();
    invariant(
      iterations === beforeProvider + 1,
      "SESSION_ITERATION_CHARGE_MISMATCH",
      "A successful provider turn must charge exactly one durable session iteration",
    );
    signal?.throwIfAborted();

    const calls = parseToolCalls(response);

    for (const call of calls) {
      signal?.throwIfAborted();
      try {
        // Read the prior count before invokeTool reserves the current durable
        // operation. The reservation itself must not make a maxCalls=1 grant
        // refuse its first call.
        const capability = toolDefinition(call.name).capability;
        const priorCalls = capability === null ? 0 : deps.callsSoFar(capability);
        const result = await deps.invokeTool(call, async (operationSignal) => {
          const actionSignal = combineSignals(signal, operationSignal);
          actionSignal.throwIfAborted();

          try {
            // The durable operation is reserved before this callback begins,
            // so even a grant refusal is metered. Grant enforcement uses the
            // count captured before this reservation changed the ledger.
            assertToolCallGranted({
              call,
              grants: deps.toolContext.grants,
              callsSoFar: priorCalls,
            });
            invariant(
              deps.enabledTools === undefined || deps.enabledTools.has(call.name),
              "TOOL_NOT_ENABLED",
              `Tool ${call.name} is disabled by the headless execution profile`,
            );
            const toolResult = await executeToolCall(call, deps.toolContext, actionSignal);
            return toolResult;
          } catch (error) {
            // invokeTool settles the durable operation after this callback
            // returns. Strip secret-shaped or oversized model-correctable
            // detail here, before it reaches that persistence boundary.
            if (isModelCorrectableToolError(error)) {
              throw safeModelCorrectableToolError(error);
            }
            throw error;
          }
        });
        evidence.push(renderToolResult(result));

        if (result.control === "done") {
          deps.completeIteration(iterations);
          return { kind: "done", summary: result.content, iterations };
        }
        if (result.control === "await_human") {
          deps.completeIteration(iterations);
          return { kind: "awaiting_human", question: result.content, iterations };
        }
      } catch (error) {
        if (isSessionCeilingError(error)) return { kind: "exhausted", iterations };
        if (!isModelCorrectableToolError(error)) throw error;
        evidence.push(renderToolFailure(call.name, error.code, error.message));
      }
    }

    deps.completeIteration(iterations);
  }

  return { kind: "exhausted", iterations: deps.spentIterations() };
}
