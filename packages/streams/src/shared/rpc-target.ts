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
  options?: { exclude?: readonly TExcluded[] },
): RpcTargetClass<RpcMethods<TSource, TExcluded>, TSource>;

export function makeRpcTargetClass<TApi extends object, TSource extends object = TApi>(
  sourceClass: { prototype: TSource },
  options?: { exclude?: readonly PropertyKey[] },
): RpcTargetClass<TApi, TSource>;

export function makeRpcTargetClass<TSource extends object>(
  sourceClass: { prototype: TSource },
  options: { exclude?: readonly PropertyKey[] } = {},
): RpcTargetClass<object, TSource> {
  const exclude = new Set<PropertyKey>(["constructor", ...(options.exclude ?? [])]);

  class GeneratedRpcTarget extends RpcTarget {
    constructor(readonly source: TSource) {
      super();
    }
  }

  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(sourceClass.prototype),
  )) {
    if (exclude.has(key)) {
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
