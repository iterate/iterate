const RESERVED_PATH_SEGMENTS = new Set([
  "__proto__",
  "catch",
  "constructor",
  "dup",
  "finally",
  "hasOwnProperty",
  "map",
  "onRpcBroken",
  "prototype",
  "then",
  "toString",
  "valueOf",
]);

export type PathProxyCall = (input: { args: unknown[]; path: string[] }) => unknown;
export type PathProxyDispose = () => void;
export type PathProxyOptions = {
  dispose?: PathProxyDispose;
};

export class PathProxyRpcTarget {
  constructor(callPath: PathProxyCall, options: PathProxyOptions = {}) {
    return pathNodeProxy(callPath, [], options.dispose) as unknown as PathProxyRpcTarget;
  }
}

function pathNodeProxy(
  callPath: PathProxyCall,
  path: string[],
  dispose: PathProxyDispose | undefined,
): Function {
  const fn = (...args: unknown[]) => callPath({ args, path });

  Object.defineProperty(fn, Symbol.dispose, {
    configurable: true,
    value() {
      dispose?.();
    },
  });

  return new Proxy(fn, {
    apply(_target, _thisArg, args) {
      return callPath({ args, path });
    },
    get(target, key, receiver) {
      if (key === "then") return undefined;
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      if (RESERVED_PATH_SEGMENTS.has(key)) return undefined;
      if (key in target) return Reflect.get(target, key, receiver);
      return pathNodeProxy(callPath, [...path, key], dispose);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor) return descriptor;
      if (key in target) return undefined;
      if (typeof key === "symbol" || RESERVED_PATH_SEGMENTS.has(key)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        value: pathNodeProxy(callPath, [...path, key], dispose),
        writable: false,
      };
    },
    has(target, key) {
      if (typeof key === "symbol") return key in target;
      if (RESERVED_PATH_SEGMENTS.has(key)) return false;
      return true;
    },
  });
}
