/**
 * Unit tests for the Tesco-shaped two-step login (tesco-login.ts), run in plain
 * Node through the whole HTTP surface like worker.test.ts: the real route
 * handler and the real state store over in-memory storage.
 */
import { expect, onTestFinished, test, vi } from "vitest";
import {
  TESCO_ACCESS_TTL_SECONDS,
  TESCO_LOGIN_PASSWORD,
  tescoLoginClientId,
} from "./tesco-login.ts";
import { makeShop, type Shop } from "./test/shop.ts";

test("GET hands out a CSRF token and the cookie that binds it; POST with both logs in", async () => {
  const shop = makeShop();
  const form = await shop.call("/api/tesco/login");
  expect(form).toMatchObject({ status: 200 });
  expect(form.headers.get("set-cookie")).toMatch(/^tesco_login=[^;]+; Path=\/api\/tesco; HttpOnly/);
  expect(await form.json()).toMatchObject({ csrf: expect.any(String) });

  const token = await login(shop, "shopper@example.com");
  expect(token).toMatchObject({
    status: 200,
    body: { access_token: expect.any(String), expires_in: TESCO_ACCESS_TTL_SECONDS },
  });
});

test.for([
  { row: "no cookie", cookie: false, csrf: "form", password: TESCO_LOGIN_PASSWORD, status: 403 },
  {
    row: "a CSRF token the cookie does not bind",
    cookie: true,
    csrf: "other",
    password: TESCO_LOGIN_PASSWORD,
    status: 403,
  },
  { row: "a wrong password", cookie: true, csrf: "form", password: "wrong-horse", status: 401 },
] as const)("POST is refused with $row: $status", async ({ cookie, csrf, password, status }) => {
  const shop = makeShop();
  const step = await loginForm(shop);
  const response = await shop.call("/api/tesco/login", {
    method: "POST",
    headers: cookie ? { cookie: step.cookie } : {},
    body: new URLSearchParams({
      email: "shopper@example.com",
      password,
      _csrf: csrf === "form" ? step.csrf : crypto.randomUUID(),
    }),
  });
  expect(response).toMatchObject({ status });
});

test("the access token is an ordinary bearer on the pets API", async () => {
  const shop = makeShop();
  const { body } = await login(shop, "shopper@example.com");

  const me = await api(shop, "/api/me", body.access_token);
  expect(me).toMatchObject({ status: 200 });
  expect(await me.json()).toMatchObject({
    sub: "shopper@example.com",
    clientId: tescoLoginClientId("shopper@example.com"),
  });
  const pets = await api(shop, "/api/pets", body.access_token);
  expect(await pets.json()).toMatchObject({ owner: "shopper@example.com" });
});

test("tokens die at 900 s and on the account's epoch bump, and no one else's do", async () => {
  const shop = makeShop();
  vi.useFakeTimers({ now: Date.now() });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const mine = (await login(shop, "mine@example.com")).body.access_token;
  const theirs = (await login(shop, "theirs@example.com")).body.access_token;

  await shop.call("/__backdoor/expire-tokens", {
    method: "POST",
    body: JSON.stringify({ clientId: tescoLoginClientId("mine@example.com") }),
  });
  expect(await api(shop, "/api/me", mine)).toMatchObject({ status: 401 });
  expect(await api(shop, "/api/me", theirs)).toMatchObject({ status: 200 });
  const again = (await login(shop, "mine@example.com")).body.access_token;
  expect(await api(shop, "/api/me", again)).toMatchObject({ status: 200 });

  vi.advanceTimersByTime((TESCO_ACCESS_TTL_SECONDS + 1) * 1000);
  expect(await api(shop, "/api/me", again)).toMatchObject({ status: 401 });
});

/** Step one: the CSRF token and the cookie, as a browser would send it back. */
async function loginForm(shop: Shop) {
  const response = await shop.call("/api/tesco/login");
  const { csrf } = (await response.json()) as { csrf: string };
  return { csrf, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
}

/** Both steps with the fixture password. */
async function login(shop: Shop, email: string) {
  const { csrf, cookie } = await loginForm(shop);
  const response = await shop.call("/api/tesco/login", {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams({ email, password: TESCO_LOGIN_PASSWORD, _csrf: csrf }),
  });
  return {
    status: response.status,
    body: (await response.json()) as { access_token: string; expires_in: number },
  };
}

function api(shop: Shop, path: string, token: string): Promise<Response> {
  return shop.call(path, { headers: { authorization: `Bearer ${token}` } });
}
