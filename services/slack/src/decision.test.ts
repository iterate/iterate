import { describe, expect, test } from "vitest";
import { decideSlackWebhook, normalizeSlackWebhookInput } from "./decision.ts";

const baseWebhook = {
  source: "slack" as const,
  channel: "C123",
  threadTs: "1730000000.123456",
  ts: "1730000000.123456",
  text: "hello",
  receivedAt: "2026-02-27T00:00:00.000Z",
};

describe("decideSlackWebhook", () => {
  test("creates an agent when no route matches", () => {
    const result = decideSlackWebhook({
      webhook: baseWebhook,
      existingRoutes: [],
    });

    expect(result.shouldCreateAgent).toBe(true);
    expect(result.shouldAppendPrompt).toBe(true);
    expect(result.getOrCreateInput?.agentPath).toBe("/agents/slack/C123/1730000000-123456");
    expect(result.reasonCodes).toEqual(["route.missing-create-agent"]);
  });

  test("does not create when route already exists", () => {
    const result = decideSlackWebhook({
      webhook: baseWebhook,
      existingRoutes: [
        {
          channel: "C123",
          threadTs: "1730000000.123456",
          agentPath: "/agents/slack/C123/1730000000-123456",
          providerSessionId: "sess-1",
          agentStreamPath: "/agents/opencode/sess-1",
        },
      ],
    });

    expect(result.shouldCreateAgent).toBe(false);
    expect(result.shouldAppendPrompt).toBe(true);
    expect(result.getOrCreateInput).toBeUndefined();
    expect(result.reasonCodes).toEqual(["route.matched-existing"]);
  });

  test("ignores empty messages", () => {
    const result = decideSlackWebhook({
      webhook: { ...baseWebhook, text: "   " },
      existingRoutes: [],
    });

    expect(result.shouldCreateAgent).toBe(false);
    expect(result.shouldAppendPrompt).toBe(false);
    expect(result.reasonCodes).toEqual(["message.empty"]);
  });

  test("ignores message_changed subtype", () => {
    const result = decideSlackWebhook({
      webhook: { ...baseWebhook, subtype: "message_changed" },
      existingRoutes: [],
    });

    expect(result.shouldCreateAgent).toBe(false);
    expect(result.shouldAppendPrompt).toBe(false);
    expect(result.reasonCodes).toEqual(["message.ignored-subtype"]);
  });
});

describe("normalizeSlackWebhookInput", () => {
  test("normalizes nested Slack event payload", () => {
    const result = normalizeSlackWebhookInput({
      event: {
        text: "hello",
        channel: "C123",
        ts: "1730000000.123456",
        thread_ts: "1730000000.123456",
        user: "U123",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.channel).toBe("C123");
    expect(result.event.threadTs).toBe("1730000000.123456");
    expect(result.event.text).toBe("hello");
  });

  test("returns error for missing identifiers", () => {
    const result = normalizeSlackWebhookInput({
      event: {
        text: "hello",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("thread_ts/ts and channel are required");
  });
});
