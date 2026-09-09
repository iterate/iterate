// workers-and-facets.e2e.test.ts — LOADING CODE: one door per host kind. `itx.workers.get({ source })`
// (a stateless WorkerEntrypoint — its spec is its address) and `itx.facets.get(name, { source,
// className })` (a DurableObject hosted as the durable facet `name`; `itx.facets.get(name)` addresses
// a RUNNING facet). The SOURCE is the worker's MODULES (module name → code, `"cap.js"` the main
// module), handed over at the load site — no bare-lambda sugar, every source exports its host; or an
// EXPRESSION producing the modules, only under a required `cacheKey`. Pins:
//   • a stateless run, a durable named facet whose state persists across calls, address by bare name,
//     independent state per instance name; modules handed over inline call back into itx via env.ITX
//   • a producer source with a cacheKey runs ONCE per cold isolate (a warm key never re-runs it, a new
//     key does, no key is refused) — for a worker and for a facet (the memo keeps the key for the bare
//     name); a producer that THREW never poisons the key: the next attempt loads under the id's next
//     generation (worker-loader.ts `loaderIdGenerations`), at both doors and through the memo
//   • dialing a REMOTE capnweb API is USERSPACE: a loaded WorkerEntrypoint imports capnweb's client
//     from the SDK (`./processor.js`), reads the remote's url from Cloudflare's own `ctx.props`, and
//     dials ONE one-shot HTTP batch per chain through egress (no built-in, no persistent socket, so the
//     remote never pins the context DO) — behind a rewrite rule by name; the remote is THIS worker's own
//     /api (another project), so the proof runs identically locally and deployed
//   • DYNAMIC WORKER → DYNAMIC WORKER mid-chain pipelining: `facets.get(name, spec).demo.timer
//     .callLater(ms, cb)` — every mid-path handle is a branded RpcTarget (context/expression.ts),
//     never a bare Proxy (NonPipelinable over Workers RPC, workerd#6873) — and the callback fires back
//     inside the caller, on the capnweb lane AND from worker B via env.ITX.get()
//   • Kenton's persistent-stub machinery IN USE: a hosted DO stores its live itx handle (the
//     ctx.exports-minted ItxEntrypoint stub) in its OWN storage and the handle read back replays the
//     restore chain on use — storage.put throws for any non-restorable stub, so put succeeding + the
//     restored call answering IS the proof

import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { adminCredentials, freshCtx, openItx, until, workerUrl } from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";

// ── the two doors and their sources ──

// A loaded SOURCE exports its host — here a WorkerEntrypoint whose `run` is `body`.
const entrypoint = (body: string) =>
  `import { WorkerEntrypoint } from "cloudflare:workers";\nexport default class extends WorkerEntrypoint { ${body} }`;

test("itx.workers.get({ source: src }) (stateless) + itx.facets.get(name, spec) (durable facet) + itx.facets.get(name)", async () => {
  const itx = openItx(freshCtx("load"));

  // The two sources, handed over INLINE — each EXPORTS its host object (the contract): a
  // WorkerEntrypoint or a DurableObject class. No host-injected wrapper.
  const SRC_GREET = JSON.stringify({
    "cap.js": entrypoint("async run(name) { return `hi ${name}`; }"),
  });
  const SRC_COUNTER = JSON.stringify({
    "cap.js": `import { DurableObject } from "cloudflare:workers";
export class CounterDurableObject extends DurableObject {
  async bump() { const n = ((await this.ctx.storage.get('n')) ?? 0) + 1; await this.ctx.storage.put('n', n); return n; }
  async value() { return (await this.ctx.storage.get('n')) ?? 0; }
}`,
  });

  // 1. STATELESS: workers.get({ source }) → a WorkerEntrypoint isolate, run it.
  expect(await itx.invoke(`itx.workers.get({ source: ${SRC_GREET} }).run('jonas')`)).toBe(
    "hi jonas",
  );

  // 2. DURABLE NAMED: facets.get('c1', { source, className: 'CounterDurableObject' }) → a facet named 'c1' whose
  //    state persists across calls.
  await itx.invoke(
    `itx.facets.get('c1', { source: ${SRC_COUNTER}, className: 'CounterDurableObject' }).bump()`,
  );
  expect(
    await itx.invoke(
      `itx.facets.get('c1', { source: ${SRC_COUNTER}, className: 'CounterDurableObject' }).bump()`,
    ),
  ).toBe(2);

  // 3. ADDRESS BY NAME: itx.facets.get('c1') reaches the SAME running instance with NO source (via
  //    the durable registration the hosting call wrote).
  expect(await itx.invoke(`itx.facets.get('c1').value()`)).toBe(2);

  // 4. a DIFFERENT instance name is INDEPENDENT state.
  expect(
    await itx.invoke(
      `itx.facets.get('c2', { source: ${SRC_COUNTER}, className: 'CounterDurableObject' }).bump()`,
    ),
  ).toBe(1);
});

