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

  it("reactivates an archived agent path when a route already exists", async () => {
    sqlite
      .prepare(
        "INSERT INTO agents (path, working_directory, archived_at) VALUES (?, ?, unixepoch())",
      )
      .run("/test/archived-with-route", "/tmp/workdir");
    sqlite
      .prepare("INSERT INTO agent_routes (agent_path, destination, active) VALUES (?, ?, 1)")
      .run("/test/archived-with-route", "/opencode/sessions/existing-route");

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const caller = trpcRouter.createCaller({});
    const result = await caller.getOrCreateAgent({
      agentPath: "/test/archived-with-route",
      createWithEvents: [{ type: "prompt", message: "resume" }],
      newAgentPath: "http://localhost:9999/new",
    });

    expect(result.wasCreated).toBe(false);
    expect(result.route?.destination).toBe("/opencode/sessions/existing-route");
    expect(result.agent.archivedAt).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    const loaded = await caller.getAgent({ path: "/test/archived-with-route" });
    expect(loaded).not.toBeNull();
    expect(loaded?.archivedAt).toBeNull();
    expect(loaded?.activeRoute?.destination).toBe("/opencode/sessions/existing-route");
  });

  it("reactivates archived agent without route and creates a new session", async () => {
    sqlite
      .prepare(
        "INSERT INTO agents (path, working_directory, archived_at) VALUES (?, ?, unixepoch())",
      )
      .run("/test/archived-no-route", "/tmp/workdir");

    const fetchSpy = vi.fn(async () => {
      return new Response(JSON.stringify({ route: "/opencode/sessions/new-route" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const caller = trpcRouter.createCaller({});
    const result = await caller.getOrCreateAgent({
      agentPath: "/test/archived-no-route",
      createWithEvents: [{ type: "prompt", message: "resume" }],
      newAgentPath: "http://localhost:9999/new",
    });

    expect(result.wasCreated).toBe(true);
    expect(result.route?.destination).toBe("/opencode/sessions/new-route");
    expect(result.agent.archivedAt).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const loaded = await caller.getAgent({ path: "/test/archived-no-route" });
    expect(loaded).not.toBeNull();
    expect(loaded?.archivedAt).toBeNull();
    expect(loaded?.activeRoute?.destination).toBe("/opencode/sessions/new-route");
  });

  it("keeps reactivated agent when route creation fails", async () => {
    sqlite
      .prepare(
        "INSERT INTO agents (path, working_directory, archived_at) VALUES (?, ?, unixepoch())",
      )
      .run("/test/archived-create-fails", "/tmp/workdir");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("upstream failed", { status: 500 });
      }),
    );

    const caller = trpcRouter.createCaller({});
    await expect(
      caller.getOrCreateAgent({
        agentPath: "/test/archived-create-fails",
        createWithEvents: [{ type: "prompt", message: "resume" }],
        newAgentPath: "http://localhost:9999/new",
      }),
    ).rejects.toThrow("Failed to create session: upstream failed");

    const loaded = await caller.getAgent({ path: "/test/archived-create-fails" });
    expect(loaded).not.toBeNull();
    expect(loaded?.archivedAt).toBeNull();
    expect(loaded?.activeRoute).toBeNull();
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
    expect(routes).toContain("/opencode/sessions/mock-1");
    const uniqueRoutes = new Set(routes);
    expect(uniqueRoutes.size).toBeLessThanOrEqual(2);
    for (const route of uniqueRoutes) {
      expect(route === "pending" || route === "/opencode/sessions/mock-1").toBe(true);
    }
  });
});
