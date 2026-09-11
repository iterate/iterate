// Facet storage independently of the processor SDK, callbacks or outbound fetch. Keep this
// basic contract separate from processor and cross-isolate capability conformance.
import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

const spec = {
  className: "Counter",
  source: {
    "cap.js": `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
    ctx.storage.sql.exec("INSERT OR IGNORE INTO counter VALUES (1, 0)");
  }
  value() { return this.ctx.storage.sql.exec("SELECT value FROM counter WHERE id = 1").toArray()[0].value; }
  bump() {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE counter SET value = value + 1 WHERE id = 1");
      return this.value();
    });
  }
  rollback() {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE counter SET value = 999 WHERE id = 1");
      throw new Error("counter transaction rolled back");
    });
  }
}
export default { fetch() { return new Response("counter module"); } };`,
  },
};

test("named SQLite facets retain independent state and can be addressed again without source", async () => {
  const itx = openItx(freshCtx("facet-sqlite"));
  expect(await itx.invoke(["itx", "facets", ["get", "one", spec], ["bump"]])).toBe(1);
  expect(await itx.invoke(["itx", "facets", ["get", "one"], ["bump"]])).toBe(2);
  expect(await itx.invoke(["itx", "facets", ["get", "two", spec], ["bump"]])).toBe(1);
  expect(await itx.invoke(["itx", "facets", ["get", "one"], ["value"]])).toBe(2);
});

test("a failed SQLite facet transaction preserves its last committed value", async () => {
  const itx = openItx(freshCtx("facet-rollback"));
  expect(await itx.invoke(["itx", "facets", ["get", "counter", spec], ["bump"]])).toBe(1);
  await expect(itx.invoke(["itx", "facets", ["get", "counter"], ["rollback"]])).rejects.toThrow(
    "counter transaction rolled back",
  );
  expect(await itx.invoke(["itx", "facets", ["get", "counter"], ["value"]])).toBe(1);
});