test("itx.workers.get takes the modules INLINE", async () => {
  const ctx = freshCtx("inline");
  const itx = openItx(ctx);

  // 1. THE source: the modules, handed over literally at the load site — nothing to fetch first.
  const inline = await itx.invoke([
    "itx",
    "workers",
    ["get", { source: { "cap.js": entrypoint("async run(x) { return x * 2; }") } }],
    ["run", 21],
  ]);
  expect(inline).toBe(42);

  // 2. inline code can call back into itx (env.ITX is bound in the confined isolate).
  const withItx = await itx.invoke([
    "itx",
    "workers",
    [
      "get",
      {
        source: {
          "cap.js": entrypoint(
            "async run() { const itx = await this.env.ITX.get(); return (await itx.whoami()).projectId; }",
          ),
        },
      },
    ],
    ["run"],
  ]);
  expect(withItx).toBe(ctx);
});

// ── a PRODUCER source behind a cacheKey: Cloudflare's `get(id, getCode)` contract, end to end ──

test("a source EXPRESSION with a cacheKey is produced ONCE per cold isolate — a warm key never re-runs it, a new key does, and no key is refused", async () => {
  const ctx = freshCtx("cachekey");
  const itx = openItx(ctx);
  // The producer: a LIVE code store the test holds, so every evaluation is countable. In a product it
  // is a build (`itx.build('todo')`) — the expensive thing the key exists to skip.
  class CodeStore extends RpcTarget {
    produced: string[] = [];
    get(name: string): Record<string, string> {
      this.produced.push(name);
      return { "cap.js": entrypoint(`async run(x) { return "${name}:" + x; }`) };
    }
  }
  const codeStore = new CodeStore();
  await itx.provide("itx.codeStore", codeStore);

  // 1. no key → refused at the door; the producer never ran
  await expect(
    itx.invoke(["itx", "workers", ["get", { source: "itx.codeStore.get('greet')" }], ["run", 1]]),
  ).rejects.toThrow(/needs a cacheKey/);
  expect(codeStore.produced).toEqual([]);

  // 2. with a key: the first call produces, the second rides the warm isolate
  const spec = { source: "itx.codeStore.get('greet')", cacheKey: "greet@v1" };
  expect(await itx.invoke(["itx", "workers", ["get", spec], ["run", 1]])).toBe("greet:1");
  expect(await itx.invoke(["itx", "workers", ["get", spec], ["run", 2]])).toBe("greet:2");
  expect(codeStore.produced).toEqual(["greet"]);

  // 3. a new key is a new isolate: produced again (the caller changed the code, so the key)
  expect(
    await itx.invoke([
      "itx",
      "workers",
      ["get", { source: "itx.codeStore.get('greet')", cacheKey: "greet@v2" }],
      ["run", 3],
    ]),
  ).toBe("greet:3");
  expect(codeStore.produced).toEqual(["greet", "greet"]);

  // 4. the same for a FACET: hosted from a producer, the state persists across calls and the
  //    producer ran once; the memo keeps the key so a bare `facets.get(name)` re-materializes it
  class FacetCodeStore extends RpcTarget {
    produced = 0;
    get(): Record<string, string> {
      this.produced++;
      return {
        "cap.js": `import { DurableObject } from "cloudflare:workers";
export class CounterDurableObject extends DurableObject {
  async bump() { const n = ((await this.ctx.storage.get('n')) ?? 0) + 1; await this.ctx.storage.put('n', n); return n; }
}`,
      };
    }
  }
  const facetCodeStore = new FacetCodeStore();
  await itx.provide("itx.facetCodeStore", facetCodeStore);
  const facetSpec = {
    source: "itx.facetCodeStore.get()",
    cacheKey: "counter@v1",
    className: "CounterDurableObject",
  };
  expect(await itx.invoke(["itx", "facets", ["get", "ck", facetSpec], ["bump"]])).toBe(1);
  expect(await itx.invoke(["itx", "facets", ["get", "ck", facetSpec], ["bump"]])).toBe(2);
  expect(await itx.invoke(["itx", "facets", ["get", "ck"], ["bump"]])).toBe(3);
  expect(facetCodeStore.produced).toBe(1);
});

