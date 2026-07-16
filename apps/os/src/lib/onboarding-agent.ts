import type { ProjectProcessorState } from "../domains/projects/project-processor-contract.ts";

export const ONBOARDING_AGENT_PATH = "/agents/onboarding";

export function isOnboardingActive(
  state: Pick<ProjectProcessorState, "onboardingActive">,
): boolean {
  return state.onboardingActive;
}
