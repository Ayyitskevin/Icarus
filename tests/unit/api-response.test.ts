import { describe, expect, test } from "vitest";

import { MAX_JSON_RESPONSE_BYTES, serializeJsonResponse } from "../../packages/api/src/server.js";

describe("workspace JSON response ceiling", () => {
  test("accepts the exact 8 MiB boundary and rejects the next byte deterministically", () => {
    const emptyBytes = Buffer.byteLength(`${JSON.stringify({ payload: "" })}\n`, "utf8");
    const exact = serializeJsonResponse({
      payload: "x".repeat(MAX_JSON_RESPONSE_BYTES - emptyBytes),
    });
    expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_JSON_RESPONSE_BYTES);

    try {
      serializeJsonResponse({ payload: "x".repeat(MAX_JSON_RESPONSE_BYTES - emptyBytes + 1) });
      throw new Error("Expected response ceiling rejection");
    } catch (error) {
      expect(error).toMatchObject({
        name: "IcarusError",
        code: "RESPONSE_TOO_LARGE",
        message: "The local workspace response exceeds the 8 MiB JSON limit",
      });
    }
  });
});
