import { RpcTarget } from "cloudflare:workers";

type PublicMethodKey<T extends object> = {
  [K in keyof T]: T[K] extends (...args: any[]) => unknown ? K : never;
}[keyof T];

export type PublicApiOf<T extends object> = Pick<T, PublicMethodKey<T>>;

export type RpcTargetClass<TApi extends object, TSource extends object = TApi> = new (
  source: TSource,
) => RpcTarget & TApi;

export function createRpcTargetClass<TSource extends object>(sourceClass: {
  prototype: TSource;
}): RpcTargetClass<PublicApiOf<TSource>, TSource>;
export function createRpcTargetClass<TApi extends object, TSource extends object>(sourceClass: {
  prototype: TSource;
}): RpcTargetClass<TApi, TSource>;
export function createRpcTargetClass<TSource extends object>(sourceClass: {
  prototype: TSource;
}): RpcTargetClass<object, TSource> {
  class GeneratedRpcTarget extends RpcTarget {
    constructor(readonly source: TSource) {
      super();
    }
  }

  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(sourceClass.prototype),
  )) {
    if (key === "constructor" || typeof descriptor.value !== "function") {
      continue;
    }

    Object.defineProperty(GeneratedRpcTarget.prototype, key, {
      value(this: GeneratedRpcTarget, ...args: unknown[]) {
        const member = Reflect.get(this.source, key);
        if (typeof member !== "function") {
          throw new TypeError(`${key} is not callable on the wrapped RPC source.`);
        }
        return Reflect.apply(member, this.source, args);
      },
    });
  }

  return GeneratedRpcTarget as unknown as RpcTargetClass<object, TSource>;
}
