import { describe, expect, test } from "vitest";
import {
  agentCreationForPath,
  defaultAgentBirthEvents,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  MCP_AGENT_SYSTEM_PROMPT,
} from "./agent-defaults.ts";

const PROJECT_ID = "prj_defaults_test";

function coreFor(agentPath: string) {
  return agentCreationForPath({
    agentPath,
    projectId: PROJECT_ID,
  });
}

describe("agentCreationForPath — the atomic core, and nothing else", () => {
  test("no personality rides the core: no prompt slot, no model config, no boot context", () => {
    const types = coreFor("/agents/demo").events.map((event): string => event.type);
    expect(types).not.toContain("events.iterate.com/agents/context-added");
    expect(types).not.toContain("events.iterate.com/agent/configured");
  });

  test("does not infer agent policy or startup events from the stream path", () => {
    const paths = [
      "/agents/email/t42",
      "/agents/web/demo",
      "/agents/repos/config/pr/7",
      "/agents/slack/main/C123/ts-99/helper",
    ];
    for (const path of paths) {
      const created = coreFor(path).events.find(
        (event) => event.type === "events.iterate.com/agent/created",
      );
      expect(created?.payload).toEqual({});
    }
  });

  test("mounts only the workspace — sandboxes are created explicitly, never granted", () => {
    const mounts = coreFor("/agents/demo")
      .events.filter(
        (event) => event.type === "events.iterate.com/capability-host/capability-provided",
      )
      .map((event) => event.payload.path);
    expect(mounts).toEqual([["workspace"]]);
  });

  test("births both universal processors before ordinary setup events", () => {
    expect(
      coreFor("/agents/demo")
        .events.slice(0, 2)
        .map((event) => event.type),
    ).toEqual(["events.iterate.com/agent/created", "events.iterate.com/capability-host/created"]);
  });

  test("journals the one-hop project-root capability fallback in the birth certificate", () => {
    const birth = coreFor("/agents/demo").events.find(
      (event) => event.type === "events.iterate.com/capability-host/created",
    );
    expect(birth?.payload).toEqual({
      config: {},
      fallback: ["capabilityHosts", ["get", "/"]],
    });
  });

  test("arms the agent processor and the narrow collection copy in the same batch", () => {
    const subscriptions = coreFor("/agents/demo").events.filter(
      (event) => event.type === "events.iterate.com/stream/subscription-configured",
    );
    expect(
      subscriptions.flatMap((event) =>
        // The subscription NAME is the contract selector (name == registered slug).
        event.payload.receiver.action === "facet-processor" ? [event.payload.name] : [],
      ),
    ).toEqual(["agent", "capability-host"]);
    expect(
      subscriptions.find((event) => event.payload.receiver.action === "copy-to-stream")?.payload,
    ).toMatchObject({
      name: "agent-collection",
      filter: {
        eventTypes: [
          "events.iterate.com/agent/created",
          "events.iterate.com/agent/summary-updated",
        ],
      },
      receiver: {
        action: "copy-to-stream",
        receivingStreamPath: "/agents",
        delivery: {
          start: "beginning",
          onFailingEvent: "halt",
        },
      },
    });
  });

  test("keys every domain event on (projectId, agentPath) so exact retries dedupe", () => {
    for (const event of coreFor("/agents/demo").events) {
      if (event.type === "events.iterate.com/stream/subscription-configured") {
        // Subscription wiring keys are stream-local by design under the
        // subscription-model redesign: the name is the identity, keys never
        // embed coordinates or hostnames, and idempotency is per stream.
        expect(String(event.idempotencyKey)).toMatch(/^stream\/subscription-configured:/);
        continue;
      }
      expect(String(event.idempotencyKey)).toContain(PROJECT_ID);
      expect(String(event.idempotencyKey)).toContain("/agents/demo");
    }
  });
});

