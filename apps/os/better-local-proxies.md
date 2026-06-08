Exactly — return a plain marker object whose `call` is a **function** (functions pass by reference over both capnweb and Workers RPC, so the client gets a callable stub). The client wrapper stays totally generic; adding `.someOtherSdk` is just another server getter/method that returns the same marker shape.

```ts
// ─────────── server ───────────
const MARK = "__localProxyCaller";
type Caller = (req: { path: string[]; args: unknown[] }) => unknown;

// the marker factory — plain object (string key) carrying a by-reference function
const localProxyCaller = (call: Caller) => ({ [MARK]: true, call });

class IterateContext extends RpcTarget {
  constructor(private projectId: string) {
    super();
  }

  // getter form:  iterate.context.sdk.bla.bla(args)
  get sdk() {
    return localProxyCaller(
      ({ path, args }) => `sdk: ${path.join(".")}(${JSON.stringify(args)}) @ ${this.projectId}`,
    );
  }

  // method form:  iterate.context.getSdk("slack").chat.postMessage(args)
  getSdk(name: string) {
    return localProxyCaller(
      ({ path, args }) => `${name}: ${path.join(".")}(${JSON.stringify(args)}) @ ${this.projectId}`,
    );
  }

  // add a new one with ZERO client / dynamic-worker changes:
  get someOtherSdk() {
    return localProxyCaller(({ path, args }) => `other: ${path.join(".")}`);
  }
}
```

```js
// ─────────── client runtime (generic, injected once) ───────────
const MARK = "__localProxyCaller";

function pathProxy(call, path = []) {
  return new Proxy(function () {}, {
    get(_t, k) {
      return k === "then" || typeof k === "symbol" ? undefined : pathProxy(call, [...path, k]);
    },
    apply(_t, _s, args) {
      return call({ path, args });
    }, // invokes the by-ref function stub
  });
}

const adapt = (v) => (v && typeof v === "object" && v[MARK] ? pathProxy(v.call) : v);

function lift(node) {
  return new Proxy(node, {
    get(target, key, recv) {
      if (key === "then" && typeof target.then === "function") {
        return (onOk, onErr) => target.then((v) => onOk(adapt(v)), onErr);
      }
      const v = Reflect.get(target, key, recv);
      return v !== null && (typeof v === "object" || typeof v === "function") ? lift(v) : v;
    },
    apply(target, thisArg, args) {
      return lift(Reflect.apply(target, thisArg, args));
    },
  });
}
```

```js
// ─────────── usage in the dynamic worker ───────────
const iterate = lift(env.ITERATE);

// getter
const sdk = await iterate.context.sdk; // marker → local pathProxy
await sdk.bla.bla("x"); // → call({ path:["bla","bla"], args:["x"] })

// method — identical detection, no client change
const slack = await iterate.context.getSdk("slack");
await slack.chat.postMessage({ channel: "#x", text: "hi" });

// new sdk — only the server getter above was added
const other = await iterate.context.someOtherSdk;
await other.deeply.nested.thing();
```

The whole mechanism in one sentence: a getter or method returns `{ __localProxyCaller: true, call }`; the object travels by value, `call` travels by reference as a callable stub; `lift` notices the marker on resolution and hands you a `pathProxy` that funnels any path into `call({ path, args })`. Getters and methods are indistinguishable to the client because it only ever inspects the _resolved value_, so both work and new entries need nothing but a new server member.

Four notes:

The marker key must be a **string** (`"__localProxyCaller"`) — symbol-keyed properties are dropped by structured clone, so a symbol marker wouldn't survive the wire. `call` is what crosses by reference.

`call` runs **on the server** with its captured closure (`this.projectId` etc.), so each sdk's logic lives right there in its getter/method — implement them manually as you wanted, no central registry needed.

There's still the **await at the boundary** (`await iterate.context.sdk`): the client can't know it's special until the marker returns, so reaching the mount is one round trip and the dispatch is another. Hold the result (`const sdk = await …`) and reuse it — each `await` of the getter mints a fresh `call` stub. Dispose it (or rely on session teardown) when done.
