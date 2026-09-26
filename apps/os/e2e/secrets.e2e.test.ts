// secrets.e2e.test.ts — `itx.secrets`, the write-only surface behind what egress substitutes. A
// SECRET IS ITS PATH: a domain object on the context at `/secrets/<name>` under the resource owner's
// root (a project's `/`), hosted as the first-party facet `secret` — the value's one keeper — and the
// path is what the placeholder spells: `getSecret("/secrets/<name>")`, and `getSecret("/secrets/<name>",
// { field: "a.b" })` for one field of an object. The verbs are path-keyed and run ON THE SECRET'S
// OWN CONTEXT: `set(path, material, { urls, refresh? })`, `delete(path)`, `list()` (the owner root's
// catalog — paths, pins, strategy kinds and when first set, never a value). Every change is ONE fact
// that never carries the value — `events.iterate.com/secret/set { path, urls, refresh? }`,
// `secret/deleted { path }` — landed on the secret's path, attributed like any append, then
// cross-posted to the root `/` whose catalog `list()` reads; a path the placeholder cannot spell is
// refused. THE PIN: a secret is sent to its pinned origins only — any other is a 502 naming the pin
// to the caller, never sent anywhere; a secret cannot be set without one. The positive half (the
// value arrives at a pinned origin) is deployed-only: it egresses to one of THIS project's own apps
// on a real project host. Every dispatch through a secret is a `secret/used` fact ON THE SECRET'S
// PATH (the request as received — placeholders, never values — and the status); a WebSocket upgrade
// through a secret is a dispatch like any other — the petshop's capnweb endpoint over egress, dialled
// from a nested context (deployed-only: the local worker cannot make an outbound upgrade; the
// platform pin, inside workerd, is __workers-tests__/secret-facet-proxies-a-socket.test.ts). The
// connection mechanisms that refresh a credential are secrets-connections.e2e.test.ts.

import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import {
  freshCtx,
  openItx,
  processorNames,
  readAll,
  runId,
  until,
  workerUrl,
} from "./support/client.ts";
import { petshopBaseUrl, petshopLegacyBearer } from "./support/petshop.ts";
import { oauthSession } from "./support/principal.ts";
import {
  deployedOnly,
  deployedSubdomainsOnly,
  freshDnsSafeProjectSlug,
  projectUrl,
  publishConfigWorker,
  registerProject,
} from "./support/project-host.ts";

