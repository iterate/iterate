// app-server.test.ts — the browser-auth gate's `/.auth/login` with a session the platform still
// honours: through to `next` when the sign-in covers what the page asked for, else the "Sign in
// again" page (a project the page named, or a permission the app asks for), which names who the app
// is signed in as and the permissions the grant holds, and whose one button is a same-origin POST
// that ends this app's session and returns to the very same login URL. The page's "signed in as /
// reaches" read of the platform is best effort: here `resource` is an offline loopback, so those two
// lines are absent and the network-free permissions line (from the held scopes) is what we assert.
import { expect, test } from "vitest";
import { appAuth } from "./app-server.ts";
import type { BrowserSession } from "./app-session.ts";

const ISSUER = "https://os.example";
const CONNECTED = "https://iterate.someorg.example";

// ── /.auth/login with a session the platform honours ──
test("covers what the page asked for → straight to next", async () => {
  const response = await login("/.auth/login?next=%2Fprojects%2Facme&scope=iterate", ["iterate"]);
  expect(response?.status).toBe(303);
  expect(response?.headers.get("location")).toBe("/projects/acme");
});

test.each([
  {
    lacks: "a project the page named",
    path: "/.auth/login?next=%2Fprojects%2Facme&scope=iterate&project=acme",
    says: "does not include a project called <code>acme</code>",
  },
  {
    lacks: "a permission the app asks for",
    path: "/.auth/login?next=%2F&scope=iterate%20account",
    says: "does not include a permission this app asks for",
  },
])("$lacks → the Sign in again page", async ({ path, says }) => {
  const response = await login(path, ["iterate"]);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  const html = await response!.text();
  expect(html).toContain("<h1>Sign in again</h1>");
  expect(html).toContain(`Your sign-in to <strong>notes.example</strong> ${says}.`);
  expect(html).toContain(`href="${ISSUER}/issuer.css"`);
  // the grant it holds, in the person's words — network-free, from the held scopes
  expect(html).toContain("Permissions: your projects.");
  // the button ends this app's session and comes back to this same login URL
  expect(html).toContain(`action="/.auth/logout?next=${encodeURIComponent(path)}"`);
  // Chromium checks form-action along the submission's whole redirect chain, which ends at the issuer
  expect(response?.headers.get("content-security-policy")).toContain(
    `form-action 'self' ${ISSUER};`,
  );
});

test("the permissions line names every held scope", async () => {
  const response = await login("/.auth/login?next=%2F&project=acme", [
    "iterate",
    "account",
    "organizations:write",
  ]);
  const html = await response!.text();
  expect(html).toContain("Permissions: your projects, your account, your organizations.");
});

test("the project the page named is text, never markup", async () => {
  const response = await login(`/.auth/login?next=%2F&project=${encodeURIComponent("<b>x</b>")}`, [
    "iterate",
  ]);
  const html = await response!.text();
  expect(html).not.toContain("<b>x</b>");
  expect(html).toContain("&#60;b&#62;x&#60;/b&#62;");
});

// ── a browser CONNECTED to another issuer stays there ──
test("an expired grant signs in again AT THE CONNECTED ISSUER, not the deployment's own", async () => {
  const { response, calls } = connected("/.auth/login?next=%2Fprojects%2Facme&scope=iterate");
  const answer = await response;
  expect(answer?.status).toBe(302);
  expect(answer?.headers.get("location")).toBe(`${CONNECTED}/oauth2/auth?state=x`);
  expect(calls).toEqual(["discard", `begin ${CONNECTED}`]);
});

test("a sign-out from a connected issuer returns through that issuer's connect page, the scopes the login asked for kept", async () => {
  // the Sign-in-again form's `next` is the login URL that showed it, scopes and all
  const loginUrl =
    "/.auth/login?next=%2Fprojects%2Facme&scope=iterate+account+organizations%3Awrite";
  const { response, calls } = connected(`/.auth/logout?next=${encodeURIComponent(loginUrl)}`, {
    method: "POST",
    headers: { origin: "https://notes.example" },
  });
  const answer = await response;
  expect(answer?.status).toBe(303);
  expect(answer?.headers.get("location")).toBe(
    `/.auth/connect?${new URLSearchParams({
      issuer: CONNECTED,
      next: loginUrl,
      scope: "iterate account organizations:write",
    })}`,
  );
  expect(calls).toEqual(["end"]);
});

test("the connect page lets its form redirect on to the issuer it names", async () => {
  // Chromium checks form-action along the submission's whole redirect chain: Continue POSTs here,
  // then 302s to that issuer's authorize endpoint
  const { response } = connected(`/.auth/connect?${new URLSearchParams({ issuer: CONNECTED })}`);
  const answer = await response;
  expect(answer?.status).toBe(200);
  expect(answer?.headers.get("content-security-policy")).toContain(
    `form-action 'self' ${CONNECTED};`,
  );
});

