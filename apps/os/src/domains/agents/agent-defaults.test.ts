import { describe, expect, test } from "vitest";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./agent-processor-contract.ts";
import { agentCreationForPath } from "./agent-defaults.ts";

const PROJECT_ID = "prj_defaults_test";

function defaultsFor(
  agentPath: string,
  overrides?: Parameters<typeof agentCreationForPath>[0]["overrides"],
) {
  return agentCreationForPath({
    agentPath,
    capabilityHostAncestorPath: "/",
    projectId: PROJECT_ID,
    ...(overrides === undefined ? {} : { overrides }),
  });
}

function createdEvent(agentPath: string, overrides?: Parameters<typeof defaultsFor>[1]) {
  return defaultsFor(agentPath, overrides).events.find(
    (event) => event.type === "events.iterate.com/agent/created",
  );
}

describe("agentCreationForPath", () => {
  test("boot context names the project when directory facts are supplied — id-only without", () => {
    const bootContent = (project?: { name: string; slug: string; workerUrl?: string }) => {
      const events = agentCreationForPath({
        agentPath: "/agents/demo",
        capabilityHostAncestorPath: "/",
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
      "/agents/repos/config/pr/7",
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

  test("puts caller overrides directly in the immutable birth certificate", () => {
    const custom = defaultsFor("/agents/demo", {
      systemPrompt: "Answer in one short sentence.",
      model: "openai/gpt-5.5",
    });
    expect(custom.systemPrompt).toBe("Answer in one short sentence.");
    expect(
      createdEvent("/agents/demo", {
        systemPrompt: "Answer in one short sentence.",
        model: "openai/gpt-5.5",
      })?.payload,
    ).toEqual({
      config: {
        llm: { model: "openai/gpt-5.5" },
        systemPrompt: "Answer in one short sentence.",
      },
    });
  });

  test("births both universal processors before ordinary setup events", () => {
    expect(
      defaultsFor("/agents/demo")
        .events.slice(0, 2)
        .map((event) => event.type),
    ).toEqual(["events.iterate.com/agent/created", "events.iterate.com/capability-host/created"]);
    expect(defaultsFor("/agents/demo").events[1]?.payload).toEqual({
      config: { ancestorPath: "/" },
    });
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