test("set / list / delete: paths, pins and strategy kinds are listed, values never are; each change is one fact on the secret's path, cross-posted to the root, without the value; a bad path, a missing pin and a bad URL are refused", async () => {
  const itx = openItx(freshCtx("secrets"));
  expect(await itx.secrets.list()).toEqual([]);
  expect(
    await itx.secrets.set("/secrets/api.key_v-2", "hunter2", { urls: ["https://api.example.com"] }),
  ).toEqual({ path: "/secrets/api.key_v-2" });
  expect(
    await itx.secrets.set("/secrets/stripe", "sk_live", { urls: ["https://api.stripe.com/v1/x"] }),
  ).toEqual({ path: "/secrets/stripe" });
  expect(await itx.secrets.list()).toEqual([
    {
      path: "/secrets/api.key_v-2",
      urls: ["https://api.example.com"],
      createdAt: expect.any(String),
    },
    { path: "/secrets/stripe", urls: ["https://api.stripe.com"], createdAt: expect.any(String) }, // the ORIGIN of the URL given, path dropped
  ]);
  expect(await itx.secrets.delete("/secrets/api.key_v-2")).toEqual({
    path: "/secrets/api.key_v-2",
  });
  expect(await itx.secrets.list()).toEqual([
    { path: "/secrets/stripe", urls: ["https://api.stripe.com"], createdAt: expect.any(String) },
  ]);
  // the facts: each secret's own log holds its own; the root's log holds every one, cross-posted
  expect(await changesOf(itx.cd("/secrets/api.key_v-2"))).toEqual([
    [
      "events.iterate.com/secret/set",
      { path: "/secrets/api.key_v-2", urls: ["https://api.example.com"] },
    ],
    ["events.iterate.com/secret/deleted", { path: "/secrets/api.key_v-2" }],
  ]);
  expect(await changesOf(itx.cd("/secrets/stripe"))).toEqual([
    [
      "events.iterate.com/secret/set",
      { path: "/secrets/stripe", urls: ["https://api.stripe.com"] },
    ],
  ]);
  expect(await changesOf(itx)).toEqual([
    [
      "events.iterate.com/secret/set",
      { path: "/secrets/api.key_v-2", urls: ["https://api.example.com"] },
    ],
    [
      "events.iterate.com/secret/set",
      { path: "/secrets/stripe", urls: ["https://api.stripe.com"] },
    ],
    ["events.iterate.com/secret/deleted", { path: "/secrets/api.key_v-2" }],
  ]);
  const logs = JSON.stringify([
    await readAll(itx),
    await readAll(itx.cd("/secrets/api.key_v-2")),
    await readAll(itx.cd("/secrets/stripe")),
  ]);
  expect(logs).not.toContain("hunter2");
  expect(logs).not.toContain("sk_live");
  // a path the placeholder grammar cannot spell can never be substituted — refused at `set`: a
  // name with a space, a bare name (the path IS the key), a path outside /secrets/
  const badPath = /a secret's path is \/secrets\/<name>, the name \[a-zA-Z0-9._-\]\+/;
  await expect(
    itx.secrets.set("/secrets/has space", "x", { urls: ["https://api.example.com"] }),
  ).rejects.toThrow(badPath);
  await expect(
    itx.secrets.set("stripe", "x", { urls: ["https://api.example.com"] }),
  ).rejects.toThrow(badPath);
  await expect(
    itx.secrets.set("/kv/stripe", "x", { urls: ["https://api.example.com"] }),
  ).rejects.toThrow(badPath);
  await expect(itx.secrets.delete("/kv/stripe")).rejects.toThrow(badPath);
  // a secret is never unpinned: a set without a pin, or with a bad URL, stores nothing
  await expect(itx.secrets.set("/secrets/unpinned", "x")).rejects.toThrow(/urls is required/);
  await expect(itx.secrets.set("/secrets/ok", "x", { urls: ["not a url"] })).rejects.toThrow();
  expect(await itx.secrets.list()).toEqual([
    { path: "/secrets/stripe", urls: ["https://api.stripe.com"], createdAt: expect.any(String) },
  ]);
});

test("an authenticated session's set is attributed — the fact on the secret's path carries the principal, never the value; the root's cross-post is the same payload", async () => {
  const slug = freshDnsSafeProjectSlug("secrets-who");
  const email = `${slug}@example.com`;
  const ada = { email };
  const projectId = await registerProject(slug, ada);
  const { api, principal } = await oauthSession(projectId, ada);
  const itx = api.projects.get(projectId);
  await itx.secrets.set("/secrets/token", "t0p", { urls: ["https://api.example.com"] });
  const payload = { path: "/secrets/token", urls: ["https://api.example.com"] };
  const change = (await readAll(itx.cd("/secrets/token"))).find(
    (e) => e.type === "events.iterate.com/secret/set",
  );
  expect(change?.payload).toEqual(payload);
  expect(change?.source?.principal).toEqual(principal);
  expect(JSON.stringify(change)).not.toContain("t0p");
  // the cross-post on the root: the same fact, the same payload, the same caller
  const crossPosted = (await readAll(itx)).find((e) => e.type === "events.iterate.com/secret/set");
  expect(crossPosted?.payload).toEqual(payload);
  expect(crossPosted?.source?.principal).toEqual(principal);
  expect(JSON.stringify(crossPosted)).not.toContain("t0p");
});

