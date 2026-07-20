import type { StreamEvent } from "iterate/processors";
import {
  agentSystemPromptContextEvent,
  ONBOARDING_AGENT_SYSTEM_PROMPT,
  ONBOARDING_AGENT_SYSTEM_PROMPT_REVISION,
} from "../domains/agents/agent-defaults.ts";
import type { AgentEventInput } from "../domains/agents/agent-processor-contract.ts";
import type { ProjectProcessorState } from "../domains/projects/project-processor-contract.ts";
import {
  isStreamUnavailableError,
  retryStreamUnavailableOnce,
} from "../domains/streams/stream-unavailable.ts";

export const ONBOARDING_AGENT_PATH = "/agents/onboarding";
const ONBOARDING_GREETING_EVENT_TYPE = "events.iterate.com/agents/web-message-sent" as const;
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
  onRetry?: (error: unknown) => void;
}): Promise<void> {
  // Both operations are idempotent: generic birth has a stable identity and
  // the startup facts carry revisioned idempotency keys. Replay them together
  // once when a deploy rolls the stream incarnation between the two calls.
  await retryStreamUnavailableOnce(async () => {
    await input.agent.create();
    await input.agent.append(...onboardingAgentStartupEvents());
  }, input.onRetry);
}

type OnboardingGreetingEvent = Pick<StreamEvent, "offset" | "type">;

type OnboardingStreamHandle<Event extends OnboardingGreetingEvent> = {
  getEvents(args?: { afterOffset?: number }): Promise<Event[]>;
  waitForEvent(args: {
    afterOffset?: number;
    eventTypes: readonly string[];
    timeoutMs: number;
  }): Promise<Event>;
};

/**
 * Wait for the fresh onboarding stream's greeting while surviving one
 * deployment-rollover reset. The recovery read closes the commit/ack gap: if
 * the greeting committed before the old incarnation lost its reply, return
 * that durable row; otherwise re-arm from the exact durable cursor so nothing
 * committed between waits can be skipped.
 */
export async function waitForOnboardingGreeting<Event extends OnboardingGreetingEvent>(input: {
  stream: OnboardingStreamHandle<Event>;
  timeoutMs: number;
  now?: () => number;
  onRetry?: (error: unknown) => void;
}): Promise<Event> {
  const now = input.now ?? Date.now;
  const deadline = now() + input.timeoutMs;
  const wait = (timeoutMs: number, afterOffset?: number) =>
    input.stream.waitForEvent({
      ...(afterOffset === undefined ? {} : { afterOffset }),
      eventTypes: [ONBOARDING_GREETING_EVENT_TYPE],
      timeoutMs,
    });

  try {
    return await wait(input.timeoutMs);
  } catch (error) {
    if (!isStreamUnavailableError(error)) throw error;
    input.onRetry?.(error);

    const events = await input.stream.getEvents({});
    const committed = events.findLast((event) => event.type === ONBOARDING_GREETING_EVENT_TYPE);
    if (committed !== undefined) return committed;

    // Empty streams have a durable head of zero and their first row is offset
    // one, so zero is also a gap-free replay cursor.
    const replayAfterOffset = events.at(-1)?.offset ?? 0;
    return await wait(Math.max(1, deadline - now()), replayAfterOffset);
  }
}

export function isOnboardingActive(
  state: Pick<ProjectProcessorState, "onboardingActive">,
): boolean {
  return state.onboardingActive;
}
