/// <reference types="@cloudflare/workers-types" />

import {
  delegateToBaseFetch,
  type DurableObjectClass,
  type RuntimeDurableObjectConstructor,
  type WithFetchMixinResult,
} from "./fetch-mixin-utils.ts";
import type { Constructor } from "./mixin-types.ts";
import type { DurableObjectCoreProtected } from "./with-durable-object-core.ts";

type WithKvInspectorResult<TBase extends DurableObjectClass> = WithFetchMixinResult<TBase>;

/**
 * Debug-only KV inspector for a Durable Object's embedded KV storage.
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

  return function <TBase extends DurableObjectClass>(
    Base: TBase & Constructor<DurableObjectCoreProtected>,
  ): WithKvInspectorResult<TBase> {
    const BaseWithCore = Base as unknown as RuntimeDurableObjectConstructor &
      Constructor<DurableObjectCoreProtected>;

    abstract class KvInspectorMixin extends BaseWithCore {
      async fetch(request: Request) {
        const url = new URL(request.url);

        // These are exact DO-local paths. If a fronting Worker mounts the
        // inspector under a prefix, it must strip that prefix before forwarding
        // the request to `stub.fetch()`.
        if (url.pathname === "/__kv" || url.pathname === "/__kv/") {
          return renderKvPage(this.getDurableObjectKv());
        }

        if (url.pathname === "/__kv/json") {
          return Response.json(readKvEntries(this.getDurableObjectKv()));
        }

        return await delegateToBaseFetch(Base, this, request);
      }
    }

    // The class expression really adds fetch(), but TypeScript cannot preserve
    // the generic DurableObject constructor plus accumulated members through
    // the mixin automatically. WithKvInspectorResult is the internal composed
    // shape we verify in the expect-type tests.
    return KvInspectorMixin as unknown as WithKvInspectorResult<TBase>;
  };
}

function renderKvPage(kv: SyncKvStorage) {
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
    <pre>${escapeHtml(JSON.stringify(readKvEntries(kv), null, 2))}</pre>
  </body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}

function readKvEntries(kv: SyncKvStorage) {
  return Array.from(kv.list()).map(([key, value]) => ({ key, value }));
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
