import { describe, expect, test } from "vitest";
import { isProjectStreamFeedPending } from "./project-stream-feed-pending.ts";

describe("isProjectStreamFeedPending", () => {
  test("keeps an agent feed pending until replayed state arrives after subscription", () => {
    expect(
      isProjectStreamFeedPending({
        agentFeed: true,
        agentUiState: null,
        connectionStatus: "subscribed",
      }),
    ).toBe(true);
    expect(
      isProjectStreamFeedPending({
        agentFeed: true,
        agentUiState: {},
        connectionStatus: "subscribed",
      }),
    ).toBe(false);
  });

  test("shows stale agent state during reconnect and gates raw feeds on subscription", () => {
    expect(
      isProjectStreamFeedPending({
        agentFeed: true,
        agentUiState: {},
        connectionStatus: "connecting",
      }),
    ).toBe(false);
    expect(
      isProjectStreamFeedPending({
        agentFeed: false,
        agentUiState: null,
        connectionStatus: "connecting",
      }),
    ).toBe(true);
  });
});
