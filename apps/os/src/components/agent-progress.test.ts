import { expect, test } from "vitest";
import { ZERO_AGENT_RUNTIME } from "@iterate-com/shared/agent-events";
import { presentAgentProgress } from "./agent-progress.ts";

const script = {
  sinceOffset: 10,
  since: new Date(10).toISOString(),
  runtime: { ...ZERO_AGENT_RUNTIME, runningScripts: 1 },
};
const followUp = {
  sinceOffset: 20,
  since: new Date(20).toISOString(),
  runtime: { ...ZERO_AGENT_RUNTIME, triggers: { pending: 1, runnable: 1 } },
};
const idle = { ...followUp, runtime: ZERO_AGENT_RUNTIME };

test("new follow-up progress replaces older active feed progress immediately", () => {
  expect(
    presentAgentProgress(script, {
      runtimeChange: followUp,
      inputAcknowledgedThroughOffset: 22,
    }),
  ).toEqual({ agentRuntime: followUp.runtime, inputAcknowledgedThroughOffset: 0 });
});

test("idle waits for the settled feed publications before releasing progress and input", () => {
  const agent = { runtimeChange: idle, inputAcknowledgedThroughOffset: 22 };
  expect(presentAgentProgress(script, agent)).toEqual({
    agentRuntime: script.runtime,
    inputAcknowledgedThroughOffset: 0,
  });
  expect(presentAgentProgress(idle, agent)).toEqual({
    agentRuntime: idle.runtime,
    inputAcknowledgedThroughOffset: 22,
  });
});

test("a newer feed transition wins over an older agent subscription", () => {
  expect(
    presentAgentProgress(idle, { runtimeChange: script, inputAcknowledgedThroughOffset: 12 })
      .agentRuntime,
  ).toBe(idle.runtime);
});

test("inputs with unchanged runtime counts are acknowledged beyond the transition offset", () => {
  expect(
    presentAgentProgress(followUp, {
      runtimeChange: followUp,
      inputAcknowledgedThroughOffset: 30,
    }).inputAcknowledgedThroughOffset,
  ).toBe(30);
});

test("a replacement lifetime has no acknowledgement until its new agent snapshot arrives", () => {
  expect(presentAgentProgress(undefined, undefined)).toEqual({
    agentRuntime: undefined,
    inputAcknowledgedThroughOffset: 0,
  });
  expect(presentAgentProgress(script, undefined)).toEqual({
    agentRuntime: script.runtime,
    inputAcknowledgedThroughOffset: 0,
  });
});
