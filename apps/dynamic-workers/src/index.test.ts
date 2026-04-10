import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { DynamicWorkerDO } from "./index.ts";

const testEnv = env as unknown as {
  DYNAMIC_WORKER_DO: DurableObjectNamespace<DynamicWorkerDO>;
};

// ─── Direct DO SQL tests ─────────────────────────────────────────

describe("DynamicWorkerDO — execSql", () => {
  it("creates tables on instantiation", async () => {
    const id = testEnv.DYNAMIC_WORKER_DO.idFromName("test-tables");
    const stub = testEnv.DYNAMIC_WORKER_DO.get(id);

    const result = await stub.execSql("SELECT * FROM users", [], "all");
    expect(result.rows).toEqual([]);
  });

  it("inserts and selects users with 'all' method", async () => {
    const id = testEnv.DYNAMIC_WORKER_DO.idFromName("test-insert-all");
    const stub = testEnv.DYNAMIC_WORKER_DO.get(id);

    await stub.execSql(
      "INSERT INTO users (name, email) VALUES (?, ?)",
      ["Alice", "alice@test.com"],
      "run",
    );

    const result = await stub.execSql("SELECT * FROM users", [], "all");
    expect(result.rows).toEqual([[1, "Alice", "alice@test.com", "user"]]);
  });

  it("returns flat array for 'get' method", async () => {
    const id = testEnv.DYNAMIC_WORKER_DO.idFromName("test-get");
    const stub = testEnv.DYNAMIC_WORKER_DO.get(id);

    await stub.execSql(
      "INSERT INTO users (name, email) VALUES (?, ?)",
      ["Bob", "bob@test.com"],
      "run",
    );

    const result = await stub.execSql("SELECT * FROM users WHERE id = ?", [1], "get");
    expect(result.rows).toEqual([1, "Bob", "bob@test.com", "user"]);
  });

  it("returns empty array for 'get' with no match", async () => {
    const id = testEnv.DYNAMIC_WORKER_DO.idFromName("test-get-empty");
    const stub = testEnv.DYNAMIC_WORKER_DO.get(id);

    const result = await stub.execSql("SELECT * FROM users WHERE id = ?", [999], "get");
    expect(result.rows).toEqual([]);
  });

  it("returns empty rows for 'run' method", async () => {
    const id = testEnv.DYNAMIC_WORKER_DO.idFromName("test-run");
    const stub = testEnv.DYNAMIC_WORKER_DO.get(id);

    const result = await stub.execSql(
      "INSERT INTO users (name, email) VALUES (?, ?)",
      ["Carol", "carol@test.com"],
      "run",
    );
    expect(result.rows).toEqual([]);
  });

  it("handles multiple rows", async () => {
    const id = testEnv.DYNAMIC_WORKER_DO.idFromName("test-multi");
    const stub = testEnv.DYNAMIC_WORKER_DO.get(id);

    await stub.execSql(
      "INSERT INTO users (name, email) VALUES (?, ?)",
      ["Alice", "alice@test.com"],
      "run",
    );
    await stub.execSql(
      "INSERT INTO users (name, email) VALUES (?, ?)",
      ["Bob", "bob@test.com"],
      "run",
    );
    await stub.execSql(
      "INSERT INTO users (name, email) VALUES (?, ?)",
      ["Carol", "carol@test.com"],
      "run",
    );

    const result = await stub.execSql("SELECT * FROM users", [], "all");
    expect(result.rows).toEqual([
      [1, "Alice", "alice@test.com", "user"],
      [2, "Bob", "bob@test.com", "user"],
      [3, "Carol", "carol@test.com", "user"],
    ]);
  });

  it("handles posts with foreign key", async () => {
    const id = testEnv.DYNAMIC_WORKER_DO.idFromName("test-posts");
    const stub = testEnv.DYNAMIC_WORKER_DO.get(id);

    await stub.execSql(
      "INSERT INTO users (name, email) VALUES (?, ?)",
      ["Alice", "alice@test.com"],
      "run",
    );
    await stub.execSql(
      "INSERT INTO posts (user_id, title, body) VALUES (?, ?, ?)",
      [1, "First Post", "Hello world"],
      "run",
    );

    const result = await stub.execSql("SELECT * FROM posts WHERE user_id = ?", [1], "all");
    expect(result.rows).toEqual([[1, 1, "First Post", "Hello world"]]);
  });
});

