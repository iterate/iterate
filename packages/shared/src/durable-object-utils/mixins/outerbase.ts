/// <reference types="@cloudflare/workers-types" />

type Constructor<T = object> = abstract new (...args: any[]) => T;

type DurableObjectInternals = {
  ctx: DurableObjectState;
};

type FetchBase = {
  fetch?(request: Request): Response | Promise<Response>;
};

export type WithOuterbaseResult<TBase extends Constructor> = TBase & Constructor<FetchBase>;

/**
 * Debug-only SQL inspector. Do not mount this on a production-routed Durable
 * Object without an explicit auth/dev gate in front of `fetch()`.
 */
export function withOuterbase<TBase extends Constructor>(Base: TBase): WithOuterbaseResult<TBase> {
  abstract class OuterbaseMixin extends Base {
    async fetch(request: Request) {
      const url = new URL(request.url);

      if (url.pathname === "/__outerbase" || url.pathname === "/__outerbase/") {
        return renderOuterbasePage();
      }

      if (url.pathname === "/__outerbase/sql") {
        return handleOuterbaseSql(this, request);
      }

      const baseFetch = (Base.prototype as FetchBase).fetch;
      if (baseFetch !== undefined) return await baseFetch.call(this, request);

      return new Response("Not found", { status: 404 });
    }
  }

  return OuterbaseMixin as unknown as WithOuterbaseResult<TBase>;
}

async function handleOuterbaseSql(instance: object, request: Request) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json<{
    statement?: string;
    statements?: string[];
    sql?: string;
    params?: SqlStorageValue[];
  }>();
  const { ctx } = instance as unknown as DurableObjectInternals;

  try {
    if (body.statements !== undefined) {
      return Response.json({
        data: body.statements.map((statement) => executeSql(ctx.storage.sql, statement, [])),
      });
    }

    const statement = body.statement ?? body.sql;
    if (statement === undefined) {
      return Response.json({ error: "Expected statement or sql." }, { status: 400 });
    }

    return Response.json({
      data: executeSql(ctx.storage.sql, statement, body.params ?? []),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
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
          const response = await fetch("/__outerbase/sql", {
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