// ── a producer that THREW: the key is never poisoned ──
// The producer runs INSIDE the loader's `getCode` (a cold isolate only), and workerd caches a failed
// `getCode` under its id exactly as it caches a successful isolate — while the cacheKey is deliberately
// LOW-CARDINALITY (a build id, never a nonce), so minting a fresh one to recover is exactly what the
// doctrine forbids. A TRANSIENT failure (the artifact not landed yet, a lent builder momentarily
// offline) must not make the key dead for the life of the loader cache: the next attempt re-runs the
// producer and loads under the id's next generation (worker-loader.ts `loaderIdGenerations`, fenced as
// a workerd workaround) — at both doors, and for a facet through the bare-name memo too.

test("workers.get: a cacheKey whose producer threw once loads on the next attempt, once the producer would succeed", async () => {
  const itx = openItx(freshCtx("poisonkey"));
  // The producer reads the built modules out of the context's own kv — "a build capability wrote
  // the artifact, now load it".
  const spec = { source: "itx.kv.get('build:cap.js')", cacheKey: "producer-poison:v1" };
  const load = (): Promise<unknown> => itx.invoke(["itx", "workers", ["get", spec], ["hello"]]);
  // 1. the artifact has not landed yet: the producer throws inside getCode
  await expect(load()).rejects.toThrow();
  // 2. the build lands — same producer expression, same key
  await itx.invoke(["itx", "kv", ["put", "build:cap.js", entrypoint("hello() { return 'hi'; }")]]);
  // 3. produced again, loaded under the next generation — never the first failure replayed
  expect(await load()).toBe("hi");
});

test("facets.get: a facet whose producer threw once materializes on the next attempt — through the hosting door and by bare name through the memo", async () => {
  const itx = openItx(freshCtx("poisonfacet"));
  const spec = {
    source: "itx.kv.get('build:door.js')",
    cacheKey: "facet-poison:v1",
    className: "Door",
  };
  const hello = (): Promise<unknown> =>
    itx.invoke(["itx", "facets", ["get", "door", spec], ["hello"]]);
  await expect(hello()).rejects.toThrow();
  await itx.invoke([
    "itx",
    "kv",
    [
      "put",
      "build:door.js",
      `import { DurableObject } from "cloudflare:workers";\nexport class Door extends DurableObject { hello() { return "hi"; } }`,
    ],
  ]);
  expect(await hello()).toBe("hi");
  expect(await itx.invoke(["itx", "facets", ["get", "door"], ["hello"]])).toBe("hi"); // the memo alone
});

// ── a remote capnweb API, dialed from userspace ──

