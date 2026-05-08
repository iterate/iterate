import { describe, expect, it } from "vitest";
import type { Event } from "@iterate-com/shared/streams/types";
import {
  agentStreamCircuitBreakerConfig,
  defaultAgentSetupEvents,
  defaultAgentSystemPrompt,
  normalizeAgentPresetBasePath,
  presetConfiguredEvent,
  readAgentPathPrefixPresets,
  selectAgentPathPrefixPreset,
} from "./agent-presets.ts";

describe("agent presets", () => {
  it("normalizes preset paths under /agents", () => {
    expect(normalizeAgentPresetBasePath("alice/bla")).toBe("/agents/alice/bla");
    expect(normalizeAgentPresetBasePath("/alice/bla/")).toBe("/agents/alice/bla");
    expect(normalizeAgentPresetBasePath("/agents/alice/bla/")).toBe("/agents/alice/bla");
    expect(normalizeAgentPresetBasePath("/")).toBe("/agents");
  });

  it("selects the longest matching path-prefix preset", () => {
    const rootPreset = {
      basePath: "/agents",
      events: defaultAgentSetupEvents("openai-ws"),
    };
    const nestedPreset = {
      basePath: "/agents/alice",
      events: defaultAgentSetupEvents("cloudflare-ai"),
    };

    expect(
      selectAgentPathPrefixPreset({
        agentPath: "/agents/alice/bla",
        presets: [rootPreset, nestedPreset],
      }),
    ).toBe(nestedPreset);
  });

  it("reads the latest configured preset per base path", () => {
    const first = presetConfiguredEvent({
      basePath: "/agents/alice",
      events: defaultAgentSetupEvents("openai-ws"),
    });
    const second = presetConfiguredEvent({
      basePath: "/agents/alice",
      events: defaultAgentSetupEvents("cloudflare-ai"),
    });

    expect(
      readAgentPathPrefixPresets([committedEvent(first, 1), committedEvent(second, 2)]),
    ).toEqual([
      {
        basePath: "/agents/alice",
        events: defaultAgentSetupEvents("cloudflare-ai"),
      },
    ]);
  });

  it("keeps the default system prompt on ctx.chat.sendMessage", () => {
    expect(defaultAgentSystemPrompt()).toContain("ctx.chat.sendMessage({ message:");
    expect(defaultAgentSystemPrompt()).not.toContain("ctx.streams.append");
  });

  it("configures agent streams for high-throughput event fanout", () => {
    expect(defaultAgentSetupEvents("openai-ws")).toContainEqual({
      type: "events.iterate.com/core/circuit-breaker-configured",
      payload: agentStreamCircuitBreakerConfig,
    });
  });
});

function committedEvent(event: { type: string; payload?: object }, offset: number): Event {
  return {
    createdAt: "2026-05-07T00:00:00.000Z",
    idempotencyKey: undefined,
    metadata: undefined,
    offset,
    payload: event.payload ?? {},
    streamPath: "/agents",
    type: event.type,
  };
}
