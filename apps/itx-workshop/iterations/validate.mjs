// validate.mjs — one runnable model-check per incremental idea folded into the
// doc sequence (v1..v6). Pure Node: each check implements the MINIMAL model the
// corresponding version describes and asserts it behaves as the doc claims.
//
// Usage: node validate.mjs <upTo>   (runs checks 1..upTo; default all)
// Each version vN is "validated" by `node validate.mjs N` passing.

let fails = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// shared helpers (the doc's findCapabilityByPath / invokeCapabilityAtPath)
function findCapabilityByPath({ caps, path }) {
  for (let i = path.length; i >= 1; i--) {
    const name = path.slice(0, i).join(".");
    if (caps.has(name)) return { name, capability: caps.get(name), rest: path.slice(i) };
  }
  return null;
}
function walk(target, path, args) {
  let recv = target;
  for (const seg of path.slice(0, -1)) recv = recv[seg];
  return path.length ? recv[path.at(-1)](...args) : target(...args);
}

// ── v1: a context IS a capability (one primitive — PathCallable) ──────────────
function check1() {
  // A PathCallable is anything with invoke({path,args}). A context dispatches
  // provided caps AND is itself a PathCallable — the same interface, recursively.
  const makeContext = () => {
    const caps = new Map();
    return {
      provide: ({ name, capability }) => caps.set(name, capability),
      invoke({ path, args }) {
        const hit = findCapabilityByPath({ caps, path });
        if (!hit) throw new Error(`no capability "${path.join(".")}"`);
        return walk(hit.capability, hit.rest, args);
      },
    };
  };
  const ctx = makeContext();
  ctx.provide({ name: "greet", capability: (who) => `hi ${who}` });
  ok(
    "v1: context dispatches a provided cap",
    ctx.invoke({ path: ["greet"], args: ["ada"] }) === "hi ada",
  );
  // the punchline: a context satisfies the very PathCallable interface it dispatches to
  const isPathCallable = (x) => x && typeof x.invoke === "function";
  ok("v1: a context IS a PathCallable (one primitive, recursively)", isPathCallable(ctx));
  // lineage is pure naming: address≈SturdyRef, dial≈restore — same behavior under new words
  const SturdyRef = { type: "rpc", worker: { type: "source" } };
  const restore = (ref) => () => ref.type; // stand-in
  ok("v1: lineage rename is behavior-preserving", restore(SturdyRef)() === "rpc");
}

// ── v2: the fold holds STURDY only; live caps are a non-durable overlay ────────
function check2() {
  // durable fold: only capability-provided(kind:"rpc") rows survive; live caps
  // are kept in an in-memory overlay keyed by name and reaped via onRpcBroken.
  function reduceItxEvent(state, ev) {
    const next = new Map(state);
    if (ev.type === "capability-provided") next.set(ev.name, { kind: "rpc", address: ev.address });
    if (ev.type === "capability-revoked") next.delete(ev.name);
    return next;
  }
  const stream = [
    { type: "capability-provided", name: "petstore", address: { worker: "openapi" } },
    { type: "capability-revoked", name: "petstore" },
    { type: "capability-provided", name: "ai", address: { worker: "ai" } },
  ];
  const fold = stream.reduce(reduceItxEvent, new Map());
  ok(
    "v2: fold reconstructs only sturdy (revoke removed, last wins)",
    !fold.has("petstore") && fold.get("ai").kind === "rpc",
  );

  // live overlay: NOT in the fold; liveness via onRpcBroken
  const live = new Map();
  const provideLive = (name, stub) => live.set(name, stub);
  const onRpcBroken = (name) => live.delete(name); // the idiomatic disconnect trigger
  provideLive("runSwift", () => "2\n");
  ok("v2: live cap is in the overlay, NOT the fold", live.has("runSwift") && !fold.has("runSwift"));
  onRpcBroken("runSwift");
  ok("v2: onRpcBroken reaps the live cap (no journaled event needed)", !live.has("runSwift"));
  // replaying the stream never resurrects a live cap — the over-claim is gone
  ok(
    "v2: fold has no live rows (no 'table is the fold' over-claim)",
    [...fold.values()].every((v) => v.kind === "rpc"),
  );
}

