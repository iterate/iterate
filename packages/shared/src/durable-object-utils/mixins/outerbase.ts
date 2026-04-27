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

export type WithOuterbaseResult<TBase extends DurableObjectClass> = StaticSide<TBase> &
  // Intersect two things:
  //
  // 1. StaticSide<TBase>, preserving static properties from the wrapped class
  //    without carrying forward an incompatible constructor signature.
  // 2. a fresh generic DurableObject constructor, preserving `MixedBase<Env>`
  //    and adding fetch() to the accumulated instance surface.
  //
  // Benefit:
  //
  //   const InspectorBase = withOuterbase(...)(DurableObject);
  //   class Inspector extends InspectorBase<Env> {}
  DurableObjectClass<ReqEnvOf<TBase>, MembersOf<TBase> & FetchBase>;

/**
 * Debug-only SQL inspector.
 *
 * This wraps `fetch()` and owns two routes:
 *
 * - `GET /__outerbase` renders a tiny page that embeds libSQL Studio.
 * - `POST /__outerbase/sql` executes SQL against `ctx.storage.sql` and returns
 *   rows/column metadata in the shape expected by the embedded UI.
 *
 * The SQL endpoint can run arbitrary reads and writes against the Durable
 * Object's embedded SQLite database. The `unsafe` option is intentionally noisy
 * so call sites have to acknowledge that this mixin must sit behind a
 * development-only or otherwise authenticated route. It is only an
 * acknowledgement, not runtime auth.
 */
export function withOuterbase(options: { unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL" }) {
  void options;

  return function <TBase extends DurableObjectClass>(Base: TBase): WithOuterbaseResult<TBase> {
    abstract class OuterbaseMixin extends (Base as unknown as RuntimeDurableObjectConstructor) {
      async fetch(request: Request) {
        const url = new URL(request.url);

        // These are exact DO-local paths. If a fronting Worker mounts the
        // inspector under a prefix, it must strip that prefix before forwarding
        // the request to `stub.fetch()`.
        if (url.pathname === "/__outerbase" || url.pathname === "/__outerbase/") {
          return renderOuterbasePage();
        }

        if (url.pathname === "/__outerbase/sql") {
          return handleOuterbaseSql(this, request);
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
    // the mixin automatically. WithOuterbaseResult is the public composed shape
    // we verify in the expect-type tests.
    return OuterbaseMixin as unknown as WithOuterbaseResult<TBase>;
  };
}

async function handleOuterbaseSql(instance: object, request: Request) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // `ctx` is protected on DurableObject. The base constructor constraint proves
  // this is a Durable Object instance; the narrow cast keeps the protected-field
  // escape hatch local to this debug-only route handler.
  const { ctx } = instance as unknown as DurableObjectInternals;

  try {
    const body = await request.json<{
      statement?: unknown;
      statements?: unknown;
      sql?: unknown;
      params?: unknown;
    }>();

    if (body.statements !== undefined) {
      const statements = readStatements(body.statements);
      if (body.params !== undefined) {
        return Response.json(
          { error: "params are not supported with transaction statements." },
          { status: 400 },
        );
      }

      return Response.json({
        // Outerbase's "transaction" messages can contain multiple statements.
        // Transaction mode supports raw statement strings only; parameterized
        // transaction batches should be represented as separate queries until
        // we intentionally support a richer per-statement shape.
        // Durable Object SQLite gives us a synchronous transaction wrapper, so
        // if any statement throws, the whole batch rolls back and the handler
        // returns one 400 error instead of partial per-statement results.
        data: ctx.storage.transactionSync(() =>
          statements.map((statement) => executeSql(ctx.storage.sql, statement, [])),
        ),
      });
    }

    const statement = readStatement(body.statement ?? body.sql);
    if (statement === undefined) {
      return Response.json({ error: "Expected statement or sql." }, { status: 400 });
    }

    return Response.json({
      data: executeSql(ctx.storage.sql, statement, readParams(body.params)),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

function readStatement(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;

  throw new Error("statement must be a string.");
}

function readStatements(value: unknown) {
  if (!Array.isArray(value) || value.some((statement) => typeof statement !== "string")) {
    throw new Error("statements must be an array of strings.");
  }

  return value;
}

function readParams(value: unknown): SqlStorageValue[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value as SqlStorageValue[];

  throw new Error("params must be an array.");
}

function executeSql(sql: SqlStorage, statement: string, params: SqlStorageValue[]) {
  const startedAt = Date.now();
  const cursor = sql.exec(statement, ...params);
  const rows = cursor.toArray();

  return {
    rows,
    headers: cursor.columnNames.map((name) => ({
      name,
      displayName: name,
      originalType: null,
      type: 1,
    })),
    stat: {
      rowsAffected: cursor.rowsWritten,
      rowsRead: cursor.rowsRead,
      rowsWritten: cursor.rowsWritten,
      queryDurationMs: Date.now() - startedAt,
    },
  };
}

function renderOuterbasePage() {
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Outerbase Durable Object Inspector</title>
    <style>
      html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; }
      body { background: #0f172a; }
    </style>
  </head>
  <body>
    <iframe id="outerbase" src="https://libsqlstudio.com/embed/sqlite?name=Durable%20Object"></iframe>
    <script>
      const frame = document.getElementById("outerbase");
      window.addEventListener("message", async (event) => {
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (message.type !== "query" && message.type !== "transaction") return;

        try {
          // Use a path relative to the page itself. The fronting worker mounts
          // this page under /inspectors/:name/__outerbase, while direct DO
          // fetches mount it at /__outerbase; absolute paths would break one
          // of those two modes.
          const endpointPath = window.location.pathname.replace(/\\/$/, "") + "/sql";
          const response = await fetch(endpointPath + window.location.search, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(message),
          });
          const payload = await response.json();
          frame.contentWindow.postMessage({
            type: message.type,
            id: message.id,
            data: payload.data,
            error: payload.error,
          }, "*");
        } catch (error) {
          frame.contentWindow.postMessage({
            type: message.type,
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          }, "*");
        }
      });
    </script>
  </body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}
