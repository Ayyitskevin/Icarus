import { describe, expect, test } from "vitest";

import {
  createBoundWorkspaceSession,
  createWorkspaceMutationHostname,
  isFreshWorkspaceLoopbackHostname,
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
    const firstHostname = createWorkspaceMutationHostname(() => Uint8Array.from([1, 2, 3]));
    const secondHostname = createWorkspaceMutationHostname(() => Uint8Array.from([4, 5, 6]));
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
    expect(isFreshWorkspaceLoopbackHostname(first.hostname)).toBe(true);
    expect(first.url).toBe(`http://${first.authority}`);
    expect(new URL(first.launchUrl).origin).toBe(first.url);
    expect(first.launchUrl.match(/#/g)).toHaveLength(1);
    expect(launchToken(first.launchUrl)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.hostname).not.toBe(first.hostname);
    expect(launchToken(second.launchUrl)).not.toBe(launchToken(first.launchUrl));
    expect(Object.keys(first)).not.toEqual(expect.arrayContaining(["token", "bearer"]));
  });

  test("rejects edge octets, refills entropy exactly, and fails closed on wrong widths", () => {
    const requests: number[] = [];
    const chunks = [Uint8Array.from([0, 255, 17]), Uint8Array.from([18, 19])];
    const hostname = createWorkspaceMutationHostname((size) => {
      requests.push(size);
      const chunk = chunks.shift();
      if (chunk === undefined) throw new Error("unexpected entropy request");
      return chunk;
    });
    expect(hostname).toBe("127.17.18.19");
    expect(requests).toEqual([3, 2]);
    expect(() => createWorkspaceMutationHostname(() => Uint8Array.from([1, 2]))).toThrowError(
      expect.objectContaining({ code: "INVALID_ORIGIN" }),
    );
    expect(() =>
      createBoundWorkspaceSession(
        "mutation-capable",
        31_337,
        "127.1.2.3",
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

  test("accepts only canonical fresh numeric loopback bindings", () => {
    for (const valid of ["127.1.1.1", "127.17.42.93", "127.254.254.254"]) {
      expect(isFreshWorkspaceLoopbackHostname(valid)).toBe(true);
      expect(createBoundWorkspaceSession("mutation-capable", 31_337, valid).hostname).toBe(valid);
    }
    for (const invalid of [
      "127.0.0.1",
      "127.0.1.2",
      "127.1.2.0",
      "127.1.2.255",
      "127.01.2.3",
      "126.1.2.3",
      "128.1.2.3",
      "127.1.2.3.localhost",
      "::1",
    ]) {
      expect(isFreshWorkspaceLoopbackHostname(invalid)).toBe(false);
      expect(() => createBoundWorkspaceSession("mutation-capable", 31_337, invalid)).toThrowError(
        expect.objectContaining({ code: "INVALID_ORIGIN" }),
      );
    }
    expect(() => createBoundWorkspaceSession("review-only", 31_337, "127.1.2.3")).toThrowError(
      expect.objectContaining({ code: "INVALID_ORIGIN" }),
    );
    expect(() =>
      createBoundWorkspaceSession(
        "mutation-capable",
        31_337,
        "127.1.2.3",
        "fresh-loopback-unavailable",
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ORIGIN" }));
    expect(() =>
      createBoundWorkspaceSession("review-only", 31_337, "127.0.0.1", null),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ORIGIN" }));
    expect(
      createBoundWorkspaceSession("review-only", 31_337, "127.0.0.1", "fresh-loopback-unavailable")
        .reviewOnlyReason,
    ).toBe("fresh-loopback-unavailable");
  });

  test("rejects invalid bound ports and invalid internal bearer widths", async () => {
    expect(() => createBoundWorkspaceSession("mutation-capable", 0, "127.1.2.3")).toThrowError(
      expect.objectContaining({ code: "INVALID_PORT" }),
    );
    expect(() => createBoundWorkspaceSession("review-only", 65_536, "127.0.0.1")).toThrowError(
      expect.objectContaining({ code: "INVALID_PORT" }),
    );
    expect(() => matchesWorkspaceBearer(Buffer.alloc(31), "Bearer invalid")).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTION_SESSION" }),
    );
  });
});
