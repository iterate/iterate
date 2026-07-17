import type { StreamEvent } from "iterate/processors";
import {
  agentSystemPromptContextEvent,
  ONBOARDING_AGENT_SYSTEM_PROMPT,
  ONBOARDING_AGENT_SYSTEM_PROMPT_REVISION,
} from "../domains/agents/agent-defaults.ts";
import type { AgentEventInput } from "../domains/agents/agent-processor-contract.ts";
import type { ProjectProcessorState } from "../domains/projects/project-processor-contract.ts";

export const ONBOARDING_AGENT_PATH = "/agents/onboarding";
const ONBOARDING_START_REVISION = "1";

export function onboardingStartEvent() {
  return {
    type: "events.iterate.com/agents/context-added",
    idempotencyKey: `agent/onboarding-start:v${ONBOARDING_START_REVISION}`,
    payload: {
      role: "developer",
      key: "agent/onboarding-start",
      content:
        "Begin onboarding. The project owner just created this project and is looking at the chat. If the user already sent a message above, answer it first, then continue the onboarding script.",
      llmRequestPolicy: { behaviour: "after-current-request" },
    },
  } as const;
}

/**
 * Build the two exact, retryable onboarding startup occurrences. Their
 * context keys own logical supersession; their explicit revisions own append
 * idempotency. Bump the matching revision whenever shipped content changes.
 */
export function onboardingAgentStartupEvents(): AgentEventInput[] {
  const systemPrompt = agentSystemPromptContextEvent({
    content: ONBOARDING_AGENT_SYSTEM_PROMPT,
    idempotencyKey: `agent/onboarding-system-prompt:v${ONBOARDING_AGENT_SYSTEM_PROMPT_REVISION}`,
  });
  return [systemPrompt, onboardingStartEvent()];
}

type OnboardingAgentHandle = {
  append(...events: AgentEventInput[]): Promise<StreamEvent[]>;
  create(): Promise<void>;
};

/** Ensure generic birth, then idempotently install the onboarding startup facts. */
export async function ensureOnboardingAgentReady(input: {
  agent: OnboardingAgentHandle;
}): Promise<void> {
  await input.agent.create();
  await input.agent.append(...onboardingAgentStartupEvents());
}

export function isOnboardingActive(
  state: Pick<ProjectProcessorState, "onboardingActive">,
): boolean {
  return state.onboardingActive;
}
