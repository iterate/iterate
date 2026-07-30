import { exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, test, vi } from "vitest";
import { semaphoreEnvs } from "../../envs.ts";
import { createSemaphoreTokenProvider } from "./semaphore-token.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("createSemaphoreTokenProvider", () => {
  test("forge-mints a fresh bearer token after the previous token's lifetime", async () => {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    privateJwk.alg = "ES256";
    privateJwk.kid = "test-forge-key";
    const provider = createSemaphoreTokenProvider({
      baseUrl: semaphoreEnvs.prd.baseUrl,
      email: "preview-cli@iterate.com",
      env: {
        AUTH_FORGE_ES256_PRIVATE_JWK: JSON.stringify(privateJwk),
      },
    });

    vi.useFakeTimers();
    vi.setSystemTime("2026-07-30T12:00:00.000Z");
    const first = await provider();
    vi.setSystemTime("2026-07-30T13:00:01.000Z");
    const refreshed = await provider();

    expect(refreshed).not.toBe(first);
  });
});
