// secrets.e2e.test.ts — `itx.secrets`, the write-only surface behind what egress substitutes:
// `set(name, material, { urls, refresh? })`, `delete(name)`, `list()` (names, pins and strategy kinds,
// never a value); every change is ONE `events.iterate.com/secrets/changed` event that never carries
// the value and is attributed like any append; a name the placeholder cannot spell is refused. THE
// PLACEHOLDER is apps/os's `getSecret("/secrets/NAME")`, and `getSecret("/secrets/NAME", { field:
// "a.b" })` for one field of a JSON value. THE PIN: a secret is sent to its pinned origins only — any
// other is a 502 naming the pin to the caller, never sent anywhere; a secret cannot be set without one.
// The positive half (the value arrives at a pinned origin) is deployed-only: it egresses to one of
// THIS project's own apps on a real project host. Every dispatch through a secret is a
// `secrets/used` fact (the request as received — placeholders, never values — and the status); a
// WebSocket upgrade through a secret is a dispatch like any other (deployed-only: the petshop's
// capnweb door over egress). The connection mechanisms that refresh a credential are
// secrets-connections.e2e.test.ts.

import { expect, test } from "vitest";
import { freshCtx, openItx, readAll, workerUrl } from "./support/client.ts";
import { petshopBaseUrl } from "./support/petshop.ts";
import { oauthSession } from "./support/principal.ts";
import {
  deployedOnly,
  freshDnsSafeProjectSlug,
  projectUrl,
  registerProject,
} from "./support/project-host.ts";

const CHANGED = "events.iterate.com/secrets/changed";

test("set / list / delete: names, pins and strategy kinds are listed, values never are; each change is one event without the value; a bad name, a missing pin and a bad URL are refused", async () => {
  const itx = openItx(freshCtx("secrets"));
  expect(await itx.secrets.list()).toEqual([]);
  expect(
    await itx.secrets.set("api.key_v-2", "hunter2", { urls: ["https://api.example.com"] }),
  ).toEqual({ ok: true });
  expect(
    await itx.secrets.set("stripe", "sk_live", { urls: ["https://api.stripe.com/v1/x"] }),
  ).toEqual({
    ok: true,
  });
  expect(await itx.secrets.list()).toEqual([
    { name: "api.key_v-2", urls: ["https://api.example.com"] },
    { name: "stripe", urls: ["https://api.stripe.com"] }, // the ORIGIN of the URL given, path dropped
  ]);
  await itx.secrets.delete("api.key_v-2");
  expect(await itx.secrets.list()).toEqual([{ name: "stripe", urls: ["https://api.stripe.com"] }]);
  const changes = (await readAll(itx)).filter((e) => e.type === CHANGED).map((e) => e.payload);
  expect(changes).toEqual([
    { name: "api.key_v-2", urls: ["https://api.example.com"] },
    { name: "stripe", urls: ["https://api.stripe.com"] },
    { name: "api.key_v-2", deleted: true },
  ]);
  expect(JSON.stringify(changes)).not.toContain("hunter2");
  expect(JSON.stringify(changes)).not.toContain("sk_live");
  // a name the placeholder grammar cannot spell can never be substituted — refused at `set`
  await expect(
    itx.secrets.set("has space", "x", { urls: ["https://api.example.com"] }),
  ).rejects.toThrow(/\[a-zA-Z0-9._-\]\+/);
  // a secret is never unpinned: a set without a pin, or with a bad URL, stores nothing
  await expect(itx.secrets.set("unpinned", "x")).rejects.toThrow(/urls is required/);
  await expect(itx.secrets.set("ok", "x", { urls: ["not a url"] })).rejects.toThrow();
});

test("an authenticated session's set is attributed — the change carries the principal, never the value", async () => {
  const slug = freshDnsSafeProjectSlug("secrets-who");
  const email = `${slug}@example.com`;
  const ada = { email };
  const projectId = await registerProject(slug, ada);
  const { api, principal } = await oauthSession(projectId, ada);
  const itx = api.projects.get(projectId);
  await itx.secrets.set("token", "t0p", { urls: ["https://api.example.com"] });
  const change = (await readAll(itx)).find((e) => e.type === CHANGED);
  expect(change?.source?.principal).toEqual(principal);
  expect(JSON.stringify(change)).not.toContain("t0p");
});

test("the pin at egress: a secret is refused, 502, for any origin but its pinned ones — naming the pin to the caller", async () => {
  const itx = openItx(freshCtx("secrets-pin"));
  await itx.secrets.set("bound", "v", { urls: ["https://api.example.com"] });
  const res = await itx.fetch(
    new Request("https://egress.invalid/", {
      headers: { authorization: 'getSecret("/secrets/bound")' },
    }),
  );
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toContain("pinned to https://api.example.com");
  expect(body).toContain("not sent to https://egress.invalid");
  expect(body).not.toContain("v\n"); // the value is nowhere in the refusal
  // a secret pinned to the destination passes and the request goes on to the network: the failure
  // of `.invalid` there (unreachable, answered as a generic 502 that names the host, never the
  // value) is the proof it left — never the pin's refusal
  await itx.secrets.set("free", "v", { urls: ["https://egress.invalid"] });
  const left = await itx
    .fetch(
      new Request("https://egress.invalid/", {
        headers: { authorization: 'getSecret("/secrets/free")' },
      }),
    )
    .then(
      async (r: Response) => ({ status: r.status, text: await r.text() }),
      (e: Error) => ({ status: 0, text: String(e.message) }),
    );
  expect(left.text).not.toMatch(/no stored project secret|pinned to/);
  expect(left.text).not.toContain("v\n");
});

