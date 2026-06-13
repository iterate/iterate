import { describe, expect, it } from "vitest";
import { createAuthHandler, type IterateAuthConfig } from "@iterate-com/auth/server";

const config = {
  issuer: "https://auth.iterate-dev.com/api/auth",
  clientId: "os-local-dev",
  clientSecret: "secret",
  redirectURI: "http://os.localhost:65455/api/iterate-auth/callback",
  resource: "http://os.localhost",
} satisfies IterateAuthConfig;

describe("iterate auth login", () => {
  it("canonicalizes loopback aliases before writing the OAuth state cookie", async () => {
    const handler = testAuthHandler(config);

    const response = await handler(
      new Request("http://127.0.0.1:65455/api/iterate-auth/login?return_to=%2Fprojects"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://os.localhost:65455/api/iterate-auth/login?return_to=%2Fprojects",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("writes the OAuth state cookie on the configured callback origin", async () => {
    const handler = testAuthHandler(config);

    const response = await handler(new Request("http://os.localhost:65455/api/iterate-auth/login"));

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("iterate_oauth_state=");

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://auth.iterate-dev.com");
    expect(location.searchParams.get("client_id")).toBe("os-local-dev");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://os.localhost:65455/api/iterate-auth/callback",
    );
    expect(location.searchParams.get("state")).toBeTruthy();
  });
});

function testAuthHandler(authConfig: IterateAuthConfig) {
  const infra = {
    issuerURL: new URL(authConfig.issuer ?? "https://auth.iterate-dev.com/api/auth"),
    jwks: {},
    oauthClient: { client_id: authConfig.clientId },
    clientAuth: {},
    insecure: false,
    secureCookies: false,
    getAuthorizationServer: async () => ({
      issuer: authConfig.issuer,
      authorization_endpoint: "https://auth.iterate-dev.com/api/auth/oauth2/authorize",
    }),
    httpOptions: () => undefined,
    toTokenSet: () => {
      throw new Error("not used by login tests");
    },
    doRefresh: async () => null,
    getUserInfo: async () => null,
    cookieOpts: () => ({ httpOnly: true, path: "/", sameSite: "Lax", secure: false }) as const,
    resource: () => "http://os.localhost",
    audiences: () => ["http://os.localhost"],
  } as unknown as Parameters<typeof createAuthHandler>[1];

  return createAuthHandler(authConfig, infra).handler;
}
