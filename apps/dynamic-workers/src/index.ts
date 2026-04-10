import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// ─── Type definitions ────────────────────────────────────────────

interface WorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, string>;
  compatibilityFlags?: string[];
  env?: Record<string, unknown>;
  globalOutbound?: null;
}

interface WorkerStub {
  getEntrypoint(name?: string): Service;
}

interface WorkerLoader {
  load(code: WorkerCode): WorkerStub;
  get(id: string, getCode: () => Promise<WorkerCode>): WorkerStub;
}

interface Env {
  LOADER: WorkerLoader;
  DYNAMIC_WORKER_DO: DurableObjectNamespace<DynamicWorkerDO>;
}

interface SqlBridgeProps {
  doId: string;
}

// ─── 1. Parent Worker ────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get("tenant") ?? "default";

    // Each tenant gets its own DO instance = its own SQLite database
    const doId = env.DYNAMIC_WORKER_DO.idFromName(tenantId);
    const stub = env.DYNAMIC_WORKER_DO.get(doId);

    return stub.handleRequest(request);
  },
};

// ─── 2. SqlBridge — WorkerEntrypoint that proxies SQL to the DO ──
//
// This is a loopback service binding created via ctx.exports.
// The dynamic worker calls env.SQL.execSql(...), which arrives here,
// and this class forwards it to the target DO instance.

export class SqlBridge extends WorkerEntrypoint<Env> {
  private get props(): SqlBridgeProps {
    return (this.ctx as unknown as { props: SqlBridgeProps }).props;
  }

  async execSql(
    sql: string,
    params: unknown[],
    method: "run" | "all" | "values" | "get",
  ): Promise<{ rows: unknown[][] | unknown[] }> {
    const doId = this.env.DYNAMIC_WORKER_DO.idFromString(this.props.doId);
    const stub = this.env.DYNAMIC_WORKER_DO.get(doId);
    return stub.execSql(sql, params, method);
  }

  async execSqlBatch(
    queries: { sql: string; params: unknown[]; method: string }[],
  ): Promise<{ rows: unknown[][] | unknown[] }[]> {
    const doId = this.env.DYNAMIC_WORKER_DO.idFromString(this.props.doId);
    const stub = this.env.DYNAMIC_WORKER_DO.get(doId);
    return stub.execSqlBatch(queries);
  }
}

// ─── 3. Durable Object ──────────────────────────────────────────