// The whole remote-dialing worker, handed over inline. Each method builds ONE capnweb chain with no
// intervening awaits (the one-shot batch flushes on the first await), so even the call → property →
// call → call chain (`authenticate(credentials).projects.get(id).whoami()`, the
// `itx.os.projects.get(id).rename(…)` shape) rides one POST. The credentials ride in ctx.props like
// the url does.
const SRC_REMOTE = {
  "cap.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
import { newHttpBatchRpcSession } from "./processor.js";
export class Remote extends WorkerEntrypoint {
  #api() { return newHttpBatchRpcSession(this.ctx.props.url); }
  whoami() { return this.#api().authenticate(this.ctx.props.credentials).projects.get(this.ctx.props.projectId).whoami(); }
}
`,
};

test("a userspace worker dials a remote capnweb API with the url in ctx.props, behind a rewrite rule by name — one batch per chain", async () => {
  const other = freshCtx("conn-other");
  const itx = openItx(freshCtx("conn"));
  await itx.provide("itx.remoteApi", [
    "itx",
    "workers",
    [
      "get",
      {
        source: SRC_REMOTE,
        className: "Remote",
        props: { url: workerUrl("/api"), projectId: other, credentials: adminCredentials() },
      },
    ],
  ]);
  // 1. one method, one HTTP batch, through the rule
  expect(await itx.remoteApi.whoami()).toEqual({ projectId: other, path: "/" });
  // 2. the same rule by expression string — a rule is a rule
  expect(await itx.invoke("itx.remoteApi.whoami()")).toEqual({ projectId: other, path: "/" });
});

// ── dynamic worker → dynamic worker mid-chain pipelining. Worker A is a STATEFUL hosted DO whose getter
// chain returns nested RpcTargets (get demo → Demo, get timer → Timer, timer.callLater(ms, cb)); worker
// B is a SECOND loaded entrypoint that reaches A through its own `env.ITX.get()` and writes the natural
// dotted chain; the callback B passes rides the membrane the other way and fires back INSIDE B ──

// ── worker A: a stateful DO with a getter chain that bottoms out at callLater(ms, cb) ──
const SRC_WORKER_A = {
  "cap.js": `
import { DurableObject, RpcTarget } from "cloudflare:workers";
class Timer extends RpcTarget {
  async callLater(ms, cb) {
    const run = cb.dup();                       // retain past this call (a param stub is disposed on return)
    await new Promise((r) => setTimeout(r, ms));
    await run();                                // fire back in the CALLER; awaited so this facet stays alive
    run[Symbol.dispose]?.();
  }
}
class Demo extends RpcTarget {
  get timer() { return new Timer(); }
}
export class CounterDurableObject extends DurableObject {
  get demo() { return new Demo(); }
}
export default CounterDurableObject;`,
};

// ── worker B: reaches A via env.ITX.get() and writes the natural mid-chain dotted call ──
const SRC_WORKER_B = {
  "cap.js": `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class ConsumerB extends WorkerEntrypoint {
  async run(aRef) {
    // env.ITX.get() is the real scope. facets.get(name, { source, className }) is a mid-chain
    // HANDLE; the getter chain .demo.timer and terminal .callLater(ms, cb) pipeline onto it natively
    // — consecutive stub-returning calls over Workers RPC, the deepest pipelining case.
    const itx = await this.env.ITX.get();
    let pinged = false;
    await itx.facets.get('counterA', { source: aRef.source, className: aRef.className })
      .demo.timer.callLater(200, () => { pinged = true; });
    if (pinged) await itx.append({ type: 'pinged-from-A-via-B' }); // observable at the client
    return { ran: true, pinged };
  }
}`,
};

test("dynamic worker → dynamic worker mid-chain pipelining, both consumer lanes", async () => {
  const itx = openItx(freshCtx("dw2dw"));

  // aRef names worker A's stateful class: the source MODULES, handed over inline, + the exported
  // className. facets.get('counterA', aRef) loads the class and materializes it as the facet 'counterA'.
  const aRef = { source: SRC_WORKER_A, className: "CounterDurableObject" };

  // ── lane 1: a plain capnweb client walks the mid-chain and the callback fires back HERE ──
  let clientPinged = false;
  await itx.facets
    .get("counterA", { source: aRef.source, className: aRef.className })
    .demo.timer.callLater(200, () => {
      clientPinged = true;
    });
  await until("capnweb client callback fired", () => clientPinged, 30_000);
  // capnweb client: facets.get('counterA', aRef).demo.timer.callLater(cb) — callback fired back in the client
  expect(clientPinged).toBe(true);

  // ── lane 2: worker B reaches worker A via env.ITX.get() — the dynamic-worker → dynamic-worker case ──
  const ran = await itx.workers.get({ source: SRC_WORKER_B }).run(aRef);
  // dynamic worker B: env.ITX.get().facets.get('counterA', aRef).demo.timer.callLater(cb) ran and the callback fired inside B
  expect(ran?.ran).toBe(true);
  expect(ran?.pinged).toBe(true);

  const got = await until(
    "worker B's callback appended to the stream",
    async () => {
      const page = await itx.invoke(["itx", ["readEvents", 0, 500]]);
      return page.events.find((e: { type: string }) => e.type === "pinged-from-A-via-B");
    },
    30_000,
  );
  // dynamic worker B: the callback effect (stream append) is observable at the client
  expect(got).toBeTruthy();
});

// ── the persistent stub ──

test("persistent stub: stash a live itx handle in DO storage, use the restored handle", async () => {
  const ctx = freshCtx("rest");
  const itx = openItx(ctx);

  await itx.provide("itx.keeper", [
    "itx",
    "facets",
    ["get", "keeper", { source: SOURCES.keeper, className: "KeeperDurableObject" }],
  ]);

  // 1. stash: storage.put(env.ITX) — throws unless the whole chain is restore-eligible
  const stashed = await itx.invoke(["itx", "keeper", ["stash"]]);
  expect(stashed?.stashed).toBe(true); // storage.put accepted the live itx handle

  // 2. use the RESTORED handle (storage.get replays the restore chain on use)
  const who = await itx.invoke(["itx", "keeper", ["useStashed"]]);
  expect(who?.projectId).toBe(ctx); // restored handle answers whoami through the rewrite rules

  // 3. and again — replay is per-load, not a one-shot
  const who2 = await itx.invoke(["itx", "keeper", ["useStashed"]]);
  expect(who2?.projectId).toBe(ctx); // second load replays again
});
