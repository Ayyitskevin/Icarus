import { describe, expect, test } from "vitest";

import {
  createBoundWorkspaceSession,
  createWorkspaceMutationHostname,
  isWorkspaceMutationHostname,
  matchesWorkspaceBearer,
} from "../../packages/api/src/workspace-session.js";

function launchToken(launchUrl: string): string {
  const parsed = new URL(launchUrl);
  const match = /^#icarus-action-session=([A-Za-z0-9_-]{43})$/.exec(parsed.hash);
  if (match === null) throw new Error("Launch URL did not contain one canonical action session");
  return match[1] ?? "";
}

describe("browser workspace session", () => {
  test("creates deterministic distinct random-origin action sessions with only launch fragments", () => {
    const firstHostname = createWorkspaceMutationHostname(() =>
      Uint8Array.from({ length: 16 }, (_, index) => index),
    );
    const secondHostname = createWorkspaceMutationHostname(() =>
      Uint8Array.from({ length: 16 }, (_, index) => index + 16),
    );
    const first = createBoundWorkspaceSession("mutation-capable", 31_337, firstHostname, null, () =>
      Uint8Array.from({ length: 32 }, () => 7),
    );
    const second = createBoundWorkspaceSession(
      "mutation-capable",
      31_337,
      secondHostname,
      null,
      () => Uint8Array.from({ length: 32 }, () => 8),
    );

    expect(first).toMatchObject({
      mode: "mutation-capable",
      reviewOnlyReason: null,
      authority: `${firstHostname}:31337`,
      hostname: firstHostname,
    });
    expect(first.hostname).toBe("000102030405060708090a0b0c0d0e0f.localhost");
    expect(second.hostname).toBe("101112131415161718191a1b1c1d1e1f.localhost");
    expect(isWorkspaceMutationHostname(first.hostname)).toBe(true);
    expect(first.url).toBe(`http://${first.authority}`);
    expect(new URL(first.launchUrl).origin).toBe(first.url);
    expect(first.launchUrl.match(/#/g)).toHaveLength(1);
    expect(launchToken(first.launchUrl)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.hostname).not.toBe(first.hostname);
    expect(launchToken(second.launchUrl)).not.toBe(launchToken(first.launchUrl));
    expect(Object.keys(first)).not.toEqual(expect.arrayContaining(["token", "bearer"]));
  });

  test("uses one exact 128-bit origin draw and fails closed on wrong entropy widths", () => {
    const requests: number[] = [];
    const hostname = createWorkspaceMutationHostname((size) => {
      requests.push(size);
      return Uint8Array.from({ length: size }, () => 0xff);
    });
    expect(hostname).toBe("ffffffffffffffffffffffffffffffff.localhost");
    expect(requests).toEqual([16]);
    expect(() => createWorkspaceMutationHostname(() => new Uint8Array(15))).toThrowError(
      expect.objectContaining({ code: "INVALID_ORIGIN" }),
    );
    expect(() =>
      createBoundWorkspaceSession(
        "mutation-capable",
        31_337,
        "0123456789abcdef0123456789abcdef.localhost",
        null,
        () => new Uint8Array(31),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ACTION_SESSION" }));
  });

  test("creates a plain stable-origin review-only session without a token fragment", async () => {
    const session = createBoundWorkspaceSession("review-only", 8_787, "127.0.0.1");
    expect(session).toMatchObject({
      mode: "review-only",
      reviewOnlyReason: "explicit-port",
      hostname: "127.0.0.1",
      authority: "127.0.0.1:8787",
      url: "http://127.0.0.1:8787",
      launchUrl: "http://127.0.0.1:8787",
    });
    expect(new URL(session.launchUrl).hash).toBe("");
  });

  test("uses canonical fixed-width bearer comparison for valid and malformed values", () => {
    const expected = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    const encoded = expected.toString("base64url");
    const wrong = Buffer.alloc(32, 0xff).toString("base64url");

    expect(matchesWorkspaceBearer(expected, `Bearer ${encoded}`)).toBe(true);
    expect(matchesWorkspaceBearer(expected, `Bearer ${wrong}`)).toBe(false);
    expect(matchesWorkspaceBearer(expected, `bearer ${encoded}`)).toBe(false);
    expect(matchesWorkspaceBearer(expected, `Bearer ${encoded}=`)).toBe(false);
    expect(matchesWorkspaceBearer(expected, `Bearer ${encoded.slice(1)}`)).toBe(false);
    expect(matchesWorkspaceBearer(expected, "")).toBe(false);
  });

  test("accepts only canonical 128-bit lowercase localhost origin labels", () => {
    for (const valid of [
      "00000000000000000000000000000000.localhost",
      "0123456789abcdef0123456789abcdef.localhost",
      "ffffffffffffffffffffffffffffffff.localhost",
    ]) {
      expect(isWorkspaceMutationHostname(valid)).toBe(true);
      expect(createBoundWorkspaceSession("mutation-capable", 31_337, valid).hostname).toBe(valid);
    }
    for (const invalid of [
      "127.0.0.1",
      "localhost",
      "0123456789abcdef0123456789abcde.localhost",
      "0123456789abcdef0123456789abcdef0.localhost",
      "0123456789ABCDEF0123456789ABCDEF.localhost",
      "g123456789abcdef0123456789abcdef.localhost",
      "0123456789abcdef0123456789abcdef.localhost.",
      "0123456789abcdef0123456789abcdef.localhost.example",
      "::1",
    ]) {
      expect(isWorkspaceMutationHostname(invalid)).toBe(false);
      expect(() => createBoundWorkspaceSession("mutation-capable", 31_337, invalid)).toThrowError(
        expect.objectContaining({ code: "INVALID_ORIGIN" }),
      );
    }
    expect(() =>
      createBoundWorkspaceSession(
        "review-only",
        31_337,
        "0123456789abcdef0123456789abcdef.localhost",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ORIGIN" }));
    expect(() =>
      createBoundWorkspaceSession(
        "mutation-capable",
        31_337,
        "0123456789abcdef0123456789abcdef.localhost",
        "explicit-port",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ORIGIN" }));
    expect(() =>
      createBoundWorkspaceSession("review-only", 31_337, "127.0.0.1", null),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ORIGIN" }));
  });

  test("rejects invalid bound ports and invalid internal bearer widths", async () => {
    expect(() =>
      createBoundWorkspaceSession(
        "mutation-capable",
        0,
        "0123456789abcdef0123456789abcdef.localhost",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PORT" }));
    expect(() => createBoundWorkspaceSession("review-only", 65_536, "127.0.0.1")).toThrowError(
      expect.objectContaining({ code: "INVALID_PORT" }),
    );
    expect(() => matchesWorkspaceBearer(Buffer.alloc(31), "Bearer invalid")).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTION_SESSION" }),
    );
  });
});
