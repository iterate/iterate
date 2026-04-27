/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

/**
 * Cloudflare Durable Object bases are generic class values:
 *
 *   class Room extends Base<Env> {}
 *
 * Fetch-wrapper mixins stack on top of each other, so they must return that
 * same generic constructor shape. `ReqEnv` is the minimum Env required by
 * mixins applied so far. `Members` are the instance methods already added by
 * mixins applied so far.
 */
type DurableObjectClass<ReqEnv = unknown, Members = object> = abstract new <Env extends ReqEnv>(
  ctx: DurableObjectState,
  env: Env,
) => DurableObject<Env> & Members;

type ReqEnvOf<C> = C extends DurableObjectClass<infer ReqEnv, infer _Members> ? ReqEnv : unknown;

type MembersOf<C> = C extends DurableObjectClass<infer _ReqEnv, infer Members> ? Members : object;

// Mapped types copy static properties but not construct signatures. That avoids
// the "base constructors must all have the same return type" problem that
// happens when an intersection contains multiple incompatible constructor
// signatures.
type StaticSide<T> = {
  [K in keyof T]: T[K];
};

type RuntimeDurableObjectConstructor = abstract new (...args: any[]) => DurableObject;

type DurableObjectInternals = {
  ctx: DurableObjectState;
};

type FetchBase = {
  fetch(request: Request): Response | Promise<Response>;
};

type OptionalFetchBase = {
  fetch?(request: Request): Response | Promise<Response>;
};

export type WithKvInspectorResult<TBase extends DurableObjectClass> = StaticSide<TBase> &
  // Intersect two things:
  //
  // 1. StaticSide<TBase>, preserving static properties from the wrapped class
  //    without carrying forward an incompatible constructor signature.
  // 2. a fresh generic DurableObject constructor, preserving `MixedBase<Env>`
  //    and adding fetch() to the accumulated instance surface.
  //
  // Benefit:
  //
  //   const InspectorBase = withKvInspector(...)(withOuterbase(...)(DurableObject));
  //   class Inspector extends InspectorBase<Env> {}
  DurableObjectClass<ReqEnvOf<TBase>, MembersOf<TBase> & FetchBase>;

/**
 * Debug-only KV inspector.
 *
 * This wraps `fetch()` and owns two routes:
 *
 * - `GET /__kv` renders a small HTML page with the current KV contents.
 * - `GET /__kv/json` returns the same entries as JSON for tests/tools.
 *
 * The route reads every key/value pair in the Durable Object's SQLite-backed
 * KV storage. The `unsafe` option is intentionally noisy so call sites have to
 * acknowledge that this mixin must sit behind a development-only or otherwise
 * authenticated route. It is only an acknowledgement, not runtime auth.
 */
export function withKvInspector(options: { unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV" }) {
  void options;

  return function <TBase extends DurableObjectClass>(Base: TBase): WithKvInspectorResult<TBase> {
    abstract class KvInspectorMixin extends (Base as unknown as RuntimeDurableObjectConstructor) {
      async fetch(request: Request) {
        const url = new URL(request.url);

        // These are exact DO-local paths. If a fronting Worker mounts the
        // inspector under a prefix, it must strip that prefix before forwarding
        // the request to `stub.fetch()`.
        if (url.pathname === "/__kv" || url.pathname === "/__kv/") {
          return renderKvPage(this);
        }

        if (url.pathname === "/__kv/json") {
          return Response.json(readKvEntries(this));
        }

        // Fetch mixins wrap the request handler in stack order. If this mixin
        // does not own the path, delegate to the wrapped base class instead of
        // swallowing the request.
        const baseFetch = (Base.prototype as OptionalFetchBase).fetch;
        if (baseFetch !== undefined) return await baseFetch.call(this, request);

        return new Response("Not found", { status: 404 });
      }
    }

    // The class expression really adds fetch(), but TypeScript cannot preserve
    // the generic DurableObject constructor plus accumulated members through
    // the mixin automatically. WithKvInspectorResult is the public composed
    // shape we verify in the expect-type tests.
    return KvInspectorMixin as unknown as WithKvInspectorResult<TBase>;
  };
}

function renderKvPage(instance: object) {
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Durable Object KV Inspector</title>
    <style>
      body { margin: 0; padding: 24px; background: #111827; color: #e5e7eb; font: 14px ui-monospace, SFMono-Regular, Menlo, monospace; }
      h1 { margin-top: 0; font: 600 18px ui-sans-serif, system-ui, sans-serif; }
      pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 16px; border: 1px solid #374151; border-radius: 12px; background: #030712; }
    </style>
  </head>
  <body>
    <h1>Durable Object KV</h1>
    <pre>${escapeHtml(JSON.stringify(readKvEntries(instance), null, 2))}</pre>
  </body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}

function readKvEntries(instance: object) {
  // `ctx` is protected on DurableObject. The base constructor constraint proves
  // this is a Durable Object instance; the narrow cast keeps the protected-field
  // escape hatch local to this debug-only inspector.
  const { ctx } = instance as unknown as DurableObjectInternals;
  return Array.from(ctx.storage.kv.list()).map(([key, value]) => ({ key, value }));
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
