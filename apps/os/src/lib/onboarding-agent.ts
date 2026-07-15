import type { ProjectProcessorState } from "../domains/projects/project-processor-contract.ts";

export const ONBOARDING_AGENT_PATH = "/agents/onboarding";

export function onboardingStartEvent(projectId: string) {
  return {
    type: "events.iterate.com/agents/context-added",
    idempotencyKey: `project-onboarding-start:${projectId}`,
    payload: {
      role: "developer",
      key: "agent/onboarding-start",
      content:
        "Begin onboarding. The project owner just created this project and is looking at the chat. If the user already sent a message above, answer it first, then continue the onboarding script.",
      llmRequestPolicy: { behaviour: "after-current-request" },
    },
  };
}

export function isOnboardingActive(
  state: Pick<ProjectProcessorState, "onboardingActive">,
): boolean {
  return state.onboardingActive;
}
