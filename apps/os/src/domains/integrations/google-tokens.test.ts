// Unit tests for Google OAuth token storage + refresh (ports the meaningful
// cases from the legacy src/domains/secrets/oauth.test.ts onto the next
// engine). Tokens live as AES-GCM ciphertext in events on the per-project
// `/integrations/google` stream, so the seam here is an in-memory STREAM
// namespace behind the mocked `nextEnv` plus a stubbed global fetch — no
// workerd, no network.

import { afterEach, describe, expect, test, vi } from "vitest";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { decryptSecretMaterial, encryptSecretMaterial } from "../secrets/crypto.ts";
import { getFreshGoogleAccessToken } from "./google-tokens.ts";
import {
  GOOGLE_CONNECTED_EVENT_TYPE,
  GOOGLE_INTEGRATION_STREAM_PATH,
  GOOGLE_TOKEN_REFRESHED_EVENT_TYPE,
} from "./utils.ts";
import { parseConfig } from "~/config.ts";

const streamNetwork = vi.hoisted(() => {
  type StoredEvent = {
    createdAt: string;
    offset: number;
    payload: unknown;
    type: string;
  };
  const streams = new Map<string, StoredEvent[]>();
  const eventsAt = (name: string): StoredEvent[] => {
    let events = streams.get(name);
    if (events === undefined) {
      events = [];
      streams.set(name, events);
    }
    return events;
  };
  return {
    getByName(name: string) {
      const events = eventsAt(name);
      return {
        async append(...inputs: Array<{ payload: unknown; type: string }>) {
          return inputs.map((input) => {
            const event: StoredEvent = {
              ...input,
              createdAt: new Date().toISOString(),
              offset: events.length + 1,
            };
            events.push(event);
            return event;
          });
        },
        async getEvents({
          afterOffset = 0,
          limit = 500,
        }: {
          afterOffset?: number;
          limit?: number;
        }) {
          return events.filter((event) => event.offset > afterOffset).slice(0, limit);
        },
      };
    },
    reset() {
      streams.clear();
    },
    streams,
  };
});

const SECRET_ENCRYPTION_KEY = "test-secret-encryption-key";

vi.mock("../../env.ts", () => ({
  nextEnv: {
    SECRET_ENCRYPTION_KEY: "test-secret-encryption-key",
    STREAM: { getByName: streamNetwork.getByName },
  },
}));

const PROJECT_ID = "prj_test";
const GOOGLE_STREAM_NAME = DurableObjectNameCodec.stringify(
  { path: GOOGLE_INTEGRATION_STREAM_PATH, projectId: PROJECT_ID },
  { allowNullProjectId: true },
);

describe("getFreshGoogleAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    streamNetwork.reset();
  });

  test("returns the stored access token when it is not near expiry", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await seedConnectedGoogleAccount({
      accessToken: "stored-access-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refreshToken: "refresh-token",
    });

    await expect(
      getFreshGoogleAccessToken({ config: testConfig(), projectId: PROJECT_ID }),
    ).resolves.toBe("stored-access-token");
    expect(fetchMock).not.toHaveBeenCalled();
    // Nothing new was recorded on the integration stream.
    expect(streamNetwork.streams.get(GOOGLE_STREAM_NAME)).toHaveLength(1);
  });

  test("refreshes and persists an expired access token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "refreshed-access-token",
        expires_in: 3920,
        scope:
          "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await seedConnectedGoogleAccount({
      accessToken: "expired-access-token",
      email: "user@example.com",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      refreshToken: "refresh-token",
    });

    await expect(
      getFreshGoogleAccessToken({ config: testConfig(), projectId: PROJECT_ID }),
    ).resolves.toBe("refreshed-access-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST", body: expect.any(URLSearchParams) }),
    );
    const refreshRequest = fetchMock.mock.calls[0]?.[1] as { body: URLSearchParams } | undefined;
    expect(refreshRequest?.body.get("grant_type")).toBe("refresh_token");
    expect(refreshRequest?.body.get("refresh_token")).toBe("refresh-token");
    expect(refreshRequest?.body.get("client_id")).toBe("google-client-id");
    expect(refreshRequest?.body.get("client_secret")).toBe("google-client-secret");

    // The rotated token is persisted as a token-refreshed event carrying fresh
    // AES-GCM ciphertext, the pushed-out expiry, and the granted scopes.
    const events = streamNetwork.streams.get(GOOGLE_STREAM_NAME) ?? [];
    expect(events).toHaveLength(2);
    const refreshed = events[1]!;
    expect(refreshed.type).toBe(GOOGLE_TOKEN_REFRESHED_EVENT_TYPE);
    const payload = refreshed.payload as {
      encryptedAccessToken: { algorithm: "AES-GCM-SHA256"; ciphertext: string; iv: string };
      expiresAt: string;
      scopes: string[];
    };
    await expect(
      decryptSecretMaterial(payload.encryptedAccessToken, SECRET_ENCRYPTION_KEY),
    ).resolves.toBe("refreshed-access-token");
    expect(Date.parse(payload.expiresAt)).toBeGreaterThan(Date.now() + 3000 * 1000);
    expect(payload.scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ]);

    // The persisted refresh is what subsequent reads fold: a second call
    // serves the rotated token without touching the network again.
    fetchMock.mockClear();
    await expect(
      getFreshGoogleAccessToken({ config: testConfig(), projectId: PROJECT_ID }),
    ).resolves.toBe("refreshed-access-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function testConfig() {
  return parseConfig({
    APP_CONFIG: JSON.stringify({
      integrations: {
        google: {
          oauthClientId: "google-client-id",
          oauthClientSecret: "google-client-secret",
        },
      },
      openAiApiKey: "openai-test-key",
    }),
  });
}

async function seedConnectedGoogleAccount(input: {
  accessToken: string;
  email?: string;
  expiresAt: string;
  refreshToken: string;
}): Promise<void> {
  await streamNetwork.getByName(GOOGLE_STREAM_NAME).append({
    type: GOOGLE_CONNECTED_EVENT_TYPE,
    payload: {
      email: input.email ?? "user@example.com",
      encryptedAccessToken: await encryptSecretMaterial(input.accessToken, SECRET_ENCRYPTION_KEY),
      encryptedRefreshToken: await encryptSecretMaterial(input.refreshToken, SECRET_ENCRYPTION_KEY),
      expiresAt: input.expiresAt,
    },
  });
}