export class DynamicWorkerDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Create tables on first instantiation (runs synchronously)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'user'
      );
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        title TEXT NOT NULL,
        body TEXT NOT NULL
      );
    `);
  }

  // ── Called by the parent Worker ──
  async handleRequest(request: Request): Promise<Response> {
    // Production path: delegate to a sandboxed dynamic worker via LOADER.
    // The dynamic worker calls back through SqlBridge (ctx.exports) for SQL.
    if (typeof this.env.LOADER?.load === "function") {
      return this.handleViaDynamicWorker(request);
    }

    // Local fallback: LOADER.load() isn't available in the local workerd
    // runtime yet, so handle the request directly with the same logic
    // the dynamic worker would use.
    return this.handleDirectly(request);
  }

  // ── Production: dynamic worker via LOADER ──
  private async handleViaDynamicWorker(request: Request): Promise<Response> {
    const ctxExports = (
      this.ctx as unknown as {
        exports: {
          SqlBridge(opts: { props: SqlBridgeProps }): Service;
        };
      }
    ).exports;

    const sqlBinding = ctxExports.SqlBridge({
      props: { doId: this.ctx.id.toString() },
    });

    const worker = this.env.LOADER.load({
      compatibilityDate: "2026-03-01",
      mainModule: "index.js",
      modules: {
        "index.js": DYNAMIC_WORKER_CODE,
      },
      env: {
        SQL: sqlBinding,
      },
      globalOutbound: null,
    });

    // While awaiting, the DO's input gate OPENS — allowing
    // the SqlBridge's RPC callbacks to be delivered and handled.
    return worker.getEntrypoint().fetch(request);
  }

  // ── Local fallback: same routing logic as DYNAMIC_WORKER_CODE ──
  private async handleDirectly(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/users" && request.method === "POST") {
      const { name, email } = (await request.json()) as {
        name: string;
        email: string;
      };
      await this.execSql("INSERT INTO users (name, email) VALUES (?, ?)", [name, email], "run");
      return Response.json({ ok: true });
    }

    if (url.pathname === "/users" && request.method === "GET") {
      const result = await this.execSql("SELECT * FROM users", [], "all");
      return Response.json(result.rows);
    }

    if (url.pathname === "/posts" && request.method === "POST") {
      const { userId, title, body } = (await request.json()) as {
        userId: number;
        title: string;
        body: string;
      };
      await this.execSql(
        "INSERT INTO posts (user_id, title, body) VALUES (?, ?, ?)",
        [userId, title, body],
        "run",
      );
      return Response.json({ ok: true });
    }

    const userPostsMatch = url.pathname.match(/^\/users\/(\d+)\/posts$/);
    if (userPostsMatch && request.method === "GET") {
      const userId = parseInt(userPostsMatch[1]!, 10);
      const result = await this.execSql("SELECT * FROM posts WHERE user_id = ?", [userId], "all");
      return Response.json(result.rows);
    }

    return new Response("Not found", { status: 404 });
  }

  // ── Called by SqlBridge (via RPC) ──
  async execSql(
    sql: string,
    params: unknown[],
    method: "run" | "all" | "values" | "get",
  ): Promise<{ rows: unknown[][] | unknown[] }> {
    const cursor = this.ctx.storage.sql.exec(sql, ...params);

    if (method === "run") {
      // DML statements — consume cursor, return empty rows
      cursor.toArray();
      return { rows: [] };
    }

    // raw() returns rows as arrays of column values (no keys)
    const rawRows = [...cursor.raw()];

    if (method === "get") {
      // drizzle expects a FLAT array for single-row get: [val1, val2, ...]
      return { rows: rawRows[0] ?? [] };
    }

    // "all" and "values" — array of arrays: [[val1, val2], [val3, val4]]
    return { rows: rawRows };
  }

  // ── Batch execution in a single transaction ──
  async execSqlBatch(
    queries: { sql: string; params: unknown[]; method: string }[],
  ): Promise<{ rows: unknown[][] | unknown[] }[]> {
    return this.ctx.storage.transactionSync(() => {
      return queries.map(({ sql, params, method }) => {
        const cursor = this.ctx.storage.sql.exec(sql, ...params);

        if (method === "run") {
          cursor.toArray();
          return { rows: [] as unknown[] };
        }

        const rawRows = [...cursor.raw()];

        if (method === "get") {
          return { rows: rawRows[0] ?? ([] as unknown[]) };
        }

        return { rows: rawRows };
      });
    });
  }
}

// ─── 4. Dynamic Worker Code (loaded at runtime) ─────────────────
//
// In production you would store this in R2/KV or generate it,
// and optionally bundle it with @cloudflare/worker-bundler for npm imports.

const DYNAMIC_WORKER_CODE = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/users" && request.method === "POST") {
      const { name, email } = await request.json();
      await env.SQL.execSql(
        "INSERT INTO users (name, email) VALUES (?, ?)",
        [name, email],
        "run"
      );
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/users" && request.method === "GET") {
      const result = await env.SQL.execSql(
        "SELECT * FROM users",
        [],
        "all"
      );
      return new Response(JSON.stringify(result.rows), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/posts" && request.method === "POST") {
      const { userId, title, body } = await request.json();
      await env.SQL.execSql(
        "INSERT INTO posts (user_id, title, body) VALUES (?, ?, ?)",
        [userId, title, body],
        "run"
      );
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    const userPostsMatch = url.pathname.match(/^\\/users\\/(\\d+)\\/posts$/);
    if (userPostsMatch && request.method === "GET") {
      const userId = parseInt(userPostsMatch[1], 10);
      const result = await env.SQL.execSql(
        "SELECT * FROM posts WHERE user_id = ?",
        [userId],
        "all"
      );
      return new Response(JSON.stringify(result.rows), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
`;
