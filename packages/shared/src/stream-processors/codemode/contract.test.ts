import { describe, expect, it } from "vitest";
import { getInitialProcessorState, type StreamEvent } from "../stream-processor.ts";
import {
  CodemodeProcessorContract,
  reduceCodemodeEvents,
  toolProviderRegistryKey,
} from "./contract.ts";

describe("CodemodeProcessorContract", () => {
  it("stores registered tool provider documentation by path", () => {
    const provider = {
      docs: "GitHub issue functions are available.",
      path: ["github"],
      typeDefinitions: "declare const github: unknown;",
    };
    const state = reduceCodemodeEvents({
      state: getInitialProcessorState(CodemodeProcessorContract),
      events: [
        committedEvent({
          type: "events.iterate.com/codemode/tool-provider-registered",
          payload: provider,
        }),
      ],
    });

    expect(state.toolProviders).toEqual({
      [toolProviderRegistryKey(["github"])]: provider,
    });
  });

  it("tracks requested and completed function calls by functionCallId", () => {
    const state = reduceCodemodeEvents({
      state: getInitialProcessorState(CodemodeProcessorContract),
      events: [
        committedEvent({
          type: "events.iterate.com/codemode/function-call-requested",
          payload: {
            functionCallId: "fn-1",
            input: { title: "Bug" },
            path: ["github", "issues", "create"],
            scriptExecutionId: "scr-1",
          },
        }),
        committedEvent({
          type: "events.iterate.com/codemode/function-call-completed",
          payload: {
            functionCallId: "fn-1",
            outcome: { status: "succeeded", output: { issue: 123 } },
            path: ["github", "issues", "create"],
            scriptExecutionId: "scr-1",
          },
        }),
      ],
    });

    expect(state.functionCalls["fn-1"]).toEqual({
      functionCallId: "fn-1",
      outcome: { status: "succeeded", output: { issue: 123 } },
      path: ["github", "issues", "create"],
      scriptExecutionId: "scr-1",
      status: "completed",
    });
  });
});

function committedEvent(args: { type: string; payload: unknown; offset?: number }): StreamEvent {
  return {
    streamPath: "/projects/prj_test/codemode-sessions/cblk_test",
    type: args.type,
    payload: args.payload,
    offset: args.offset ?? 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
