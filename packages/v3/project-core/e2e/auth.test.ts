import assert from "node:assert/strict";
import { test } from "node:test";
import { base, timeout } from "./support.ts";

test(
  "email-entry login establishes a demo identity, not verified email ownership",
  { skip: !base, timeout },
  async () => {
    const request = (path: string, init: RequestInit = {}) =>
      fetch(new URL(path, base), {
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
        ...init,
      });
    assert.equal((await request("/api?project=anonymous", { method: "POST" })).status, 401);
    const page = await request("/");
    assert.equal(page.status, 303);
    assert.equal(page.headers.get("location"), "/login");
    const login = await request("/login");
    assert.match(await login.text(), /no email verification/i);
    const body = new URLSearchParams({ email: "ada@example.com" });
    assert.equal(
      (
        await request("/login", {
          method: "POST",
          body,
          headers: { origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    const response = await request("/login", { method: "POST", body, headers: { origin: base! } });
    assert.equal(response.status, 303);
    const cookie = response.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    if (base!.startsWith("https:")) assert.match(cookie, /Secure/);
    const headers = { cookie: cookie.split(";")[0] };
    assert.deepEqual(await (await request("/session", { headers })).json(), {
      email: "ada@example.com",
      verified: false,
    });
    assert.equal(
      (
        await request("/api?project=logged-in", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ method: ["inspect"], args: [] }),
        })
      ).status,
      200,
    );
    assert.equal(
      (await request("/session", { headers: { cookie: headers.cookie + "tampered" } })).status,
      401,
    );
    const challenge = await request("/mcp?project=anonymous", { method: "POST" });
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get("www-authenticate")!, /resource_metadata=/);
  },
);
