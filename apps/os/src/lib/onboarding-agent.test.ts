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
  waitForOnboardingGreeting,
} from "./onboarding-agent.ts";

const state = (overrides: Partial<ProjectProcessorState>): ProjectProcessorState => ({
  birthCertificate: { config: { slug: "test" }, createRequestedAtOffset: 1 },
  createFailure: null,
  createRequest: { config: { slug: "test" } },
  createRequestedAtOffset: 1,
  clients: {},
  customDomains: [],
  devices: [],
  egressRules: [],
  humanApprovalKeys: [],
  notificationReady: false,
  onboardingActive: false,
  onboardingCompletedAt: null,
  repos: [],
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
          // The processor ignores the defaulted policy on system items.
          llmRequestPolicy: { behaviour: "after-current-request" },
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

  test("recovers a rollover during the greeting wait without losing a committed greeting", async () => {
    const reset = new Error("stream-unavailable: deployment reset");
    const greeting = {
      type: "events.iterate.com/agents/web-message-sent",
      offset: 14,
      payload: { message: "Welcome" },
    };
    const waitForEvent = vi.fn().mockRejectedValueOnce(reset);
    const getEvents = vi.fn(async () => [greeting]);
    const onRetry = vi.fn();

    await expect(
      waitForOnboardingGreeting({
        stream: { getEvents, waitForEvent },
        timeoutMs: 90_000,
        onRetry,
      }),
    ).resolves.toBe(greeting);

    expect(waitForEvent).toHaveBeenCalledOnce();
    expect(getEvents).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(reset);
  });

  test("re-arms the greeting wait from a durable replay cursor after rollover", async () => {
    const reset = new Error("stream-unavailable: deployment reset");
    const baseline = { type: "events.iterate.com/agents/context-added", offset: 8 };
    const greeting = {
      type: "events.iterate.com/agents/web-message-sent",
      offset: 9,
      payload: { message: "Welcome" },
    };
    const waitForEvent = vi.fn().mockRejectedValueOnce(reset).mockResolvedValueOnce(greeting);
    const getEvents = vi.fn(async () => [baseline]);
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_250);

    await expect(
      waitForOnboardingGreeting({
        stream: { getEvents, waitForEvent },
        timeoutMs: 90_000,
        now,
      }),
    ).resolves.toBe(greeting);

    expect(waitForEvent).toHaveBeenNthCalledWith(1, {
      eventTypes: ["events.iterate.com/agents/web-message-sent"],
      timeoutMs: 90_000,
    });
    expect(waitForEvent).toHaveBeenNthCalledWith(2, {
      afterOffset: 8,
      eventTypes: ["events.iterate.com/agents/web-message-sent"],
      timeoutMs: 89_750,
    });
  });

  test("surfaces a second greeting-wait rollover instead of retrying without a bound", async () => {
    const firstReset = new Error("stream-unavailable: first deployment reset");
    const secondReset = new Error("stream-unavailable: second deployment reset");
    const waitForEvent = vi
      .fn()
      .mockRejectedValueOnce(firstReset)
      .mockRejectedValueOnce(secondReset);
    const getEvents = vi.fn(async () => []);
    const onRetry = vi.fn();

    await expect(
      waitForOnboardingGreeting({
        stream: { getEvents, waitForEvent },
        timeoutMs: 90_000,
        onRetry,
      }),
    ).rejects.toBe(secondReset);

    expect(waitForEvent).toHaveBeenCalledTimes(2);
    expect(getEvents).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(firstReset);
  });
});
