// SPIKE: does a capability-host that dispatches through a single fallback still
// let a consumer pipeline `itx.streams.get("/x").helloWorld()` in ONE round trip
// consumer→hub AND ONE round trip hub→provider? And does a Proxy-based dynamic
// resolver pipeline over capnweb at all (the claim Jonas doubted)?
//
// Topology (all in ONE node process, connected by instrumented in-memory wires):
//
//   client B ──wireB── hub (CapabilityHost) ──wireA── client A (StreamsCollection)
//   (consumer)          provideCapability + invokeCapability      (provider)
//
// We count frames on each wire and add per-hop latency, so round trips are visible.

import { RpcSession, RpcTarget } from "capnweb";
import { makeLinkedPair, summarize, frameType } from "./inproc.mjs";

const HOP = Number(process.env.HOP ?? 25); // ms one-way latency per wire
const LOG = process.env.LOG === "1";

// ── Client A's provided capability: a stream collection / factory ───────────────
const providerHits = []; // records calls that ACTUALLY reached client A
class Stream extends RpcTarget {
  #path;
  constructor(path) {
    super();
    this.#path = path;
  }
  helloWorld() {
    providerHits.push(`Stream(${this.#path}).helloWorld()`);
    return `hello from stream ${this.#path}`;
  }
}
class StreamsCollection extends RpcTarget {
  get(path) {
    providerHits.push(`StreamsCollection.get(${JSON.stringify(path)})`);
    return new Stream(path);
  }
}

// ── The hub: a capability host with provideCapability + a single fallback ───────
class CapabilityHost extends RpcTarget {
  #caps = new Map();
  // Client A calls this. Params are disposed when the call returns, so dup() to keep it.
  provideCapability(name, stub) {
    this.#caps.set(name, stub.dup());
    return true;
  }
  // THE SINGLE FALLBACK. Returns the provider ROOT stub for `name`; capnweb's
  // native pipelining then chains .get(...).helloWorld() onto it in one hop.
  invokeCapability(name) {
    const cap = this.#caps.get(name);
    if (!cap) throw new Error(`no capability "${name}"`);
    return cap.dup(); // dup: the returned stub is disposed after the call; keep ours
  }
  // Test 1 "built-in-style" real prototype getter.
  get streams() {
    return this.#caps.get("streams").dup();
  }
}

// Same host but with NO declared `streams` member — so `.streams` is UNKNOWN and
// must be resolved dynamically by the Proxy wrapper (Test 3). This is the real
// "everything falls back to invokeCapability" case Jonas doubted was pipelinable.
class BareCapabilityHost extends RpcTarget {
  #caps = new Map();
  provideCapability(name, stub) {
    this.#caps.set(name, stub.dup());
    return true;
  }
  invokeCapability(name) {
    const cap = this.#caps.get(name);
    if (!cap) throw new Error(`no capability "${name}"`);
    return cap.dup();
  }
}

// The Proxy hop: unknown property → resolve via the single invokeCapability
// fallback and return the provider stub; capnweb pipelines the rest onto it.
// Real members (provideCapability/invokeCapability) are bound to the REAL target
// so their private #fields still work (a Proxy is not the instance).
function proxyHub(hub) {
  return new Proxy(hub, {
    get(target, prop, _recv) {
      if (typeof prop === "symbol" || prop in target) {
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      }
      return target.invokeCapability(prop); // dynamic capability root
    },
    has() {
      return true; // any capability name appears present (prototype-like, not own)
    },
  });
}

