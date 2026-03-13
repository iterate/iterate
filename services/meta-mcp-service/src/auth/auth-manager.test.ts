import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { AuthManager } from "./auth-manager.ts";

const { authMock } = vi.hoisted(() => ({
  authMock:
    vi.fn<(provider: OAuthClientProvider, options: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/sdk/client/auth.js")>();
  return {
    ...actual,
    auth: authMock,
  };
});

function createServerFile(url: string) {
  return {
    servers: [
      {
        id: "github",
        url,
        enabled: true,
        auth: { type: "oauth" as const, scope: "read:org" },
      },
    ],
  };
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("AuthManager OAuth lifecycle", () => {
  let tempRoot: string;
  let serversPath: string;
  let authPath: string;
  let previousEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "meta-mcp-auth-manager-"));
    serversPath = join(tempRoot, "servers.json");
    authPath = join(tempRoot, "auth.json");
    previousEnv = { ...process.env };

    await writeFile(
      serversPath,
      `${JSON.stringify(createServerFile("https://github.example.com/mcp"), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      authPath,
      `${JSON.stringify(
        { version: "1.0.0", oauth: {}, clientInformation: {}, tokens: {} },
        null,
        2,
      )}\n`,
      "utf8",
    );

    process.env.META_MCP_SERVICE_SERVERS_PATH = serversPath;
    process.env.META_MCP_SERVICE_AUTH_PATH = authPath;
    process.env.META_MCP_SERVICE_PUBLIC_URL = "http://127.0.0.1:19070";
    authMock.mockReset();
  });

  afterEach(async () => {
    process.env = previousEnv;
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("creates and persists a new OAuth authorization state", async () => {
    authMock.mockImplementation(async (provider) => {
      await provider.saveClientInformation!({ client_id: "client-123" });
      await provider.saveCodeVerifier!("code-verifier");
      await provider.saveDiscoveryState!({
        authorizationServerUrl: "https://provider.example.com",
      });
      const state = await provider.state?.();
      const authorizationUrl = new URL("https://provider.example.com/oauth/authorize");
      if (state) {
        authorizationUrl.searchParams.set("state", state);
      }
      provider.redirectToAuthorization(authorizationUrl);
      return "REDIRECTED";
    });

    const authManager = new AuthManager();
    const state = await authManager.startOAuthAuthorization("github");
    const authFile = await readJson(authPath);

    expect(state.serverId).toBe("github");
    expect(state.authenticationUrl).toBe(
      `https://provider.example.com/oauth/authorize?state=${state.stateIdentifier}`,
    );
    expect(authFile).toMatchObject({
      oauth: {
        github: {
          authorization: {
            localAuthState: state.stateIdentifier,
            providerAuthUrl: `https://provider.example.com/oauth/authorize?state=${state.stateIdentifier}`,
          },
          codeVerifier: "code-verifier",
          discoveryState: {
            authorizationServerUrl: "https://provider.example.com",
          },
        },
      },
      clientInformation: {
        github: {
          client_id: "client-123",
        },
      },
    });
  });

  test("reuses an active saved OAuth state without calling auth again", async () => {
    const existingState = {
      version: "1.0.0",
      oauth: {
        github: {
          authorization: {
            authUrl: "http://127.0.0.1:19070/auth/start/existing-state",
            providerAuthUrl: "https://provider.example.com/oauth/authorize",
            callbackUrl: "http://127.0.0.1:19070/auth/finish",
            redirectUrl: "http://127.0.0.1:19070/auth/finish",
            localAuthState: "existing-state",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      },
      clientInformation: {},
      tokens: {},
    };
    await writeFile(authPath, `${JSON.stringify(existingState, null, 2)}\n`, "utf8");

    const authManager = new AuthManager();
    const state = await authManager.startOAuthAuthorization("github");

    expect(authMock).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      stateIdentifier: "existing-state",
      serverId: "github",
      authenticationUrl: "https://provider.example.com/oauth/authorize",
    });
  });

  test("replaces an expired OAuth state with a new one", async () => {
    await writeFile(
      authPath,
      `${JSON.stringify(
        {
          version: "1.0.0",
          oauth: {
            github: {
              authorization: {
                authUrl: "http://127.0.0.1:19070/auth/start/expired-state",
                providerAuthUrl: "https://provider.example.com/oauth/expired",
                callbackUrl: "http://127.0.0.1:19070/auth/finish",
                redirectUrl: "http://127.0.0.1:19070/auth/finish",
                localAuthState: "expired-state",
                expiresAt: new Date(Date.now() - 60_000).toISOString(),
              },
            },
          },
          clientInformation: {},
          tokens: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    authMock.mockImplementation(async (provider) => {
      provider.redirectToAuthorization(new URL("https://provider.example.com/oauth/fresh"));
      return "REDIRECTED";
    });

    const authManager = new AuthManager();
    const state = await authManager.startOAuthAuthorization("github");

    expect(authMock).toHaveBeenCalledOnce();
    expect(state.stateIdentifier).not.toBe("expired-state");
    expect(state.authenticationUrl).toBe("https://provider.example.com/oauth/fresh");
  });

  test("clears expired state when looked up directly", async () => {
    await writeFile(
      authPath,
      `${JSON.stringify(
        {
          version: "1.0.0",
          oauth: {
            github: {
              authorization: {
                authUrl: "http://127.0.0.1:19070/auth/start/expired-state",
                providerAuthUrl: "https://provider.example.com/oauth/expired",
                callbackUrl: "http://127.0.0.1:19070/auth/finish",
                redirectUrl: "http://127.0.0.1:19070/auth/finish",
                localAuthState: "expired-state",
                expiresAt: new Date(Date.now() - 60_000).toISOString(),
              },
            },
          },
          clientInformation: {},
          tokens: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const authManager = new AuthManager();
    const state = await authManager.getOAuthSate("expired-state");
    const authFile = await readJson(authPath);

    expect(state).toBeNull();
    expect(authFile).toMatchObject({
      oauth: {
        github: {},
      },
    });
  });

  test("persists tokens and clears transient oauth state after successful finish", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(
      authPath,
      `${JSON.stringify(
        {
          version: "1.0.0",
          oauth: {
            github: {
              authorization: {
                authUrl: "http://127.0.0.1:19070/auth/start/test-state",
                providerAuthUrl: "https://provider.example.com/oauth/authorize",
                callbackUrl: "http://127.0.0.1:19070/auth/finish",
                redirectUrl: "http://127.0.0.1:19070/auth/finish",
                localAuthState: "test-state",
                expiresAt,
              },
              codeVerifier: "code-verifier",
            },
          },
          clientInformation: {
            github: {
              client_id: "client-123",
            },
          },
          tokens: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    authMock.mockImplementation(async (provider, options) => {
      expect(options.authorizationCode).toBe("code-123");
      await provider.saveTokens({
        access_token: "access-123",
        refresh_token: "refresh-123",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read:org",
      });
      return "AUTHORIZED";
    });

    const authManager = new AuthManager();
    const result = await authManager.finishOAuthAuthorization("test-state", "code-123");
    const authFile = await readJson(authPath);

    expect(result).toEqual({
      success: true,
      message:
        "github is now authorized for Meta MCP. You can close this tab and return to the daemon.",
    });
    expect(authFile).toMatchObject({
      oauth: {
        github: {},
      },
      clientInformation: {
        github: {
          client_id: "client-123",
        },
      },
      tokens: {
        github: {
          accessToken: "access-123",
          refreshToken: "refresh-123",
          tokenType: "Bearer",
          scopes: ["read:org"],
        },
      },
    });
  });

  test("returns a failure result when finish is called with an unknown state", async () => {
    const authManager = new AuthManager();

    await expect(
      authManager.finishOAuthAuthorization("missing-state", "code-123"),
    ).resolves.toEqual({
      success: false,
      message: "No saved state found for the given state identifier",
    });
  });
});
