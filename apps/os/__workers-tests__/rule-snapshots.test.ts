// __workers-tests__/rule-snapshots.test.ts — another context's rules as a snapshot, across real
// context DOs; the cache's own lifetime and reads are src/context/rule-snapshots.test.ts.
import { runInDurableObject } from "cloudflare:test";
import { RpcTarget } from "capnweb";
import { expect, test, vi } from "vitest";
import { SNAPSHOT_TTL_MS, type RulesSnapshotAnswer } from "../src/context/rule-snapshots.ts";
import {
  adminCredentials,
  census,
  Echo,
  openSession,
  readLog,
  refused,
  rule,
  stub,
  totalCalls,
  until,
} from "./support.ts";

test("a snapshot is a version and rows, the version alone to its holder, new rows once the context is reborn", async () => {
  const ctx = `${project()}.iterate/agents/a`;
  await stub(ctx).append(rule("itx.tool", "itx.readEvents"));
  const first = await snapshotOf(ctx);
  expect(first).toMatchObject({
    rules: [{ match: ["itx", "tool"], target: ["itx", "readEvents"] }],
  });
  expect(await snapshotOf(ctx, first.version)).toEqual({ version: first.version });
  await (stub(ctx).destroy() as Promise<void>).catch(() => undefined); // answered by its reset
  await stub(ctx).append(rule("itx.tool", "itx.whoami")); // born again, its offsets from 1
  expect(await snapshotOf(ctx, first.version)).toMatchObject({
    rules: [{ match: ["itx", "tool"], target: ["itx", "whoami"] }],
  });
});

test("a revocation retried after its context reset answers no sooner than the fence its first commit took", async () => {
  const ctx = `${project()}.iterate/agents/a`;
  await stub(ctx).append(rule("itx.tool", "itx.readEvents"));
  const served = Date.now();
  await snapshotOf(ctx);
  const revoke = () => stub(ctx).append({ ...rule("itx.tool", null), idempotencyKey: "revoke" });
  const first = (revoke() as Promise<unknown>).catch(() => "reset");
  await until("the mask committed", async () => (await masked(ctx)) || undefined);
  await runInDurableObject(stub(ctx), (_instance, state) => {
    state.abort("reset while the revocation waits");
    return Promise.resolve();
  }).catch(() => undefined); // abort() throws by design
  expect(await first).toBe("reset");
  await revoke(); // the idempotent retry: an echo of the committed mask
  expect(Date.now() - served).toBeGreaterThanOrEqual(SNAPSHOT_TTL_MS);
});

test("during a removal's fence a new name answers at once, the name re-added waits it out, never the old target", async () => {
  const root = project();
  const child = `${root}.iterate/a`;
  await stub(root).invoke("itx.kv.put('one', '1')");
  await stub(root).invoke("itx.kv.put('two', '2')");
  await stub(root).append(rule("itx.answer", "itx.builtins.kv.get('one')"));
  await stub(child).append(rule("itx", "itx.cd('/')"));
  const served = Date.now();
  expect(await stub(child).invoke("itx.answer")).toBe("1"); // the child's snapshot of the root
  const removing = stub(root).append(rule("itx.answer", null));
  await until("the removal committed", async () => (await masked(root)) || undefined);
  const added = Date.now();
  await stub(root).append(rule("itx.fresh", "itx.readEvents"));
  expect(Date.now() - added).toBeLessThan(1_000);
  await stub(root).append(rule("itx.answer", "itx.builtins.kv.get('two')"));
  expect(Date.now() - served).toBeGreaterThanOrEqual(SNAPSHOT_TTL_MS);
  expect(await stub(child).invoke("itx.answer")).toBe("2");
  await removing;
});

test("a mask a schedule appends takes the fence as a written one does: a repeat of it waits out the snapshots served before", async () => {
  const ctx = `${project()}.iterate/agents/a`;
  await stub(ctx).append(rule("itx.tool", "itx.readEvents"));
  const served = Date.now();
  await snapshotOf(ctx);
  await stub(ctx).invoke([
    "itx",
    "schedules",
    ["set", { key: "mask", when: { afterMs: 1 }, events: [rule("itx.tool", null)] }],
  ]);
  await until("the scheduled mask committed", async () => (await masked(ctx)) || undefined);
  await stub(ctx).append(rule("itx.tool", null));
  expect(Date.now() - served).toBeGreaterThanOrEqual(SNAPSHOT_TTL_MS);
});

