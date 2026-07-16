import {
  ONBOARDING_AGENT_SYSTEM_PROMPT,
  type AgentCreateInput,
} from "../domains/agents/agent-defaults.ts";
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

/** The explicit, atomic birth batch used by every onboarding entry point. */
export function onboardingAgentCreateInput(projectId: string): AgentCreateInput {
  return {
    systemPrompt: ONBOARDING_AGENT_SYSTEM_PROMPT,
    initialEvents: [onboardingStartEvent(projectId)],
  };
}

export function isOnboardingActive(
  state: Pick<ProjectProcessorState, "onboardingActive">,
): boolean {
  return state.onboardingActive;
}
