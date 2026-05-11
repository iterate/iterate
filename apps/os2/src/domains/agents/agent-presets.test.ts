import { describe, expect, it } from "vitest";
import type { Event } from "@iterate-com/shared/streams/types";
import {
  defaultAgentSetupEvents,
  defaultAgentSystemPrompt,
  normalizeAgentPresetBasePath,
  parseAgentRunOptsJson,
  presetConfiguredEvent,
  readAgentPathPrefixPresets,
  selectAgentPathPrefixPreset,
} from "./agent-presets.ts";

describe("agent presets", () => {
  it("accepts full preset paths under /agents", () => {
    expect(normalizeAgentPresetBasePath("/agents")).toBe("/agents");
    expect(normalizeAgentPresetBasePath("/agents/alice/bla")).toBe("/agents/alice/bla");
    expect(() => normalizeAgentPresetBasePath("alice/bla")).toThrow(
      "Agent preset path must be /agents or start with /agents/.",
    );
    expect(() => normalizeAgentPresetBasePath("/alice/bla")).toThrow(
      "Agent preset path must be /agents or start with /agents/.",
    );
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

  it("ignores invalid stored preset paths while selecting a prefix preset", () => {
    const validPreset = {
      basePath: "/agents/alice",
      events: defaultAgentSetupEvents("cloudflare-ai"),
    };

    expect(
      selectAgentPathPrefixPreset({
        agentPath: "/agents/alice/bla",
        presets: [
          {
            basePath: "/alice",
            events: defaultAgentSetupEvents("openai-ws"),
          },
          validPreset,
        ],
      }),
    ).toBe(validPreset);
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

  it("ignores configured preset events with invalid base paths", () => {
    const invalid = presetConfiguredEvent({
      basePath: "/alice",
      events: defaultAgentSetupEvents("openai-ws"),
    });
    const valid = presetConfiguredEvent({
      basePath: "/agents/alice",
      events: defaultAgentSetupEvents("cloudflare-ai"),
    });

    expect(
      readAgentPathPrefixPresets([committedEvent(invalid, 1), committedEvent(valid, 2)]),
    ).toEqual([
      {
        basePath: "/agents/alice",
        events: defaultAgentSetupEvents("cloudflare-ai"),
      },
    ]);
  });

  it("includes key patterns in the default system prompt", () => {
    const prompt = defaultAgentSystemPrompt("/agents/test");
    expect(prompt).toContain("ctx.chat.sendMessage({ message }");
    expect(prompt).toContain("/agents/test");
    expect(prompt).toContain("return undefined");
    expect(prompt).toContain("Promise.all");
  });

  it("distinguishes invalid run options JSON from non-object run options", () => {
    expect(() => parseAgentRunOptsJson("[1, 2]")).toThrow("Run options must be a JSON object.");
    expect(() => parseAgentRunOptsJson("{")).toThrow("Run options must be valid JSON.");
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
