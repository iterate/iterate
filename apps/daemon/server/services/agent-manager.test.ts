import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import type { AgentHarness } from "../agent-harness.ts";
import { ensureAgentRunning, sendMessageToAgent, type AgentManagerDeps } from "./agent-manager.ts";

type TestDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema }) as TestDb;
  const migrationsFolder = resolve(process.cwd(), "drizzle");
  migrate(db, { migrationsFolder });
  return { db, sqlite };
}

describe("agent-manager", () => {
  let db: TestDb;
  let sqlite: Database.Database;

  beforeEach(() => {
    const setup = createTestDb();
    db = setup.db;
    sqlite = setup.sqlite;
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });

  it("creates agent and tmux session when missing", async () => {
    const createTmuxSession = vi.fn(() => true);
    const hasTmuxSession = vi.fn(() => false);
    const sendKeys = vi.fn(() => true);
    const isSessionProcessRunning = vi.fn(() => true);
    const getHarness = vi.fn(
      (): AgentHarness => ({
        type: "pi",
        getStartCommand: (_workingDir: string, options?: { prompt?: string }) => {
          const cmd = ["pi"];
          if (options?.prompt) cmd.push(options.prompt);
          return cmd;
        },
      }),
    );

    const result = await ensureAgentRunning(
      {
        slug: "slack-123",
        harnessType: "pi",
        workingDirectory: "/tmp",
        initialPrompt: "Hello from Slack",
      },
      {
        db,
        hasTmuxSession,
        createTmuxSession,
        sendKeys,
        isSessionProcessRunning,
        getHarness,
      },
    );

    expect(result.wasCreated).toBe(true);
    expect(createTmuxSession).toHaveBeenCalledTimes(1);
    const [, command] = createTmuxSession.mock.calls[0] as unknown as [string, string];
    expect(command).toContain('cd "/tmp" && pi');
    expect(command).toContain("Hello from Slack");

    const agents = await db.select().from(schema.agents).where(eq(schema.agents.slug, "slack-123"));
    expect(agents).toHaveLength(1);
    expect(agents[0]?.tmuxSession).toBe(result.tmuxSession);
  });

  it("reuses existing agent and recreates tmux session if missing", async () => {
    await db.insert(schema.agents).values({
      id: "agent-1",
      slug: "slack-456",
      harnessType: "pi",
      tmuxSession: "tmux-456",
      workingDirectory: "/tmp",
      status: "stopped",
    });

    const createTmuxSession = vi.fn(() => true);
    const hasTmuxSession = vi.fn(() => false);
    const sendKeys = vi.fn(() => true);
    const isSessionProcessRunning = vi.fn(() => true);
    const getHarness = vi.fn(
      (): AgentHarness => ({
        type: "pi",
        getStartCommand: (_workingDir: string, _options?: { prompt?: string }) => ["pi"],
      }),
    );

    const result = await ensureAgentRunning(
      {
        slug: "slack-456",
        harnessType: "pi",
        workingDirectory: "/tmp",
      },
      {
        db,
        hasTmuxSession,
        createTmuxSession,
        sendKeys,
        isSessionProcessRunning,
        getHarness,
      },
    );

    expect(result.wasCreated).toBe(false);
    expect(createTmuxSession).toHaveBeenCalledTimes(1);
    expect(createTmuxSession).toHaveBeenCalledWith(
      "tmux-456",
      expect.stringContaining('cd "/tmp" && pi'),
    );
  });

  it("sendMessageToAgent sends literal keys after session is ready", async () => {
    vi.useFakeTimers();

    const sendKeys = vi.fn(() => true);
    const isSessionProcessRunning = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    const deps: AgentManagerDeps = {
      db,
      hasTmuxSession: vi.fn(() => true),
      createTmuxSession: vi.fn(() => true),
      sendKeys,
      isSessionProcessRunning,
      getHarness: vi.fn((): AgentHarness => ({ type: "pi", getStartCommand: () => ["pi"] })),
    };

    const promise = sendMessageToAgent("tmux-789", "Hello keys", "pi", deps);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe(true);
    expect(sendKeys).toHaveBeenCalledWith("tmux-789", "Hello keys", true, true);

    vi.useRealTimers();
  });
});
