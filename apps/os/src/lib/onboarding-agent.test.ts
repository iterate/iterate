import { describe, expect, test } from "vitest";
import {
  ONBOARDING_AGENT_PATH,
  hasActiveOnboardingAgent,
  isOnboardingActive,
} from "./onboarding-agent.ts";
import type { ProjectProcessorState } from "~/types.ts";

const state = (overrides: Partial<ProjectProcessorState>): ProjectProcessorState => ({
  agents: [],
  createRequest: null,
  created: true,
  onboardingActive: false,
  onboardingCompletedAt: null,
  repos: [],
  secrets: [],
  streams: [],
  ...overrides,
});

describe("hasActiveOnboardingAgent", () => {
  test("does not treat legacy projects with only an onboarding agent as active onboarding", () => {
    expect(
      hasActiveOnboardingAgent(
        state({
          agents: [{ createdAt: "2026-01-01T00:00:00.000Z", path: ONBOARDING_AGENT_PATH }],
        }),
      ),
    ).toBe(false);
  });

  test("requires both the active onboarding marker and the onboarding agent stream", () => {
    expect(hasActiveOnboardingAgent(state({ onboardingActive: true }))).toBe(false);
    expect(
      hasActiveOnboardingAgent(
        state({
          agents: [{ createdAt: "2026-01-01T00:00:00.000Z", path: ONBOARDING_AGENT_PATH }],
          onboardingActive: true,
        }),
      ),
    ).toBe(true);
  });

  test("treats the active marker as enough for early redirect before the agent list catches up", () => {
    const activeWithoutListedAgent = state({ onboardingActive: true });

    expect(isOnboardingActive(activeWithoutListedAgent)).toBe(true);
    expect(hasActiveOnboardingAgent(activeWithoutListedAgent)).toBe(false);
  });
});
