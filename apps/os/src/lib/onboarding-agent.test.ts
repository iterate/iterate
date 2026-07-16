import { describe, expect, test } from "vitest";
import { ONBOARDING_AGENT_SYSTEM_PROMPT } from "../domains/agents/agent-defaults.ts";
import type { ProjectProcessorState } from "../domains/projects/project-processor-contract.ts";
import {
  isOnboardingActive,
  onboardingAgentCreateInput,
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
  test("is an idempotent developer input that starts the onboarding turn", () => {
    expect(onboardingStartEvent("prj_test")).toMatchObject({
      type: "events.iterate.com/agents/context-added",
      idempotencyKey: "project-onboarding-start:prj_test",
      payload: {
        role: "developer",
        key: "agent/onboarding-start",
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    });
  });

  test("is part of the single explicit onboarding create input", () => {
    expect(onboardingAgentCreateInput("prj_test")).toEqual({
      systemPrompt: ONBOARDING_AGENT_SYSTEM_PROMPT,
      initialEvents: [onboardingStartEvent("prj_test")],
    });
  });
});
