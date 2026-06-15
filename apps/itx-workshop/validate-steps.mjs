// validate-steps.mjs — independent, runnable checks for the MODEL-level steps of
// the workshop (7-11), the half the wire-level harness (server.ts + harness.ts,
// min-dynamic-target.mjs) doesn't exercise. Pure Node, no workerd needed: these
// steps are about the capability model (fold, ref taxonomy, chain, processor),
// not the RPC transport. Run: node apps/itx-workshop/validate-steps.mjs
//
// Each check mirrors the doc's named pieces (reduceItxEvent, isCapabilityAddress,
// dial, extend/super, StreamProcessor) with the minimum faithful implementation
// and asserts the behavior the doc claims.

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ===========================================================================
// STEP 7 — a capability is a name → a target that is EITHER live OR a sturdy ref.
// CapabilityKind = "live" | "rpc". The discriminator decides dispatch.
// ===========================================================================
{
  // A sturdy ref is plain data: { type:"rpc", worker:{...} }. A live target is
  // anything else (a function / stub held in memory).
  const isCapabilityAddress = (t) => !!t && typeof t === "object" && t.type === "rpc";

  const live = async (code) => `ran:${code}`;
  const sturdy = {
    type: "rpc",
    worker: { type: "source", source: { repo: "r", commit: "c", path: "p" } },
  };

  // dispatch: live → call in place; rpc → dial the ref, then call.
  const dialed = [];
  const dial = (ref) => {
    dialed.push(ref);
    return async (code) => `dialed:${code}`; // the dynamic worker, as a callable
  };
  async function dispatch(target, code) {
    return isCapabilityAddress(target) ? await dial(target)(code) : await target(code);
  }

  const a = await dispatch(live, "x");
  const b = await dispatch(sturdy, "y");
  check("Step 7: live target dispatches in place", a === "ran:x");
  check(
    "Step 7: sturdy (rpc) target is dialed, not called",
    b === "dialed:y" && dialed.length === 1,
  );
  check(
    "Step 7: discriminator is purely structural",
    isCapabilityAddress(sturdy) && !isCapabilityAddress(live),
  );
}

// ===========================================================================
// STEP 8 — durability: the registry is the FOLD of the context's stream.
// reduceItxEvent(state, event) is the single source of truth; replaying the same
// stream reproduces the same registry (no hidden state).
// ===========================================================================
function reduceItxEvent(state, event) {
  const next = new Map(state);
  switch (event.type) {
    case "capability-provided":
      next.set(event.name, { kind: event.kind, value: event.value });
      break;
    case "capability-revoked":
      next.delete(event.name);
      break;
  }
  return next;
}
const foldStream = (events) => events.reduce(reduceItxEvent, new Map());
{
  const stream = [
    { type: "capability-provided", name: "fetch", kind: "live", value: "f0" },
    { type: "capability-provided", name: "slack", kind: "live", value: "s0" },
    { type: "capability-revoked", name: "fetch" },
    { type: "capability-provided", name: "slack", kind: "live", value: "s1" }, // last write wins
  ];
  const reg = foldStream(stream);
  check(
    "Step 8: revoke removes, last provide wins",
    !reg.has("fetch") && reg.get("slack").value === "s1",
  );
  // determinism: replaying the SAME stream yields an identical registry.
  const replay = foldStream(stream);
  check("Step 8: replaying the stream reproduces the registry", eq([...reg], [...replay]));
}

