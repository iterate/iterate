import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createIterateAuth, withAuthenticationResponseHeaders } from "./server.ts";

const auth = createIterateAuth({
  clientId: "relying-party-test",
  clientSecret: "secret",
  issuer: "https://auth.example.test/api/auth",
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
