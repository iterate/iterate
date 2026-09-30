// vitest/os-workers/local-sign-in.test.ts — local dev's one click (src/local-sign-in.ts): on a
// laptop's platform, the link `pnpm getin` opens signs the browser in as a test person and sends it
// on to another URL on the laptop. This worker plays the laptop's platform under a second
// configuration, its `urls.os` a loopback origin. That prd, a preview and a self-host have no such
// route is worker.test.ts's.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { appSession } from "iterate/app-server";
import worker from "../../../core/os/src/worker.ts";
import { platformAddressesOf } from "../../../core/os/src/app-config.ts";
import { authorizationForToken } from "../../../core/os/src/oauth.ts";

const LAPTOP = "http://localhost:8788";
// the suite's config (wrangler.test.jsonc: test email domain `signin.test`) on a loopback issuer
const laptopEnv = { ...env, APP_CONFIG_URLS__OS: LAPTOP } as typeof env;

/** What a browser's own navigation carries (the address bar, `open`, a Playwright `goto`). */
const TYPED = { "sec-fetch-site": "none" };

test.for<{ name: string; query: Record<string, string>; headers: HeadersInit; lands: string }>([
  {
    name: "the laptop's Dash, as getin opens it",
    query: { email: "Ada@signin.test", next: "http://localhost:5173/projects/ada" },
    headers: TYPED,
    lands: "http://localhost:5173/projects/ada",
  },
  {
    name: "a project host on the laptop, from a client that is no browser",
    query: { email: "ada@signin.test", next: "http://ada.localhost:8788/" },
    headers: {},
    lands: "http://ada.localhost:8788/",
  },
  {
    name: "no next: the issuer's /login",
    query: { email: "ada@signin.test" },
    headers: TYPED,
    lands: `${LAPTOP}/login`,
  },
  {
    name: "off the laptop: /login",
    query: { email: "ada@signin.test", next: "https://evil.example/" },
    headers: TYPED,
    lands: `${LAPTOP}/login`,
  },
  {
    name: "protocol-relative: /login",
    query: { email: "ada@signin.test", next: "//evil.example/x" },
    headers: TYPED,
    lands: `${LAPTOP}/login`,
  },
  {
    name: "not http: /login",
    query: { email: "ada@signin.test", next: "javascript:alert(1)" },
    headers: TYPED,
    lands: `${LAPTOP}/login`,
  },
  {
    name: "a blob: URL made on the laptop: /login",
    query: { email: "ada@signin.test", next: `blob:${LAPTOP}/0f3c` },
    headers: TYPED,
    lands: `${LAPTOP}/login`,
  },
])("signs the test person in, no password, and lands on $name", async (row) => {
  fetchReachesTheLaptop();
  const landed = await localSignIn(row.query, row.headers);
  expect({
    status: landed.status,
    location: landed.headers.get("location"),
    signedInAs: await signedInAs(landed),
  }).toMatchObject({ status: 302, location: row.lands, signedInAs: "ada@signin.test" });
});

test.for<{ name: string; email: string; headers: HeadersInit; says: RegExp }>([
  {
    name: "a web page's navigation",
    email: "ada@signin.test",
    headers: { "sec-fetch-site": "cross-site" },
    says: /a web page cannot sign you in/,
  },
  {
    name: "another app on the laptop's navigation",
    email: "ada@signin.test",
    headers: { "sec-fetch-site": "same-site" },
    says: /a web page cannot sign you in/,
  },
  {
    name: "a real person's address",
    email: "ada@example.com",
    headers: TYPED,
    says: /under signin\.test/,
  },
  {
    name: "an address with no local part",
    email: "@signin.test",
    headers: TYPED,
    says: /under signin\.test/,
  },
  { name: "no address", email: "", headers: TYPED, says: /under signin\.test/ },
])("refuses $name, and signs nobody in", async ({ email, headers, says }) => {
  const refused = await localSignIn({ email, next: "http://localhost:5173/" }, headers);
  expect({
    status: refused.status,
    body: await refused.text(),
    cookies: refused.headers.getSetCookie(),
  }).toMatchObject({ status: 403, body: expect.stringMatching(says), cookies: [] });
});

/** A GET of the link on the laptop's platform. */
function localSignIn(query: Record<string, string>, headers: HeadersInit) {
  return worker.fetch(
    new Request(`${LAPTOP}/.auth/local-sign-in?${new URLSearchParams(query)}`, {
      redirect: "manual",
      headers,
    }),
    laptopEnv,
    createExecutionContext(),
  );
}

/** `fetch` reaches this worker as the laptop's platform: the issuer exchanges its own code. */
function fetchReachesTheLaptop() {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    worker.fetch(new Request(input, init), laptopEnv, createExecutionContext()),
  );
}

/** Whom the issuer session `response` started is signed in as. */
async function signedInAs(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .find((each) => each.startsWith("__Host-itx-session"));
  expect(cookie, "the issuer session's cookie").toBeDefined();
  const session = appSession(
    laptopEnv.BROWSER_SESSION,
    new Request(LAPTOP, { headers: { cookie: cookie!.split(";")[0]! } }),
  )!;
  const grant = await authorizationForToken(
    laptopEnv,
    (await session.bearer())!,
    platformAddressesOf(laptopEnv, new Request(`${LAPTOP}/`)),
    "browser-session",
  );
  return grant?.principal.email;
}
