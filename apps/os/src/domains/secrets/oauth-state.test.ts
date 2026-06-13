import { describe, expect, it } from "vitest";
import { generateSecretsKeyBase64 } from "./secret-crypto.ts";
import { signOAuthState, verifyOAuthState } from "./oauth-state.ts";

const NOW = Date.parse("2026-06-12T12:00:00.000Z");

describe("sealed stateless OAuth state", () => {
  it("round-trips a payload and enforces expiry", async () => {
    const key = generateSecretsKeyBase64();
    const state = await signOAuthState({
      key,
      payload: {
        provider: "google",
        projectId: "proj-a",
        userId: "user-1",
        callbackUrl: "https://os.iterate.com/projects/p/integrations",
        codeVerifier: "pkce-verifier",
      },
      nowMs: NOW,
    });

    const verified = await verifyOAuthState({ key, state, nowMs: NOW + 60_000 });
    expect(verified).toMatchObject({
      provider: "google",
      projectId: "proj-a",
      userId: "user-1",
      codeVerifier: "pkce-verifier",
    });

    // Expired eleven minutes later.
    expect(await verifyOAuthState({ key, state, nowMs: NOW + 11 * 60_000 })).toBeNull();
  });

  it("is SEALED, not just signed: the PKCE verifier never appears in the token", async () => {
    const state = await signOAuthState({
      key: generateSecretsKeyBase64(),
      payload: {
        provider: "google",
        projectId: "proj-a",
        userId: "user-1",
        codeVerifier: "pkce-verifier-material",
      },
      nowMs: NOW,
    });
    // The token round-trips through the provider and the user's browser —
    // nothing in it may be readable.
    const decodable = Buffer.from(
      state.replaceAll("-", "+").replaceAll("_", "/").replaceAll(".", ""),
      "base64",
    ).toString("latin1");
    expect(state).not.toContain("pkce-verifier-material");
    expect(decodable).not.toContain("pkce-verifier-material");
    expect(decodable).not.toContain("proj-a");
  });

  it("rejects tampered tokens and wrong keys", async () => {
    const key = generateSecretsKeyBase64();
    const state = await signOAuthState({
      key,
      payload: { provider: "slack", projectId: "p", userId: "u" },
      nowMs: NOW,
    });

    expect(await verifyOAuthState({ key, state: `${state}x`, nowMs: NOW })).toBeNull();
    expect(
      await verifyOAuthState({ key: generateSecretsKeyBase64(), state, nowMs: NOW }),
    ).toBeNull();
    expect(await verifyOAuthState({ key, state: "not-a-token", nowMs: NOW })).toBeNull();
  });
});
