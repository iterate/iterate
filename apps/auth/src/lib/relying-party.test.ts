import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { sessionCookie, signedTokenSet } from "./relying-party-test-support.ts";
import { createIterateAuth, withAuthenticationResponseHeaders } from "./server.ts";

const auth = createIterateAuth({
  clientId: "relying-party-test",
  clientSecret: "secret",
  issuer: "https://auth.example.test/api/auth",
  jwks: { keys: [] },
  redirectURI: "https://app.example.test/api/iterate-auth/callback",
});

describe("relying-party auth fetch composition", () => {
  it("returns null without consuming requests outside its route", async () => {
    const request = new Request("https://app.example.test/api/books", {
      body: JSON.stringify({ title: "The Dispossessed" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    assert.equal(await auth.fetch(request), null);
    assert.equal(request.bodyUsed, false);
    assert.equal(await request.text(), JSON.stringify({ title: "The Dispossessed" }));
  });

  it("returns a response for a route it owns", async () => {
    const response = await auth.fetch(
      new Request("https://app.example.test/api/iterate-auth/logout?global=false"),
    );

    assert.ok(response);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://app.example.test/");
  });
});

describe("relying-party credential resolution", () => {
  it("accepts a bearer without treating the absent session cookie as an error", async () => {
    const issuer = "https://auth.example.test/api/auth";
    const resource = "https://app.example.test";
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "relying-party-test-key";
    const token = await new SignJWT({ scope: "openid profile" })
      .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
      .setIssuer(issuer)
      .setAudience(resource)
      .setSubject("usr_bearer")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const bearerAuth = createIterateAuth({
      clientId: "relying-party-test",
      clientSecret: "secret",
      issuer,
      jwks: { keys: [publicJwk] },
      redirectURI: `${resource}/api/iterate-auth/callback`,
      resource,
    });
    const errors: unknown[] = [];

    const authentication = await bearerAuth.authenticate({
      headers: new Headers({ authorization: `Bearer ${token}` }),
      onError: (error) => errors.push(error),
    });

    assert.equal(authentication.credential, "bearer");
    if (authentication.credential !== "bearer") return;
    assert.equal(authentication.accessToken.sub, "usr_bearer");
    assert.deepEqual(authentication.identity, {
      userId: "usr_bearer",
      sessionId: undefined,
      email: undefined,
      isAdmin: false,
      organizations: [],
      projects: [],
    });
    assert.deepEqual(errors, []);
  });

  it("sends an access token to userinfo only when userinfo is its audience", async (t) => {
    const issuer = "https://auth.example.test/api/auth";
    const resource = "https://app.example.test";
    const userInfoEndpoint = `${issuer}/oauth2/userinfo`;
    const baseConfig = {
      clientId: "relying-party-session-test",
      clientSecret: "secret",
      issuer,
      jwks: { keys: [] },
      redirectURI: `${resource}/api/iterate-auth/callback`,
    };
    const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
    const fetchedUrls: string[] = [];

    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString();
      fetchedUrls.push(url);
      if (url === discoveryUrl) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          jwks_uri: `${issuer}/jwks`,
          userinfo_endpoint: userInfoEndpoint,
        });
      }
      assert.equal(url, userInfoEndpoint);
      return Response.json({
        sub: "usr_session",
        "https://iterate.com/claims/active_organization_id": "org_iterate",
        "https://iterate.com/claims/organizations": [
          { id: "org_iterate", name: "Iterate", role: "owner", slug: "iterate" },
        ],
      });
    });

    async function fetchSession(audience: string | string[]) {
      const config = { ...baseConfig, resource: audience };
      const signed = await signedTokenSet(config);
      const publicJwk = await exportJWK(signed.jwks as CryptoKey);
      const sessionAuth = createIterateAuth({
        ...config,
        jwks: { keys: [publicJwk] },
      });
      return sessionAuth.fetch(
        new Request(`${resource}/api/iterate-auth/session`, {
          headers: { cookie: sessionCookie(signed.tokenSet) },
        }),
      );
    }

    const response = await fetchSession(resource);

    assert.ok(response);
    assert.equal(response.status, 200);
    assert.partialDeepStrictEqual(await response.json(), {
      authenticated: true,
      user: { id: "usr_session" },
    });
    assert.deepEqual(fetchedUrls, [discoveryUrl]);

    fetchedUrls.length = 0;
    const responseWithUserInfo = await fetchSession([resource, userInfoEndpoint]);

    assert.ok(responseWithUserInfo);
    assert.equal(responseWithUserInfo.status, 200);
    assert.partialDeepStrictEqual(await responseWithUserInfo.json(), {
      authenticated: true,
      session: {
        activeOrganizationId: "org_iterate",
        organizations: [{ id: "org_iterate", name: "Iterate", role: "owner", slug: "iterate" }],
      },
    });
    assert.deepEqual(fetchedUrls, [discoveryUrl, userInfoEndpoint]);
  });
});

describe("authentication response headers", () => {
  it("preserves every rotated cookie and the downstream error response", async () => {
    const authenticationHeaders = new Headers({ "x-auth-version": "2" });
    authenticationHeaders.append("set-cookie", "session=new; Path=/; HttpOnly");
    authenticationHeaders.append("set-cookie", "csrf=new; Path=/; SameSite=Lax");
    const downstream = new Response("unauthorized", {
      headers: {
        "set-cookie": "downstream=kept; Path=/",
        "x-downstream": "yes",
      },
      status: 401,
      statusText: "Unauthorized",
    });

    const response = withAuthenticationResponseHeaders(downstream, authenticationHeaders);

    assert.notEqual(response, downstream);
    assert.equal(response.status, 401);
    assert.equal(response.statusText, "Unauthorized");
    assert.equal(response.headers.get("x-auth-version"), "2");
    assert.equal(response.headers.get("x-downstream"), "yes");
    assert.deepEqual(response.headers.getSetCookie(), [
      "downstream=kept; Path=/",
      "session=new; Path=/; HttpOnly",
      "csrf=new; Path=/; SameSite=Lax",
    ]);
    assert.equal(await response.text(), "unauthorized");
  });

  it("returns the original response when authentication emitted no headers", () => {
    const response = new Response("unchanged");
    assert.equal(withAuthenticationResponseHeaders(response, new Headers()), response);
  });
});