// Test 4: a provider whose get() returns a *Proxy* (not a bare RpcTarget), with
// RpcTarget on its prototype chain — the exact thing Jonas remembered working.
class ProxyReturningCollection extends RpcTarget {
  get(path) {
    providerHits.push(`ProxyReturningCollection.get(${JSON.stringify(path)})`);
    const real = new Stream(path);
    return new Proxy(real, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }
}

function setup({ wrapHubForB, makeHub, makeCollection } = {}) {
  const hub = (makeHub ?? (() => new CapabilityHost()))();

  const wireA = makeLinkedPair({ name: "A<->hub", hopMs: HOP, log: LOG });
  new RpcSession(wireA.right, hub); // hub side
  const hubFromA = new RpcSession(wireA.left, null).getRemoteMain(); // A's stub to hub

  const wireB = makeLinkedPair({ name: "B<->hub", hopMs: HOP, log: LOG });
  new RpcSession(wireB.right, wrapHubForB ? wrapHubForB(hub) : hub); // hub side (maybe wrapped)
  const hubFromB = new RpcSession(wireB.left, null).getRemoteMain(); // B's stub to hub

  return { hub, hubFromA, hubFromB, wireA, wireB, makeCollection };
}

// A "round trip" = a side BLOCKING for a reply = a "pull" frame it emits.
const countType = (stats, side, type) =>
  stats[side].frames.filter((f) => frameType(f) === type).length;

const results = [];
async function runScenario(
  label,
  { wrapHubForB, makeHub, makeCollection, op, expectPipelined = true },
) {
  providerHits.length = 0;
  const { hubFromA, hubFromB, wireA, wireB } = setup({ wrapHubForB, makeHub });
  await hubFromA.provideCapability(
    "streams",
    (makeCollection ?? (() => new StreamsCollection()))(),
  );
  wireA.reset();
  wireB.reset();

  const t0 = performance.now();
  let result, error;
  try {
    result = await op(hubFromB);
  } catch (e) {
    error = e;
  }
  const ms = performance.now() - t0;

  // round trips: B blocking on the hub (B is `left` on wireB); hub blocking on A (hub is `right` on wireA).
  const rttBtoHub = countType(wireB.stats, "left", "pull");
  const rttHubToA = countType(wireA.stats, "right", "pull");
  const b = summarize(wireB.stats);
  const a = summarize(wireA.stats);

  const ok =
    !error &&
    result === "hello from stream /some/stream" &&
    (!expectPipelined || (rttBtoHub === 1 && rttHubToA === 1));

  console.log(`\n### ${label}`);
  if (error) console.log(`  ✗ ERROR: ${error.message}`);
  else console.log(`  result: ${JSON.stringify(result)}`);
  console.log(
    `  ROUND TRIPS →  B→hub: ${rttBtoHub}   hub→A: ${rttHubToA}   ${expectPipelined ? (ok ? "✅ (1+1)" : "❌ expected 1+1") : "(baseline)"}`,
  );
  console.log(`  wall: ${ms.toFixed(0)}ms  (≈${(ms / HOP).toFixed(0)} one-way hops @ ${HOP}ms)`);
  console.log(`  provider actually saw: ${JSON.stringify(providerHits)}`);
  console.log(
    `  wireB frames: B=${JSON.stringify(b.left.types)}  hub=${JSON.stringify(b.right.types)}`,
  );
  console.log(
    `  wireA frames: hub=${JSON.stringify(a.right.types)}  A=${JSON.stringify(a.left.types)}`,
  );
  results.push({ label, ok: expectPipelined ? ok : true, rttBtoHub, rttHubToA });
  return { ms, result, error, rttBtoHub, rttHubToA };
}

console.log(`capnweb pipelining spike — hop latency = ${HOP}ms/wire\n` + "=".repeat(64));

// ── Test 1: passthrough via a real prototype getter (built-in style) ────────────
await runScenario("Test 1 — hub.streams (real getter) → provider stub, native pipeline", {
  op: (hub) => hub.streams.get("/some/stream").helloWorld(),
});

// ── Test 2: single invokeCapability fallback, then native pipeline ──────────────
await runScenario("Test 2 — hub.invokeCapability('streams').get('/x').helloWorld() [pipelined]", {
  op: (hub) => hub.invokeCapability("streams").get("/some/stream").helloWorld(),
});

// ── Contrast: the NAIVE way (await each hop) — should cost 3 round trips ─────────
await runScenario("Contrast — NAIVE: await every step (expected: many round trips)", {
  expectPipelined: false,
  op: async (hub) => {
    const coll = await hub.invokeCapability("streams");
    const stream = await coll.get("/some/stream");
    return await stream.helloWorld();
  },
});

// ── Test 3: THE REAL QUESTION — a Proxy resolves `.streams` dynamically ─────────
// `streams` is NOT a declared member; the Proxy hop routes it through the single
// invokeCapability fallback. Ergonomic `hub.streams.get("/x").helloWorld()`.
await runScenario("Test 3 — PROXY hub, dynamic .streams via single fallback (ergonomic)", {
  makeHub: () => new BareCapabilityHost(),
  wrapHubForB: (hub) => proxyHub(hub),
  op: (hub) => hub.streams.get("/some/stream").helloWorld(),
});

// ── Test 4: provider returns a PROXY (RpcTarget on its prototype chain) ─────────
await runScenario("Test 4 — provider get() returns a PROXY-wrapped RpcTarget", {
  makeHub: () => new BareCapabilityHost(),
  wrapHubForB: (hub) => proxyHub(hub),
  makeCollection: () => new ProxyReturningCollection(),
  op: (hub) => hub.streams.get("/some/stream").helloWorld(),
});

console.log("\n" + "=".repeat(64));
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.label}`);
console.log(
  failed.length
    ? `\n❌ ${failed.length} FAILED`
    : `\n✅ ALL PASS — proxy + single fallback pipeline 1+1`,
);
process.exit(failed.length ? 1 : 0);
