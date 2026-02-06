import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as schema from "../db/schema.ts";

const sqlite = new Database(":memory:");
sqlite.exec(`
  CREATE TABLE agents (
    path text PRIMARY KEY NOT NULL,
    working_directory text NOT NULL,
    created_at integer DEFAULT (unixepoch()),
    updated_at integer DEFAULT (unixepoch()),
    archived_at integer
  );
  CREATE TABLE agent_routes (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    agent_path text NOT NULL,
    destination text NOT NULL,
    active integer DEFAULT 1 NOT NULL,
    metadata text,
    created_at integer DEFAULT (unixepoch()),
    updated_at integer DEFAULT (unixepoch()),
    FOREIGN KEY (agent_path) REFERENCES agents(path)
  );
  CREATE UNIQUE INDEX agent_routes_active_unique ON agent_routes (agent_path) WHERE active = 1;
`);

const testDb = drizzle(sqlite, { schema });

vi.mock("../db/index.ts", () => ({
  db: testDb,
}));

const { trpcRouter } = await import("./router.ts");

describe("getOrCreateAgent concurrency", () => {
  beforeEach(() => {
    sqlite.exec("DELETE FROM agent_routes; DELETE FROM agents;");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("only creates one session when called concurrently", async () => {
    let mockServerCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        mockServerCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response(
          JSON.stringify({
            route: `/opencode/sessions/mock-${mockServerCalls}`,
            sessionId: `mock-${mockServerCalls}`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const caller = trpcRouter.createCaller({});
    const promises = Array.from({ length: 10 }, () =>
      caller.getOrCreateAgent({
        agentPath: "/test/concurrent",
        createWithEvents: [{ type: "prompt", message: "Hello" }],
        newAgentPath: "http://localhost:9999/new",
      }),
    );

    const results = await Promise.all(promises);

    const createdCount = results.filter((r) => r.wasCreated).length;
    expect(createdCount).toBe(1);
    expect(mockServerCalls).toBe(1);

    const routes = results.map((r) => r.route?.destination);
    expect(new Set(routes).size).toBe(1);
  });
});
