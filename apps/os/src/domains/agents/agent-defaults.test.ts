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

  it("bakes overrides into the returned events, appended after the codemode contract", () => {
    const custom = defaultsFor("/agents/demo", {
      systemPrompt: "Answer only in pirate speak.",
      model: "openai/gpt-5.5",
    });
    // The persona rides after the platform prompt — an agent whose prompt
    // loses the codemode contract cannot act at all.
    expect(custom.systemPrompt).toContain("HOW YOU ACT");
    expect(custom.systemPrompt.endsWith("Answer only in pirate speak.")).toBe(true);
    const config = custom.events.find(
      (event) => event.type === "events.iterate.com/agent/config-updated",
    );
    expect(config?.payload.systemPrompt).toBe(custom.systemPrompt);
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

  it("subagents get the default prompt plus the subagent suffix — never a thread transcriber prompt", () => {
    const nested = defaultsFor("/agents/slack/main/C123/ts-99/subagents/helper");
    expect(nested.systemPrompt).toContain("YOU ARE A SUBAGENT");
    expect(nested.systemPrompt).toContain("/agents/slack/main/C123/ts-99");
    // The shape-loose Slack predicate must not classify the nested path.
    expect(nested.systemPrompt).not.toContain("inside a Slack thread");
    const plain = defaultsFor("/agents/main");
    expect(plain.systemPrompt).not.toContain("YOU ARE A SUBAGENT");
  });

  it("a systemPrompt override keeps the codemode contract and the subagent suffix", () => {
    const custom = defaultsFor("/agents/main/subagents/pirate", {
      systemPrompt: "Answer only in pirate speak.",
    });
    expect(custom.systemPrompt).toContain("HOW YOU ACT");
    expect(custom.systemPrompt).toContain("Answer only in pirate speak.");
    expect(custom.systemPrompt).toContain("YOU ARE A SUBAGENT");
    expect(custom.systemPrompt).toContain("/agents/main");
    // Order: platform contract, then persona, then the subagent contract.
    expect(custom.systemPrompt.indexOf("HOW YOU ACT")).toBeLessThan(
      custom.systemPrompt.indexOf("Answer only in pirate speak."),
    );
    expect(custom.systemPrompt.indexOf("Answer only in pirate speak.")).toBeLessThan(
      custom.systemPrompt.indexOf("YOU ARE A SUBAGENT"),
    );
  });
});
