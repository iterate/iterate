import { describe, expect, test, vi } from "vitest";
import type { StreamEvent } from "../itx-api.generated.ts";
import { createAgentFeedModel } from "./agent-feed-model.ts";
import { sendAgentMessage } from "./agent-message-command.ts";

const userMessage = (offset: number, content: string): StreamEvent => ({
  type: "events.iterate.com/agents/context-added",
  payload: {
    role: "user",
    content,
    actor: { type: "user", origin: "web" },
    llmRequestPolicy: { behaviour: "after-current-request" },
  },
  path: "/agents/test",
  offset,
  createdAt: new Date(1_700_000_000_000 + offset).toISOString(),
});

describe("sendAgentMessage", () => {
  test("leaves the mutation response out of the feed so delayed subscription events stay ordered", async () => {
    const model = createAgentFeedModel();
    model.applyEvents([userMessage(10, "already rendered")]);

    const returnedEvent = userMessage(12, "mutation response");
    const message = vi.fn(async () => returnedEvent);

    await expect(sendAgentMessage({ message }, "mutation response")).resolves.toBeUndefined();
    expect(message).toHaveBeenCalledWith("mutation response");
    expect(model.snapshot().lastOffset).toBe(10);

    // The ordered, replay-capable subscription is the only live feed writer.
    // When its delayed batch arrives, offset 11 cannot be skipped by the
    // mutation response at offset 12.
    model.applyEvents([userMessage(11, "delayed predecessor"), returnedEvent]);

    expect(model.snapshot()).toMatchObject({ eventCount: 3, lastOffset: 12 });
    expect(model.snapshot().items).toMatchObject([
      { kind: "user", text: "already rendered" },
      { kind: "user", text: "delayed predecessor" },
      { kind: "user", text: "mutation response" },
    ]);
  });
});