describe("DynamicWorkerDO — execSqlBatch", () => {
  it("executes multiple queries in a transaction", async () => {
    const id = testEnv.DYNAMIC_WORKER_DO.idFromName("test-batch");
    const stub = testEnv.DYNAMIC_WORKER_DO.get(id);

    const results = await stub.execSqlBatch([
      {
        sql: "INSERT INTO users (name, email) VALUES (?, ?)",
        params: ["Alice", "alice@test.com"],
        method: "run",
      },
      {
        sql: "INSERT INTO users (name, email) VALUES (?, ?)",
        params: ["Bob", "bob@test.com"],
        method: "run",
      },
      {
        sql: "SELECT * FROM users",
        params: [],
        method: "all",
      },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]!.rows).toEqual([]);
    expect(results[1]!.rows).toEqual([]);
    expect(results[2]!.rows).toEqual([
      [1, "Alice", "alice@test.com", "user"],
      [2, "Bob", "bob@test.com", "user"],
    ]);
  });

  it("batch get returns flat row", async () => {
    const id = testEnv.DYNAMIC_WORKER_DO.idFromName("test-batch-get");
    const stub = testEnv.DYNAMIC_WORKER_DO.get(id);

    const results = await stub.execSqlBatch([
      {
        sql: "INSERT INTO users (name, email) VALUES (?, ?)",
        params: ["Alice", "alice@test.com"],
        method: "run",
      },
      {
        sql: "SELECT * FROM users WHERE id = ?",
        params: [1],
        method: "get",
      },
    ]);

    expect(results).toHaveLength(2);
    expect(results[1]!.rows).toEqual([1, "Alice", "alice@test.com", "user"]);
  });
});

// ─── Per-tenant isolation test ───────────────────────────────────

describe("DynamicWorkerDO — tenant isolation", () => {
  it("each tenant has independent data", async () => {
    const id1 = testEnv.DYNAMIC_WORKER_DO.idFromName("tenant-a");
    const id2 = testEnv.DYNAMIC_WORKER_DO.idFromName("tenant-b");
    const stubA = testEnv.DYNAMIC_WORKER_DO.get(id1);
    const stubB = testEnv.DYNAMIC_WORKER_DO.get(id2);

    await stubA.execSql(
      "INSERT INTO users (name, email) VALUES (?, ?)",
      ["Alice", "alice@a.com"],
      "run",
    );
    await stubB.execSql(
      "INSERT INTO users (name, email) VALUES (?, ?)",
      ["Bob", "bob@b.com"],
      "run",
    );

    const resultA = await stubA.execSql("SELECT * FROM users", [], "all");
    const resultB = await stubB.execSql("SELECT * FROM users", [], "all");

    expect(resultA.rows).toEqual([[1, "Alice", "alice@a.com", "user"]]);
    expect(resultB.rows).toEqual([[1, "Bob", "bob@b.com", "user"]]);
  });
});

// ─── End-to-end HTTP flow tests ──────────────────────────────────
// Full flow: SELF.fetch() → parent worker → DO.handleRequest → SQL
// Uses the direct fallback since LOADER.load() isn't available locally.

describe("End-to-end HTTP flow", () => {
  it("POST /users creates a user, GET /users returns it", async () => {
    const tenant = `e2e-${Date.now()}`;

    const postRes = await SELF.fetch(`http://localhost/users?tenant=${tenant}`, {
      method: "POST",
      body: JSON.stringify({ name: "Eve", email: "eve@test.com" }),
      headers: { "content-type": "application/json" },
    });
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toEqual({ ok: true });

    const getRes = await SELF.fetch(`http://localhost/users?tenant=${tenant}`);
    expect(getRes.status).toBe(200);
    const users = await getRes.json();
    expect(users).toEqual([[1, "Eve", "eve@test.com", "user"]]);
  });

  it("POST /posts and GET /users/:id/posts", async () => {
    const tenant = `e2e-posts-${Date.now()}`;

    await SELF.fetch(`http://localhost/users?tenant=${tenant}`, {
      method: "POST",
      body: JSON.stringify({ name: "Frank", email: "frank@test.com" }),
      headers: { "content-type": "application/json" },
    });

    const postRes = await SELF.fetch(`http://localhost/posts?tenant=${tenant}`, {
      method: "POST",
      body: JSON.stringify({
        userId: 1,
        title: "Hello World",
        body: "First post content",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(postRes.status).toBe(200);

    const getRes = await SELF.fetch(`http://localhost/users/1/posts?tenant=${tenant}`);
    expect(getRes.status).toBe(200);
    const posts = await getRes.json();
    expect(posts).toEqual([[1, 1, "Hello World", "First post content"]]);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await SELF.fetch("http://localhost/unknown?tenant=e2e-404");
    expect(res.status).toBe(404);
  });

  it("different tenants have isolated data", async () => {
    const tenantA = `e2e-iso-a-${Date.now()}`;
    const tenantB = `e2e-iso-b-${Date.now()}`;

    await SELF.fetch(`http://localhost/users?tenant=${tenantA}`, {
      method: "POST",
      body: JSON.stringify({ name: "Alice", email: "alice@test.com" }),
      headers: { "content-type": "application/json" },
    });

    await SELF.fetch(`http://localhost/users?tenant=${tenantB}`, {
      method: "POST",
      body: JSON.stringify({ name: "Bob", email: "bob@test.com" }),
      headers: { "content-type": "application/json" },
    });

    const resA = await SELF.fetch(`http://localhost/users?tenant=${tenantA}`);
    const resB = await SELF.fetch(`http://localhost/users?tenant=${tenantB}`);

    expect(await resA.json()).toEqual([[1, "Alice", "alice@test.com", "user"]]);
    expect(await resB.json()).toEqual([[1, "Bob", "bob@test.com", "user"]]);
  });
});
