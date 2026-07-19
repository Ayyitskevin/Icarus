import { describe, expect, test } from "vitest";

import {
  containsSecretShapedContent,
  isSecretShapedPath,
} from "../../packages/core/src/context.js";
import { IcarusError } from "../../packages/core/src/errors.js";
import { assertAllowedTarget } from "../../packages/core/src/policy.js";
import { sanitizeText } from "../../packages/core/src/redaction.js";

function rejectedCode(target: string): string | null {
  try {
    assertAllowedTarget(target);
    return null;
  } catch (error) {
    return error instanceof IcarusError ? error.code : "UNKNOWN";
  }
}

describe("host-owned policy boundaries", () => {
  test.each([
    "../escape",
    "/absolute/path",
    ".git/config",
    ".env.production",
    "migrations/001.sql",
    "AGENTS.md",
    "Dockerfile",
    "package.json",
    "pnpm-lock.yaml",
    "keys/private.pem",
  ])("rejects protected or escaping target %s", (target) => {
    expect(rejectedCode(target)).not.toBeNull();
  });

  test("detects secret-shaped paths and content before context or sandbox export", () => {
    expect(isSecretShapedPath("config/credentials.json")).toBe(true);
    expect(containsSecretShapedContent(Buffer.from(`token = sk-${"a".repeat(24)}`))).toBe(true);
    expect(containsSecretShapedContent(Buffer.from("ordinary fixture text"))).toBe(false);
  });

  test("redacts known and recognizable credentials plus control bytes", () => {
    const key = `sk-${"b".repeat(24)}`;
    const result = sanitizeText(`before ${key} secret-value\u0000 after`, ["secret-value"]);
    expect(result).not.toContain(key);
    expect(result).not.toContain("secret-value");
    expect(result).toContain("<redacted:api-key:");
    expect(result).toContain("<redacted:known-secret:");
    expect(result).toContain("<escaped-control>");
  });
});