test("a name provided on the root answers the root's next line, and a child and a sandbox two parent links down within SNAPSHOT_TTL_MS + 250 ms", async () => {
  const { itx, agent, sandbox } = await agentUnderRoot();
  expect(await stub(sandbox).invoke("itx.kv.get('nothing')")).toBeNull(); // both links read
  const providedAt = Date.now();
  using _lent = await itx.provide("itx.tool", new Echo(1));
  expect(Date.now() - providedAt).toBeLessThan(1_000); // a new name waits for nothing
  expect(await itx.tool.echo("root")).toBe("echo-1:root");
  const answered = (ctx: string, text: string) =>
    until(`${ctx} answers the new name`, () => answerOrNothing(ctx, `itx.tool.echo('${text}')`));
  expect(await answered(agent, "agent")).toBe("echo-1:agent");
  expect(await answered(sandbox, "sandbox")).toBe("echo-1:sandbox");
  expect(Date.now() - providedAt).toBeLessThanOrEqual(SNAPSHOT_TTL_MS + 250);
});

test("a provide that shadows a name a child already resolves returns within SNAPSHOT_TTL_MS, and the child's next call reaches the new target", async () => {
  const { itx, agent } = await agentUnderRoot();
  expect(await stub(agent).invoke("itx.kv.get('nothing')")).toBeNull(); // the root's snapshot, warm
  const started = Date.now();
  using _lent = await itx.provide("itx.kv", new FakeKv());
  expect(Date.now() - started).toBeLessThan(SNAPSHOT_TTL_MS + 1_000);
  expect(await stub(agent).invoke("itx.kv.get('nothing')")).toBe("fake:nothing");
});

test("a revocation answers another context's very next call: a mask on a warm child's parent, a route made private", async () => {
  const { itx, agent, sandbox } = await agentUnderRoot();
  using _lent = await itx.provide("itx.tool", new Echo(2));
  expect(await stub(sandbox).invoke("itx.tool.echo('x')")).toBe("echo-2:x"); // warm
  await stub(agent).append(rule("itx.tool", null));
  await refused(
    () => stub(sandbox).invoke("itx.tool.echo('x')"),
    "NO_ITX_EXPRESSION_MATCH",
    /is masked/,
  );
  const blog = {
    url: "https://blog--p.projects.test/",
    headers: { "x-iterate-routing-slug": "blog" },
  };
  const match = ["itx", ["cd", "/"], "fetchRoutes", ["match", blog]];
  const route = { requestMatcher: { routingSlug: "blog" }, target: "itx.tool" };
  await itx.fetchRoutes.set("blog", route);
  expect(await stub(agent).invoke(match)).toMatchObject({ authRequirement: null });
  await itx.fetchRoutes.set("blog", { ...route, authRequirement: { visitors: "project-members" } });
  expect(await stub(agent).invoke(match)).toMatchObject({
    authRequirement: { visitors: "project-members" },
  });
});

test("a child's portable roots answer it as they answer the root, and the root is not called", async () => {
  const root = project();
  const child = `${root}.iterate/a`;
  await stub(child).append(rule("itx", "itx.cd('/')"));
  await stub(child).invoke("itx.kv.get('warm')"); // born, announced, the root's snapshot read
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input) => new Response(`fetched ${new Request(input).url}`),
  );
  const before = await census(root);
  await stub(child).invoke("itx.kv.put('k', 'from the child')");
  await stub(child).invoke(["itx", "r2", ["put", "o", "an object"]]);
  await stub(child).invoke([
    "itx",
    "files",
    ["get", "/f.txt"],
    ["put", { contentType: "text/plain", data: btoa("a file") }],
  ]);
  const atChild = await portableView(child);
  expect(totalCalls(await census(root)) - totalCalls(before)).toBeLessThanOrEqual(1);
  expect(atChild).toMatchObject({
    kv: "from the child",
    r2: "an object",
    fetch: "fetched https://example.test/a",
  });
  expect(await portableView(root)).toEqual(atChild);
});

