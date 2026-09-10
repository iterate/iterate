// secrets.e2e.test.ts — `itx.secrets`, the write door to what egress substitutes: `set(name, value,
// { origin? })`, `delete(name)`, `list()` (names and origins, never a value); every change is ONE
// `events.iterate.com/secrets/changed` event that never carries the value and is attributed like any
// append; a name the placeholder cannot spell is refused at the door. THE PLACEHOLDER is apps/os's
// `getSecret("/secrets/NAME")`, and `getSecret("/secrets/NAME", { field: "a.b" })` for one field of
// a JSON value. ORIGIN BINDING at the egress door: a secret bound to one origin is refused, 502, for
// any other — the credential's name is told to the caller, never sent anywhere; the project's own API
// key is no secret the placeholder reaches. The positive half (the value arrives at the bound origin)
// is deployed-only: it egresses to one of THIS project's own apps on a real project host.

import { expect, test } from "vitest";
import { freshCtx, openItx, readAll } from "./support/client.ts";
import { oauthSession } from "./support/principal.ts";
import {
  deployedOnly,
  freshDnsSafeProjectId,
  projectHostnameBase,
  registerProject,
} from "./support/project-host.ts";

const CHANGED = "events.iterate.com/secrets/changed";

test("set / list / delete: names and origins are listed, values never are; each change is one event without the value; a bad name is refused", async () => {
  const itx = openItx(freshCtx("secrets"));
  expect(await itx.secrets.list()).toEqual([]);
  expect(await itx.secrets.set("api.key_v-2", "hunter2")).toEqual({ ok: true });
  expect(
    await itx.secrets.set("stripe", "sk_live", { origin: "https://api.stripe.com/v1/x" }),
  ).toEqual({
    ok: true,
  });
  expect(await itx.secrets.list()).toEqual([
    { name: "api.key_v-2" },
    { name: "stripe", origin: "https://api.stripe.com" }, // the ORIGIN of the URL given, path dropped
  ]);
  await itx.secrets.delete("api.key_v-2");
  expect(await itx.secrets.list()).toEqual([{ name: "stripe", origin: "https://api.stripe.com" }]);
  const changes = (await readAll(itx)).filter((e) => e.type === CHANGED).map((e) => e.payload);
  expect(changes).toEqual([
    { name: "api.key_v-2" },
    { name: "stripe", origin: "https://api.stripe.com" },
    { name: "api.key_v-2", deleted: true },
  ]);
  expect(JSON.stringify(changes)).not.toContain("hunter2");
  expect(JSON.stringify(changes)).not.toContain("sk_live");
  // a name the placeholder grammar cannot spell can never be substituted — refused at the door
  await expect(itx.secrets.set("has space", "x")).rejects.toThrow(/\[a-zA-Z0-9._-\]\+/);
  await expect(itx.secrets.set("ok", "x", { origin: "not a url" })).rejects.toThrow();
});

test("an authenticated session's set is attributed — the change carries the principal, never the value", async () => {
  const projectId = freshDnsSafeProjectId("secrets-who");
  const email = `${projectId}@example.com`;
  const ada = { email };
  await registerProject(projectId, ada);
  const { api, principal } = await oauthSession(projectId, ada);
  const itx = api.projects.get(projectId);
  await itx.secrets.set("token", "t0p");
  const change = (await readAll(itx)).find((e) => e.type === CHANGED);
  expect(change?.source?.principal).toEqual(principal);
  expect(JSON.stringify(change)).not.toContain("t0p");
});

test("origin binding at the egress door: a bound secret is refused, 502, for any other origin — naming the binding to the caller", async () => {
  const itx = openItx(freshCtx("secrets-origin"));
  await itx.secrets.set("bound", "v", { origin: "https://api.example.com" });
  const res = await itx.fetch(
    new Request("https://egress.invalid/", {
      headers: { authorization: 'getSecret("/secrets/bound")' },
    }),
  );
  expect(res.status).toBe(502);
  const body = await res.text();
  expect(body).toContain("bound to https://api.example.com");
  expect(body).toContain("not sent to https://egress.invalid");
  expect(body).not.toContain("v\n"); // the value is nowhere in the refusal
  // an unbound secret passes the door and the request goes on to the network: the failure of
  // `.invalid` there (a thrown fetch error deployed, a 5xx from the local runtime) is the proof it
  // left — never our door's 502 with its message
  await itx.secrets.set("free", "v");
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
  expect(left.status).not.toBe(502);
  expect(left.text).not.toMatch(/no stored project secret|bound to/);
});

