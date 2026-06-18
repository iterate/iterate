import { RpcTarget } from "cloudflare:workers";

type RpcMember<T> = T extends (...args: infer Args) => infer Result
  ? (...args: Args) => Result
  : () => T;

export type Rpcify<T> = {
  [K in keyof T]: RpcMember<T[K]>;
};

type RpcMethodKey<T extends object> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];

export type RpcMethods<T extends object, TExcluded extends PropertyKey = never> = Pick<
  T,
  Exclude<RpcMethodKey<T>, TExcluded>
>;

export type RpcTargetClass<TApi extends object, TSource extends object = TApi> = new (
  source: TSource,
) => RpcTarget & Rpcify<TApi>;

export function makeRpcTargetClass<
  TSource extends object,
  const TExcluded extends keyof TSource = never,
>(
  sourceClass: { prototype: TSource },
  options?: { exclude?: readonly TExcluded[]; include?: readonly PropertyKey[] },
): RpcTargetClass<RpcMethods<TSource, TExcluded>, TSource>;

export function makeRpcTargetClass<TApi extends object, TSource extends object = TApi>(
  sourceClass: { prototype: TSource },
  options?: { exclude?: readonly PropertyKey[]; include?: readonly PropertyKey[] },
): RpcTargetClass<TApi, TSource>;

export function makeRpcTargetClass<TSource extends object>(
  sourceClass: { prototype: TSource },
  options: { exclude?: readonly PropertyKey[]; include?: readonly PropertyKey[] } = {},
): RpcTargetClass<object, TSource> {
  const exclude = new Set<PropertyKey>(["constructor", ...(options.exclude ?? [])]);
  // When `include` is given it is an allowlist: only those methods are proxied.
  // Prefer it for classes with internal (e.g. `protected`) methods — `protected`
  // does not exist at runtime, so a denylist silently leaks any method not
  // explicitly excluded.
  const include = options.include === undefined ? undefined : new Set<PropertyKey>(options.include);

  class GeneratedRpcTarget extends RpcTarget {
    declare readonly source: TSource;

    constructor(source: TSource) {
      super();
      // RpcTarget instances can cross Workers RPC boundaries. Keep the local
      // source reference off the structured-clone surface; only methods below
      // should be exposed remotely.
      Object.defineProperty(this, "source", { value: source, enumerable: false });
    }
  }

  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(sourceClass.prototype),
  )) {
    if (exclude.has(key)) {
      continue;
    }
    if (include !== undefined && !include.has(key)) {
      continue;
    }

    if (typeof descriptor.value === "function") {
      Object.defineProperty(GeneratedRpcTarget.prototype, key, {
        value(this: GeneratedRpcTarget, ...args: unknown[]) {
          const member = Reflect.get(this.source, key);
          if (typeof member !== "function") {
            throw new TypeError(`${key} is not callable on the wrapped RPC source.`);
          }
          return Reflect.apply(member, this.source, args);
        },
      });
      continue;
    }

    if (typeof descriptor.get === "function") {
      Object.defineProperty(GeneratedRpcTarget.prototype, key, {
        value(this: GeneratedRpcTarget) {
          return Reflect.get(this.source, key);
        },
      });
    }
  }

  return GeneratedRpcTarget as RpcTargetClass<object, TSource>;
}
