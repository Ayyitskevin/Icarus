import { sha256 } from "./digest.js";

// biome-ignore lint/complexity/useRegexLiterals: constructors keep control bytes out of regex literals
const ANSI_PATTERN = new RegExp(
  String.raw`\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])`,
  "g",
);
// biome-ignore lint/complexity/useRegexLiterals: constructors keep control bytes out of regex literals
const CONTROL_PATTERN = new RegExp(String.raw`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`, "g");
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const TOKEN_PATTERNS: readonly [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "api-key"],
  [/\bgh[opusr]_[A-Za-z0-9]{20,}\b/g, "github-token"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "aws-access-key"],
  [/(?:https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, "credentialed-url"],
];

function marker(kind: string, value: string): string {
  return `<redacted:${kind}:${sha256(value).slice(0, 12)}>`;
}

export function sanitizeText(input: string, knownSecrets: readonly string[] = []): string {
  let result = input.replace(ANSI_PATTERN, "<escaped-control>");
  for (const secret of knownSecrets) {
    if (secret.length >= 4) {
      result = result.split(secret).join(marker("known-secret", secret));
    }
  }
  result = result.replace(PRIVATE_KEY_PATTERN, (value) => marker("private-key", value));
  for (const [pattern, kind] of TOKEN_PATTERNS) {
    result = result.replace(pattern, (value) => marker(kind, value));
  }
  return result.replace(CONTROL_PATTERN, "<escaped-control>");
}
