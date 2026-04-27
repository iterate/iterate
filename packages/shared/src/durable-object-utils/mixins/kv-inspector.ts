/// <reference types="@cloudflare/workers-types" />

type Constructor<T = object> = abstract new (...args: any[]) => T;

type DurableObjectInternals = {
  ctx: DurableObjectState;
};

type FetchBase = {
  fetch?(request: Request): Response | Promise<Response>;
};

export type WithKvInspectorResult<TBase extends Constructor> = TBase & Constructor<FetchBase>;

/**
 * Debug-only KV inspector. Do not mount this on a production-routed Durable
 * Object without an explicit auth/dev gate in front of `fetch()`.
 */
export function withKvInspector<TBase extends Constructor>(
  Base: TBase,
): WithKvInspectorResult<TBase> {
  abstract class KvInspectorMixin extends Base {
    async fetch(request: Request) {
      const url = new URL(request.url);

      if (url.pathname === "/__kv" || url.pathname === "/__kv/") {
        return renderKvPage(this);
      }

      if (url.pathname === "/__kv/json") {
        return Response.json(readKvEntries(this));
      }

      const baseFetch = (Base.prototype as FetchBase).fetch;
      if (baseFetch !== undefined) return await baseFetch.call(this, request);

      return new Response("Not found", { status: 404 });
    }
  }

  return KvInspectorMixin as unknown as WithKvInspectorResult<TBase>;
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