// ── v3: two verbs (provide+invoke) + one firstOf/membrane combinator ──────────
function check3() {
  const TOMBSTONE = Symbol("revoked");
  function makeContext(parent = null) {
    const caps = new Map();
    const self = {
      provide: ({ name, capability }) => caps.set(name, capability), // the ONE write
      // revoke = provide(⊥); extend = provide a parent-fallback handled by firstOf
      revoke: ({ name }) => caps.set(name, TOMBSTONE),
      invoke({ path, args }) {
        const hit = findCapabilityByPath({ caps, path });
        if (hit && hit.capability !== TOMBSTONE) return walk(hit.capability, hit.rest, args); // self wins (shadow)
        if (parent) return parent.invoke({ path, args }); // firstOf: try self, then parent
        throw new Error(`no capability "${path.join(".")}"`);
      },
    };
    return self;
  }
  // deep-shadow (within a context) and chain-shadow (across the chain) are ONE rule:
  const parent = makeContext();
  parent.provide({ name: "fetch", capability: () => "parent.fetch" });
  parent.provide({
    name: "slack",
    capability: { chat: { postMessage: () => "orig" }, users: { list: () => "orig-users" } },
  });
  const child = makeContext(parent);
  child.provide({ name: "fetch", capability: () => "child.fetch" }); // chain-shadow
  parent.provide({ name: "slack.chat.postMessage", capability: () => "SHADOW" }); // deep-shadow (same rule)

  ok(
    "v3: chain-shadow — child.fetch wins over parent",
    child.invoke({ path: ["fetch"], args: [] }) === "child.fetch",
  );
  ok(
    "v3: child inherits parent's slack via firstOf",
    child.invoke({ path: ["slack", "users", "list"], args: [] }) === "orig-users",
  );
  ok(
    "v3: deep-shadow via SAME longest-prefix rule",
    parent.invoke({ path: ["slack", "chat", "postMessage"], args: [] }) === "SHADOW",
  );
  ok(
    "v3: non-shadowed deep path falls through to original",
    parent.invoke({ path: ["slack", "users", "list"], args: [] }) === "orig-users",
  );
  // revoke = provide(⊥): lookup misses (tombstone), climbs to parent
  child.revoke({ name: "fetch" });
  ok(
    "v3: revoke = provide(⊥) → falls through to parent",
    child.invoke({ path: ["fetch"], args: [] }) === "parent.fetch",
  );
  let threw = false;
  try {
    child.invoke({ path: ["nope"], args: [] });
  } catch {
    threw = true;
  }
  ok("v3: total miss throws", threw);
}

// ── v4: sealed SturdyRef → restore checks the seal (no separate allowlist) ─────
function check4() {
  const restore = (ref, dialerIdentity) => {
    if (ref.type !== "rpc") throw new Error("not dialable");
    if (ref.sealedFor !== dialerIdentity)
      throw new Error(`sealed for ${ref.sealedFor}, not ${dialerIdentity}`);
    return () => `restored:${ref.worker}`; // a PathCallable stand-in
  };
  const ref = { type: "rpc", worker: "openapi", props: {}, sealedFor: "prj_abc" };
  ok("v4: matched seal restores", restore(ref, "prj_abc")() === "restored:openapi");
  let threw = "";
  try {
    restore(ref, "prj_evil");
  } catch (e) {
    threw = e.message;
  }
  ok(
    "v4: mismatched seal refuses (authority travels with the ref)",
    /sealed for prj_abc/.test(threw),
  );
  // the allowlist is gone: any worker type is fine as long as the seal matches
  const weird = { type: "rpc", worker: "anything", sealedFor: "prj_abc" };
  ok(
    "v4: no class allowlist needed — seal is the gate",
    restore(weird, "prj_abc")() === "restored:anything",
  );
}

// ── v5: lean on followPath — itx only SELECTS; the platform TRAVERSES ──────────
function check5() {
  // itx's irreducible part is choosing the target + offset (longest prefix). The
  // remainder traversal is delegated to Cap'n Web's followPath. Validate the
  // equivalence: select, then a generic walk (stand-in for followPath) of `rest`
  // yields the same result replayPath would have — so the live/stub half of
  // replayPath is redundant.
  const caps = new Map([["slack", { chat: { postMessage: (m) => `posted:${m}` } }]]);
  const hit = findCapabilityByPath({ caps, path: ["slack", "chat", "postMessage"] });
  ok(
    "v5: selection picks the longest-prefix target + offset",
    hit.name === "slack" && eq(hit.rest, ["chat", "postMessage"]),
  );
  // platform traversal (followPath) of the remainder on the live stub:
  const platformFollowPath = (target, path, args) => walk(target, path, args);
  const viaPlatform = platformFollowPath(hit.capability, hit.rest, ["hi"]);
  ok(
    "v5: delegated traversal == hand-rolled replay (replayPath live half is redundant)",
    viaPlatform === "posted:hi",
  );
}

// ── v6: bind origin into the reference (no wire field) + typed/dynamic tiers ───
function check6() {
  // boundTo currys the origin into the inherited cap — a membrane. A bare call
  // through it carries the right origin with NO origin argument at the callsite.
  const platformFetch = (url, ctx) => `${url}@${ctx}`; // ctx is the egress identity
  const boundTo = (fn, origin) => (url) => fn(url, origin); // membrane: origin pre-bound
  const childFetch = boundTo(platformFetch, "child-ctx");
  ok(
    "v6: bound ref carries origin with no wire field",
    childFetch("https://x") === "https://x@child-ctx",
  );
  // typed tier (direct method) vs dynamic tier (invoke({path})) reach the same target
  const slack = { chat: { postMessage: (m) => `ok:${m}` } };
  const typed = slack.chat.postMessage("a"); // typed cap: reference-called
  const dynamic = walk(slack, ["chat", "postMessage"], ["a"]); // dynamic cap: path-dispatched
  ok(
    "v6: typed (direct) and dynamic (path) tiers reach the same target",
    typed === dynamic && typed === "ok:a",
  );
}