test("`{ field }` in the egress placeholder: a field the JSON value has no string at, and a field of a non-JSON value, are 502s naming the placeholder; a name never set is a 502 too", async () => {
  const itx = openItx(freshCtx("secrets-field"));
  const urls = ["https://egress.invalid"];
  await itx.secrets.set("tg", JSON.stringify({ bot: { token: "123:abc" } }), { urls });
  await itx.secrets.set("plain", "p", { urls });
  const refusal = async (authorization: string): Promise<string> => {
    const res = await itx.fetch(
      new Request("https://egress.invalid/", { headers: { authorization } }),
    );
    expect(res.status).toBe(502);
    return res.text();
  };
  expect(await refusal('getSecret("/secrets/tg", { field: "bot.nope" })')).toContain(
    'no string at field "bot.nope"',
  );
  expect(await refusal('getSecret("/secrets/plain", { field: "x" })')).toContain(
    "not a JSON value",
  );
  // a name the catalog never held: the placeholder finds nothing, the request never leaves
  expect(await refusal('Bearer getSecret("/secrets/never-set")')).toContain(
    'no stored project secret for getSecret("/secrets/never-set")',
  );
  // a well-formed field passes the pin and the request goes on to the network (the `.invalid`
  // failure there is the proof it left)
  const left = await itx
    .fetch(
      new Request("https://egress.invalid/", {
        headers: { authorization: 'getSecret("/secrets/tg", { field: "bot.token" })' },
      }),
    )
    .then(
      async (r: Response) => ({ status: r.status, text: await r.text() }),
      (e: Error) => ({ status: 0, text: String(e.message) }),
    );
  expect(left.text).not.toMatch(/no stored project secret|pinned to|no string at field/);
});

deployedOnly(
  "DEPLOYED: the value arrives at a pinned origin — an egress to one of this project's own apps, on its real host",
  async () => {
    const slug = freshDnsSafeProjectSlug("secrets-arrive");
    const itx = openItx(await registerProject(slug));
    // an app that echoes two headers back, served at `echo--<slug>.<base>`
    await itx.provide("itx.apps.echo", [
      "itx",
      "workers",
      [
        "get",
        {
          source: {
            "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Echo extends WorkerEntrypoint {
  fetch(request) { return new Response((request.headers.get("x-secret") ?? "(none)") + " " + (request.headers.get("x-field") ?? "(none)")); }
}`,
          },
        },
      ],
    ]);
    // the app's address; a secret is pinned to its ORIGIN (secrets.ts `originsOf`) — under paths that
    // is the platform's own origin, every project's apps included
    const app = projectUrl({ project: slug, app: "echo", path: "/" }).href;
    await itx.secrets.set("arrives", "the-value", { urls: [app] });
    await itx.secrets.set("arrives-json", { a: { b: "the-field" } }, { urls: [app] });
    // one request, one secret — the whole-string form, then the `{ field }` form of an object material
    const plain = await itx.fetch(
      new Request(app, { headers: { "x-secret": 'getSecret("/secrets/arrives")' } }),
    );
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe("the-value (none)");
    const field = await itx.fetch(
      new Request(app, {
        headers: { "x-field": 'getSecret("/secrets/arrives-json", { field: "a.b" })' },
      }),
    );
    expect(field.status).toBe(200);
    expect(await field.text()).toBe("(none) the-field");
    // each dispatch is a `secrets/used` fact on the project's root log: the request AS RECEIVED
    // (the placeholder, never the value) and the upstream's status
    const used = await usedFacts(itx, 2);
    expect(used).toEqual([
      { name: "arrives", method: "GET", url: app, status: 200 },
      { name: "arrives-json", method: "GET", url: app, status: 200 },
    ]);
    expect(JSON.stringify(used)).not.toContain("the-value");
    expect(JSON.stringify(used)).not.toContain("the-field");
  },
  30_000,
);

/** The `secrets/used` facts on a context's log, oldest first (appended off the response path, so
 *  polled briefly). */
async function usedFacts(itx: any, expected = 1): Promise<unknown[]> {
  for (let i = 0; ; i += 1) {
    const facts = (await readAll(itx))
      .filter((e) => e.type === "events.iterate.com/secrets/used")
      .map((e) => e.payload);
    if (facts.length >= expected || i > 40) return facts;
    await new Promise((r) => setTimeout(r, 250));
  }
}

test("a use is a fact: an egress through a secret appends `secrets/used` with the request as received and the status — the value never enters the log; a refusal is no use", async () => {
  const itx = openItx(freshCtx("secrets-used"));
  const origin = new URL(workerUrl("/version")).origin;
  await itx.secrets.set("ver", "the-value", { urls: [origin] });
  // /version ignores the header; what matters is that the credential was dispatched to a pinned host
  const res = await itx.fetch(
    new Request(workerUrl("/version"), { headers: { "x-secret": 'getSecret("/secrets/ver")' } }),
  );
  expect(res.status).toBe(200);
  expect(await usedFacts(itx)).toEqual([
    { name: "ver", method: "GET", url: workerUrl("/version"), status: 200 },
  ]);
  // a pin refusal dispatches nothing, so it is no use
  const refused = await itx.fetch(
    new Request("https://elsewhere.invalid/", {
      headers: { "x-secret": 'getSecret("/secrets/ver")' },
    }),
  );
  expect(refused.status).toBe(502);
  expect((await usedFacts(itx)).length).toBe(1);
  expect(JSON.stringify(await readAll(itx))).not.toContain("the-value");
});

deployedOnly(
  "DEPLOYED: a WebSocket 101 through a secret — the petshop's capnweb door over egress, the bearer as a secret in the upgrade header; the socket comes back and the use is a fact with status 101",
  async () => {
    const shop = petshopBaseUrl();
    const login = await fetch(`${shop}/api/legacy-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "secret-ws@example.com", password: "correct-horse" }),
    });
    expect(login.status).toBe(200);
    const { accessToken } = (await login.json()) as { accessToken: string };
    const itx = openItx(freshCtx("secrets-ws"));
    await itx.secrets.set("shop", accessToken, { urls: [shop] });
    const wsUrl = `${shop.replace(/^http/, "ws")}/capnweb`;
    const options = JSON.stringify({
      headers: { authorization: 'Bearer getSecret("/secrets/shop")' },
    });
    expect(
      await itx.invoke(
        `itx.connectToCapnweb(${JSON.stringify(wsUrl)}, ${options}).getPet('pet-1')`,
      ),
    ).toMatchObject({ id: "pet-1", name: "Biscuit" });
    expect(await usedFacts(itx)).toEqual([
      { name: "shop", method: "GET", url: `${shop}/capnweb`, status: 101 },
    ]);
  },
  30_000,
);