test("a secret is its path: after a set the `secret` processor row is on /secrets/<name> and its facet's snapshot says material is stored at the set's offset; delete drops the row and the catalog, a second delete answers at once, a never-set path refuses, and a deleted secret can be set again", async () => {
  const itx = openItx(freshCtx("secrets-entity"));
  const x = itx.cd("/secrets/x");
  const urls = ["https://api.example.com"];
  await itx.secrets.set("/secrets/x", "the-first-value", { urls });
  // the row is the secret's, not the root's; the facet's state points at the fact that set it
  expect(await processorNames(x)).toEqual(["secret"]);
  const set1 = (await readAll(x)).find((e) => e.type === "events.iterate.com/secret/set");
  expect(set1?.payload).toEqual({ path: "/secrets/x", urls });
  const snapshot1 = await x.facets.get("secret").snapshot();
  expect(snapshot1).toMatchObject({ state: { material: { offset: set1.offset }, deletion: null } });
  expect(snapshot1.offset).toBeGreaterThanOrEqual(set1.offset);
  // delete: the fact lands, the row goes, the catalog drops it
  expect(await itx.secrets.delete("/secrets/x")).toEqual({ path: "/secrets/x" });
  expect(await processorNames(x)).toEqual([]);
  expect(await itx.secrets.list()).toEqual([]);
  const deleted = (await readAll(x)).find((e) => e.type === "events.iterate.com/secret/deleted");
  expect(deleted?.payload).toEqual({ path: "/secrets/x" });
  expect(deleted.offset).toBeGreaterThan(set1.offset);
  // a second delete answers at once — no second fact
  expect(await itx.secrets.delete("/secrets/x")).toEqual({ path: "/secrets/x" });
  expect(
    (await readAll(x)).filter((e) => e.type === "events.iterate.com/secret/deleted"),
  ).toHaveLength(1);
  // a path never set has nothing to delete
  await expect(itx.secrets.delete("/secrets/never")).rejects.toThrow(
    "secret /secrets/never: never set — nothing to delete",
  );
  // set again: the row is back, the snapshot points at the NEW set, the catalog lists it again
  expect(await itx.secrets.set("/secrets/x", "the-second-value", { urls })).toEqual({
    path: "/secrets/x",
  });
  expect(await processorNames(x)).toEqual(["secret"]);
  const set2 = (await readAll(x)).filter((e) => e.type === "events.iterate.com/secret/set").at(-1);
  expect(set2.offset).toBeGreaterThan(deleted.offset);
  expect(await x.facets.get("secret").snapshot()).toMatchObject({
    state: { material: { offset: set2.offset }, deletion: null },
  });
  expect(await itx.secrets.list()).toEqual([
    { path: "/secrets/x", urls, createdAt: expect.any(String) },
  ]);
  expect(await changesOf(itx)).toEqual([
    ["events.iterate.com/secret/set", { path: "/secrets/x", urls }],
    ["events.iterate.com/secret/deleted", { path: "/secrets/x" }],
    ["events.iterate.com/secret/set", { path: "/secrets/x", urls }],
  ]);
  const logs = JSON.stringify([await readAll(itx), await readAll(x)]);
  expect(logs).not.toContain("the-first-value");
  expect(logs).not.toContain("the-second-value");
});

