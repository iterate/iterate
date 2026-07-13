import { describe, expect, it } from "vitest";
import { ONBOARDING_AGENT_PATH } from "../../lib/onboarding-agent.ts";
import {
  EMAIL_AGENT_SYSTEM_PROMPT,
  agentDefaultsForPath,
  slackAgentSystemPrompt,
  telegramAgentSystemPrompt,
} from "./agent-defaults.ts";

const PROJECT_ID = "prj_defaults_test";

function defaultsFor(
  agentPath: string,
  overrides?: Parameters<typeof agentDefaultsForPath>[0]["overrides"],
) {
  return agentDefaultsForPath({
    agentPath,
    projectId: PROJECT_ID,
    ...(overrides === undefined ? {} : { overrides }),
  });
}

describe("agentDefaultsForPath", () => {
  it("boot context names the project when directory facts are supplied — id-only without", () => {
    const bootContent = (project?: { name: string; slug: string; workerUrl?: string }) => {
      const events = agentDefaultsForPath({
        agentPath: "/agents/demo",
        projectId: PROJECT_ID,
        ...(project === undefined ? {} : { project }),
      }).events;
      const boot = events.find((event) =>
        String(event.idempotencyKey).startsWith("agent/boot-context:"),
      );
      return String(boot?.payload.content);
    };

    // The very first real prd question was "which project is this?" — the
    // context must answer with the human name, not only the hex id.
    const named = bootContent({
      name: "Snake Game",
      slug: "snake",
      workerUrl: "https://snake.iterate.app",
    });
    expect(named).toContain('"Snake Game" (slug snake');
    expect(named).toContain("https://snake.iterate.app");
    expect(named).toContain(PROJECT_ID);

    // Bare hosts (tests, seeds without a directory) still get the id line.
    expect(bootContent()).toContain(`- Project id: ${PROJECT_ID}`);
  });

  it("mounts only the workspace — sandboxes are created explicitly, never granted", () => {
    const mounts = defaultsFor("/agents/demo")
      .events.filter(
        (event) => event.type === "events.iterate.com/capability-host/capability-provided",
      )
      .map((event) => event.payload.path);
    expect(mounts).toEqual([["workspace"]]);
  });

  it("selects the prompt by path and reports it alongside the events", () => {
    const emailDefaults = defaultsFor("/agents/email/t42");
    expect(emailDefaults.systemPrompt).toBe(EMAIL_AGENT_SYSTEM_PROMPT);
    const config = emailDefaults.events.find(
      (event) => event.type === "events.iterate.com/agent/config-updated",
    );
    expect(config?.payload.systemPrompt).toBe(EMAIL_AGENT_SYSTEM_PROMPT);
  });

  it("gives pull-request agents the GitHub PR prompt (reply door = createComment)", () => {
    const prompt = defaultsFor("/agents/repos/root/pull-requests/7").systemPrompt;
    expect(prompt).toContain("attached to one GitHub pull request");
    expect(prompt).toContain("rest.issues.createComment");
  });

  it("standardizes every platform agent prompt on TypeScript ts fences", () => {
    const prompts = {
      default: defaultsFor("/agents/demo").systemPrompt,
      email: EMAIL_AGENT_SYSTEM_PROMPT,
      pullRequest: defaultsFor("/agents/repos/root/pull-requests/7").systemPrompt,
      slack: slackAgentSystemPrompt("main"),
      telegram: telegramAgentSystemPrompt({
        agentPath: "/agents/telegram/main/chat-42",
        chatId: "42",
        connection: "main",
      }),
    };

    for (const [name, prompt] of Object.entries(prompts)) {
      expect(prompt, `${name} prompt is missing the ts fence`).toContain("```ts");
      expect(prompt, `${name} prompt still mentions JavaScript or a js fence`).not.toMatch(
        /JavaScript|```(?:js|javascript)(?:\s|$)/,
      );
    }
  });

  it("only the onboarding agent gets the kickoff input", () => {
    const kickoffTypes = (path: string) =>
      defaultsFor(path).events.filter(
        (event) => event.idempotencyKey === `project-onboarding-start:${PROJECT_ID}`,
      ).length;
    expect(kickoffTypes(ONBOARDING_AGENT_PATH)).toBe(1);
    expect(kickoffTypes("/agents/demo")).toBe(0);
  });

  it("bakes overrides into the returned events — a systemPrompt override replaces wholesale", () => {
    const custom = defaultsFor("/agents/demo", {
      systemPrompt: "Answer in one short sentence.",
      model: "openai/gpt-5.5",
    });
    expect(custom.systemPrompt).toBe("Answer in one short sentence.");
    const config = custom.events.find(
      (event) => event.type === "events.iterate.com/agent/config-updated",
    );
    expect(config?.payload.systemPrompt).toBe("Answer in one short sentence.");
    const provider = custom.events.find(
      (event) => event.type === "events.iterate.com/agent/llm-provider-selected",
    );
    expect(provider?.payload).toMatchObject({ model: "openai/gpt-5.5" });
  });

  it("uses GPT-5.6 Sol by default", () => {
    const defaults = defaultsFor("/agents/demo");
    expect(defaults.model).toBe("openai/gpt-5.6-sol");
    const provider = defaults.events.find(
      (event) => event.type === "events.iterate.com/agent/llm-provider-selected",
    );
    expect(provider?.payload).toMatchObject({ ifUnset: true, model: "openai/gpt-5.6-sol" });
  });

  it("keys every event on (projectId, agentPath) so re-appends dedupe", () => {
    for (const event of defaultsFor("/agents/demo").events) {
      expect(event.idempotencyKey).toContain(PROJECT_ID);
    }
  });

  it("child agents get the plain default prompt — never a thread transcriber prompt, no child suffix", () => {
    // Child-agent-ness rides on the parent's message (the fold labels
    // agent-sourced messages with the sender's path and reply door), not on
    // a birth-time prompt.
    const nested = defaultsFor("/agents/slack/main/C123/ts-99/helper");
    expect(nested.systemPrompt).toContain("HOW YOU ACT");
    expect(nested.systemPrompt).not.toContain("You are a child agent");
    // The shape-loose Slack predicate must not classify the nested path.
    expect(nested.systemPrompt).not.toContain("inside a Slack thread");
    expect(nested.systemPrompt).toBe(defaultsFor("/agents/main").systemPrompt);
  });
});
