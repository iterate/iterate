import type { ProjectProcessorState } from "~/types.ts";

export const ONBOARDING_AGENT_PATH = "/agents/onboarding";

export function isOnboardingActive(
  state: Pick<ProjectProcessorState, "onboardingActive">,
): boolean {
  return state.onboardingActive;
}

export function hasActiveOnboardingAgent(
  state: Pick<ProjectProcessorState, "agents" | "onboardingActive">,
): boolean {
  return (
    state.onboardingActive && state.agents.some((agent) => agent.path === ONBOARDING_AGENT_PATH)
  );
}
