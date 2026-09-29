// __workers-tests__/rule-snapshots.test.ts — ANOTHER CONTEXT'S RULES, AS A SNAPSHOT, across real
// context Durable Objects (context/rule-snapshots.ts): what a context serves as its snapshot, the
// write that waits out the snapshots it served, and a call that crosses contexts through them. The
// cache's own rules (lifetime, conditional and single-flight reads) are unit rows beside it.
import { runInDurableObject } from "cloudflare:test";
import { RpcTarget } from "capnweb";
import { expect, test, vi } from "vitest";
import { SNAPSHOT_TTL_MS, type RulesSnapshotAnswer } from "../src/context/rule-snapshots.ts";
import { adminCredentials, Echo, openSession, readLog, refused, stub, until } from "./support.ts";

test("a context's snapshot is its version and rows, sources and all, its version alone when the reader holds it; the same row again moves no version", async () => {
  const ctx = `prj_snap_${crypto.randomUUID().slice(0, 8)}.iterate/agents/a`;
  await stub(ctx).append(
    rule("itx.tool", "itx.readEvents"),
    rule("itx.agents", [
      "itx",
      "builtins",
      "facets",
      ["get", "agents", { className: "C", source: { "worker.js": "export default 1" } }],
    ]),
  );
  const first = await snapshotOf(ctx);
  expect(first).toMatchObject({
    rules: [
      { match: ["itx", "tool"], target: ["itx", "readEvents"] },
      {
        match: ["itx", "agents"],
        target: [
          "itx",
          "builtins",
          "facets",
          ["get", "agents", { className: "C", source: { "worker.js": "export default 1" } }],
        ],
      },
    ],
  });
  // a reinstall that restates its rules changes nothing a reader holds
  await stub(ctx).append(rule("itx.tool", "itx.readEvents"));
  expect(await snapshotOf(ctx, first.version)).toEqual({ version: first.version });
});

test("a context destroyed and born again serves versions no reader of its last life holds: the version a reader names is answered with the new rows", async () => {
  const ctx = `${project()}.iterate/agents/a`;
  await stub(ctx).append(rule("itx.tool", "itx.readEvents"));
  const last = await snapshotOf(ctx);
  await (stub(ctx).destroy() as Promise<void>).catch(() => undefined); // answered by its reset
  await stub(ctx).append(rule("itx.tool", "itx.whoami")); // born again, its offsets from 1
  expect(await snapshotOf(ctx, last.version)).toMatchObject({
    rules: [{ match: ["itx", "tool"], target: ["itx", "whoami"] }],
  });
});

