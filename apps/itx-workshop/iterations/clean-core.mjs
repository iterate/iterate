// clean-core.mjs — the core of itx, built from scratch, runnable, and self-checking.
//
// This is the executable companion to `clean-core.md`. Every claim the doc makes is
// asserted at the bottom of this file: run `node clean-core.mjs` and it prints one ✓
// per check, or throws. The doc quotes this file, so the two cannot drift.
//
// DESIGN STANCE (what this version deliberately leaves OUT, vs earlier iterations):
//   - NO origin tracking. There is no `origin` wire field, no "act on behalf of" tag.
//   - NO dragging the calling context around. A capability is NOT handed an ambient
//     `itx`/context argument on every call. If a capability needs another capability
//     (e.g. its parent's `fetch`), it CAPTURES that specific reference when it is
//     built — authority rides the reference, not an ambient channel.
//   - NO dependency on capnweb's internal `followPath`. We write our own traversal
//     (`followPath` below). It's ~20 lines and we own it.
//
// What remains is, we think, the irreducible core: a capability is a callable
// reference; a context is a registry of capabilities that is itself a capability;
// the registry is event-sourced; contexts form an inheritance chain with shadow/super;
// and capabilities come in two kinds — live (a held stub) and sturdy (a serializable
// address you can re-`dial`).
//
// This file is a pure-Node MODEL. A real deployment runs each context in a Cloudflare
// Durable Object and each capability over a Cap'n Web socket; here a "stub" is just a
// JS object and "dial" just looks a worker up in a Map. The model preserves the
// SHAPE of the system (the algorithms and the data) without the transport.

// ---------------------------------------------------------------------------
// Part 1 — followPath: our own path traversal
// ---------------------------------------------------------------------------
//
// A capability is reached by a PATH: an array of segments like ["db", "users", "get"].
// The registry resolves the longest *named* prefix to a target object; whatever path
// segments are left over are walked on that object. `followPath` does that walk and
// the final call. We own this code so we depend on nothing internal to capnweb.
//
// Two safety rules, both load-bearing:
//   1. Reserved segments are refused. These are names that would either let a caller
//      climb the prototype chain (`__proto__`, `constructor`, `prototype`) or make a
//      returned value masquerade as a promise (`then`/`catch`/`finally`).
//   2. Only OWN properties are followed — never inherited ones. A path may not reach
//      through an object's prototype to find a method it didn't explicitly expose.
//
// MODEL SCOPE: this set is for plain-object/function targets. Over a real Cap'n Web
// wire the target is a stub and the set must ALSO refuse stub controls (`dup`, `map`,
// `apply`, `call`, `bind`) — here caught by the own-property guard or simply absent.
// Port the rule (refuse what isn't a real member), not this literal set.

const RESERVED_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "then",
  "catch",
  "finally",
]);

function assertSafeSegment(holder, segment) {
  if (typeof segment !== "string") {
    throw new Error(`path segment must be a string, got ${typeof segment}`);
  }
  if (RESERVED_SEGMENTS.has(segment)) {
    throw new Error(`refusing reserved path segment "${segment}"`);
  }
  if (!Object.hasOwn(holder, segment)) {
    // own-property only: never traverse up the prototype chain.
    throw new Error(`"${segment}" is not an own property of the capability`);
  }
}

// Walk `path` on `target` and call the thing it points at with `args`.
//   - path === []        → the capability is itself callable; call it.
//   - path === ["m"]     → call target.m(...args), with `this` === target.
//   - path === ["a","m"] → walk to target.a, then call target.a.m(...args).
// The receiver of the final call is always the object the method lives on, so a
// mounted SDK's `this`-using methods work unchanged.
function followPath(target, path, args) {
  if (path.length === 0) {
    if (typeof target !== "function") {
      throw new Error("capability is not callable and no path was given");
    }
    return target(...args);
  }

  let holder = target;
  // Walk every segment except the last, descending into own properties.
  for (let i = 0; i < path.length - 1; i++) {
    assertSafeSegment(holder, path[i]);
    holder = holder[path[i]];
    if (holder == null) {
      throw new Error(`path segment "${path[i]}" resolved to ${holder}`);
    }
  }

  const method = path[path.length - 1];
  assertSafeSegment(holder, method);
  const fn = holder[method];
  if (typeof fn !== "function") {
    throw new Error(`"${method}" is not a function`);
  }
  return fn.apply(holder, args); // preserve the receiver
}

