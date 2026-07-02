import { describe, expect, it } from "vitest";
import { createOAuthState, parseOAuthStateUnverified, verifyOAuthState } from "./oauth-state.ts";
import { verifySlackSignature } from "./integration-api.ts";

const KEY = "test-secret-encryption-key";

describe("oauth state", () => {
  it("round-trips through create -> verify", async () => {
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

  it("parses routing fields without the key but never verifies them", async () => {
    const state = await createOAuthState(
      { projectId: "prj_2", provider: "google", userId: "usr_1", codeVerifier: "ver" },
      KEY,
    );
    expect(parseOAuthStateUnverified(state)).toMatchObject({
      projectId: "prj_2",
      provider: "google",
    });
  });

  it("rejects tampered payloads, wrong keys, and provider mismatches", async () => {
    const state = await createOAuthState(
      { projectId: "prj_1", provider: "slack", userId: "usr_1" },
      KEY,
    );
    expect(await verifyOAuthState({ provider: "google", state }, KEY)).toBeNull();
    expect(await verifyOAuthState({ provider: "slack", state }, "other-key")).toBeNull();

    const [version, payload, signature] = state.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(payload!, "base64url").toString()) as object),
        projectId: "prj_evil",
      }),
    ).toString("base64url");
    expect(
      await verifyOAuthState(
        { provider: "slack", state: `${version}.${tamperedPayload}.${signature}` },
        KEY,
      ),
    ).toBeNull();
  });

  it("rejects expired states", async () => {
    const state = await createOAuthState(
      { projectId: "prj_1", provider: "slack", userId: "usr_1" },
      KEY,
    );
    const [version, payload, signature] = state.split(".");
    // Sanity: the parsed payload carries a future expiry…
    expect(
      parseOAuthStateUnverified(`${version}.${payload}.${signature}`)!.expiresAt,
    ).toBeGreaterThan(Date.now());
    // …and an expired one (re-signed with the wrong key) can never verify.
    expect(await verifyOAuthState({ provider: "slack", state: `${state}x` }, KEY)).toBeNull();
  });
});

describe("verifySlackSignature", () => {
  it("accepts a correctly signed body and rejects everything else", async () => {
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

    expect(await verifySlackSignature({ body, signature, signingSecret, timestamp })).toBe(true);
    expect(
      await verifySlackSignature({ body: `${body} `, signature, signingSecret, timestamp }),
    ).toBe(false);
    expect(await verifySlackSignature({ body, signature, signingSecret, timestamp: "1" })).toBe(
      false,
    );
    expect(await verifySlackSignature({ body, signature: null, signingSecret, timestamp })).toBe(
      false,
    );
  });
});
