import { findSecretSpans, type SecretSpan } from "./context.js";

// biome-ignore lint/complexity/useRegexLiterals: constructors keep control bytes out of regex literals
const CONTROL_PATTERN = new RegExp(String.raw`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`, "g");
const MAX_REDACTION_SPANS = 4_096;

interface RedactionSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: SecretSpan["kind"] | "known-secret";
}

function mergedSpans(spans: readonly RedactionSpan[]): RedactionSpan[] {
  const ordered = [...spans].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const merged: RedactionSpan[] = [];
  for (const span of ordered) {
    const previous = merged.at(-1);
    if (previous === undefined || span.start > previous.end) {
      merged.push(span);
    } else if (span.end > previous.end) {
      merged[merged.length - 1] = { ...previous, end: span.end };
    }
  }
  return merged;
}

function knownSecretSpans(input: string, knownSecrets: readonly string[]): RedactionSpan[] {
  const spans: RedactionSpan[] = [];
  for (const secret of new Set(knownSecrets.filter((value) => value.length > 0))) {
    let start = 0;
    while (start < input.length) {
      const match = input.indexOf(secret, start);
      if (match === -1) break;
      if (spans.length >= MAX_REDACTION_SPANS) {
        spans.push({ start: match, end: input.length, kind: "known-secret" });
        return mergedSpans(spans);
      }
      spans.push({ start: match, end: match + secret.length, kind: "known-secret" });
      start = match + secret.length;
    }
  }
  return mergedSpans(spans);
}

function redactSpans(input: string, spans: readonly RedactionSpan[]): string {
  let cursor = 0;
  let output = "";
  for (const span of mergedSpans(spans)) {
    output += input.slice(cursor, span.start);
    output += `<redacted:${span.kind}>`;
    cursor = span.end;
  }
  return output + input.slice(cursor);
}

function escapeAnsiControls(input: string): string {
  const parts: string[] = [];
  let segmentStart = 0;
  let cursor = 0;
  while (cursor < input.length) {
    if (input.charCodeAt(cursor) !== 0x1b) {
      cursor += 1;
      continue;
    }
    parts.push(input.slice(segmentStart, cursor), "<escaped-control>");
    let end = cursor + 1;
    const introducer = input[end];
    if (introducer === "]") {
      end += 1;
      while (end < input.length) {
        if (input.charCodeAt(end) === 0x07) {
          end += 1;
          break;
        }
        if (input.charCodeAt(end) === 0x1b && input[end + 1] === "\\") {
          end += 2;
          break;
        }
        end += 1;
      }
    } else if (introducer === "[") {
      end += 1;
      while (end < input.length && /[0-?]/.test(input[end] ?? "")) end += 1;
      while (end < input.length && /[ -/]/.test(input[end] ?? "")) end += 1;
      if (end < input.length && /[@-~]/.test(input[end] ?? "")) end += 1;
    }
    cursor = end;
    segmentStart = end;
  }
  if (parts.length === 0) return input;
  parts.push(input.slice(segmentStart));
  return parts.join("");
}

export function sanitizeText(input: string, knownSecrets: readonly string[] = []): string {
  let result = redactSpans(input, [
    ...knownSecretSpans(input, knownSecrets),
    ...findSecretSpans(input),
  ]);
  result = escapeAnsiControls(result);
  result = redactSpans(result, findSecretSpans(result));
  return result.replace(CONTROL_PATTERN, "<escaped-control>");
}