test("a sign-out from a connected issuer bound for an ordinary page carries no scope", async () => {
  const { response } = connected("/.auth/logout?next=%2Fprojects%2Facme", {
    method: "POST",
    headers: { origin: "https://notes.example" },
  });
  expect((await response)?.headers.get("location")).toBe(
    `/.auth/connect?${new URLSearchParams({ issuer: CONNECTED, next: "/projects/acme", scope: "" })}`,
  );
});

test("a login that names no scope asks for the app's own, so Switch account and Stop impersonating sign an app back in with what it needs", async () => {
  const begun: string[][] = [];
  const sessions = {
    getByName: () => ({
      begin: async (host: { issuer: string; scopes: string[] }) => {
        begun.push(host.scopes);
        return `${host.issuer}/oauth2/auth?state=x`;
      },
    }),
  } as unknown as DurableObjectNamespace<BrowserSession>;
  const config = {
    sessions,
    issuer: ISSUER,
    resource: `${ISSUER}/api`,
    scopes: ["admin"],
    api: () => new Response(""),
  };
  // the shell's POST: the logout hands the login on as it is, no scope copied from the ended grant
  const logout = await appAuth(
    new Request("https://admin.example/.auth/logout?next=%2F.auth%2Flogin%3Fnext%3D%2F", {
      method: "POST",
      headers: { origin: "https://admin.example" },
    }),
    config,
  );
  expect(logout?.headers.get("location")).toBe("/.auth/login?next=/");
  const login = await appAuth(new Request("https://admin.example/.auth/login?next=/"), config);
  expect(login?.status).toBe(302);
  expect(begun).toEqual([["iterate", "admin"]]);
});

test("client metadata publishes app branding relative to its own origin, independently of the issuer", async () => {
  const response = await appAuth(new Request("https://notes.example/.auth/client.json"), {
    sessions: {} as DurableObjectNamespace<BrowserSession>,
    issuer: ISSUER,
    resource: `${ISSUER}/api`,
    api: () => new Response(),
    client: { name: "Iterate Notes", logoUri: "/client-logo.svg" },
  });
  expect(await response!.json()).toMatchObject({
    client_id: "https://notes.example/.auth/client.json",
    client_name: "Iterate Notes",
    client_uri: "https://notes.example",
    logo_uri: "https://notes.example/client-logo.svg",
    token_endpoint_auth_method: "none",
  });
});

/** One app session the platform honours, holding `scopes`; the platform read is pointed at a closed
 *  port so it fails at once and the page degrades. */
function login(path: string, scopes: string[]) {
  const sessions = {
    getByName: () => ({
      bearer: async () => "token",
      scopes: async () => scopes,
      host: async () => ({ issuer: ISSUER, resource: "http://127.0.0.1:1/api" }),
    }),
  } as unknown as DurableObjectNamespace<BrowserSession>;
  return appAuth(
    new Request(`https://notes.example${path}`, {
      headers: { cookie: "__Host-itx-session=0c9a1c4e-7d2b-4d7e-9a4a-1f3c5e7b9d21" },
    }),
    { sessions, issuer: ISSUER, resource: "http://127.0.0.1:1/api", api: () => new Response("") },
  );
}

/** A session bound to `CONNECTED` whose grant the platform no longer honours (the probe is 401):
 *  what `/.auth/login` starts next, and where `/.auth/logout` sends the person. */
function connected(path: string, init?: RequestInit) {
  const calls: string[] = [];
  const sessions = {
    getByName: () => ({
      bearer: async () => "stale",
      scopes: async () => ["iterate"],
      host: async () => ({ issuer: CONNECTED, resource: `${CONNECTED}/api` }),
      discard: async () => calls.push("discard"),
      end: async () => calls.push("end"),
      begin: async (host: { issuer: string }) => {
        calls.push(`begin ${host.issuer}`);
        return `${host.issuer}/oauth2/auth?state=x`;
      },
    }),
  } as unknown as DurableObjectNamespace<BrowserSession>;
  const response = appAuth(
    new Request(`https://notes.example${path}`, {
      ...init,
      headers: {
        cookie: "__Host-itx-session=0c9a1c4e-7d2b-4d7e-9a4a-1f3c5e7b9d21",
        ...(init?.headers as Record<string, string>),
      },
    }),
    {
      sessions,
      issuer: ISSUER,
      resource: `${ISSUER}/api`,
      api: () => new Response("", { status: 401 }),
    },
  );
  return { response, calls };
}
