import { describe, expect, it } from "vitest";
import type { Event } from "@iterate-com/shared/streams/types";
import {
  configuredAgentSetupEvents,
  defaultAgentSetupEvents,
  defaultAgentSystemPrompt,
  isSlackAgentPath,
  normalizeAgentPresetBasePath,
  parseAgentRunOptsJson,
  presetConfiguredEvent,
  readAgentPathPrefixPresets,
  selectAgentSetupPreset,
  selectAgentPathPrefixPreset,
} from "./agent-presets.ts";

describe("agent presets", () => {
  it("defaults new agent setup events to OpenAI", () => {
    expect(defaultAgentSetupEvents()).toEqual([
      {
        type: "events.iterate.com/os-agent/llm-provider-selected",
        payload: { provider: "openai-ws" },
      },
      {
        type: "events.iterate.com/openai-ws/config-updated",
        payload: { model: "gpt-5.5" },
      },
      {
        type: "events.iterate.com/agent/llm-config-updated",
        payload: { model: "gpt-5.5", runOpts: {}, debounceMs: 200 },
      },
      {
        type: "events.iterate.com/agent/system-prompt-updated",
        payload: {
          systemPrompt: defaultAgentSystemPrompt(),
        },
      },
    ]);
  });

  it("configures OpenAI agent scheduling debounce explicitly", () => {
    expect(
      configuredAgentSetupEvents({
        model: "gpt-5.5-mini",
        provider: "openai-ws",
        runOpts: { ignored: true },
        systemPrompt: "Use OpenAI quickly.",
      }),
    ).toEqual([
      {
        type: "events.iterate.com/os-agent/llm-provider-selected",
        payload: { provider: "openai-ws" },
      },
      {
        type: "events.iterate.com/openai-ws/config-updated",
        payload: { model: "gpt-5.5-mini" },
      },
      {
        type: "events.iterate.com/agent/llm-config-updated",
        payload: { model: "gpt-5.5-mini", runOpts: {}, debounceMs: 200 },
      },
      {
        type: "events.iterate.com/agent/system-prompt-updated",
        payload: {
          systemPrompt: "Use OpenAI quickly.",
        },
      },
    ]);
  });

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

  it("keeps Slack agents from inheriting the root agent preset", () => {
    const rootOpenAiPreset = {
      basePath: "/agents",
      events: defaultAgentSetupEvents("openai-ws"),
    };

    expect(
      selectAgentSetupPreset({
        agentPath: "/agents/slack/c123/ts-1778565914-773159",
        presets: [rootOpenAiPreset],
      }),
    ).toBeNull();
  });

  it("recognizes only routed Slack agent paths as Slack agents", () => {
    expect(isSlackAgentPath("/agents/slack")).toBe(true);
    expect(isSlackAgentPath("/agents/slack/c123/ts-1778565914-773159")).toBe(true);
    expect(isSlackAgentPath("/agents/slack-test")).toBe(false);
  });

  it("allows explicit Slack presets to override the built-in default", () => {
    const rootOpenAiPreset = {
      basePath: "/agents",
      events: defaultAgentSetupEvents("openai-ws"),
    };
    const slackOpenAiPreset = {
      basePath: "/agents/slack",
      events: defaultAgentSetupEvents("openai-ws"),
    };

    expect(
      selectAgentSetupPreset({
        agentPath: "/agents/slack/c123/ts-1778565914-773159",
        presets: [rootOpenAiPreset, slackOpenAiPreset],
      }),
    ).toBe(slackOpenAiPreset);
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
    expect(prompt).toContain("/agents/test");
    expect(prompt).toContain("return undefined");
    expect(prompt).toContain("If you're not sure about the shape of the result of a call");
    expect(prompt).toContain("Promise.all");
    expect(prompt).toContain("itx.<name>.<method>(args)");
    expect(prompt).toContain("itx.slack.chat.postMessage({ channel, thread_ts, text })");
    expect(prompt).toContain("itx.streams.get(");
  });

  it("tells Slack agents not to reply to FYI-only thread events", () => {
    const prompt = defaultAgentSystemPrompt("/agents/slack/c123/ts-1778565914-773159");
    expect(prompt).toContain("Do not chime in just because a Slack event arrived.");
    expect(prompt).toContain("explicitly mentioned");
    expect(prompt).toContain("surrounding thread context clearly calls for agent action");
    expect(prompt).toContain("async (itx) => {}");
    expect(prompt).toContain("Do not call `itx.slack.chat.postMessage` for FYI-only updates.");
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