test("`{ field }` at the egress door: a field the JSON value has no string at, and a field of a non-JSON value, are 502s naming the placeholder; the project's own API key is outside the catalog — no placeholder reaches it", async () => {
  const itx = openItx(freshCtx("secrets-field"));
  await itx.secrets.set("tg", JSON.stringify({ bot: { token: "123:abc" } }));
  await itx.secrets.set("plain", "p");
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
  // the key that authenticates AS the project (principal.ts, outside the `secret:` prefix): the
  // placeholder finds nothing, so the project's own code can never mail it anywhere
  await itx.rotateApiKey();
  expect(await refusal('Bearer getSecret("/secrets/project-api-key")')).toContain(
    'no stored project secret for getSecret("/secrets/project-api-key")',
  );
  // a well-formed field passes the door and the request goes on to the network (the `.invalid`
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
  expect(left.status).not.toBe(502);
});

deployedOnly(
  "DEPLOYED: the value arrives at the bound origin — an egress to one of this project's own apps, on its real host",
  async () => {
    const projectId = freshDnsSafeProjectId("secrets-arrive");
    await registerProject(projectId);
    const itx = openItx(projectId);
    // an app that echoes two headers back, served at `echo--<projectId>.<base>`
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
    const origin = `https://echo--${projectId}.${projectHostnameBase()}`;
    await itx.secrets.set("arrives", "the-value", { origin });
    await itx.secrets.set("arrives-json", JSON.stringify({ a: { b: "the-field" } }), { origin });
    const res = await itx.fetch(
      new Request(`${origin}/`, {
        headers: {
          "x-secret": 'getSecret("/secrets/arrives")',
          "x-field": 'getSecret("/secrets/arrives-json", { field: "a.b" })',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("the-value the-field");
  },
  30_000,
);

test("the catalog is the PROJECT's: a secret set from one context is listed from any other and from the root, and a delete anywhere clears it everywhere", async () => {
  const projectId = freshCtx("secrets-project");
  const root = openItx(projectId);
  const a = root.cd("/a");
  const b = root.cd("/b");
  await a.secrets.set("shared", "v", { origin: "https://api.example.com" });
  expect(await b.secrets.list()).toEqual([{ name: "shared", origin: "https://api.example.com" }]);
  expect(await root.secrets.list()).toEqual([
    { name: "shared", origin: "https://api.example.com" },
  ]);
  await b.secrets.delete("shared");
  expect(await a.secrets.list()).toEqual([]);
  // the change events live in the ROOT's log, whichever context wrote them
  expect((await readAll(root)).filter((e) => e.type === CHANGED).map((e) => e.payload)).toEqual([
    { name: "shared", origin: "https://api.example.com" },
    { name: "shared", deleted: true },
  ]);
});

// The change is appended BEFORE the value is written: a paused stream refuses the append and the
// credential is untouched — the catalog and the store agree. (A KV failure after the append is the
// other order — a catalog row whose value egress cannot find, a loud 502, never a silent live secret.)
test("a set refused by a paused stream leaves no value behind — egress cannot substitute what the catalog never listed", async () => {
  const itx = openItx(freshCtx("secrets-paused"));
  await itx.append({ type: "events.iterate.com/stream/paused" });
  await expect(itx.secrets.set("ghost", "v")).rejects.toThrow();
  await itx.append({ type: "events.iterate.com/stream/resumed" });
  expect(await itx.secrets.list()).toEqual([]);
  const res = await itx.fetch(
    new Request("https://egress.invalid/", {
      headers: { authorization: 'getSecret("/secrets/ghost")' },
    }),
  );
  expect(res.status).toBe(502); // the refused set stored no value, so the door finds none for `ghost` and refuses before the terminal fetch — the request never leaves
});
