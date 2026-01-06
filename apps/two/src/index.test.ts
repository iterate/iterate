import * as fs from "node:fs";
import { test, expect, beforeAll, afterAll } from "vitest";
import { startServer, type RunningServer } from "./server.ts";

const TEST_HTTP_PORT = 13000;
const TEST_OPENCODE_PORT = 13096;
const TEST_DB_FILE = "test-two.db";
const TEST_WORKSPACES_DIR = process.cwd();

process.env.TWO_SERVER_URL = `http://localhost:${TEST_HTTP_PORT}`;

let server: RunningServer;

beforeAll(async () => {
  for (const file of [TEST_DB_FILE, `${TEST_DB_FILE}-shm`, `${TEST_DB_FILE}-wal`]) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }

  server = await startServer({
    httpPort: TEST_HTTP_PORT,
    openCodePort: TEST_OPENCODE_PORT,
    dbFilename: TEST_DB_FILE,
    workspacesDir: TEST_WORKSPACES_DIR,
  });
});

afterAll(async () => {
  if (server) {
    await server.shutdown();
  }
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