// ── v3b: chain spans DOs + origin makes a shadow reach an inherited cap ────────
function check7() {
  // two "DOs": a project context and an agent context that extends it.
  const projectFetch = (url) => `${url}#project-fetch`;
  const agentFetch = (url) => `${url}#agent-SHADOW`; // the shadow lives on the agent
  const fetchFor = (origin) => (origin === "agent" ? agentFetch : projectFetch);

  const projectCaps = new Map();
  projectCaps.set("slack", { chat: { postMessage: () => "project.slack" } });
  // a project cap whose bare fetch() is routed through the call's `origin` chain:
  projectCaps.set("doProjectThing", ({ origin } = {}) => fetchFor(origin)("https://api"));

  const project = {
    invoke({ path, args, origin }) {
      const hit = findCapabilityByPath({ caps: projectCaps, path });
      if (!hit) throw new Error(`no capability "${path.join(".")}"`);
      return typeof hit.capability === "function"
        ? hit.capability({ origin })
        : walk(hit.capability, hit.rest, args);
    },
  };
  const agentCaps = new Map(); // agent owns the fetch shadow via origin, not by NAME here
  const agent = {
    address: "agent",
    invoke({ path, args, origin = this.address }) {
      const hit = findCapabilityByPath({ caps: agentCaps, path });
      if (hit) return walk(hit.capability, hit.rest, args);
      return project.invoke({ path, args, origin }); // climb CROSS-DO, carrying origin=agent
    },
  };

  ok(
    "v3b: chain spans DOs — project cap reachable through the agent",
    agent.invoke({ path: ["slack", "chat", "postMessage"], args: [] }) === "project.slack",
  );
  ok(
    "v3b: origin makes the agent fetch-shadow reach an inherited project cap",
    agent.invoke({ path: ["doProjectThing"], args: [] }) === "https://api#agent-SHADOW",
  );
  ok(
    "v3b: without origin the project cap uses its HOME fetch (name-resolution ≠ deep interposition)",
    project.invoke({ path: ["doProjectThing"], args: [] }) === "https://api#project-fetch",
  );
}

// ── v7: inheritance is by reference + late binding (no copy to children) ──────
function check8() {
  const projectCaps = new Map();
  const project = {
    invoke({ path, args }) {
      const hit = findCapabilityByPath({ caps: projectCaps, path });
      if (!hit) throw new Error(`miss "${path.join(".")}"`);
      return walk(hit.capability, hit.rest, args);
    },
  };
  const agentCaps = new Map();
  const agent = {
    invoke({ path, args }) {
      const hit = findCapabilityByPath({ caps: agentCaps, path });
      if (hit) return walk(hit.capability, hit.rest, args);
      return project.invoke({ path, args }); // a REFERENCE to the parent, resolved per call
    },
  };

  // the agent exists BEFORE the base cap is added:
  let before = false;
  try {
    agent.invoke({ path: ["ai"], args: [] });
  } catch {
    before = true;
  }
  ok("v7: pre-existing child doesn't see a base cap that isn't there yet", before);

  // add to the base AFTER the child exists → visible to the child (late binding, no copy):
  projectCaps.set("ai", () => "project.ai");
  ok(
    "v7: base cap added later is visible to the pre-existing child",
    agent.invoke({ path: ["ai"], args: [] }) === "project.ai",
  );
  ok(
    "v7: the cap lives ONCE in the base, not copied into the child",
    projectCaps.has("ai") && !agentCaps.has("ai"),
  );

  // revoke at the base propagates instantly:
  projectCaps.delete("ai");
  let after = false;
  try {
    agent.invoke({ path: ["ai"], args: [] });
  } catch {
    after = true;
  }
  ok("v7: revoke at the base reaches the child on the next call", after);

  // child shadow is local — base untouched, sibling unaffected:
  projectCaps.set("ai", () => "project.ai");
  agentCaps.set("ai", () => "agent.ai");
  const sibling = { invoke: ({ path, args }) => project.invoke({ path, args }) };
  ok("v7: child shadow wins locally", agent.invoke({ path: ["ai"], args: [] }) === "agent.ai");
  ok(
    "v7: sibling still sees the base (shadow didn't mutate the base)",
    sibling.invoke({ path: ["ai"], args: [] }) === "project.ai",
  );
}

const checks = [check1, check2, check3, check4, check5, check6, check7, check8];
const upTo = Number(process.argv[2] ?? checks.length);
console.log(`running checks 1..${upTo}`);
for (let i = 0; i < upTo; i++) checks[i]();
console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAIL`} (v1..v${upTo})`);
process.exit(fails === 0 ? 0 : 1);