// ===========================================================================
// STEP 9 — dial: restoring a sturdy ref by running the dynamic worker.
// Real itx uses the Worker Loader (closed beta); here the loader is stubbed by a
// content-addressed factory map, which lets us validate the dial SHAPE and the
// isolate-cache-by-content claim (same content → same isolate).
// ===========================================================================
{
  const built = new Map(); // contentKey → isolate (the "Worker Loader cache")
  let builds = 0;
  // the stubbed loader: builds an isolate from source the first time, caches by content.
  function loadIsolate(source) {
    const key = `${source.repo}@${source.commit}:${source.path}`;
    if (!built.has(key)) {
      builds++;
      // "build" the worker: a module exposing a callable. Stand-in for source-build.
      const instanceId = builds;
      built.set(key, { run: async (code) => `worker#${instanceId}(${code})` });
    }
    return built.get(key);
  }
  function dial(ref) {
    if (ref.type !== "rpc") throw new Error("not dialable");
    const w = ref.worker;
    switch (w.type) {
      case "source":
        return (code) => loadIsolate(w.source).run(code);
      default:
        throw new Error(`unknown worker kind ${w.type}`);
    }
  }
  const ref = {
    type: "rpc",
    worker: { type: "source", source: { repo: "r", commit: "c1", path: "agent.ts" } },
  };
  const r1 = await dial(ref)("hello");
  const r2 = await dial(ref)("again"); // same content → same isolate, no rebuild
  const buildsAfterSameContent = builds; // snapshot BEFORE the different-content dial
  const ref2 = {
    type: "rpc",
    worker: { type: "source", source: { repo: "r", commit: "c2", path: "agent.ts" } },
  };
  const r3 = await dial(ref2)("new"); // different content → new isolate
  check("Step 9: dialing a source ref runs the built worker", r1 === "worker#1(hello)");
  check(
    "Step 9: same content reuses the cached isolate (no rebuild)",
    r2 === "worker#1(again)" && buildsAfterSameContent === 1,
  );
  check("Step 9: different content builds a new isolate", r3 === "worker#2(new)" && builds === 2);
}

// ===========================================================================
// STEP 10 — extend / super: a child context delegates a MISS up to its parent;
// a child shadow wins over the parent (deep shadowing from Step 6, up the chain).
// ===========================================================================
{
  function makeContext(events, sup = null) {
    const reg = foldStream(events);
    return {
      invoke(name) {
        if (reg.has(name)) return { from: "self", value: reg.get(name).value };
        if (sup) return sup.invoke(name);
        throw new Error(`no capability "${name}"`);
      },
    };
  }
  const parent = makeContext([
    { type: "capability-provided", name: "fetch", kind: "live", value: "parent.fetch" },
    { type: "capability-provided", name: "ai", kind: "rpc", value: "parent.ai" },
  ]);
  const child = makeContext(
    [
      { type: "capability-provided", name: "slack", kind: "live", value: "child.slack" },
      { type: "capability-provided", name: "fetch", kind: "live", value: "child.fetch" }, // shadow parent
    ],
    parent,
  );
  check("Step 10: a miss on the child climbs to super", child.invoke("ai").value === "parent.ai");
  check("Step 10: child's own cap resolves locally", child.invoke("slack").from === "self");
  check("Step 10: child shadow wins over parent", child.invoke("fetch").value === "child.fetch");
}

// ===========================================================================
// STEP 11 — Itx IS a StreamProcessor. provideCapability == append an event;
// getState() == the fold; so the materialized registry equals reduceItxEvent over
// the appended stream, and you read your own writes.
// ===========================================================================
{
  class StreamProcessor {
    #events = [];
    #reduce;
    constructor(reduce) {
      this.#reduce = reduce;
    }
    append(event) {
      this.#events.push(event);
    }
    get events() {
      return this.#events.slice();
    }
    getState() {
      return this.#events.reduce(this.#reduce, new Map());
    }
  }
  class Itx extends StreamProcessor {
    constructor() {
      super(reduceItxEvent);
    }
    provideCapability(name, kind, value) {
      this.append({ type: "capability-provided", name, kind, value });
    }
    invoke(name) {
      const reg = this.getState();
      if (!reg.has(name)) throw new Error(`no capability "${name}"`);
      return reg.get(name).value;
    }
  }
  const itx = new Itx();
  itx.provideCapability("slack", "live", "s0");
  itx.provideCapability("slack", "live", "s1"); // read-your-writes: last wins
  const readBack = itx.invoke("slack");
  const foldedDirectly = foldStream(itx.events).get("slack").value;
  check("Step 11: read-your-writes through getState()", readBack === "s1");
  check(
    "Step 11: materialized state == reduceItxEvent fold of the stream",
    readBack === foldedDirectly,
  );
}

console.log(`\n${failures === 0 ? "ALL MODEL STEPS VALID" : `${failures} FAILED`} (steps 7-11)`);
process.exit(failures === 0 ? 0 : 1);
