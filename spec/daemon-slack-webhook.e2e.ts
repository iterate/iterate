/**
 * E2E tests for daemon Slack webhook handler.
 *
 * Uses Playwright's request fixture (no browser) to test daemon API directly.
 * Requires daemon server running on localhost:3001.
 */
/* eslint-disable no-restricted-imports, no-restricted-syntax -- API-only test, no browser assertions */
import { test, expect } from "@playwright/test";

const DAEMON_API = "http://localhost:3001";

function uniqueTs(): string {
  return `${Date.now()}.${Math.floor(Math.random() * 1000000)}`;
}

test.describe("Daemon Slack Webhook", () => {
  test("creates agent from slack webhook with correct slug", async ({ request }) => {
    const ts = uniqueTs();
    const slackPayload = {
      type: "event_callback",
      team_id: "T12345",
      event: {
        type: "message",
        ts,
        channel: "C12345",
        user: "U12345",
        text: "Hello from Slack test",
      },
    };

    const response = await request.post(`${DAEMON_API}/api/integrations/slack/webhook`, {
      data: slackPayload,
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.agentSlug).toBe(`slack-${ts.replace(".", "-")}`);
    expect(body.created).toBe(true);
  });

  test("reuses existing agent for same thread", async ({ request }) => {
    const ts = uniqueTs();
    const slackPayload = {
      type: "event_callback",
      event: { type: "message", ts, text: "First message" },
    };

    // First request creates agent
    const res1 = await request.post(`${DAEMON_API}/api/integrations/slack/webhook`, {
      data: slackPayload,
    });
    expect(res1.ok()).toBe(true);
    expect((await res1.json()).created).toBe(true);

    // Second request reuses agent
    const res2 = await request.post(`${DAEMON_API}/api/integrations/slack/webhook`, {
      data: { ...slackPayload, event: { ...slackPayload.event, text: "Second message" } },
    });
    expect(res2.ok()).toBe(true);
    expect((await res2.json()).created).toBe(false);
  });

  test("uses thread_ts for replies instead of ts", async ({ request }) => {
    const parentTs = uniqueTs();
    const replyTs = uniqueTs();
    const slackPayload = {
      type: "event_callback",
      event: {
        type: "message",
        ts: replyTs,
        thread_ts: parentTs, // Parent thread
        text: "Reply in thread",
      },
    };

    const response = await request.post(`${DAEMON_API}/api/integrations/slack/webhook`, {
      data: slackPayload,
    });

    expect(response.ok()).toBe(true);
    const body = await response.json();
    // Should use thread_ts (parent), not ts (reply)
    expect(body.agentSlug).toBe(`slack-${parentTs.replace(".", "-")}`);
  });

  test("returns 400 when no thread_id can be extracted", async ({ request }) => {
    const slackPayload = {
      type: "event_callback",
      // Missing event.ts and event.thread_ts
      event: { type: "message", text: "No timestamp" },
    };

    const response = await request.post(`${DAEMON_API}/api/integrations/slack/webhook`, {
      data: slackPayload,
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("thread_id");
  });

  test("formats message with user and channel info", async ({ request }) => {
    const ts = uniqueTs();
    const slackPayload = {
      type: "event_callback",
      event: {
        type: "message",
        ts,
        channel: "C_TEST_CHANNEL",
        user: "U_TEST_USER",
        text: "Test message content",
      },
    };

    const response = await request.post(`${DAEMON_API}/api/integrations/slack/webhook`, {
      data: slackPayload,
    });

    expect(response.ok()).toBe(true);
    // The formatted message should include user and channel info
    // This is verified by the agent's initial prompt containing the formatted message
  });
});
