import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.ts";

const sqlite = new Database(":memory:");
sqlite.exec(`
  CREATE TABLE agents (
    path text PRIMARY KEY NOT NULL,
    working_directory text NOT NULL,
    metadata text,
    created_at integer DEFAULT (unixepoch()),
    updated_at integer DEFAULT (unixepoch()),
    archived_at integer,
    short_status text NOT NULL DEFAULT 'idle',
    is_working integer NOT NULL DEFAULT 0
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
  CREATE TABLE agent_subscriptions (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    agent_path text NOT NULL,
    callback_url text NOT NULL,
    created_at integer DEFAULT (unixepoch()),
    updated_at integer DEFAULT (unixepoch()),
    FOREIGN KEY (agent_path) REFERENCES agents(path)
  );
`);

const testDb = drizzle(sqlite, { schema });

vi.mock("../db/index.ts", () => ({
  db: testDb,
}));

const { agentsRouter } = await import("./agents.ts");

describe("agents router", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    sqlite.exec("DELETE FROM agent_subscriptions; DELETE FROM agent_routes; DELETE FROM agents;");
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards upstream when route is ready", async () => {
    // Pre-populate agent + ready route so getOrCreateAgent finds it
    sqlite
      .prepare("INSERT INTO agents (path, working_directory) VALUES (?, ?)")
      .run("/slack/thread-123", "/tmp/workdir");
    sqlite
      .prepare("INSERT INTO agent_routes (agent_path, destination, active) VALUES (?, ?, 1)")
      .run("/slack/thread-123", "/opencode/sessions/existing");

    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ success: true, sessionId: "existing" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await agentsRouter.request("/api/agents/slack/thread-123", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "iterate:agent:prompt-added", message: "hello" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, sessionId: "existing" });
    // fetch should only be called once — for the proxy, not for session creation
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3001/api/opencode/sessions/existing",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns 400 for invalid path", async () => {
    const response = await agentsRouter.request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "iterate:agent:prompt-added", message: "hello" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid agent path" });
  });
});
