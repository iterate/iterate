import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { expect, test } from "vitest";
import { Config } from "./config.ts";
import { oauthLogin, oauthResourceForOsBaseUrl, refreshOAuthSession } from "./oauth.ts";

test("OAuth uses the platform's API audience including the local port", () => {
  expect(Config.parse({})).toMatchObject({ osBaseUrl: "https://os.iterate.com" });
  expect(oauthResourceForOsBaseUrl("http://localhost:54896/")).toBe("http://localhost:54896/api");
  expect(oauthResourceForOsBaseUrl("https://os.iterate.com")).toBe("https://os.iterate.com/api");
});

test("login registers a native client, sends PKCE and the API audience, and redeems the redirect", async () => {
  await using issuer = await startIssuer();
  const session = await oauthLogin({ issuer: issuer.url, openBrowser: consent });
  expect(session).toMatchObject({
    token: "access-1",
    refreshToken: "refresh-1",
    clientId: "cli-client",
    scope: "iterate",
  });
  expect(Date.parse(session.expiresAt!)).toBeGreaterThan(Date.now() + 3_500_000);
  const redirectUri = expect.stringMatching(/^http:\/\/localhost:\d+\/callback$/);
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact requests: a field beyond RFC 7591 and RFC 6749 must fail
  expect(issuer.seen).toEqual({
    registration: {
      client_name: "iterate CLI",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    authorize: {
      response_type: "code",
      client_id: "cli-client",
      redirect_uri: redirectUri,
      scope: "iterate",
      state: expect.any(String),
      code_challenge: expect.any(String),
      code_challenge_method: "S256",
      resource: `${issuer.url}/api`,
    },
    token: [
      {
        grant_type: "authorization_code",
        client_id: "cli-client",
        code: "the-code",
        redirect_uri: redirectUri,
        code_verifier: expect.any(String),
        resource: `${issuer.url}/api`,
      },
    ],
  });
});

test.for<{ name: string; redirect: Record<string, string>; message: string }>([
  {
    name: "a declined consent",
    redirect: { error: "access_denied" },
    message: "Sign-in was not authorized: access_denied.",
  },
  {
    name: "a redirect from another issuer",
    redirect: { iss: "https://issuer.example" },
    message: '"iss"',
  },
  {
    name: "a redirect for another login",
    redirect: { state: "another-login" },
    message: '"state"',
  },
])("login refuses $name and redeems nothing", async ({ redirect, message }) => {
  await using issuer = await startIssuer(redirect);
  await expect(oauthLogin({ issuer: issuer.url, openBrowser: consent })).rejects.toThrow(message);
  expect(issuer.seen).toMatchObject({ token: [] });
});

test("refresh keeps an unrotated refresh token and the granted scope", async () => {
  await using issuer = await startIssuer();
  const session = await refreshOAuthSession({
    issuer: issuer.url,
    session: {
      token: "access-1",
      refreshToken: "refresh-1",
      clientId: "cli-client",
      scope: "iterate",
    },
  });
  expect(session).toMatchObject({
    token: "access-2",
    refreshToken: "refresh-1",
    clientId: "cli-client",
    scope: "iterate",
  });
  // oxlint-disable-next-line iterate/prefer-object-property-match -- exact request: only the refresh grant goes out
  expect(issuer.seen).toEqual({
    token: [
      {
        grant_type: "refresh_token",
        client_id: "cli-client",
        refresh_token: "refresh-1",
        resource: `${issuer.url}/api`,
      },
    ],
  });
});

test("refresh with a dead or missing refresh token asks for a new login", async () => {
  await using issuer = await startIssuer();
  await expect(
    refreshOAuthSession({
      issuer: issuer.url,
      session: { token: "access-1", refreshToken: "revoked", clientId: "cli-client" },
    }),
  ).rejects.toThrow(
    "OAuth refresh failed (400 invalid_grant: Invalid refresh token). Run `iterate login` again.",
  );
  await expect(
    refreshOAuthSession({ issuer: issuer.url, session: { token: "access-1" } }),
  ).rejects.toThrow(`Session expired for ${issuer.url}. Run \`iterate login\` again.`);
});

/** The person's browser: open the authorization URL and follow the issuer's redirect back. */
async function consent(url: URL) {
  const response = await fetch(url);
  await response.body?.cancel();
}

/** A local issuer with the platform's endpoints. Its consent answers at once, with `redirect`
 *  overriding the parameters it sends back; its token endpoint checks the PKCE verifier. */
async function startIssuer(redirect: Record<string, string> = {}) {
  const seen: {
    registration?: { redirect_uris: string[] };
    authorize?: Record<string, string>;
    token: Record<string, string>[];
  } = { token: [] };
  let url = "";
  const server = createServer(async (request, response) => {
    const path = new URL(request.url || "/", url);
    const body = await readBody(request);
    const json = (status: number, value: unknown) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (path.pathname === "/oauth2/register") {
      seen.registration = JSON.parse(body);
      json(201, { client_id: "cli-client", redirect_uris: seen.registration?.redirect_uris });
    } else if (path.pathname === "/oauth2/auth") {
      seen.authorize = Object.fromEntries(path.searchParams);
      const back = new URL(path.searchParams.get("redirect_uri")!);
      back.search = new URLSearchParams({
        code: "the-code",
        state: path.searchParams.get("state")!,
        iss: url,
        ...redirect,
      }).toString();
      if (redirect.error) back.searchParams.delete("code");
      response.writeHead(302, { location: back.href }).end();
    } else if (path.pathname === "/oauth2/token") {
      const form = new URLSearchParams(body);
      seen.token.push(Object.fromEntries(form));
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") || "")
        .digest("base64url");
      if (
        form.get("grant_type") === "authorization_code" &&
        form.get("code") === "the-code" &&
        challenge === seen.authorize?.code_challenge
      )
        json(200, {
          access_token: "access-1",
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: "refresh-1",
          scope: "iterate",
        });
      else if (
        form.get("grant_type") === "refresh_token" &&
        form.get("refresh_token") === "refresh-1"
      )
        json(200, { access_token: "access-2", token_type: "bearer", expires_in: 3600 });
      else json(400, { error: "invalid_grant", error_description: "Invalid refresh token" });
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    seen,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