// ---------------------------------------------------------------------------
// Part 2 — two kinds of capability: live and sturdy
// ---------------------------------------------------------------------------
//
// A capability is one of:
//   - LIVE:   an in-memory object/function (models a Cap'n Web stub on a socket).
//             It cannot be serialized. When its connection dies, it's gone.
//   - STURDY: a serializable ADDRESS — { worker, entrypoint, props } — that a
//             RESTORER can turn back into a live target later. This is Cap'n Proto's
//             SturdyRef + restorer, which Cap'n Web does not give you; itx adds it.
//
// `dial` is the restorer: it maps an address back to a live target by looking the
// worker up in a registry. In production the registry is the platform's worker
// loader / DO namespace; here it's a Map.

const WORKERS = new Map(); // worker name → (entrypoint, props) → live target

function registerWorker(name, make) {
  WORKERS.set(name, make);
}

function isAddress(value) {
  return (
    value != null &&
    typeof value === "object" &&
    typeof value.worker === "string" &&
    "entrypoint" in value
  );
}

function dial(address) {
  const make = WORKERS.get(address.worker);
  if (!make) throw new Error(`cannot dial unknown worker "${address.worker}"`);
  return make(address.entrypoint, address.props);
}

// ---------------------------------------------------------------------------
// Part 3 — the context: a registry of capabilities that is itself a capability
// ---------------------------------------------------------------------------
//
// An `Itx` is a context. It holds:
//   - providers: the durable registry, name → { kind, address } (the FOLD's product).
//   - liveStubs: the non-durable overlay, name → live target (the "bridge").
//   - parent:    the next context up the inheritance chain (or null).
//   - log:       the event log this context's durable state folds from.
//
// The context exposes four verbs — provide, revoke, invoke, describe — and `extend`
// to make a child. The context is itself a capability: `invoke` IS its call surface,
// so a context can be provided into another context as just another capability.

const MISS = { miss: true }; // resolution sentinel (a plain object, so it's wire-safe)

class Itx {
  constructor(name, parent = null) {
    this.name = name;
    this.parent = parent;
    this.providers = new Map(); // name → { kind: "live"|"sturdy", address: object|null }
    this.liveStubs = new Map(); // name → live target (overlay; never serialized)
    this.log = []; // durable event log
  }

  extend(childName) {
    return new Itx(childName, this);
  }

  // provide(name, target): register a capability.
  //   - an address  → sturdy: recorded in the log, reconstructable by the fold.
  //   - anything else → live: held in the overlay; the log only learns it existed.
  provide(name, target) {
    if (isAddress(target)) {
      this.providers.set(name, { kind: "sturdy", address: target });
      this.liveStubs.delete(name);
      this.log.push({ type: "capability-provided", name, address: target });
    } else {
      // LIVE-STUB BRIDGE (simplified): hold the stub so a *different* caller, who
      // never had it passed to them, can still reach it. In production this stub
      // must be retained against capnweb's call-return disposal (a `.dup()`) — and a
      // live object whose members are stubs needs a RECURSIVE dup of each member, not
      // one top-level dup. Here a plain reference suffices because nothing disposes it.
      // The fold records address:null so a restart knows the cap existed but is offline.
      this.providers.set(name, { kind: "live", address: null });
      this.liveStubs.set(name, target);
      this.log.push({ type: "capability-provided", name, address: null });
    }
  }

  // revoke(name): remove a capability provided *at this context*. Because resolution
  // climbs to the parent (below), revoking a shadow re-exposes the parent's version;
  // revoking at the base removes it for every child that inherited it — instantly,
  // because resolution is late-bound (re-run on every invoke).
  revoke(name) {
    this.providers.delete(name);
    this.liveStubs.delete(name);
    this.log.push({ type: "capability-revoked", name });
  }

  // onConnectionBroken(name): the only teardown path for a live capability. In
  // production this is wired to capnweb's `onRpcBroken`; the overlay entry is reaped
  // so `describe()` reports the capability offline. The durable record stays.
  onConnectionBroken(name) {
    this.liveStubs.delete(name);
  }