test("the catalog is the PROJECT's: a secret set from one context is listed from any other and from the root, and a delete anywhere clears it everywhere", async () => {
  const projectId = freshCtx("secrets-project");
  const root = openItx(projectId);
  const a = root.cd("/a");
  const b = root.cd("/b");
  await a.secrets.set("shared", "v", { urls: ["https://api.example.com"] });
  expect(await b.secrets.list()).toEqual([{ name: "shared", urls: ["https://api.example.com"] }]);
  expect(await root.secrets.list()).toEqual([
    { name: "shared", urls: ["https://api.example.com"] },
  ]);
  await b.secrets.delete("shared");
  expect(await a.secrets.list()).toEqual([]);
  // the change events live in the ROOT's log, whichever context wrote them
  expect((await readAll(root)).filter((e) => e.type === CHANGED).map((e) => e.payload)).toEqual([
    { name: "shared", urls: ["https://api.example.com"] },
    { name: "shared", deleted: true },
  ]);
});

// The change is appended BEFORE the value is written: a paused stream refuses the append and the
// credential is untouched — the catalog and the store agree. (A KV failure after the append is the
// other order — a catalog row whose value egress cannot find, a loud 502, never a silent live secret.)
test("a set refused by a paused stream leaves no value behind — egress cannot substitute what the catalog never listed", async () => {
  const itx = openItx(freshCtx("secrets-paused"));
  await itx.append({ type: "events.iterate.com/stream/paused" });
  await expect(
    itx.secrets.set("ghost", "v", { urls: ["https://api.example.com"] }),
  ).rejects.toThrow();
  await itx.append({ type: "events.iterate.com/stream/resumed" });
  expect(await itx.secrets.list()).toEqual([]);
  const res = await itx.fetch(
    new Request("https://egress.invalid/", {
      headers: { authorization: 'getSecret("/secrets/ghost")' },
    }),
  );
  expect(res.status).toBe(502); // the refused set stored no value, so egress finds none for `ghost` and refuses before the terminal fetch — the request never leaves
});

test("one request, one secret: a request naming two secrets is refused at egress, before either object is dialled", async () => {
  const itx = openItx(freshCtx("secrets-two"));
  const urls = ["https://egress.invalid"];
  await itx.secrets.set("a", "1", { urls });
  await itx.secrets.set("b", "2", { urls });
  const res = await itx.fetch(
    new Request("https://egress.invalid/", {
      headers: { "x-a": 'getSecret("/secrets/a")', "x-b": 'getSecret("/secrets/b")' },
    }),
  );
  expect(res.status).toBe(502);
  expect(await res.text()).toContain('one request, one secret — this one names "a", "b"');
});
