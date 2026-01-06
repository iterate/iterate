import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { LogLevel } from "effect";
import { test, expect, beforeAll, afterAll } from "vitest";
import { startServer, type RunningServer } from "./server.ts";

const TEST_HTTP_PORT = 13000;
const TEST_OPENCODE_PORT = 13096;
const TEST_DB_FILE = "test-two.db";
const TEST_WORKSPACES_DIR = process.cwd();

process.env.TWO_SERVER_URL = `http://localhost:${TEST_HTTP_PORT}`;

let server: RunningServer;

function killProcessesOnPort(port: number): void {
  try {
    const result = execSync(`lsof -ti :${port}`, { encoding: "utf-8" });
    const pids = result.trim().split("\n").filter(Boolean);
    const myPid = process.pid.toString();
    for (const pid of pids) {
      if (pid === myPid) {
        continue; // Don't kill ourselves
      }
      try {
        execSync(`kill -9 ${pid}`, { stdio: "ignore" });
        console.log(`[cleanup] Killed process ${pid} on port ${port}`);
      } catch {
        // Process might have already exited
      }
    }
  } catch {
    // No processes on port (lsof returns non-zero)
  }
}

beforeAll(async () => {
  killProcessesOnPort(TEST_HTTP_PORT);
  killProcessesOnPort(TEST_OPENCODE_PORT);

  for (const file of [TEST_DB_FILE, `${TEST_DB_FILE}-shm`, `${TEST_DB_FILE}-wal`]) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }

  server = await startServer(
    {
      httpPort: TEST_HTTP_PORT,
      openCodePort: TEST_OPENCODE_PORT,
      dbFilename: TEST_DB_FILE,
      workspacesDir: TEST_WORKSPACES_DIR,
    },
    {
      minLevel: LogLevel.Debug,
      format: "structured",
    },
  );
});

afterAll(async () => {
  if (server) {
    await server.shutdown();
    // Give graceful shutdown more time to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  // Force kill any remaining processes (shouldn't be needed but ensures cleanup)
  killProcessesOnPort(TEST_OPENCODE_PORT);
});

test("slack webhook triggers agent response with correct answer", async () => {
  const slackPayload = {
    team_id: "T123TEST",
    event: {
      ts: "1234567890.123456",
      text: "What is one plus two?",
      user: "U123USER",
      channel: "C123CHAN",
    },
  };

  const webhookResponse = await fetch(`${server.baseUrl}/slack-receiver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(slackPayload),
  });

  expect(webhookResponse.ok).toBe(true);
  const webhookResult = await webhookResponse.json();
  expect(webhookResult).toEqual({ ok: true });

  const agentName = `slack:${slackPayload.team_id}:${slackPayload.event.ts}`;

  const outgoingMessage = await pollForOutgoingMessage();

  console.log({ outgoingMessage });
  expect(outgoingMessage).not.toBeNull();
  expect(outgoingMessage!.text.toLowerCase()).toMatch(/3|three/);

  // helpers

  async function pollForOutgoingMessage(
    maxAttempts = 60,
    delayMs = 1000,
  ): Promise<{ text: string } | null> {
    for (let i = 0; i < maxAttempts; i++) {
      const eventsResponse = await fetch(`${server.baseUrl}/agents/${agentName}`);
      if (!eventsResponse.ok) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      const events = (await eventsResponse.json()) as Array<{
        type: string;
        payload: unknown;
      }>;

      const outgoingMessage = events.find((e) => e.type === "outgoing_message");
      if (outgoingMessage) {
        return outgoingMessage.payload as { text: string };
      }

      console.log(
        `[Attempt ${i + 1}/${maxAttempts}] Waiting for outgoing_message... Current events: ${events.map((e) => e.type).join(", ")}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return null;
  }
});
