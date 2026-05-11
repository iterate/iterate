/// <reference types="@cloudflare/workers-types" />

import type {
  DurableObjectClass,
  DurableObjectMixinResult,
  RuntimeDurableObjectConstructor,
} from "./mixin-types.ts";
export type {
  DurableObjectClass,
  MembersOf,
  ReqEnvOf,
  RuntimeDurableObjectConstructor,
  StaticSide,
} from "./mixin-types.ts";

export type FetchBase = {
  fetch(request: Request): Response | Promise<Response>;
};

type OptionalFetchBase = {
  fetch?(request: Request): Response | Promise<Response>;
};

/**
 * Public result type for mixins that add or wrap fetch().
 *
 * Benefit:
 *
 *   const Base = withKvInspector(...)(withOuterbase(...)(withDurableObjectCore(DurableObject)));
 *   class Room extends Base<Env> {}
 *
 * The composed class remains generic in Env, statics from the wrapped class are
 * preserved, and the instance type now includes fetch().
 */
export type WithFetchMixinResult<TBase extends DurableObjectClass> = DurableObjectMixinResult<
  TBase,
  FetchBase
>;

/**
 * Delegate to the wrapped class's fetch() when a mixin does not own a route.
 *
 * Fetch mixins compose by trying their route first, then passing through to the
 * base class. If no lower layer handles fetch(), return a plain 404. This keeps
 * each inspector focused on its own route instead of duplicating fallback logic.
 */
export async function delegateToBaseFetch(
  Base: DurableObjectClass,
  instance: object,
  request: Request,
): Promise<Response> {
  const baseFetch = (Base.prototype as OptionalFetchBase).fetch;
  if (baseFetch !== undefined) return await baseFetch.call(instance, request);

  return new Response("Not found", { status: 404 });
}