test("the pin at egress: a secret is refused, 502, for any origin but its pinned ones — naming the secret and the pin to the caller", async () => {
  const itx = openItx(freshCtx("secrets-pin"));
  await itx.secrets.set("/secrets/bound", "v", { urls: ["https://api.example.com"] });
  const res = await itx.fetch(
    new Request("https://egress.invalid/", {
      headers: { authorization: 'getSecret("/secrets/bound")' },
    }),
  );
  expect(res).toMatchObject({ status: 502 });
  const body = await res.text();
  expect(body).toContain("the secret /secrets/bound is pinned to https://api.example.com");
  expect(body).toContain("not sent to https://egress.invalid");
  expect(body).not.toContain("v\n"); // the value is nowhere in the refusal
  // a secret pinned to the destination passes and the request goes on to the network: the failure
  // of `.invalid` there (unreachable, answered as a generic 502 that names the host, never the
  // value) is the proof it left — never the pin's refusal
  await itx.secrets.set("/secrets/free", "v", { urls: ["https://egress.invalid"] });
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

test("`{ field }` in the egress placeholder: a field the object value has no string at, and a field of a string value, are 502s naming the placeholder; a path never set is a 502 too", async () => {
  const itx = openItx(freshCtx("secrets-field"));
  const urls = ["https://egress.invalid"];
  await itx.secrets.set("/secrets/tg", { bot: { token: "123:abc" } }, { urls });
  await itx.secrets.set("/secrets/plain", "p", { urls });
  const refusal = async (authorization: string): Promise<string> => {
    const res = await itx.fetch(
      new Request("https://egress.invalid/", { headers: { authorization } }),
    );
    expect(res).toMatchObject({ status: 502 });
    return res.text();
  };
  expect(await refusal('getSecret("/secrets/tg", { field: "bot.nope" })')).toContain(
    'no string at field "bot.nope"',
  );
  expect(await refusal('getSecret("/secrets/plain", { field: "x" })')).toContain(
    "one string, not an object",
  );
  // a path never set: its facet holds nothing, the placeholder finds nothing, the request never leaves
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

deployedSubdomainsOnly(
  "DEPLOYED: the value arrives at a pinned origin — an egress to one of this project's own apps, on its real host",
  async () => {
    const slug = freshDnsSafeProjectSlug("secrets-arrive");
    const itx = openItx(await registerProject(slug));
    // an app that echoes two headers back, served at `echo--<slug>.<base>`
    await publishConfigWorker(itx, [
      "itx",
      "workers",
      [
        "get",
        {
          source: {
            "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Echo extends WorkerEntrypoint {
  fetch(request) { return new Response((request.headers.get("x-secret") ?? "(none)") + " " + (request.headers.get("x-field") ?? "(none)")); }
}`,
          },
        },
      ],
    ]);
    // the app's address; a secret is pinned to its ORIGIN (secrets.ts `originsOf`) — under paths that
    // is the platform's own origin, every project's apps included
    const app = projectUrl({ project: slug, routingSlug: "echo", path: "/" }).href;
    await itx.secrets.set("/secrets/arrives", "the-value", { urls: [app] });
    await itx.secrets.set("/secrets/arrives-json", { a: { b: "the-field" } }, { urls: [app] });
    // one request, one secret — the whole-string form, then the `{ field }` form of an object material
    const plain = await itx.fetch(
      new Request(app, { headers: { "x-secret": 'getSecret("/secrets/arrives")' } }),
    );
    expect(plain).toMatchObject({ status: 200 });
    expect(await plain.text()).toBe("the-value (none)");
    const field = await itx.fetch(
      new Request(app, {
        headers: { "x-field": 'getSecret("/secrets/arrives-json", { field: "a.b" })' },
      }),
    );
    expect(field).toMatchObject({ status: 200 });
    expect(await field.text()).toBe("(none) the-field");
    // each dispatch is a `secret/used` fact on the SECRET's own log: the request AS RECEIVED (the
    // placeholder, never the value) and the upstream's status
    const used = [
      ...(await usedFacts(itx.cd("/secrets/arrives"))),
      ...(await usedFacts(itx.cd("/secrets/arrives-json"))),
    ];
    expect(used).toEqual([
      { method: "GET", url: app, status: 200 },
      { method: "GET", url: app, status: 200 },
    ]);
    expect(JSON.stringify(used)).not.toContain("the-value");
    expect(JSON.stringify(used)).not.toContain("the-field");
    expect((await readAll(itx)).filter((e) => e.type === "events.iterate.com/secret/used")).toEqual(
      [],
    ); // a use is the secret's fact, never the root's
  },
  30_000,
);

test("a use is a fact: an egress through a secret appends `secret/used` on the secret's path with the request as received and the status — the value never enters a log; a refusal is no use", async () => {
  const itx = openItx(freshCtx("secrets-used"));
  const origin = new URL(workerUrl("/version")).origin;
  await itx.secrets.set("/secrets/ver", "the-value", { urls: [origin] });
  const ver = itx.cd("/secrets/ver");
  // /version ignores the header; what matters is that the credential was dispatched to a pinned host
  const res = await itx.fetch(
    new Request(workerUrl("/version"), { headers: { "x-secret": 'getSecret("/secrets/ver")' } }),
  );
  expect(res).toMatchObject({ status: 200 });
  expect(await usedFacts(ver)).toEqual([
    { method: "GET", url: workerUrl("/version"), status: 200 },
  ]);
  // a pin refusal dispatches nothing, so it is no use
  const refused = await itx.fetch(
    new Request("https://elsewhere.invalid/", {
      headers: { "x-secret": 'getSecret("/secrets/ver")' },
    }),
  );
  expect(refused).toMatchObject({ status: 502 });
  expect((await usedFacts(ver)).length).toBe(1);
  expect(JSON.stringify([await readAll(itx), await readAll(ver)])).not.toContain("the-value");
});

// DEPLOYED ONLY (measured 2026-09-21): the local worker under wrangler cannot make an OUTBOUND
// WebSocket upgrade — its terminal fetch answers `TypeError: fetch failed` — while the deployed worker
// and the Workers suite (vitest-pool-workers, workerd's own fetch) can; the local proof of the same
// path, against an in-process fake shop, is __workers-tests__/secret-facet-proxies-a-socket.test.ts.
deployedOnly(
  "DEPLOYED: a WebSocket 101 through a secret — the petshop's capnweb endpoint dialled from a NESTED context (`/agents/dialler`), whose egress forwards the upgrade to /secrets/shop and its facet substitutes the bearer, dials, and hands the 101 back; the capnweb call answers over it; the use is a fact on the secret's path with status 101",
  async () => {
    const shop = petshopBaseUrl();
    const accessToken = await petshopLegacyBearer(`secret-ws-${runId()}@example.com`);
    const itx = openItx(freshCtx("secrets-ws"));
    await itx.secrets.set("/secrets/shop", accessToken, { urls: [shop] });
    const wsUrl = `${shop.replace(/^http/, "ws")}/capnweb`;
    const options = JSON.stringify({
      headers: { authorization: 'Bearer getSecret("/secrets/shop")' },
    });
    // Dialled from a sibling context, never the secret's own: the caller's `#egress` forwards the
    // upgrade to the context at /secrets/shop (a fetch hop), and that one's to its facet.
    const dialler = itx.cd("/agents/dialler");
    // A context merely cd-ed into is naked: the library roots reach it through the creator's link.
    await dialler.provide("itx", "itx.builtins.cd('/')");
    expect(
      await dialler.invoke(
        `itx.connectToCapnweb(${JSON.stringify(wsUrl)}, ${options}).getPet('pet-1')`,
      ),
    ).toMatchObject({ id: "pet-1", name: "Biscuit" });
    // A second call rides the same held session (the library memoizes the connection).
    expect(
      await dialler.invoke(
        `itx.connectToCapnweb(${JSON.stringify(wsUrl)}, ${options}).getPet('pet-2')`,
      ),
    ).toMatchObject({ id: "pet-2" });
    expect(await usedFacts(itx.cd("/secrets/shop"))).toEqual([
      { method: "GET", url: `${shop}/capnweb`, status: 101 },
    ]);
    // The bearer never entered any log — the dialler's, the secret's, the root's.
    for (const context of [dialler, itx.cd("/secrets/shop"), itx])
      expect(JSON.stringify(await readAll(context))).not.toContain(accessToken);
  },
  30_000,
);

test("the catalog is the PROJECT's: a secret set from one nested context is listed from any other and from the root, and a delete anywhere clears it everywhere — the facts on the secret's path and the root's, never the writer's", async () => {
  const projectId = freshCtx("secrets-project");
  const root = openItx(projectId);
  const a = root.cd("/a");
  const b = root.cd("/b");
  // nothing project-level is implicit below the root: each child reaches the catalog through the row
  // its creator would have written — here the session writes the link itself
  await a.provide("itx", "itx.builtins.cd('/')");
  await b.provide("itx", "itx.builtins.cd('/')");
  const row = {
    path: "/secrets/shared",
    urls: ["https://api.example.com"],
    createdAt: expect.any(String),
  };
  await a.secrets.set("/secrets/shared", "v", { urls: ["https://api.example.com"] });
  expect(await b.secrets.list()).toEqual([row]);
  expect(await root.secrets.list()).toEqual([row]);
  await b.secrets.delete("/secrets/shared");
  expect(await a.secrets.list()).toEqual([]);
  expect(await root.secrets.list()).toEqual([]);
  // the facts live on the SECRET's log and, cross-posted, on the ROOT's — whichever context wrote
  // them; the writers' own logs hold none
  const facts = [
    [
      "events.iterate.com/secret/set",
      { path: "/secrets/shared", urls: ["https://api.example.com"] },
    ],
    ["events.iterate.com/secret/deleted", { path: "/secrets/shared" }],
  ];
  expect(await changesOf(root.cd("/secrets/shared"))).toEqual(facts);
  expect(await changesOf(root)).toEqual(facts);
  expect(await changesOf(a)).toEqual([]);
  expect(await changesOf(b)).toEqual([]);
});

// Every set begins with appends on the SECRET's own path — the `secret` processor row's enablement
// (`itx/subscription-configured`), then the `secret/set` fact — BEFORE the value is written into
// the facet: a paused stream there refuses the first of them and the credential is untouched — the
// catalog, the log and the facet agree. (A facet failure after the fact is the other order — a
// catalog row whose value egress cannot find, a loud 502, never a silent live secret.)
test("a set refused by a paused stream on the secret's path leaves no value behind — no row, no fact, nothing in the catalog, and egress cannot substitute what was never stored", async () => {
  const itx = openItx(freshCtx("secrets-paused"));
  const ghost = itx.cd("/secrets/ghost");
  await ghost.append({ type: "events.iterate.com/itx/paused" });
  await expect(
    itx.secrets.set("/secrets/ghost", "v", { urls: ["https://api.example.com"] }),
  ).rejects.toThrow();
  await ghost.append({ type: "events.iterate.com/itx/resumed" });
  expect(await itx.secrets.list()).toEqual([]);
  expect(await processorNames(ghost)).toEqual([]);
  expect(await changesOf(ghost)).toEqual([]);
  expect(await changesOf(itx)).toEqual([]);
  const res = await itx.fetch(
    new Request("https://egress.invalid/", {
      headers: { authorization: 'getSecret("/secrets/ghost")' },
    }),
  );
  expect(res).toMatchObject({ status: 502 }); // the refused set stored no value, so the secret's facet finds none for `ghost` and refuses before the terminal fetch — the request never leaves
  expect(await res.text()).toContain('no stored project secret for getSecret("/secrets/ghost")');
});

// The verdicts themselves (hex case, a field of an object, a wrong key, a short signature) are
// secrets.test.ts's `verifySecretHmac` table; this row proves the wire and the facet around it.
test("verifyHmac checks a webhook's HMAC-SHA256 inside the secret's facet: true for the signed string or its bytes, false for a tampered payload or a secret never set or deleted; loaded code verifies through its creator's link; no fact and no value leaves the facet", async () => {
  const itx = openItx(freshCtx("secrets-verify"));
  await itx.secrets.set("/secrets/hook", "whsec_test_key", { urls: ["https://api.stripe.com"] });
  const payload =
    "1700000000." + JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const signature = createHmac("sha256", "whsec_test_key").update(payload).digest("hex");
  expect(await itx.secrets.verifyHmac("/secrets/hook", { payload, signature })).toBe(true);
  expect(
    await itx.secrets.verifyHmac("/secrets/hook", {
      payload: new TextEncoder().encode(payload),
      signature,
    }),
  ).toBe(true);
  expect(await itx.secrets.verifyHmac("/secrets/hook", { payload: `${payload} `, signature })).toBe(
    false,
  );
  expect(await itx.secrets.verifyHmac("/secrets/never-set", { payload, signature })).toBe(false);
  // loaded code: a script in a child context, through its creator's link, verifies the same way
  const child = itx.cd("/agents/hook");
  await child.provide("itx", "itx.builtins.cd('/')");
  expect(
    await child.run(
      `async (itx) => itx.secrets.verifyHmac("/secrets/hook", ${JSON.stringify({ payload, signature })})`,
    ),
  ).toBe(true);
  // the secret's log has the set and nothing of the verifications; the value is nowhere in it
  const events = await readAll(itx.cd("/secrets/hook"));
  expect(
    events.filter((e) => e.type.startsWith("events.iterate.com/secret/")).map((e) => e.type),
  ).toEqual(["events.iterate.com/secret/set"]);
  expect(JSON.stringify(events)).not.toContain("whsec_test_key");
  await itx.secrets.delete("/secrets/hook");
  expect(await itx.secrets.verifyHmac("/secrets/hook", { payload, signature })).toBe(false); // deleted: no key
});

test("loaded code may write a secret: a script run in a child context (through its creator's link) sets, lists and deletes one — the platform's hops to the secret's context are its own, never the script's spelling; the fact speaks for the project (no principal)", async () => {
  const itx = openItx(freshCtx("secrets-script"));
  const child = itx.cd("/agents/writer");
  await child.provide("itx", "itx.builtins.cd('/')");
  const urls = ["https://api.example.com"];
  expect(
    await child.run(
      `async (itx) => itx.secrets.set("/secrets/fromscript", "v", { urls: ${JSON.stringify(urls)} })`,
    ),
  ).toEqual({ path: "/secrets/fromscript" });
  const row = { path: "/secrets/fromscript", urls, createdAt: expect.any(String) };
  expect(await child.run("async (itx) => itx.secrets.list()")).toEqual([row]);
  expect(await itx.secrets.list()).toEqual([row]);
  const set = (await readAll(itx.cd("/secrets/fromscript"))).find(
    (e) => e.type === "events.iterate.com/secret/set",
  );
  expect(set?.payload).toEqual({ path: "/secrets/fromscript", urls });
  expect(set?.source?.principal).toBeUndefined(); // loaded code speaks for the project
  expect(await child.run('async (itx) => itx.secrets.delete("/secrets/fromscript")')).toEqual({
    path: "/secrets/fromscript",
  });
  expect(await itx.secrets.list()).toEqual([]);
});

test("one request, one secret: a request naming two secrets is refused at egress, before either secret's context is dialled", async () => {
  const itx = openItx(freshCtx("secrets-two"));
  const urls = ["https://egress.invalid"];
  await itx.secrets.set("/secrets/a", "1", { urls });
  await itx.secrets.set("/secrets/b", "2", { urls });
  const res = await itx.fetch(
    new Request("https://egress.invalid/", {
      headers: { "x-a": 'getSecret("/secrets/a")', "x-b": 'getSecret("/secrets/b")' },
    }),
  );
  expect(res).toMatchObject({ status: 502 });
  expect(await res.text()).toContain(
    'one request, one secret — this one names "/secrets/a", "/secrets/b"',
  );
  // neither secret was dialled: no use on either
  expect(await usedFacts(itx.cd("/secrets/a"), 0)).toEqual([]);
  expect(await usedFacts(itx.cd("/secrets/b"), 0)).toEqual([]);
});

/** The `secret/used` facts on a SECRET's log (`itx.cd("/secrets/<name>")`), oldest first — the
 *  facet appends them off the response path, so polled briefly. */
function usedFacts(secret: any, expected = 1): Promise<unknown[]> {
  return until(
    "secret/used facts",
    async () => {
      const facts = (await readAll(secret))
        .filter((e) => e.type === "events.iterate.com/secret/used")
        .map((e) => e.payload);
      return facts.length >= expected ? facts : undefined;
    },
    10_000,
  );
}

/** The `secret/set` and `secret/deleted` facts on a context's log as `[type, payload]`, oldest first. */
const changesOf = async (itx: any): Promise<unknown[]> =>
  (await readAll(itx))
    .filter(
      (e) =>
        e.type === "events.iterate.com/secret/set" ||
        e.type === "events.iterate.com/secret/deleted",
    )
    .map((e) => [e.type, e.payload]);
