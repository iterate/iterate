/// <reference types="@cloudflare/workers-types" />

import {
  delegateToBaseFetch,
  type DurableObjectClass,
  type RuntimeDurableObjectConstructor,
  type WithFetchMixinResult,
} from "./fetch-mixin-utils.ts";
import type { Constructor } from "./mixin-types.ts";
import type { DurableObjectCoreProtected } from "./with-durable-object-core.ts";

type WithOuterbaseResult<TBase extends DurableObjectClass> = WithFetchMixinResult<TBase>;

/**
 * Debug-only SQL inspector for a Durable Object's embedded SQLite storage.
 *
 * This wraps `fetch()` and owns two routes:
 *
 * - `GET /__outerbase` renders a tiny page that embeds libSQL Studio.
 * - `POST /__outerbase/sql` executes SQL against DO-local SQLite storage and
 *   returns rows/column metadata in the shape expected by the embedded UI.
 *
 * The SQL endpoint can run arbitrary reads and writes against the Durable
 * Object's embedded SQLite database. The page also sends query results and
 * errors to the embedded third-party libSQL Studio iframe. The `unsafe` option
 * is intentionally noisy so call sites have to acknowledge that this mixin must
 * sit behind a development-only or otherwise authenticated route. It is only an
 * acknowledgement, not runtime auth.
 */
export function withOuterbase(options: { unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL" }) {
  void options;

  return function <TBase extends DurableObjectClass>(
    Base: TBase & Constructor<DurableObjectCoreProtected>,
  ): WithOuterbaseResult<TBase> {
    const BaseWithCore = Base as unknown as RuntimeDurableObjectConstructor &
      Constructor<DurableObjectCoreProtected>;

    abstract class OuterbaseMixin extends BaseWithCore {
      async fetch(request: Request) {
        const url = new URL(request.url);

        // These are exact DO-local paths. If a fronting Worker mounts the
        // inspector under a prefix, it must strip that prefix before forwarding
        // the request to `stub.fetch()`.
        if (url.pathname === "/__outerbase" || url.pathname === "/__outerbase/") {
          return renderOuterbasePage();
        }

        if (url.pathname === "/__outerbase/sql") {
          return this.useDurableObjectSql((sql) =>
            handleOuterbaseSql(sql, (closure) => this.transactionSync(closure), request),
          );
        }

        return await delegateToBaseFetch(Base, this, request);
      }
    }

    // The class expression really adds fetch(), but TypeScript cannot preserve
    // the generic DurableObject constructor plus accumulated members through
    // the mixin automatically. WithOuterbaseResult is the internal composed
    // shape we verify in the expect-type tests.
    return OuterbaseMixin as unknown as WithOuterbaseResult<TBase>;
  };
}

async function handleOuterbaseSql(
  sql: SqlStorage,
  transactionSync: <T>(closure: () => T) => T,
  request: Request,
) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

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
        data: transactionSync(() => statements.map((statement) => executeSql(sql, statement, []))),
      });
    }

    const statement = readStatement(body.statement ?? body.sql);
    if (statement === undefined) {
      return Response.json({ error: "Expected statement or sql." }, { status: 400 });
    }

    return Response.json({
      data: executeSql(sql, statement, readParams(body.params)),
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
  if (Array.isArray(value)) {
    return value.map(readSqlStorageValue);
  }

  throw new Error("params must be an array.");
}

function readSqlStorageValue(value: unknown): SqlStorageValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    value === null ||
    value instanceof ArrayBuffer
  ) {
    return value;
  }

  throw new Error("params entries must be strings, numbers, null, or ArrayBuffers.");
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