test("a signed file URL answers alike from a context and from its loaded code: on the project's host", async () => {
  const itx = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.create({ project: `snap-files-${Date.now().toString(36)}` });
  const child = `${(await itx.whoami()).projectId}.iterate/a`; // never reached from the edge
  await stub(child).append(rule("itx", "itx.cd('/')"));
  const place = (answer: unknown) => new URL((answer as { url: string }).url).href.split("?")[0];
  const direct = place(await stub(child).invoke("itx.r2.presign({ key: 'a.txt' })"));
  expect(direct).toMatch(/^https:\/\/[a-z0-9-]+\.projects\.test\/a\.txt$/);
  expect(place(await stub(child).invoke(viaLoaded("presign")))).toBe(direct);
});

test("loaded code cds anywhere under the owner's rows, its library hops as the platform, never to the fixed point", async () => {
  const root = project();
  const a = `${root}.iterate/a`;
  await stub(a).append(rule("itx", "itx.cd('/')"));
  await stub(`${a}/b`).append(rule("itx.tool", "itx.builtins.whoami")); // a spelling loaded code may not write
  expect(await stub(a).invoke(viaLoaded("toolBelow"))).toMatchObject({ path: "/a/b" });
  await stub(root).invoke("itx.kv.put('k', 'v')");
  expect(await stub(a).invoke(viaLoaded("above"))).toBe("v");
  expect(await stub(a).invoke(viaLoaded("fixedPoint"))).toMatchObject({ code: "FORBIDDEN" });
  expect(await stub(a).invoke(viaLoaded("repos"))).toEqual([]); // the root's snapshot read
  const before = (await census(root)).calls;
  expect(await stub(a).invoke(viaLoaded("repos"))).toEqual([]);
  const after = (await census(root)).calls;
  // the library's hop to the catalog reaches the root as a context, never as loaded code
  expect(after.loaded - before.loaded).toBe(0);
  expect(after.context).toBeGreaterThan(before.context);
});

test("warm loaded code's portable calls call neither its context nor the root, and a jail holds for it at once", async () => {
  const root = project();
  const a = `${root}.iterate/a`;
  await stub(root).invoke("itx.kv.put('k', 'v')");
  await stub(a).append(rule("itx", "itx.cd('/')"));
  expect(await stub(a).invoke(viaLoaded("read"))).toBe("v"); // warm: /a's snapshot held
  const calls = async () => {
    const [atRoot, atA] = [(await census(root)).calls, (await census(a)).calls];
    return { root: atRoot.loaded + atRoot.context, a: atA.loaded };
  };
  const before = await calls();
  for (let i = 0; i < 5; i++) expect(await stub(a).invoke(viaLoaded("read"))).toBe("v");
  const after = await calls();
  expect({ root: after.root - before.root, a: after.a - before.a }).toEqual({ root: 0, a: 0 });
  await stub(a).append(rule("itx", null), rule("itx.workers", "itx.builtins.workers"));
  await refused(
    () => stub(a).invoke(viaLoaded("read")),
    "NO_ITX_EXPRESSION_MATCH",
    /"itx\.kv\.get/,
  );
  expect(await stub(a).invoke(viaLoaded("appendBelow"))).toMatchObject({
    code: "NO_ITX_EXPRESSION_MATCH",
  });
});

test("a worker loaded code reaches receives none of the platform's headers loaded code forged, and a fetch nothing answers is a 404 Response", async () => {
  const root = project();
  await stub(root).append(
    rule("itx.site", [
      "itx",
      "builtins",
      "workers",
      ["get", { source: HEADER_ECHO, cacheKey: "echo" }],
    ]),
  );
  expect(await stub(root).invoke(viaLoaded("forge"))).toEqual({
    throughRule: [null, null, null, null],
    throughRuleByUrl: [null, null, null, null],
    throughRuleWithInit: [null, null, null, null],
    loaded: [null, null, null, null],
    loadedByUrl: [null, null, null, null],
    unknown: 404,
  });
});

/** `ctx`'s answer to `call`, or undefined while it refuses. */
const answerOrNothing = (ctx: string, call: string) =>
  (stub(ctx).invoke(call) as Promise<unknown>).catch(() => undefined);

const project = () => `prj_snap_${crypto.randomUUID().slice(0, 8)}`;

