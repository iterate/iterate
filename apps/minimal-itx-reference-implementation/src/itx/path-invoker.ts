import { replayPath } from "./processor.ts";

export type PathInvocation = { path: string[]; args?: unknown[] };
export type PathInvokable = { invokeCapability(args: PathInvocation): unknown };

// Names Cap'n Web (or the JS runtime) probes that must never be treated as path
// segments or verbs. "then" is the important one: if a path proxy looks
// thenable, every await tries to unwrap it instead of preserving the capability
// path.
const RESERVED = new Set([
  "then",
  "__proto__",
  "constructor",
  "prototype",
  "apply",
  "call",
  "bind",
  "dup",
  "onRpcBroken",
]);

// `objectToPathInvoker` and `pathInvokerToProxy` are inverses:
//
//   ordinary object -> objectToPathInvoker -> { invokeCapability({ path,args }) }
//   PathInvokable   -> pathInvokerToProxy  -> ordinary dotted/call object
//
// The first direction is how a domain Durable Object exposes its explicit public
// surface as an ITX built-in. The second direction is how Cap'n Web clients get
// the pleasant `itx.slack.chat.postMessage(...)` spelling while the server still
// sees exactly one operation: invokeCapability({ path, args }).

function findSubclassDescriptor(
  target: object,
  key: string,
  stopAt: object,
): PropertyDescriptor | undefined {
  for (
    let proto = Object.getPrototypeOf(target);
    proto && proto !== stopAt;
    proto = Object.getPrototypeOf(proto)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (descriptor) return descriptor;
  }
  return undefined;
}

async function replayObjectPath(target: object, path: string[], args: unknown[], stopAt: object) {
  const [head, ...rest] = path;
  if (!head) return target;
  const descriptor = findSubclassDescriptor(target, head, stopAt);
  if (!descriptor) throw new Error(`no host capability "${head}"`);

  const value = "value" in descriptor ? descriptor.value : await descriptor.get?.call(target);
  if (rest.length > 0) return await replayPath({ args, path: rest, target: value });
  if (typeof value === "function") return await value.apply(target, args);
  return value;
}

export function objectToPathInvoker(target: object, stopAt: object): PathInvokable {
  return {
    invokeCapability: ({ path, args = [] }) => replayObjectPath(target, path, args, stopAt),
  };
}

export function pathInvokerToProxy(target: PathInvokable, path: string[] = []): any {
  const valueFor = (key: string) => pathInvokerToProxy(target, [...path, key]);
  return new Proxy(function () {}, {
    get(t, key) {
      if (typeof key === "symbol") return Reflect.get(t, key);
      if (RESERVED.has(key as string)) return undefined;
      return valueFor(key);
    },
    getOwnPropertyDescriptor(t, key) {
      if (typeof key === "symbol" || RESERVED.has(key as string))
        return Reflect.getOwnPropertyDescriptor(t, key);
      return { configurable: true, enumerable: true, writable: false, value: valueFor(key) };
    },
    has(t, key) {
      return typeof key === "symbol" ? key in t : !RESERVED.has(key as string);
    },
    apply(_t, _s, args) {
      return target.invokeCapability({ path, args: args as unknown[] });
    },
  });
}

export function localPathProxy(target: unknown | Promise<unknown>, path: string[] = []): any {
  return new Proxy(function () {}, {
    get(_t, key) {
      if (typeof key === "symbol") return undefined;
      if (RESERVED.has(key as string)) return undefined;
      return localPathProxy(target, [...path, key as string]);
    },
    apply: async (_t, _s, args) => await replayPath({ args, path, target: await target }),
  });
}
