import { describe, expect, test } from "vitest";
import {
  AGENT_INITIAL_DEBOUNCE_MS,
  agentCreationForPath,
  agentSystemPromptContextEvent,
  DEFAULT_AGENT_SYSTEM_PROMPT,
} from "./agent-defaults.ts";

const PROJECT_ID = "prj_defaults_test";

function defaultsFor(agentPath: string) {
  return agentCreationForPath({
    agentPath,
    projectId: PROJECT_ID,
    highInitialDebounce: true,
  });
}

function createdEvent(agentPath: string) {
  return defaultsFor(agentPath).events.find(
    (event) => event.type === "events.iterate.com/agent/created",
  );
}

describe("agentCreationForPath", () => {
  test("boot context names the project when directory facts are supplied — id-only without", () => {
    const bootContent = (project?: { name: string; slug: string; workerUrl?: string }) => {
      const events = agentCreationForPath({
        agentPath: "/agents/demo",
        projectId: PROJECT_ID,
        highInitialDebounce: true,
        ...(project === undefined ? {} : { project }),
      }).events;
      const boot = events.find((event) =>
        String(event.idempotencyKey).startsWith("agent/boot-system-context:"),
      );
      if (boot?.type !== "events.iterate.com/agents/context-added") {
        throw new Error("agent creation batch did not contain its boot context");
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

  test("mounts only the workspace — sandboxes are created explicitly, never granted", () => {
    const mounts = defaultsFor("/agents/demo")
      .events.filter(
        (event) => event.type === "events.iterate.com/capability-host/capability-provided",
      )
      .map((event) => event.payload.path);
    expect(mounts).toEqual([["workspace"]]);
  });

  test("does not infer agent policy or startup events from the stream path", () => {
    const paths = [
      "/agents/email/t42",
      "/agents/web/demo",
      "/agents/repos/config/pr/7",
      "/agents/slack/main/C123/ts-99/helper",
    ];

    for (const path of paths) {
      const defaults = defaultsFor(path);
      expect(defaults.systemPrompt).toBe(DEFAULT_AGENT_SYSTEM_PROMPT);
      expect(createdEvent(path)?.payload).toEqual({});
    }
  });

  test("keeps birth empty and installs model and prompt as ordinary setup events", () => {
    const defaults = defaultsFor("/agents/demo");
    expect(defaults.systemPrompt).toBe(DEFAULT_AGENT_SYSTEM_PROMPT);
    expect(
      defaults.events.find((event) => event.type === "events.iterate.com/agent/created")?.payload,
    ).toEqual({});
    expect(
      defaults.events.find((event) => event.type === "events.iterate.com/agent/configured"),
    ).toMatchObject({
      idempotencyKey: `agent/model-configured:v2:${PROJECT_ID}:/agents/demo`,
      payload: { config: { llm: { model: "openai/gpt-5.6-terra" } } },
    });
    expect(
      defaults.events.find(
        (event) =>
          event.type === "events.iterate.com/agents/context-added" &&
          event.payload.key === "agent/system-prompt",
      )?.payload,
    ).toEqual({
      role: "system",
      key: "agent/system-prompt",
      content: DEFAULT_AGENT_SYSTEM_PROMPT,
      // The flat context payload defaults the policy on every role; the
      // processor ignores it on system items.
      llmRequestPolicy: { behaviour: "after-current-request" },
    });
  });

  test("lets a routed agent choose one initial prompt without changing birth", () => {
    const creation = agentCreationForPath({
      agentPath: "/agents/slack/test",
      projectId: PROJECT_ID,
      highInitialDebounce: false,
      systemPromptPolicy: {
        content: "Slack execution contract",
        id: "slack",
        revision: "7",
      },
    });
    const prompts = creation.events.filter(
      (event) =>
        event.type === "events.iterate.com/agents/context-added" &&
        event.payload.key === "agent/system-prompt",
    );

    expect(creation.birthCertificate.payload).toEqual({});
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      idempotencyKey: `agent/system-prompt:slack:v7:${PROJECT_ID}:/agents/slack/test`,
      payload: { content: "Slack execution contract" },
    });
  });

  test("gives each shipped prompt revision its own exact occurrence", () => {
    const promptEvent = (revision: string, content: string) =>
      agentCreationForPath({
        agentPath: "/agents/routed/test",
        projectId: PROJECT_ID,
        highInitialDebounce: false,
        systemPromptPolicy: { content, id: "routed", revision },
      }).events.find(
        (event) =>
          event.type === "events.iterate.com/agents/context-added" &&
          event.payload.key === "agent/system-prompt",
      );

    const first = promptEvent("1", "first policy");
    expect(promptEvent("1", "first policy")).toEqual(first);
    expect(promptEvent("2", "changed policy")).toMatchObject({
      idempotencyKey: `agent/system-prompt:routed:v2:${PROJECT_ID}:/agents/routed/test`,
      payload: { content: "changed policy", key: "agent/system-prompt" },
    });
  });

  test("births both universal processors before ordinary setup events", () => {
    expect(
      defaultsFor("/agents/demo")
        .events.slice(0, 2)
        .map((event) => event.type),
    ).toEqual(["events.iterate.com/agent/created", "events.iterate.com/capability-host/created"]);
  });

  test("journals the one-hop project-root capability fallback in the birth certificate", () => {
    const birth = defaultsFor("/agents/demo").events.find(
      (event) => event.type === "events.iterate.com/capability-host/created",
    );
    expect(birth?.payload).toEqual({
      config: {},
      fallback: ["capabilityHosts", ["get", "/"]],
    });
  });

  test("appends processor wake subscriptions and the narrow collection copy in the same batch", () => {
    const subscriptions = defaultsFor("/agents/demo").events.filter(
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
    for (const event of defaultsFor("/agents/demo").events) {
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

describe("agentSystemPromptContextEvent", () => {
  test("keeps logical context identity separate from durable policy revision", () => {
    const first = agentSystemPromptContextEvent({
      content: "first policy",
      idempotencyKey: "agent/test-system-prompt:v1",
    });
    const retry = agentSystemPromptContextEvent({
      content: "first policy",
      idempotencyKey: "agent/test-system-prompt:v1",
    });
    const changed = agentSystemPromptContextEvent({
      content: "changed policy",
      idempotencyKey: "agent/test-system-prompt:v2",
    });

    expect(retry).toEqual(first);
    expect(first.idempotencyKey).toBe("agent/test-system-prompt:v1");
    expect(changed.idempotencyKey).toBe("agent/test-system-prompt:v2");
    expect(changed.payload).toMatchObject({ key: "agent/system-prompt", role: "system" });
  });
});

describe("birth config", () => {
  test("a newborn gets the explicit birth config: parsing on, high debounce", () => {
    const configured = defaultsFor("/agents/demo").events.filter(
      (event) => event.type === "events.iterate.com/agent/configured",
    );
    expect(configured).toMatchObject([
      { payload: { config: { llm: { model: "openai/gpt-5.6-terra" } } } },
      {
        idempotencyKey: `agent/birth-config:v1:${PROJECT_ID}:/agents/demo`,
        payload: {
          config: {
            interpretResponses: true,
            llmRequestDebounceMs: AGENT_INITIAL_DEBOUNCE_MS,
          },
        },
      },
    ]);
  });

  test("highInitialDebounce false (re-creates, routers) omits the birth config entirely", () => {
    const configured = agentCreationForPath({
      agentPath: "/agents/demo",
      projectId: PROJECT_ID,
      highInitialDebounce: false,
    }).events.filter((event) => event.type === "events.iterate.com/agent/configured");
    expect(configured).toMatchObject([
      { payload: { config: { llm: { model: "openai/gpt-5.6-terra" } } } },
    ]);
  });
});
