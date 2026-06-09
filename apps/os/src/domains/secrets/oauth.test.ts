import type { Client, QueryArg, SqlQuery } from "sqlfu";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseConfig } from "~/config.ts";
import { getFreshGoogleAccessToken } from "~/domains/secrets/oauth.ts";

type SecretRow = {
  id: string;
  project_id: string;
  key: string;
  material: string;
  metadata: string;
  created_at: string;
  updated_at: string;
};

describe("getFreshGoogleAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("returns the stored access token when it is not near expiry", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const secret = googleSecretRow({
      material: "stored-access-token",
      metadata: {
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        refreshToken: "refresh-token",
      },
    });

    await expect(
      getFreshGoogleAccessToken({
        config: testConfig(),
        db: testDb({ secret }),
        projectId: "proj_test",
      }),
    ).resolves.toBe("stored-access-token");
    expect(fetchMock).not.toHaveBeenCalled();
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

    const updates: Array<{ args: QueryArg[] }> = [];
    const secret = googleSecretRow({
      material: "expired-access-token",
      metadata: {
        email: "user@example.com",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        refreshToken: "refresh-token",
      },
    });

    await expect(
      getFreshGoogleAccessToken({
        config: testConfig(),
        db: testDb({ secret, updates }),
        projectId: "proj_test",
      }),
    ).resolves.toBe("refreshed-access-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST",
        body: expect.any(URLSearchParams),
      }),
    );
    const refreshRequest = fetchMock.mock.calls[0]?.[1] as { body: URLSearchParams } | undefined;
    expect(refreshRequest?.body.get("grant_type")).toBe("refresh_token");
    expect(refreshRequest?.body.get("refresh_token")).toBe("refresh-token");

    expect(updates).toHaveLength(1);
    const [, , , material, rawMetadata] = updates[0]!.args;
    expect(material).toBe("refreshed-access-token");
    expect(JSON.parse(String(rawMetadata))).toMatchObject({
      email: "user@example.com",
      refreshToken: "refresh-token",
      scopes: [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
      ],
    });
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

function googleSecretRow(input: {
  material: string;
  metadata: Record<string, unknown>;
}): SecretRow {
  return {
    id: "sec_test",
    project_id: "proj_test",
    key: "google.access_token",
    material: input.material,
    metadata: JSON.stringify(input.metadata),
    created_at: "2026-05-13 12:00:00",
    updated_at: "2026-05-13 12:00:00",
  };
}

function testDb(input: { secret: SecretRow; updates?: Array<{ args: QueryArg[] }> }): Client {
  const db = {
    all: async <TRow extends object>(query: SqlQuery) => {
      if (query.name === "getProjectSecret") return [input.secret] as TRow[];
      if (query.name === "upsertProjectSecret") {
        input.updates?.push({ args: query.args });
        return [
          {
            ...input.secret,
            key: String(query.args[2]),
            material: String(query.args[3]),
            metadata: String(query.args[4]),
            updated_at: "2026-05-13 12:01:00",
          },
        ] as TRow[];
      }
      throw new Error(`Unexpected query: ${query.name ?? query.sql}`);
    },
    run: async () => ({ rowsAffected: 1 }),
  };
  return db as unknown as Client;
}
