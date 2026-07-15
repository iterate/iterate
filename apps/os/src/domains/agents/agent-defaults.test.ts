import { describe, expect, test } from "vitest";
import { ONBOARDING_AGENT_PATH } from "../../lib/onboarding-agent.ts";
import { EMAIL_AGENT_SYSTEM_PROMPT, agentDefaultsForPath } from "./agent-defaults.ts";

const PROJECT_ID = "prj_defaults_test";
const GITHUB_AGENT_PATH = `/agents/repos/g~${"0".repeat(64)}/pull-requests/7`;

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
  test("boot context names the project when directory facts are supplied — id-only without", () => {
    const bootContent = (project?: { name: string; slug: string; workerUrl?: string }) => {
      const events = agentDefaultsForPath({
        agentPath: "/agents/demo",
        projectId: PROJECT_ID,
        ...(project === undefined ? {} : { project }),
      }).events;
      const boot = events.find((event) =>
        String(event.idempotencyKey).startsWith("agent/boot-system-context:"),
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

  test("mounts only the workspace — sandboxes are created explicitly, never granted", () => {
    const mounts = defaultsFor("/agents/demo")
      .events.filter(
        (event) => event.type === "events.iterate.com/capability-host/capability-provided",
      )
      .map((event) => event.payload.path);
    expect(mounts).toEqual([["workspace"]]);
  });

  test("selects the prompt by path and reports it alongside the events", () => {
    const emailDefaults = defaultsFor("/agents/email/t42");
    expect(emailDefaults.systemPrompt).toBe(EMAIL_AGENT_SYSTEM_PROMPT);
    const systemContext = emailDefaults.events.find(
      (event) =>
        event.type === "events.iterate.com/agents/context-added" &&
        event.payload.role === "system" &&
        event.payload.key === "agent/system-prompt",
    );
    expect(systemContext?.payload.content).toBe(EMAIL_AGENT_SYSTEM_PROMPT);
  });

  test("gives pull-request agents the GitHub prompt without platform review policy", () => {
    const defaults = defaultsFor(GITHUB_AGENT_PATH);
    // Prompt SELECTION is the invariant (one identifying anchor + not the
    // generic default); the guidance prose is deliberately unpinned —
    // docs/testing.md names prompt-copy pinning as an antipattern.
    expect(defaults.systemPrompt).toContain("attached to one GitHub pull request");
    expect(defaults.systemPrompt).not.toBe(defaultsFor("/agents/demo").systemPrompt);
    expect(
      defaults.events.some((event) => event.type === "events.iterate.com/github-agent/configure"),
    ).toBe(false);
  });

  test("only the onboarding agent gets the kickoff context", () => {
    const kickoffTypes = (path: string) =>
      defaultsFor(path).events.filter(
        (event) => event.idempotencyKey === `project/onboarding-context:${PROJECT_ID}`,
      ).length;
    expect(kickoffTypes(ONBOARDING_AGENT_PATH)).toBe(1);
    expect(kickoffTypes("/agents/demo")).toBe(0);
  });

  test("bakes overrides into the returned events — a systemPrompt override replaces wholesale", () => {
    const custom = defaultsFor("/agents/demo", {
      systemPrompt: "Answer in one short sentence.",
      model: "openai/gpt-5.5",
    });
    expect(custom.systemPrompt).toBe("Answer in one short sentence.");
    const systemContext = custom.events.find(
      (event) =>
        event.type === "events.iterate.com/agents/context-added" &&
        event.payload.role === "system" &&
        event.payload.key === "agent/system-prompt",
    );
    expect(systemContext?.payload.content).toBe("Answer in one short sentence.");
    const provider = custom.events.find(
      (event) => event.type === "events.iterate.com/agent/llm-provider-selected",
    );
    expect(provider?.payload).toMatchObject({ model: "openai/gpt-5.5" });
  });

  test("uses GPT-5.6 Sol by default", () => {
    const defaults = defaultsFor("/agents/demo");
    expect(defaults.model).toBe("openai/gpt-5.6-sol");
    const provider = defaults.events.find(
      (event) => event.type === "events.iterate.com/agent/llm-provider-selected",
    );
    expect(provider?.payload).toMatchObject({ ifUnset: true, model: "openai/gpt-5.6-sol" });
  });

  test("keys every event on (projectId, agentPath) so re-appends dedupe", () => {
    for (const event of defaultsFor("/agents/demo").events) {
      expect(event.idempotencyKey).toContain(PROJECT_ID);
    }
  });

  test("child agents get the plain default prompt — never a thread transcriber prompt, no child suffix", () => {
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
