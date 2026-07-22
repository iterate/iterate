import { describe, expect, it, vi } from "vitest";

import { findDashboardState } from "./pr-dashboard.ts";

describe("findDashboardState", () => {
  it("paginates today's Slack history and finds the dashboard detail reply", async () => {
    const history = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ ts: "newer", text: "another CI message" }],
        response_metadata: { next_cursor: "next-page" },
      })
      .mockResolvedValueOnce({
        messages: [
          {
            bot_id: "ci-bot",
            text: "*PR dashboard 22nd July* — 2 opened (details in thread)",
            ts: "dashboard",
          },
        ],
        response_metadata: {},
      });
    const replies = vi.fn().mockResolvedValue({
      messages: [
        { bot_id: "ci-bot", text: "parent", ts: "dashboard" },
        { bot_id: "ci-bot", text: "details", ts: "details", thread_ts: "dashboard" },
      ],
    });
    const slack = { conversations: { history, replies } } as unknown as Parameters<
      typeof findDashboardState
    >[0];

    await expect(
      findDashboardState(slack, {
        channel: "ci-channel",
        heading: "*PR dashboard 22nd July*",
        today: "2026-07-22",
      }),
    ).resolves.toEqual({ ts: "dashboard", detailsTs: "details" });
    expect(history).toHaveBeenNthCalledWith(1, {
      channel: "ci-channel",
      cursor: undefined,
      limit: 100,
      oldest: "1784678400",
    });
    expect(history).toHaveBeenNthCalledWith(2, {
      channel: "ci-channel",
      cursor: "next-page",
      limit: 100,
      oldest: "1784678400",
    });
    expect(replies).toHaveBeenCalledWith({ channel: "ci-channel", limit: 100, ts: "dashboard" });
  });

  it("returns null when today's Slack history contains no dashboard", async () => {
    const replies = vi.fn();
    const slack = {
      conversations: {
        history: vi.fn().mockResolvedValue({ messages: [], response_metadata: {} }),
        replies,
      },
    } as unknown as Parameters<typeof findDashboardState>[0];

    await expect(
      findDashboardState(slack, {
        channel: "ci-channel",
        heading: "*PR dashboard 22nd July*",
        today: "2026-07-22",
      }),
    ).resolves.toBeNull();
    expect(replies).not.toHaveBeenCalled();
  });
});