  // resolve(path): find the capability that owns `path`.
  // Longest *named* prefix wins within a context; if nothing matches, climb to the
  // parent (late binding). Returns { ctx, entry, matchedLen } or MISS.
  resolve(path) {
    for (let len = path.length; len >= 1; len--) {
      const name = path.slice(0, len).join(".");
      const entry = this.providers.get(name);
      if (entry) return { ctx: this, entry, name, matchedLen: len };
    }
    if (this.parent) return this.parent.resolve(path);
    return MISS;
  }

  // borrow(ctx, entry, name): produce the live target to call.
  //   - live   → the held stub (must still be connected).
  //   - sturdy → dial the address fresh.
  #borrow(ctx, entry, name) {
    if (entry.kind === "live") {
      const stub = ctx.liveStubs.get(name);
      if (!stub) {
        throw new Error(`capability "${name}" is offline (live provider disconnected)`);
      }
      return stub;
    }
    return dial(entry.address);
  }

  // invoke(path, args): resolve, borrow, traverse, call. This is the whole call path.
  invoke(path, args = []) {
    const r = this.resolve(path);
    if (r === MISS) throw new Error(`no capability at "${path.join(".")}"`);
    const target = this.#borrow(r.ctx, r.entry, r.name);
    return followPath(target, path.slice(r.matchedLen), args);
  }

  // superRef(path): a late-bound reference to whatever `path` resolves to STARTING AT
  // THE PARENT — i.e. skipping this context's own (possibly shadowing) providers.
  // This is how a shadow reaches `super`: it captures this reference when it is built
  // and calls it at runtime. It is the ONLY context-spanning authority a capability
  // gets, and it gets it by holding a reference — not by being handed the caller's
  // context. Late-bound: if the parent later swaps the capability, the ref follows.
  superRef(path) {
    if (!this.parent) throw new Error("no parent to super into");
    const parent = this.parent;
    return (...args) => parent.invoke(path, args);
  }

  // describe(): the live view of every reachable capability, child shadowing parent,
  // with connection status for live ones. Pure read; no side effects.
  describe() {
    const out = {};
    let ctx = this;
    while (ctx) {
      for (const [name, entry] of ctx.providers) {
        if (name in out) continue; // nearer context shadows farther one
        out[name] = {
          kind: entry.kind,
          connected: entry.kind === "sturdy" ? true : ctx.liveStubs.has(name),
        };
      }
      ctx = ctx.parent;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Part 4 — the fold: durable state is a reduction over the event log
// ---------------------------------------------------------------------------
//
// A context's `providers` registry is not the source of truth — the event LOG is.
// `reduceItxEvent` folds the log back into a registry. The crucial asymmetry:
//   - a STURDY capability is fully reconstructed (its address is in the event), so it
//     survives a restart and is immediately invocable again via `dial`.
//   - a LIVE capability cannot be reconstructed (a socket can't be serialized). The
//     fold knows it EXISTED (address:null) and marks it offline. It comes back only
//     if the provider reconnects and provides again.
// This is why live and sturdy are different kinds and not unifiable: only one of them
// can be written down.

function reduceItxEvent(registry, event) {
  switch (event.type) {
    case "capability-provided":
      registry.set(event.name, {
        kind: event.address ? "sturdy" : "live",
        address: event.address ?? null,
      });
      break;
    case "capability-revoked":
      registry.delete(event.name);
      break;
    // Unknown events are ignored — the fold only consumes what it understands.
  }
  return registry;
}

// Rebuild a context's durable registry from its log (models a cold start / new isolate).
function rebuildFromLog(name, log) {
  const ctx = new Itx(name);
  for (const event of log) reduceItxEvent(ctx.providers, event);
  // liveStubs is intentionally empty: the overlay did not survive the restart.
  return ctx;
}

// ===========================================================================
// CHECKS — every assertion the doc makes. `node clean-core.mjs` runs these.
// ===========================================================================

function assert(cond, msg) {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
}
function assertThrows(fn, msg) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, msg);
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

// --- Part 1: followPath ---------------------------------------------------
check("followPath calls a bare function with []", () => {
  assert(followPath((x) => x + 1, [], [41]) === 42, "bare call");
});
check("followPath walks an own path and preserves the receiver", () => {
  const obj = {
    n: 7,
    db: {
      get(k) {
        return `${k}=${this.secret}`;
      },
      secret: "S",
    },
  };
  assert(followPath(obj, ["db", "get"], ["k"]) === "k=S", "receiver preserved (this.secret)");
});
check("followPath refuses reserved segments", () => {
  assertThrows(() => followPath({}, ["__proto__", "x"], []), "rejects __proto__");
  assertThrows(() => followPath({ then() {} }, ["then"], []), "rejects then");
});
check("followPath refuses inherited (non-own) properties", () => {
  // toString is on Object.prototype, not own — must be refused.
  assertThrows(() => followPath({}, ["toString"], []), "rejects inherited toString");
});

// --- Part 2/3: provide + invoke, live + sturdy ----------------------------
check("provide+invoke a live function capability", () => {
  const itx = new Itx("root");
  itx.provide("greet", (who) => `hello ${who}`);
  assert(itx.invoke(["greet"], ["ada"]) === "hello ada", "live fn invoked");
});
check("provide+invoke a live object capability with a dotted path", () => {
  const itx = new Itx("root");
  itx.provide("db", { get: (k) => `row:${k}` });
  assert(itx.invoke(["db", "get"], ["7"]) === "row:7", "dotted path into live object");
});
check("longest-prefix selection prefers the most specific provided name", () => {
  const itx = new Itx("root");
  itx.provide("a", { b: () => "short" });
  itx.provide("a.b", () => "long"); // more specific name wins
  assert(itx.invoke(["a", "b"], []) === "long", "longest prefix wins");
});
check("sturdy capability: provide an address, dial restores it, invoke works", () => {
  registerWorker("petstore", (_entrypoint, props) => ({
    listPets: () => `pets@${props.region}`,
  }));
  const itx = new Itx("root");
  itx.provide("pets", { worker: "petstore", entrypoint: "default", props: { region: "eu" } });
  assert(itx.providers.get("pets").kind === "sturdy", "stored as sturdy");
  assert(itx.invoke(["pets", "listPets"], []) === "pets@eu", "dialed + invoked");
});

// --- Part 4: the fold -----------------------------------------------------
check("the fold reconstructs sturdy caps but marks live caps offline", () => {
  const itx = new Itx("root");
  itx.provide("live", () => "hi"); // live
  itx.provide("sturdy", { worker: "petstore", entrypoint: "default", props: { region: "us" } });

  const rebuilt = rebuildFromLog("root", itx.log);
  // sturdy survived and is invocable again:
  assert(rebuilt.invoke(["sturdy", "listPets"], []) === "pets@us", "sturdy survives restart");
  // live is known-but-offline: present in the registry, no stub, invoke throws:
  assert(rebuilt.providers.get("live").kind === "live", "live recorded");
  assert(rebuilt.describe().live.connected === false, "live reports offline after restart");
  assertThrows(() => rebuilt.invoke(["live"], []), "offline live cap is not invocable");
});

// --- Inheritance, shadow, super, late binding -----------------------------
check("a child inherits a parent capability by reference", () => {
  const base = new Itx("project");
  base.provide("db", { get: (k) => `row:${k}` });
  const child = base.extend("agent");
  assert(child.invoke(["db", "get"], ["7"]) === "row:7", "child reaches parent's db");
});
check("a child shadows a parent capability; the child's wins", () => {
  const base = new Itx("project");
  base.provide("region", () => "eu");
  const child = base.extend("agent");
  child.provide("region", () => "us");
  assert(child.invoke(["region"], []) === "us", "child shadow wins");
  assert(base.invoke(["region"], []) === "eu", "base unaffected");
});
check("a shadow reaches super via a CAPTURED reference (no ambient context)", () => {
  const log = [];
  const base = new Itx("project");
  base.provide("fetch", (url) => `BODY(${url})`); // the real fetch
  const child = base.extend("agent");
  // The shadow captures super's fetch when it is built, then calls it at runtime.
  const superFetch = child.superRef(["fetch"]);
  child.provide("fetch", (url) => {
    log.push(url); // observe
    return superFetch(url); // delegate up the chain
  });
  const body = child.invoke(["fetch"], ["/pets"]);
  assert(body === "BODY(/pets)", "super reached the base fetch");
  assert(log.length === 1 && log[0] === "/pets", "the shadow observed the call");
});
check("late binding: revoke at the base removes the cap for the child instantly", () => {
  const base = new Itx("project");
  base.provide("db", { get: (k) => `row:${k}` });
  const child = base.extend("agent");
  assert(child.invoke(["db", "get"], ["7"]) === "row:7", "reachable before revoke");
  base.revoke("db");
  assertThrows(() => child.invoke(["db", "get"], ["7"]), "gone after base revoke");
});
check("one capability, N references: a base swap is seen by every child", () => {
  const base = new Itx("project");
  base.provide("region", () => "eu");
  const a = base.extend("a");
  const b = base.extend("b");
  assert(a.invoke(["region"], []) === "eu" && b.invoke(["region"], []) === "eu", "both inherit");
  base.revoke("region");
  base.provide("region", () => "us"); // swap at the base
  assert(a.invoke(["region"], []) === "us" && b.invoke(["region"], []) === "us", "both see swap");
});
check("superRef is late-bound: it follows a base swap", () => {
  const base = new Itx("project");
  base.provide("fetch", () => "v1");
  const child = base.extend("agent");
  const superFetch = child.superRef(["fetch"]);
  child.provide("fetch", () => superFetch()); // pure delegate
  assert(child.invoke(["fetch"], []) === "v1", "delegates to v1");
  base.revoke("fetch");
  base.provide("fetch", () => "v2");
  assert(child.invoke(["fetch"], []) === "v2", "now delegates to v2");
});

// --- The live-stub bridge -------------------------------------------------
check("the bridge: a connection-broken live cap is reaped and reports offline", () => {
  const itx = new Itx("root");
  itx.provide("daemon", { run: () => "ok" });
  assert(itx.invoke(["daemon", "run"], []) === "ok", "callable while connected");
  assert(itx.describe().daemon.connected === true, "reports connected");
  itx.onConnectionBroken("daemon"); // models capnweb onRpcBroken firing
  assert(itx.describe().daemon.connected === false, "reports offline after break");
  assertThrows(() => itx.invoke(["daemon", "run"], []), "not invocable once reaped");
});

// --- CAPSTONE: inheritance + shadow + super, end-to-end, no origin ---------
check("CAPSTONE: agent shadows fetch with logging→super, inherits db by reference", () => {
  const log = [];

  // The project context provides two capabilities.
  const project = new Itx("project");
  project.provide("fetch", (url) => `200 ${url}`); // a real egress capability
  project.provide("db", { query: (sql) => `rows(${sql})` }); // a real data capability

  // The agent extends the project. It shadows `fetch` to log every request, then
  // delegates to the project's fetch via a captured super reference. It does NOT
  // shadow `db` — it inherits it by reference.
  const agent = project.extend("agent");
  const superFetch = agent.superRef(["fetch"]);
  agent.provide("fetch", (url) => {
    log.push(`agent.fetch ${url}`);
    return superFetch(url);
  });

  // 1) The agent's own fetch: shadow fires, super reaches the base. No origin tag,
  //    no calling context was passed — the shadow simply holds super's reference.
  assert(agent.invoke(["fetch"], ["/pets"]) === "200 /pets", "shadow→super returned base body");
  assert(log.length === 1 && log[0] === "agent.fetch /pets", "shadow observed the call");

  // 2) The agent invokes the INHERITED db (it never provided one) — by reference.
  assert(agent.invoke(["db", "query"], ["SELECT 1"]) === "rows(SELECT 1)", "inherited db");

  // 3) The project, calling its OWN fetch, is NOT logged — the shadow is the agent's
  //    alone. (This is the key consequence of dropping origin: a capability the
  //    project calls runs with the project's own chain, never the agent's shadow.)
  assert(project.invoke(["fetch"], ["/admin"]) === "200 /admin", "project fetch works");
  assert(log.length === 1, "project's own fetch did NOT hit the agent's shadow");

  // 4) Late binding holds end-to-end: revoke db at the base, the agent loses it.
  project.revoke("db");
  assertThrows(() => agent.invoke(["db", "query"], ["x"]), "agent loses db after base revoke");
});

// --- run ------------------------------------------------------------------
let passed = 0;
for (const [name, fn] of checks) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
console.log(`\n${passed}/${checks.length} checks passed.`);

export { followPath, Itx, dial, registerWorker, reduceItxEvent, rebuildFromLog };