test("a write that masks a name answers once every snapshot the context served has expired, and so does its repeat while it waits; a new name meanwhile answers at once", async () => {
  const ctx = `${project()}.iterate/agents/a`;
  await stub(ctx).append(rule("itx.tool", "itx.readEvents"));
  const served = Date.now();
  await snapshotOf(ctx);
  const first = (stub(ctx).append(rule("itx.tool", null)) as Promise<unknown>).then(() =>
    Date.now(),
  );
  await until("the first mask committed", async () => (await masked(ctx)) || undefined);
  const added = Date.now();
  await stub(ctx).append(rule("itx.fresh", "itx.readEvents"));
  expect(Date.now() - added).toBeLessThan(1_000);
  // the table is already masked: the repeat changes nothing, and still waits out the first's fence
  await stub(ctx).append(rule("itx.tool", null));
  expect(Date.now() - served).toBeGreaterThanOrEqual(SNAPSHOT_TTL_MS);
  expect((await first) - served).toBeGreaterThanOrEqual(SNAPSHOT_TTL_MS);
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

test("a name re-added while the fence of its removal is pending waits that fence out, and a reader never answers the old target after", async () => {
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

// ── a call across contexts: resolved through snapshots, run where its target lives ──

test("a context's own rules answer its next call at once: set, re-pointed, masked", async () => {
  const ctx = `${project()}.iterate/agents/a`;
  await stub(ctx).append(rule("itx.tool", "itx.whoami"));
  expect(await stub(ctx).invoke("itx.tool()")).toMatchObject({ path: "/agents/a" });
  await stub(ctx).append(rule("itx.tool", "itx.readEvents"));
  expect(await stub(ctx).invoke("itx.tool(0, 1)")).toMatchObject({ events: [{ offset: 1 }] });
  await stub(ctx).append(rule("itx.tool", null));
  await refused(() => stub(ctx).invoke("itx.tool()"), "NO_ITX_EXPRESSION_MATCH", /no rewrite rule/);
});

test("a hundred calls in 5 s from a child through the root's rules, a name the root has and one it lacks in turn, read the root at most twice", async () => {
  const root = project();
  const child = `${root}.iterate/a`;
  await stub(root).invoke("itx.kv.put('one', '1')");
  await stub(root).append(rule("itx.answer", "itx.builtins.kv.get('one')"));
  await stub(child).append(rule("itx", "itx.cd('/')"));
  expect(await stub(child).invoke("itx.answer")).toBe("1"); // born, announced, the snapshot read
  const before = await census(root);
  const answers = new Set<unknown>();
  for (let i = 0; i < 50; i++) {
    answers.add(await stub(child).invoke("itx.answer"));
    await refused(() => stub(child).invoke("itx.missing()"), "NO_ITX_EXPRESSION_MATCH");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const after = await census(root);
  expect([...answers]).toEqual(["1"]);
  expect(after).toMatchObject({ incarnation: before.incarnation });
  expect(totalCalls(after) - totalCalls(before)).toBeLessThanOrEqual(2);
});

test("a root rule re-pointed is seen from a child within SNAPSHOT_TTL_MS + 250 ms, and never the old target after", async () => {
  const root = project();
  const child = `${root}.iterate/a`;
  await stub(root).invoke("itx.kv.put('one', '1')");
  await stub(root).invoke("itx.kv.put('two', '2')");
  await stub(root).append(rule("itx.answer", "itx.builtins.kv.get('one')"));
  await stub(child).append(rule("itx", "itx.cd('/')"));
  expect(await stub(child).invoke("itx.answer")).toBe("1");
  const repointedAt = Date.now();
  const repointing = stub(root).append(rule("itx.answer", "itx.builtins.kv.get('two')"));
  await until("the child answers the new target", async () =>
    (await stub(child).invoke("itx.answer")) === "2" ? true : undefined,
  );
  expect(Date.now() - repointedAt).toBeLessThanOrEqual(SNAPSHOT_TTL_MS + 250);
  await repointing;
  const afterwards = new Set<unknown>();
  for (let i = 0; i < 20; i++) afterwards.add(await stub(child).invoke("itx.answer"));
  expect([...afterwards]).toEqual(["2"]);
});

test("a name provided on the root answers the root's next line, and a child and a sandbox two parent links down within SNAPSHOT_TTL_MS + 250 ms", async () => {
  const { itx, agent, sandbox } = await agentUnderRoot();
  // both links read, the snapshots warm and without the name
  expect(await stub(sandbox).invoke("itx.kv.get('nothing')")).toBeNull();
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

test("a subscription the root's snapshot refused is delivered once that snapshot expires, with no commit of its own to wake it", async () => {
  const { itx, agent } = await agentUnderRoot();
  expect(await stub(agent).invoke("itx.kv.get('nothing')")).toBeNull(); // the root's snapshot, warm
  await stub(agent).append(
    {
      type: "events.iterate.com/itx/subscription-configured",
      payload: { name: "tool", target: "itx.cd('/').tool.echo", consumes: ["demo/ping"] },
    },
    { type: "demo/ping" },
  ); // refused: the snapshot has no `itx.tool`
  const tool = new Recorder();
  using _lent = await itx.provide("itx.tool", tool);
  await until("the ping reached the root's tool", () => tool.batches.length > 0);
});

test("a provide that shadows a name a child already resolves returns within SNAPSHOT_TTL_MS, and the child's next call reaches the new target", async () => {
  const { itx, agent } = await agentUnderRoot();
  // the child resolves the root's names through a snapshot it read just now
  expect(await stub(agent).invoke("itx.kv.get('nothing')")).toBeNull();
  const started = Date.now();
  using _lent = await itx.provide("itx.kv", new FakeKv());
  expect(Date.now() - started).toBeLessThan(SNAPSHOT_TTL_MS + 1_000);
  expect(await stub(agent).invoke("itx.kv.get('nothing')")).toBe("fake:nothing");
});

test("a revocation answers the very next call from another context: a mask on a warm child's parent, a provide withdrawn, a route made private", async () => {
  const { itx, root, agent, sandbox } = await agentUnderRoot();
  using _lent = await itx.provide("itx.tool", new Echo(2));
  expect(await stub(sandbox).invoke("itx.tool.echo('x')")).toBe("echo-2:x"); // warm
  // the agent masks the root's tool for everything beneath it: the sandbox's snapshot of the agent
  // still grants it until the mask returns
  await stub(agent).append(rule("itx.tool", null));
  await refused(
    () => stub(sandbox).invoke("itx.tool.echo('x')"),
    "NO_ITX_EXPRESSION_MATCH",
    /is masked/,
  );

  await itx.provide("itx.other", new Echo(3));
  expect(
    await until("the new name answers another context", () =>
      answerOrNothing(`${root}.iterate/x`, "itx.cd('/').other.echo('y')"),
    ),
  ).toBe("echo-3:y");
  await itx.provide("itx.other", null);
  await refused(
    () => stub(`${root}.iterate/x`).invoke("itx.cd('/').other.echo('y')"),
    "NO_ITX_EXPRESSION_MATCH",
    /no rewrite rule matches/,
  );

  const match = [
    "itx",
    ["cd", "/"],
    "fetchRoutes",
    [
      "match",
      { url: "https://blog--p.projects.test/", headers: { "x-iterate-routing-slug": "blog" } },
    ],
  ];
  await itx.fetchRoutes.set("blog", {
    requestMatcher: { routingSlug: "blog" },
    target: "itx.tool",
  });
  expect(await stub(agent).invoke(match)).toMatchObject({ authRequirement: null });
  await itx.fetchRoutes.set("blog", {
    requestMatcher: { routingSlug: "blog" },
    target: "itx.tool",
    authRequirement: { visitors: "project-members" },
  });
  expect(await stub(agent).invoke(match)).toMatchObject({
    authRequirement: { visitors: "project-members" },
  });
});

test("the portable roots answer a child through the parent link exactly as they answer the root, and the root is not called for them", async () => {
  const root = project();
  const child = `${root}.iterate/a`;
  await stub(child).append(rule("itx", "itx.cd('/')"));
  await stub(child).invoke("itx.kv.get('warm')"); // born, announced, the root's snapshot read
  const fetches = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => new Response(`fetched ${new Request(input).url}`));
  const before = await census(root);
  await stub(child).invoke("itx.kv.put('k', 'from the child')");
  await stub(child).invoke(["itx", "r2", ["put", "o", "an object"]]);
  await stub(child).invoke([
    "itx",
    "files",
    ["get", "/f.txt"],
    ["put", { contentType: "text/plain", data: btoa("a file") }],
  ]);
  const atChild = {
    kv: await stub(child).invoke("itx.kv.get('k')"),
    r2: textOf(await stub(child).invoke("itx.r2.get('o')")),
    files: await stub(child).invoke("itx.files.list()"),
    fetch: await (await stub(child).fetch(fetchThrough("https://example.test/a"))).text(),
  };
  const after = await census(root);
  expect(totalCalls(after) - totalCalls(before)).toBeLessThanOrEqual(1);
  expect({
    kv: await stub(root).invoke("itx.kv.get('k')"),
    r2: textOf(await stub(root).invoke("itx.r2.get('o')")),
    files: await stub(root).invoke("itx.files.list()"),
    fetch: await (await stub(root).fetch(fetchThrough("https://example.test/a"))).text(),
  }).toEqual(atChild);
  expect(atChild).toMatchObject({
    kv: "from the child",
    r2: "an object",
    fetch: "fetched https://example.test/a",
  });
  expect(fetches).toHaveBeenCalledTimes(2);
});

test("loaded code's portable calls run in its stateless entrypoint: neither its own context nor the root its parent link reaches them through is called", async () => {
  const root = project();
  const child = `${root}.iterate/a`;
  await stub(root).invoke("itx.kv.put('k', 'v')");
  await stub(child).append(rule("itx", "itx.cd('/')"));
  const read = ["itx", "workers", ["get", { source: LOADED }], ["read"]];
  expect(await stub(child).invoke(read)).toBe("v"); // loaded, the snapshots read
  const [rootBefore, childBefore] = [await census(root), await census(child)];
  for (let i = 0; i < 5; i++) expect(await stub(child).invoke(read)).toBe("v");
  const [rootAfter, childAfter] = [await census(root), await census(child)];
  expect({
    root: {
      loaded: rootAfter.calls.loaded - rootBefore.calls.loaded,
      context: rootAfter.calls.context - rootBefore.calls.context,
    },
    child: { loaded: childAfter.calls.loaded - childBefore.calls.loaded },
  }).toEqual({ root: { loaded: 0, context: 0 }, child: { loaded: 0 } });
});

test("the library's hops from loaded code are the platform's: its `itx.repos.list()` reaches the root as a context, never as loaded code", async () => {
  const root = project();
  const a = `${root}.iterate/a`;
  await stub(a).append(rule("itx", "itx.cd('/')"));
  const repos = ["itx", "workers", ["get", { source: LOADED }], ["repos"]];
  expect(await stub(a).invoke(repos)).toEqual([]); // loaded, the snapshots read
  const before = await census(root);
  expect(await stub(a).invoke(repos)).toEqual([]);
  const after = await census(root);
  // the collection's own facet calls its context too, so `context` counts more than the hop
  expect({
    loaded: after.calls.loaded - before.calls.loaded,
    asContext: after.calls.context > before.calls.context,
  }).toEqual({ loaded: 0, asContext: true });
});

test("a signed file URL answers alike from a context and from its loaded code, one check behind both: on the project's host, at the platform's own origin when no caller named one", async () => {
  const itx = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.create({ project: `snap-files-${Date.now().toString(36)}` });
  const child = `${(await itx.whoami()).projectId}.iterate/a`; // never reached from the edge
  await stub(child).append(rule("itx", "itx.cd('/')"));
  const direct = await stub(child).invoke("itx.r2.presign({ key: 'a.txt' })");
  const loaded = await stub(child).invoke([
    "itx",
    "workers",
    ["get", { source: LOADED }],
    ["presign"],
  ]);
  const place = (answer: unknown) => new URL((answer as { url: string }).url).href.split("?")[0];
  expect(place(direct)).toMatch(/^https:\/\/[a-z0-9-]+\.projects\.test\/a\.txt$/);
  expect(place(loaded)).toBe(place(direct));
});

test("loaded code's cd reaches the context it names, above it too, which honours its owner's rows; the app wall refuses the fixed point at the entrypoint as at the context", async () => {
  const root = project();
  const a = `${root}.iterate/a`;
  const b = `${root}.iterate/a/b`;
  // the owner of /a/b says what `itx.tool` is there, in a spelling loaded code may not write
  await stub(b).append(rule("itx.tool", "itx.builtins.whoami"));
  const loaded = (method: string) => ["itx", "workers", ["get", { source: LOADED }], [method]];
  expect(await stub(a).invoke(loaded("toolBelow"))).toMatchObject({ path: "/a/b" });
  // a cd above the context reads there; the wall is the fixed point alone
  await stub(root).invoke("itx.kv.put('k', 'v')");
  expect(await stub(a).invoke(loaded("above"))).toBe("v");
  expect(await stub(a).invoke(loaded("fixedPoint"))).toMatchObject({ code: "FORBIDDEN" });
  // a jail's own table — its code granted `workers` alone — refuses the cd, live, in the jail
  const jail = `${root}.iterate/jail`;
  await stub(jail).append(rule("itx", null), rule("itx.workers", "itx.builtins.workers"));
  expect(await stub(jail).invoke(loaded("toolBelow"))).toMatchObject({
    code: "NO_ITX_EXPRESSION_MATCH",
  });
});

test("loaded code reads its own context's table as a snapshot, and a narrowing holds for it once the write answers: a warm worker in a context just jailed is refused its next read and its next cd append", async () => {
  const root = project();
  const a = `${root}.iterate/a`;
  await stub(root).invoke("itx.kv.put('k', 'v')");
  await stub(a).append(rule("itx", "itx.cd('/')"));
  const loaded = (method: string) => ["itx", "workers", ["get", { source: LOADED }], [method]];
  expect(await stub(a).invoke(loaded("read"))).toBe("v"); // warm: /a's snapshot held
  // the jail — its code granted `workers` alone — answers once that snapshot has expired
  await stub(a).append(rule("itx", null), rule("itx.workers", "itx.builtins.workers"));
  await refused(() => stub(a).invoke(loaded("read")), "NO_ITX_EXPRESSION_MATCH", /"itx\.kv\.get/);
  expect(await stub(a).invoke(loaded("appendBelow"))).toMatchObject({
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
  const loaded = ["itx", "workers", ["get", { source: LOADED }], ["forge"]];
  expect(await stub(root).invoke(loaded)).toEqual({
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

/** A fresh project id. */
const project = () => `prj_snap_${crypto.randomUUID().slice(0, 8)}`;

/** A project's root as a signed-in operator holds it, an agent linked to the root and its sandbox
 *  linked to the agent — the parent links the agents collection writes. */
async function agentUnderRoot() {
  const root = project();
  const agent = `${root}.iterate/agents/a`;
  const sandbox = `${agent}/sandbox`;
  await stub(agent).append(rule("itx", "itx.cd('/')"));
  await stub(sandbox).append(rule("itx", "itx.cd('/agents/a')"));
  const itx = await (await openSession()).authenticate(adminCredentials()).projects.get(root);
  return { itx, root, agent, sandbox };
}

/** A loaded worker reaching its context through `env.ITX`: `read()` a portable root, `presign()` a
 *  file URL, `repos()` the library's collection, `toolBelow()` a name its child `./b` defines,
 *  `appendBelow()` an append there, `above()` a read above its context, `fixedPoint()` the reserved
 *  root. A refusal answers as its code. */
const LOADED = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/with-itx";
const refusal = (error) => ({ code: error.code, message: error.message });
export default class Loaded extends WorkerEntrypoint {
  read() {
    return withItx(this.env.ITX, (itx) => itx.kv.get("k"));
  }
  presign() {
    return withItx(this.env.ITX, (itx) => itx.r2.presign({ key: "a.txt" }));
  }
  repos() {
    return withItx(this.env.ITX, (itx) => itx.repos.list());
  }
  toolBelow() {
    return withItx(this.env.ITX, (itx) => itx.cd("b").tool()).catch(refusal);
  }
  appendBelow() {
    return withItx(this.env.ITX, (itx) => itx.cd("b").append({ type: "x" })).catch(refusal);
  }
  above() {
    return withItx(this.env.ITX, (itx) => itx.cd("/").kv.get("k")).catch(refusal);
  }
  fixedPoint() {
    return withItx(this.env.ITX, (itx) => itx.invoke("itx.builtins.whoami()")).catch(refusal);
  }
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
    const echo = ${JSON.stringify({ "package.json": '{"main":"worker.js"}', "worker.js": "export default { fetch(request) { return Response.json(['x-itx-principal','x-itx-grant','x-itx-expression','x-iterate-routing-slug'].map((name) => request.headers.get(name))); } };" })};
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

/** A site that answers with the platform headers its Request carries. */
const HEADER_ECHO = {
  "package.json": '{"main":"worker.js"}',
  "worker.js":
    "export default { fetch(request) { return Response.json(['x-itx-principal','x-itx-grant','x-itx-expression','x-iterate-routing-slug'].map((name) => request.headers.get(name))); } };",
};

/** A lent tool that keeps each batch a subscription pushes it. */
class Recorder extends RpcTarget {
  readonly batches: unknown[] = [];
  echo(events: unknown) {
    this.batches.push(events);
  }
}

/** A lent stand-in for `itx.kv`. */
class FakeKv extends RpcTarget {
  get(key: string) {
    return `fake:${key}`;
  }
}

/** The root's census: its incarnation and inbound calls by kind. */
const census = (root: string) => stub(root).inboundCallCensus();

const totalCalls = ({ calls }: Awaited<ReturnType<typeof census>>) =>
  calls.loaded + calls.context + calls.other;

/** An R2 object as the built-in answers it, its bytes as text. */
const textOf = (object: unknown) => new TextDecoder().decode((object as { data: Uint8Array }).data);

/** An expression fetch of `itx.fetch` with a Request to `url`: egress, as a loaded worker's raw
 *  `fetch` reaches it. */
const fetchThrough = (url: string) =>
  new Request(url, { headers: { "x-itx-expression": "itx.fetch" } });

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

/** A `rewrite-rule-configured` literal: `match ⇒ target`, `null` a mask. */
function rule(match: string, target: string | unknown[] | null) {
  return { type: "events.iterate.com/itx/rewrite-rule-configured", payload: { match, target } };
}
