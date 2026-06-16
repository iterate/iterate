// The minimum server-side target that turns a naked capnweb stub's dotted call
// `stub.slack.chat.postMessage(args)` into a single `invoke(path, args)` against
// a registry whose contents are NOT known when the target is constructed and
// change at runtime (via provideCapability). This is the genuinely-hard core of
// itx — and the reason the target can't be a plain class with fixed getters.
//
// Run: node apps/itx-workshop/min-dynamic-target.mjs   (needs `capnweb` on the
// node path — e.g. symlink ~/src/itx-workshop-repro/node_modules, or pnpm i).
//
// Three non-obvious things this encodes (each cost a debugging round):
//   1. The target must be a FUNCTION-typed proxy, NOT a Proxy wrapping an
//      RpcTarget. capnweb classifies an rpc-target by prototype and forbids
//      "instance properties"; a getOwnPropertyDescriptor trap that fabricates
//      own descriptors for dynamic names is rejected (even the real verbs get
//      flagged). A function-typed target is walked via Object.hasOwn instead,
//      where fabricated own properties are allowed.
//   2. getOwnPropertyDescriptor is load-bearing, not just get. Server-side
//      capnweb traverses the path with Object.hasOwn(value, segment) BEFORE
//      reading value[segment]; without the descriptor trap each segment reads
//      as absent and the chain dies at ".chat of undefined".
//   3. A provided live capability must be RETAINED (dup) past the provide
//      call's return — capnweb disposes argument stubs when the call returns.

import { newMessagePortRpcSession } from "capnweb";

// Registry: empty at construction, mutated at runtime.
const registry = new Map();

// Retain a provided capability past the provide call's return: capnweb disposes
// argument stubs when the call returns; dup() each stub (a plain object crosses
// by value with its function members as stubs, so walk and dup them).
function retain(t) {
  if (t && typeof t.dup === "function") return t.dup();
  if (t && typeof t === "object") {
    const o = Array.isArray(t) ? [] : {};
    for (const k of Object.keys(t)) o[k] = retain(t[k]);
    return o;
  }
  return t;
}

const RESERVED = new Set([
  "then",
  "constructor",
  "prototype",
  "__proto__",
  "apply",
  "call",
  "bind",
  "dup",
  "onRpcBroken",
]);

// rpcTarget: the runtime verbs + invoke, all on the ONE object the dynamic proxy
// wraps. invoke() does longest-prefix dispatch + receiver-preserving replay of
// the remainder. Empty at construction, mutated at runtime (via provideCapability).
const rpcTarget = {
  provideCapability: (name, target) => {
    registry.set(name, retain(target));
    return `provided ${name}`;
  },
  list: () => [...registry.keys()],
  invoke({ path, args }) {
    for (let i = path.length; i >= 1; i--) {
      if (registry.has(path.slice(0, i).join("."))) {
        const recv = registry.get(path.slice(0, i).join("."));
        const rest = path.slice(i);
        if (rest.length === 0) return typeof recv === "function" ? recv(...args) : recv;
        let parent = recv;
        for (let j = 0; j < rest.length - 1; j++) parent = parent[rest[j]];
        return parent[rest.at(-1)](...args);
      }
    }
    throw new Error(`no capability "${path.join(".")}"`);
  },
};

// THE single dynamic target. Function-typed (see note 1). A root verb name
// resolves to the verb on rpcTarget; any other name extends the path; the
// terminal call funnels into rpcTarget.invoke({ path, args }).
function dynamicTarget({ rpcTarget, path = [] }) {
  const valueFor = (key) =>
    path.length === 0 && key in rpcTarget // provide / invoke / list
      ? rpcTarget[key].bind(rpcTarget)
      : dynamicTarget({ rpcTarget, path: [...path, key] });
  return new Proxy(function () {}, {
    get(t, key) {
      if (typeof key === "symbol") return Reflect.get(t, key);
      if (key === "then" || RESERVED.has(key)) return undefined; // never a thenable; never a control word
      return valueFor(key);
    },
    // LOAD-BEARING: server-side Cap'n Web does Object.hasOwn(value, segment) BEFORE
    // reading value[segment]. Without this trap every segment reads as absent and the
    // chain dies at ".chat of undefined" — even the base verbs read as "not a function".
    getOwnPropertyDescriptor(t, key) {
      if (typeof key === "symbol" || RESERVED.has(key))
        return Reflect.getOwnPropertyDescriptor(t, key);
      return { configurable: true, enumerable: true, writable: false, value: valueFor(key) };
    },
    has(t, key) {
      return typeof key === "symbol" ? key in t : !RESERVED.has(key);
    },
    apply(_t, _s, args) {
      return rpcTarget.invoke({ path, args }); // the accumulated dotted path, in one call
    },
  });
}

const { port1, port2 } = new MessageChannel();
newMessagePortRpcSession(port1, dynamicTarget({ rpcTarget })); // server: ONE dynamic target
const stub = newMessagePortRpcSession(port2); // client: a NAKED stub, no proxy

// The server had no knowledge of "slack" when node([]) was constructed.
console.log(
  "provide    :",
  await stub.provideCapability("slack", {
    chat: { postMessage: async (m) => ({ ok: true, posted: m, via: "original" }) },
    users: { list: async () => ({ ok: true, members: ["U1", "U2"] }) },
  }),
);

// Naked dotted calls — capnweb pipelines the whole path in ONE message; the
// dynamic server target collapses it to one invoke().
console.log("postMessage:", JSON.stringify(await stub.slack.chat.postMessage({ text: "hi" })));
console.log("users.list :", JSON.stringify(await stub.slack.users.list()));

// Register a deeper prefix at runtime; longest-prefix wins, the rest falls through.
await stub.provideCapability("slack.chat.postMessage", async () => ({ ok: true, via: "SHADOW" }));
console.log("shadowed   :", JSON.stringify(await stub.slack.chat.postMessage({ text: "x" })));
console.log("fellthrough:", JSON.stringify(await stub.slack.users.list()));
console.log("list       :", JSON.stringify(await stub.list()));
try {
  await stub.nope.doThing();
} catch (e) {
  console.log("unknown    :", e.message);
}
process.exit(0);
