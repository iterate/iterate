// Which part of an app's Worker answers a request (appServerEntry): its health check, the PostHog
// proxy, the app's own routes, the sign-in gate, the signed-in landing, the assets and the pages.
// The gate's own behaviour is iterate/app-server's (app-server.test.ts).
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { appServerEntry } from "./server.ts";

// `owns`: the one path the app's own routes answer ("own"), or "*" for every path.
test.for([
  {
    name: "/healthz answers ok before the app's own routes",
    path: "/healthz",
    owns: "*",
    expected: "ok",
  },
  {
    name: "PostHog's files come from PostHog through /e/, before the app's own routes",
    path: "/e/static/array.js",
    owns: "*",
    expected: "fetched https://eu-assets.i.posthog.com/static/array.js",
  },
  {
    name: "the app's own routes answer before the gate",
    path: "/.auth/login",
    owns: "/.auth/login",
    expected: "own",
  },
  {
    name: "a static file is the built asset",
    path: "/client-logo.svg",
    owns: "/.auth/login",
    expected: "asset",
  },
  {
    name: "every other path is a page",
    path: "/projects/p1",
    owns: "/.auth/login",
    expected: "page /projects/p1",
  },
  {
    name: "a signed-out landing is the landing page",
    path: "/",
    owns: "/.auth/login",
    expected: "page /",
  },
])("$name", async ({ path, owns, expected }) => {
  vi.stubGlobal("fetch", async (url: string) => new Response(`fetched ${url}`));
  const response = await testEntry({
    home: "/projects",
    before: async (request) =>
      owns === "*" || new URL(request.url).pathname === owns ? new Response("own") : null,
  }).fetch(new Request(`https://app.example${path}`));
  expect({ status: response.status, body: await response.text() }).toMatchObject({
    status: 200,
    body: expected,
  });
});

test("a signed-in landing goes home, and without a home it is the landing page", async () => {
  const landing = () =>
    new Request("https://app.example/", { headers: { cookie: `__Host-itx-session=${SIGNED_IN}` } });
  const home = await testEntry({ home: "/projects" }).fetch(landing());
  const noHome = await testEntry({}).fetch(landing());
  expect({
    home: { status: home.status, location: home.headers.get("location") },
    noHome: { status: noHome.status, body: await noHome.text() },
  }).toMatchObject({
    home: { status: 302, location: "/projects" },
    noHome: { status: 200, body: "page /" },
  });
});

test.for([
  {
    name: "the client document names the app, with its logo",
    clientName: "iterate Notes",
    expected: { client_name: "iterate Notes", logo_uri: "https://app.example/client-logo.svg" },
  },
  {
    name: "an app with no client name is named by its host",
    clientName: undefined,
    expected: { client_name: "app.example" },
  },
])("$name", async ({ clientName, expected }) => {
  const response = await testEntry({ clientName }).fetch(
    new Request("https://app.example/.auth/client.json"),
  );
  expect(await response.json()).toMatchObject(expected);
});

test("a proxied app has no sign-in gate: /.auth/*, and a signed-in landing, are its pages", async () => {
  const entry = testEntry({ proxied: true });
  const answer = async (path: string) => {
    const response = await entry.fetch(
      new Request(`https://app.example${path}`, {
        headers: { cookie: `__Host-itx-session=${SIGNED_IN}` },
      }),
    );
    return { status: response.status, body: await response.text() };
  };
  expect({
    client: await answer("/.auth/client.json"),
    login: await answer("/.auth/login"),
    landing: await answer("/"),
  }).toEqual({
    client: { status: 200, body: "page /.auth/client.json" },
    login: { status: 200, body: "page /.auth/login" },
    landing: { status: 200, body: "page /" },
  });
});

const SIGNED_IN = "00000000-0000-4000-8000-000000000001";

/** The entry over the shim's `env` (vitest.config.ts): the platform at os.example, one built file,
 *  and one browser session, signed in, whose cookie is `SIGNED_IN`. */
function testEntry(app: Parameters<typeof appServerEntry>[1]) {
  Object.assign(env, {
    APP_CONFIG: JSON.stringify({ urls: { os: "https://os.example" }, denyZones: ["example"] }),
    ASSETS: {
      fetch: async (request: Request) =>
        new URL(request.url).pathname === "/client-logo.svg"
          ? new Response("asset")
          : new Response(null, { status: 404 }),
    },
    BROWSER_SESSION: {
      getByName: (name: string) => ({
        bearer: async () => (name.endsWith(`:${SIGNED_IN}`) ? "bearer" : null),
      }),
    },
  });
  return appServerEntry(
    { fetch: async (request) => new Response(`page ${new URL(request.url).pathname}`) },
    app,
  );
}