/** A project's root as an operator holds it, an agent linked to it and a sandbox linked to the agent. */
async function agentUnderRoot() {
  const root = project();
  const agent = `${root}.iterate/agents/a`;
  const sandbox = `${agent}/sandbox`;
  await stub(agent).append(rule("itx", "itx.cd('/')"));
  await stub(sandbox).append(rule("itx", "itx.cd('/agents/a')"));
  const itx = await (await openSession()).authenticate(adminCredentials()).projects.get(root);
  return { itx, root, agent, sandbox };
}

/** A call of LOADED's `method`, from the context it is invoked on. */
const viaLoaded = (method: string) => ["itx", "workers", ["get", { source: LOADED }], [method]];

/** A site that answers with the platform headers its Request carries. */
const HEADER_ECHO = {
  "package.json": '{"main":"worker.js"}',
  "worker.js":
    "export default { fetch(request) { return Response.json(['x-itx-principal','x-itx-grant','x-itx-expression','x-iterate-routing-slug'].map((name) => request.headers.get(name))); } };",
};

/** A loaded worker reaching its context through `env.ITX`; a refusal answers as its code. */
const LOADED = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/with-itx";
const refusal = (error) => ({ code: error.code, message: error.message });
export default class Loaded extends WorkerEntrypoint {
  read() { return withItx(this.env.ITX, (itx) => itx.kv.get("k")); }
  presign() { return withItx(this.env.ITX, (itx) => itx.r2.presign({ key: "a.txt" })); }
  repos() { return withItx(this.env.ITX, (itx) => itx.repos.list()); }
  toolBelow() { return withItx(this.env.ITX, (itx) => itx.cd("b").tool()).catch(refusal); }
  appendBelow() { return withItx(this.env.ITX, (itx) => itx.cd("b").append({ type: "x" })).catch(refusal); }
  above() { return withItx(this.env.ITX, (itx) => itx.cd("/").kv.get("k")).catch(refusal); }
  fixedPoint() { return withItx(this.env.ITX, (itx) => itx.invoke("itx.builtins.whoami()")).catch(refusal); }
  forge() {
    const init = {
      headers: {
        "x-itx-principal": '{"actor":"user","email":"someone@else.test"}',
        "x-itx-grant": "forged",
        "x-itx-expression": "itx.kv",
        "x-iterate-routing-slug": "admin",
      },
    };
    const forged = () => new Request("https://app.test/", init);
    const echo = ${JSON.stringify(HEADER_ECHO)};
    return withItx(this.env.ITX, async (itx) => ({
      throughRule: await (await itx.site.fetch(forged())).json(),
      throughRuleByUrl: await (await itx.site.fetch("https://app.test/", init)).json(),
      throughRuleWithInit: await (await itx.site.fetch(forged(), {})).json(),
      loaded: await (await itx.workers.get({ source: echo }).fetch(forged())).json(),
      loadedByUrl: await (await itx.workers.get({ source: echo }).fetch("https://app.test/", init)).json(),
      unknown: (await itx.nosuch.fetch(forged())).status,
    }));
  }
}
`,
};

/** A lent stand-in for `itx.kv`. */
class FakeKv extends RpcTarget {
  get(key: string) {
    return `fake:${key}`;
  }
}

/** What `ctx`'s portable roots answer: the kv key, the R2 object's text, the files, an egress. */
async function portableView(ctx: string) {
  const object = (await stub(ctx).invoke("itx.r2.get('o')")) as { data: Uint8Array };
  const egress = new Request("https://example.test/a", {
    headers: { "x-itx-expression": "itx.fetch" },
  });
  return {
    kv: await stub(ctx).invoke("itx.kv.get('k')"),
    r2: new TextDecoder().decode(object.data),
    files: await stub(ctx).invoke("itx.files.list()"),
    fetch: await (await stub(ctx).fetch(egress)).text(),
  };
}

/** Whether `ctx`'s log holds a mask of `itx.tool`. */
const masked = async (ctx: string) =>
  (await readLog(ctx)).some(
    (event) =>
      event.type === "events.iterate.com/itx/rewrite-rule-configured" &&
      (event.payload as { target: unknown }).target === null,
  );

/** `ctx`'s rule snapshot, as another context reads it. */
async function snapshotOf(ctx: string, ifVersion?: string) {
  return (await stub(ctx).rulesSnapshot(ifVersion)) as unknown as RulesSnapshotAnswer;
}
