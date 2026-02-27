import { describe, it, expect } from "vitest";
import { PromptAddedEvent, AgentUpdatedEvent, IterateEvent } from "./events.ts";

describe("events schema", () => {
  it("accepts prompt-added events", () => {
    const input = { type: "iterate:agent:prompt-added", message: "hello" };
    expect(PromptAddedEvent.parse(input)).toEqual(input);
    expect(IterateEvent.parse(input)).toEqual(input);
  });

  it("accepts agent-updated events", () => {
    const input = { type: "iterate:agent:updated", path: "/opencode/test", isWorking: true };
    expect(AgentUpdatedEvent.parse(input)).toEqual(input);
    expect(IterateEvent.parse(input)).toEqual(input);
  });

  it("rejects unknown event types", () => {
    expect(PromptAddedEvent.safeParse({ type: "other", message: "x" }).success).toBe(false);
    expect(IterateEvent.safeParse({ type: "other", message: "x" }).success).toBe(false);
  });
});
