import { describe, expect, it } from "vitest";
import { ONBOARDING_AGENT_PATH } from "../../lib/onboarding-agent.ts";
import { EMAIL_AGENT_SYSTEM_PROMPT, agentDefaultsForPath } from "./agent-defaults.ts";

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

  it("only the onboarding agent gets the kickoff input", () => {
    const kickoffTypes = (path: string) =>
      defaultsFor(path).events.filter(
        (event) => event.idempotencyKey === `project-onboarding-start:${PROJECT_ID}`,
      ).length;
    expect(kickoffTypes(ONBOARDING_AGENT_PATH)).toBe(1);
    expect(kickoffTypes("/agents/demo")).toBe(0);
  });

  it("bakes overrides into the returned events", () => {
    const custom = defaultsFor("/agents/demo", {
      systemPrompt: "Answer only in pirate speak.",
      model: "openai/gpt-5.5",
    });
    expect(custom.systemPrompt).toBe("Answer only in pirate speak.");
    const config = custom.events.find(
      (event) => event.type === "events.iterate.com/agent/config-updated",
    );
    expect(config?.payload.systemPrompt).toBe("Answer only in pirate speak.");
    const provider = custom.events.find(
      (event) => event.type === "events.iterate.com/agent/llm-provider-selected",
    );
    expect(provider?.payload).toMatchObject({ model: "openai/gpt-5.5" });
  });

  it("keys every event on (projectId, agentPath) so re-appends dedupe", () => {
    for (const event of defaultsFor("/agents/demo").events) {
      expect(event.idempotencyKey).toContain(PROJECT_ID);
    }
  });

  it("child agents get parent-reporting guidance — never a thread transcriber prompt", () => {
    const nested = defaultsFor("/agents/slack/main/C123/ts-99/helper");
    expect(nested.systemPrompt).toContain("You are a child agent");
    expect(nested.systemPrompt).toContain("/agents/slack/main/C123/ts-99");
    // The shape-loose Slack predicate must not classify the nested path.
    expect(nested.systemPrompt).not.toContain("inside a Slack thread");
    const plain = defaultsFor("/agents/main");
    expect(plain.systemPrompt).not.toContain("You are a child agent");
  });

  it("a systemPrompt override keeps the parent-reporting guidance appended", () => {
    const custom = defaultsFor("/agents/main/pirate", {
      systemPrompt: "Answer only in pirate speak.",
    });
    expect(custom.systemPrompt.startsWith("Answer only in pirate speak.")).toBe(true);
    expect(custom.systemPrompt).toContain("You are a child agent");
    expect(custom.systemPrompt).toContain("/agents/main");
  });
});
