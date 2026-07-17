import { describe, expect, test } from "vitest";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./agent-processor-contract.ts";
import { agentCreationForPath, agentSystemPromptContextEvent } from "./agent-defaults.ts";

const PROJECT_ID = "prj_defaults_test";

function defaultsFor(agentPath: string) {
  return agentCreationForPath({
    agentPath,
    projectId: PROJECT_ID,
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
      "/agents/onboarding",
      `/agents/repos/g~${"0".repeat(64)}/pull-requests/7`,
      "/agents/slack/main/C123/ts-99/helper",
    ];

    for (const path of paths) {
      const defaults = defaultsFor(path);
      expect(defaults.systemPrompt).toBe(DEFAULT_AGENT_SYSTEM_PROMPT);
      expect(createdEvent(path)?.payload).toEqual({
        config: {
          llm: { model: "openai/gpt-5.6-sol" },
          systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
        },
      });
      expect(
        defaults.events.some((event) =>
          String(event.idempotencyKey).startsWith("project-onboarding-start:"),
        ),
      ).toBe(false);
    }
  });

  test("always puts the platform prompt and model in the generic birth", () => {
    const defaults = defaultsFor("/agents/demo");
    expect(defaults.systemPrompt).toBe(DEFAULT_AGENT_SYSTEM_PROMPT);
    expect(
      defaults.events.find((event) => event.type === "events.iterate.com/agent/created")?.payload,
    ).toEqual({
      config: {
        llm: { model: "openai/gpt-5.6-sol" },
        systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
      },
    });
  });

  test("births both universal processors before ordinary setup events", () => {
    expect(
      defaultsFor("/agents/demo")
        .events.slice(0, 2)
        .map((event) => event.type),
    ).toEqual(["events.iterate.com/agent/created", "events.iterate.com/capability-host/created"]);
  });

  test("installs both universal processor subscriptions in the same batch", () => {
    const subscriptions = defaultsFor("/agents/demo").events.filter(
      (event) => event.type === "events.iterate.com/stream/subscription-configured",
    );
    expect(subscriptions.map((event) => event.payload.delivery.processorSlug)).toEqual([
      "agent",
      "capability-host",
    ]);
  });

  test("keys every event on (projectId, agentPath) so exact retries dedupe", () => {
    for (const event of defaultsFor("/agents/demo").events) {
      expect(String(event.idempotencyKey)).toContain(PROJECT_ID);
      expect(String(event.idempotencyKey)).toContain("/agents/demo");
    }
  });
});

describe("agentSystemPromptContextEvent", () => {
  test("dedupes one prompt revision and versions changed policy under the same context key", () => {
    const first = agentSystemPromptContextEvent({
      content: "first policy",
      idempotencyKey: "agent/test-system-prompt",
    });
    const retry = agentSystemPromptContextEvent({
      content: "first policy",
      idempotencyKey: "agent/test-system-prompt",
    });
    const changed = agentSystemPromptContextEvent({
      content: "changed policy",
      idempotencyKey: "agent/test-system-prompt",
    });

    expect(retry).toEqual(first);
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(changed.payload).toMatchObject({ key: "agent/system-prompt", role: "system" });
  });
});
