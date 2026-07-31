import { describe, expect, test } from "vitest";

import {
  createResolvedWorkspaceSession,
  matchesWorkspaceBearer,
  workspaceHostnameResolvesToBoundLoopback,
} from "../../packages/api/src/workspace-session.js";

function launchToken(launchUrl: string): string {
  const parsed = new URL(launchUrl);
  const match = /^#icarus-action-session=([A-Za-z0-9_-]{43})$/.exec(parsed.hash);
  if (match === null) throw new Error("Launch URL did not contain one canonical action session");
  return match[1] ?? "";
}

describe("browser workspace session", () => {
  const loopbackLookup = async () => [
    { address: "::1", family: 6 },
    { address: "127.0.0.1", family: 4 },
  ];

  test("creates a rotating random-origin action session with only a launch fragment", async () => {
    const first = await createResolvedWorkspaceSession("mutation-capable", 31_337, loopbackLookup);
    const second = await createResolvedWorkspaceSession("mutation-capable", 31_337, loopbackLookup);

    expect(first).toMatchObject({
      mode: "mutation-capable",
      authority: expect.stringMatching(/^[a-f0-9]{32}\.localhost:31337$/),
      hostname: expect.stringMatching(/^[a-f0-9]{32}\.localhost$/),
    });
    expect(first.url).toBe(`http://${first.authority}`);
    expect(new URL(first.launchUrl).origin).toBe(first.url);
    expect(first.launchUrl.match(/#/g)).toHaveLength(1);
    expect(launchToken(first.launchUrl)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.hostname).not.toBe(first.hostname);
    expect(launchToken(second.launchUrl)).not.toBe(launchToken(first.launchUrl));
    expect(Object.keys(first)).not.toEqual(expect.arrayContaining(["token", "bearer"]));
  });

  test("creates a plain stable-origin review-only session without a token fragment", async () => {
    const session = await createResolvedWorkspaceSession("review-only", 8_787, async () => {
      throw new Error("Review-only startup must not resolve a mutation hostname");
    });
    expect(session).toMatchObject({
      mode: "review-only",
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

  test("fails closed to review-only when the random hostname cannot be proven at the bound loopback", async () => {
    for (const addresses of [
      [],
      [{ address: "::1", family: 6 }],
      [{ address: "127.0.0.2", family: 4 }],
      [
        { address: "127.0.0.1", family: 4 },
        { address: "192.0.2.10", family: 4 },
      ],
    ]) {
      const session = await createResolvedWorkspaceSession(
        "mutation-capable",
        31_337,
        async () => addresses,
      );
      expect(session).toMatchObject({
        mode: "review-only",
        hostname: "127.0.0.1",
        launchUrl: "http://127.0.0.1:31337",
      });
    }

    const lookupFailure = await createResolvedWorkspaceSession(
      "mutation-capable",
      31_337,
      async () => {
        throw new Error("resolution failed");
      },
    );
    expect(lookupFailure.mode).toBe("review-only");
    await expect(
      workspaceHostnameResolvesToBoundLoopback("not-canonical.localhost", loopbackLookup),
    ).resolves.toBe(false);
  });

  test("rejects invalid bound ports and invalid internal bearer widths", async () => {
    await expect(
      createResolvedWorkspaceSession("mutation-capable", 0, loopbackLookup),
    ).rejects.toMatchObject({ code: "INVALID_PORT" });
    await expect(createResolvedWorkspaceSession("review-only", 65_536)).rejects.toThrowError(
      expect.objectContaining({ code: "INVALID_PORT" }),
    );
    expect(() => matchesWorkspaceBearer(Buffer.alloc(31), "Bearer invalid")).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTION_SESSION" }),
    );
  });
});
