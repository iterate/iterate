import { describe, expect, test } from "vitest";
import { createOAuthState, parseOAuthStateUnverified, verifyOAuthState } from "./oauth-state.ts";
import { verifySlackSignature } from "./slack-signature.ts";

const KEY = "test-secret-encryption-key";

describe("oauth state", () => {
  test("round-trips through create -> verify", async () => {
    const state = await createOAuthState(
      {
        callbackUrl: "https://example.com/settings",
        projectId: "prj_1",
        provider: "slack",
        userId: "usr_1",
      },
      KEY,
    );
    const verified = await verifyOAuthState({ provider: "slack", state }, KEY);
    expect(verified).toMatchObject({
      callbackUrl: "https://example.com/settings",
      projectId: "prj_1",
      provider: "slack",
      userId: "usr_1",
    });
  });

  test("parses routing fields without the key but never verifies them", async () => {
    const state = await createOAuthState(
      { projectId: "prj_2", provider: "google", userId: "usr_1", codeVerifier: "ver" },
      KEY,
    );
    expect(parseOAuthStateUnverified(state)).toMatchObject({
      projectId: "prj_2",
      provider: "google",
    });
  });

  test.for([
    {
      name: "rejects a provider mismatch",
      verify: (state: string) => verifyOAuthState({ provider: "google", state }, KEY),
    },
    {
      name: "rejects a wrong key",
      verify: (state: string) => verifyOAuthState({ provider: "slack", state }, "other-key"),
    },
    {
      name: "rejects a tampered payload",
      verify: (state: string) => {
        const [version, payload, signature] = state.split(".");
        const tamperedPayload = Buffer.from(
          JSON.stringify({
            ...(JSON.parse(Buffer.from(payload!, "base64url").toString()) as object),
            projectId: "prj_evil",
          }),
        ).toString("base64url");
        return verifyOAuthState(
          { provider: "slack", state: `${version}.${tamperedPayload}.${signature}` },
          KEY,
        );
      },
    },
    {
      // Appending garbage breaks the signature — the only way to hold an
      // expired-or-otherwise-doctored state without the key.
      name: "rejects a state with a broken signature",
      verify: (state: string) => verifyOAuthState({ provider: "slack", state: `${state}x` }, KEY),
    },
  ])("$name", async ({ verify }) => {
    const state = await createOAuthState(
      { projectId: "prj_1", provider: "slack", userId: "usr_1" },
      KEY,
    );
    // Sanity: the fixture state is live (carries a future expiry), so every
    // rejection below is the verifier's doing, never mere expiry.
    expect(parseOAuthStateUnverified(state)!.expiresAt).toBeGreaterThan(Date.now());

    expect(await verify(state)).toBeNull();
  });
});

type SlackSignatureInput = {
  body: string;
  signature: string | null;
  signingSecret: string;
  timestamp: string;
};

describe("verifySlackSignature", () => {
  test.for([
    { name: "accepts a correctly signed body", expected: true },
    {
      name: "rejects a tampered body",
      tamper: (input: SlackSignatureInput) => ({ ...input, body: `${input.body} ` }),
      expected: false,
    },
    {
      name: "rejects a stale timestamp",
      tamper: (input: SlackSignatureInput) => ({ ...input, timestamp: "1" }),
      expected: false,
    },
    {
      name: "rejects a missing signature",
      tamper: (input: SlackSignatureInput) => ({ ...input, signature: null }),
      expected: false,
    },
  ])("$name", async ({ expected, tamper }) => {
    const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
    const body = JSON.stringify({ type: "event_callback", team_id: "T1" });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingSecret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)),
    );
    const signature = `v0=${Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

    const input: SlackSignatureInput = { body, signature, signingSecret, timestamp };
    expect(await verifySlackSignature(tamper ? tamper(input) : input)).toBe(expected);
  });
});
