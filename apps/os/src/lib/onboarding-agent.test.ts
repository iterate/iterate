import { describe, expect, test, vi } from "vitest";
import {
  ONBOARDING_AGENT_SYSTEM_PROMPT,
  ONBOARDING_AGENT_SYSTEM_PROMPT_REVISION,
} from "../domains/agents/agent-defaults.ts";
import type { ProjectProcessorState } from "../domains/projects/project-processor-contract.ts";
import {
  isOnboardingActive,
  ensureOnboardingAgentReady,
  onboardingAgentStartupEvents,
  onboardingStartEvent,
} from "./onboarding-agent.ts";

const state = (overrides: Partial<ProjectProcessorState>): ProjectProcessorState => ({
  agents: [],
  birthCertificate: { config: { slug: "test" } },
  customDomains: [],
  egressRules: [],
  humanApprovalKeys: [],
  onboardingActive: false,
  onboardingCompletedAt: null,
  repos: [],
  ready: true,
  secrets: [],
  streams: [],
  ...overrides,
});

describe("isOnboardingActive", () => {
  test("keys off the phase marker alone — the agent may not have been explicitly created yet", () => {
    expect(isOnboardingActive(state({ onboardingActive: true }))).toBe(true);
    expect(isOnboardingActive(state({ onboardingActive: false }))).toBe(false);
  });
});

describe("onboardingStartEvent", () => {
  test("is a revisioned developer input that starts the onboarding turn", () => {
    expect(onboardingStartEvent()).toMatchObject({
      type: "events.iterate.com/agents/context-added",
      idempotencyKey: "agent/onboarding-start:v1",
      payload: {
        role: "developer",
        key: "agent/onboarding-start",
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });
  });

  test("builds the same exact startup occurrences for every retry", () => {
    const expected = [
      {
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: `agent/onboarding-system-prompt:v${ONBOARDING_AGENT_SYSTEM_PROMPT_REVISION}`,
        payload: {
          role: "system",
          key: "agent/system-prompt",
          content: ONBOARDING_AGENT_SYSTEM_PROMPT,
        },
      },
      onboardingStartEvent(),
    ];
    expect(onboardingAgentStartupEvents()).toEqual(expected);
    expect(onboardingAgentStartupEvents()).toEqual(expected);
  });

  test("ensures generic birth before appending the startup facts", async () => {
    const calls: string[] = [];
    const create = vi.fn(async () => {
      calls.push("create");
    });
    const append = vi.fn(async () => {
      calls.push("append");
      return [];
    });

    await ensureOnboardingAgentReady({ agent: { append, create } });

    expect(calls).toEqual(["create", "append"]);
    expect(append).toHaveBeenCalledWith(...onboardingAgentStartupEvents());
  });
});