describe("defaultAgentBirthEvents — the platform-default personality as plain events", () => {
  const coordinates = { agentPath: "/agents/demo", projectId: PROJECT_ID };

  test("web kind: prompt slot, default model config, boot context — all content-hash keyed", () => {
    const events = defaultAgentBirthEvents({ kind: "web", coordinates });
    expect(events.map((event) => event.type)).toEqual([
      "events.iterate.com/agents/context-added",
      "events.iterate.com/agent/configured",
      "events.iterate.com/agents/context-added",
    ]);
    expect(events[0]).toMatchObject({
      idempotencyKey: expect.stringMatching(/^agent\/default-birth:prompt:web:[0-9a-f]{8}$/),
      payload: {
        role: "system",
        key: "agent/system-prompt",
        content: DEFAULT_AGENT_SYSTEM_PROMPT,
      },
    });
    expect(events[1]).toMatchObject({
      payload: { config: { llm: { model: "openai/gpt-5.6-terra" } } },
    });
    expect(events[2]).toMatchObject({
      payload: { role: "system", key: "agent/boot-context" },
    });
  });

  test("deterministic keys: two callers producing the same content converge on the same keys", () => {
    // THIS is what makes the degraded-start / late-worker pair heal instead
    // of conflict: identical content, identical keys, appends dedupe.
    const first = defaultAgentBirthEvents({ kind: "web", coordinates });
    const again = defaultAgentBirthEvents({ kind: "web", coordinates });
    expect(again).toEqual(first);
    // The degraded-start caller knows the agent's identity but has no
    // directory access: same prompt/model keys, and a boot context whose
    // id-only content hashes to a DIFFERENT key — so a late worker's
    // directory-informed boot context supersedes it instead of deduping.
    const degraded = defaultAgentBirthEvents({
      kind: "web",
      coordinates: { agentPath: coordinates.agentPath, projectId: coordinates.projectId },
    });
    expect(degraded.slice(0, 2).map((event) => event.idempotencyKey)).toEqual(
      first.slice(0, 2).map((event) => event.idempotencyKey),
    );
    expect(degraded).toHaveLength(3);
  });

  test("boot context names the project when directory facts are supplied — id-only without", () => {
    const bootContent = (project?: { name: string; slug: string; workerUrl?: string }) => {
      const events = defaultAgentBirthEvents({
        kind: "web",
        coordinates: { ...coordinates, ...(project === undefined ? {} : { project }) },
      });
      const boot = events.find(
        (event) =>
          event.type === "events.iterate.com/agents/context-added" &&
          event.payload.key === "agent/boot-context",
      );
      if (boot?.type !== "events.iterate.com/agents/context-added") {
        throw new Error("default birth events did not contain the boot context");
      }
      return boot.payload.content;
    };

    const named = bootContent({
      name: "Snake Game",
      slug: "snake",
      workerUrl: "https://snake.iterate.app",
    });
    expect(named).toContain('"Snake Game" (slug snake');
    expect(named).toContain("https://snake.iterate.app");
    expect(named).toContain(PROJECT_ID);
    expect(bootContent()).toContain(`- Project id: ${PROJECT_ID}`);
  });

  test("mcp kind layers the ask_assistant reply contract on the web prompt", () => {
    const [prompt] = defaultAgentBirthEvents({ kind: "mcp", coordinates });
    expect(prompt).toMatchObject({
      payload: { key: "agent/system-prompt", content: MCP_AGENT_SYSTEM_PROMPT },
    });
    expect(MCP_AGENT_SYSTEM_PROMPT).toContain(DEFAULT_AGENT_SYSTEM_PROMPT);
    expect(MCP_AGENT_SYSTEM_PROMPT).toContain("ask_assistant");
  });

  test("slack kind interpolates the connection recorded in the birth certificate", () => {
    const [prompt] = defaultAgentBirthEvents({
      kind: "slack",
      coordinates: { agentPath: "/agents/slack/main/C1/ts-1", projectId: PROJECT_ID },
      birthCertificate: {
        channel: { type: "slack", connection: "main", channelId: "C1", threadTs: "ts-1" },
      },
    });
    if (prompt?.type !== "events.iterate.com/agents/context-added") {
      throw new Error("slack birth events did not lead with the prompt slot");
    }
    expect(prompt.payload.content).toContain('itx.integrations.slack.get("main").chat.postMessage');
    expect(String(prompt.idempotencyKey)).toMatch(/^agent\/default-birth:prompt:slack:/);
  });

  test("telegram kind interpolates connection, chat id, and the agent's own path", () => {
    const [prompt] = defaultAgentBirthEvents({
      kind: "telegram",
      coordinates: { agentPath: "/agents/telegram/chat-42/s-1", projectId: PROJECT_ID },
      birthCertificate: { channel: { type: "telegram", connection: "bot", chatId: "42" } },
    });
    if (prompt?.type !== "events.iterate.com/agents/context-added") {
      throw new Error("telegram birth events did not lead with the prompt slot");
    }
    expect(prompt.payload.content).toContain('itx.integrations.telegram.get("bot")');
    expect(prompt.payload.content).toContain("this chat's id is 42");
    expect(prompt.payload.content).toContain("/agents/telegram/chat-42/s-1");
  });

  test("channel kinds are LOUD about missing channel facts — never a silently wrong personality", () => {
    expect(() => defaultAgentBirthEvents({ kind: "slack", coordinates })).toThrow(
      /invalid channel facts/,
    );
    expect(() =>
      defaultAgentBirthEvents({
        kind: "telegram",
        coordinates,
        birthCertificate: { channel: { type: "slack", connection: "main" } },
      }),
    ).toThrow(/telegram/);
  });
});
