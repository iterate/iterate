import { expect, test } from "vitest";
import { StreamEvent } from "iterate/processors";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { reduceAgentEvent } from "./agent-prompt-fold.ts";

const path = "/agents/input-progress";
function fold(
  offset: number,
  type: string,
  payload: unknown,
  state = AgentProcessorContract.stateSchema.parse({}),
  sourceOffset?: number,
) {
  const event = StreamEvent.parse({
    offset,
    type,
    payload,
    path,
    createdAt: new Date(offset).toISOString(),
    ...(sourceOffset === undefined
      ? {}
      : {
          source: {
            processor: {
              slug: "agent",
              version: "7.0.0",
              stream: { path, projectId: null, streamId: "00000000-0000-4000-8000-000000000001" },
              whileProcessing: {
                offset: sourceOffset,
                type: "events.iterate.com/agents/context-added",
              },
            },
          },
        }),
  });
  return reduceAgentEvent({ event: AgentProcessorContract.parseEvent(event), state });
}
const context = "events.iterate.com/agents/context-added";
const mention = {
  role: "user",
  content: "Read [@AGENTS.md](mention://config-repo/AGENTS.md)",
  mentions: [
    {
      id: "config-repo/AGENTS.md",
      type: "repo-file",
      repoPath: "/repos/config",
      path: "AGENTS.md",
    },
  ],
};
const resolution = (sourceOffset: number) => ({
  role: "developer",
  content: "File resolved",
  actor: { type: "integration", name: "agent-mention-resolver" },
  mentionResolution: {
    sourceOffset,
    sourceScheduling: { triggerSource: "external", clearsWaitingFor: true },
  },
});

test("ordinary and no-op input need no retained receipt", () => {
  const ordinary = fold(10, context, { role: "user", content: "Hello" });
  expect(ordinary.pendingInputConsequences).toEqual({});
  expect(ordinary.runtimeChange?.runtime.triggers.pending).toBe(1);
  const noOp = fold(11, context, {
    role: "user",
    content: "Store only",
    llmRequestPolicy: { behaviour: "dont-trigger-request" },
  });
  expect(noOp.pendingInputConsequences).toEqual({});
  expect(noOp.runtimeChange).toBeUndefined();
});

test("mention inputs retire only on their own processor-produced resolution, together with the trigger", () => {
  const first = fold(10, context, mention);
  const second = fold(11, context, mention, first);
  expect(second.pendingInputConsequences).toEqual({ "mention:10": 10, "mention:11": 11 });
  const forged = fold(12, context, resolution(10), second);
  expect(forged.pendingInputConsequences).toEqual(second.pendingInputConsequences);
  const wrongCause = fold(13, context, resolution(10), second, 11);
  expect(wrongCause.pendingInputConsequences).toEqual(second.pendingInputConsequences);
  const resolvedSecond = fold(14, context, resolution(11), second, 11);
  expect(resolvedSecond.pendingInputConsequences).toEqual({ "mention:10": 10 });
  expect(resolvedSecond.runtimeChange?.runtime.triggers.pending).toBe(1);
  expect(fold(15, context, resolution(10), resolvedSecond, 10).pendingInputConsequences).toEqual(
    {},
  );
});

test("slash input hands off to its exact script request; disabled interpretation owes no derived script", () => {
  const pending = fold(10, context, { role: "user", content: "/example describe-project" });
  expect(pending.pendingInputConsequences).toEqual({ "slash-command:example:10": 10 });
  const request = {
    executionId: "slash-command:example:10",
    code: "async () => {}",
    expiresAt: 1000,
  };
  const forged = fold(
    11,
    "events.iterate.com/capability-host/script-run-requested",
    request,
    pending,
  );
  expect(forged.pendingInputConsequences).toEqual(pending.pendingInputConsequences);
  const active = fold(
    12,
    "events.iterate.com/capability-host/script-run-requested",
    request,
    pending,
    10,
  );
  expect(active.pendingInputConsequences).toEqual({});
  expect(active.runtimeChange?.runtime.runningScripts).toBe(1);
  const disabled = AgentProcessorContract.stateSchema.parse({
    config: { interpretResponses: false },
  });
  expect(
    fold(10, context, { role: "user", content: "/example describe-project" }, disabled)
      .pendingInputConsequences,
  ).toEqual({});
});
