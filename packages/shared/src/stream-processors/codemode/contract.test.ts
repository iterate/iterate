import { describe, expect, it } from "vitest";
import type { Callable } from "../../callable/types.ts";
import { getInitialProcessorState, type StreamEvent } from "../stream-processor.ts";
import {
  CodemodeProcessorContract,
  reduceCodemodeEvents,
  toolProviderRegistryKey,
} from "./contract.ts";

const testCallable = {
  type: "workers-rpc",
  via: {
    type: "env-binding",
    bindingType: "service",
    bindingName: "CODEMODE_SESSION",
  },
  rpcMethod: "getCodemodeSessionCapability",
  argsMode: "object",
} satisfies Callable;

describe("CodemodeProcessorContract", () => {
  it("stores session capability callable from session-started", () => {
    const state = reduceCodemodeEvents({
      state: getInitialProcessorState(CodemodeProcessorContract),
      events: [
        committedEvent({
          type: "events.iterate.com/codemode/session-started",
          payload: { sessionCapabilityCallable: testCallable },
        }),
      ],
    });

    expect(state.sessionStarted).toBe(true);
    expect(state.sessionCapabilityCallable).toEqual(testCallable);
  });

  it("stores registered tool provider instructions and invocation by path", () => {
    const provider = {
      instructions: "GitHub issue functions are available.",
      invocation: { kind: "event" as const },
      path: ["github"],
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
            args: [{ title: "Bug" }],
            functionCallId: "fn-1",
            functionPath: ["issues", "create"],
            invocationKind: "event",
            path: ["github", "issues", "create"],
            providerPath: ["github"],
            scriptExecutionId: "scr-1",
          },
        }),
        committedEvent({
          type: "events.iterate.com/codemode/function-call-completed",
          payload: {
            functionCallId: "fn-1",
            functionPath: ["issues", "create"],
            invocationKind: "event",
            outcome: { status: "returned", value: { issue: 123 } },
            path: ["github", "issues", "create"],
            providerPath: ["github"],
            scriptExecutionId: "scr-1",
          },
        }),
      ],
    });

    expect(state.functionCalls["fn-1"]).toEqual({
      functionCallId: "fn-1",
      functionPath: ["issues", "create"],
      invocationKind: "event",
      outcome: { status: "returned", value: { issue: 123 } },
      path: ["github", "issues", "create"],
      providerPath: ["github"],
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
