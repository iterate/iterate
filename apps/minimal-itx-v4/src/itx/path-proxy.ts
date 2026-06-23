export type DynamicPathCall = {
  args: unknown[];
  path: string[];
};

export type InvokeCapabilityTarget = {
  invokeCapability(call: DynamicPathCall): unknown;
};

export const RESERVED_DYNAMIC_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "apply",
  "bind",
  "call",
  "catch",
  "constructor",
  "dup",
  "finally",
  "hasOwnProperty",
  "isPrototypeOf",
  "map",
  "onRpcBroken",
  "propertyIsEnumerable",
  "prototype",
  "then",
  "toLocaleString",
  "toString",
  "valueOf",
]);

export type DynamicPathFallbackOptions = {
  isReserved?: (segment: string) => boolean;
};

export function isReservedDynamicPathSegment(segment: string): boolean {
  return RESERVED_DYNAMIC_PATH_SEGMENTS.has(segment);
}

export function createInvokeCapabilityPathProxy(
  target: InvokeCapabilityTarget,
  path: string[] = [],
  isReserved = isReservedDynamicPathSegment,
): unknown {
  const valueFor = (key: string) =>
    createInvokeCapabilityPathProxy(target, [...path, key], isReserved);

  function pathTarget() {
    return undefined;
  }

  return new Proxy(pathTarget, {
    apply(_target, _thisArg, args) {
      return target.invokeCapability({ args: [...args], path });
    },
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      if (isReserved(key)) return undefined;
      return valueFor(key);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor) return descriptor;
      if (typeof key === "symbol" || isReserved(key)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        value: valueFor(key),
        writable: false,
      };
    },
    has(target, key) {
      if (typeof key === "symbol") return key in target;
      return !isReserved(key);
    },
  });
}

export function withInvokeCapabilityFallback<T extends object & InvokeCapabilityTarget>(
  target: T,
  options: DynamicPathFallbackOptions = {},
): T {
  const isReserved = options.isReserved ?? isReservedDynamicPathSegment;

  return new Proxy(target, {
    get(target, key) {
      if (key === "then") return undefined;
      if (typeof key === "symbol" || key in target) {
        const value = Reflect.get(target, key, target);
        if (typeof value === "function" && !isAccessor(target, key)) {
          return value.bind(target);
        }
        return value;
      }
      if (isReserved(key)) return undefined;
      return createInvokeCapabilityPathProxy(target, [key], isReserved);
    },
    getOwnPropertyDescriptor(target, key) {
      // Unknown dynamic roots must not look like instance fields to Cap'n Web.
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

function isAccessor(target: object, key: PropertyKey): boolean {
  for (let node: object | null = target; node; node = Object.getPrototypeOf(node)) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (descriptor) return descriptor.get !== undefined;
  }
  return false;
}
