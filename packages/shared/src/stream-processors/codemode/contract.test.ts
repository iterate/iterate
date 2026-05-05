import { describe, expect, it } from "vitest";
import { getInitialProcessorState, type StreamEvent } from "../stream-processor.ts";
import {
  CodemodeProcessorContract,
  reduceCodemodeEvents,
  toolProviderRegistryKey,
} from "./contract.ts";
import type { ToolProviderDescriptor } from "../../codemode/types.ts";

describe("CodemodeProcessorContract", () => {
  it("stores registered tool providers by path", () => {
    const descriptor = testToolProvider(["github"]);
    const state = reduceCodemodeEvents({
      state: getInitialProcessorState(CodemodeProcessorContract),
      events: [
        committedEvent({
          type: "events.iterate.com/codemode/tool-provider-registered",
          payload: {
            descriptor,
            path: descriptor.path,
          },
        }),
      ],
    });

    expect(state.toolProviders).toEqual({
      [toolProviderRegistryKey(["github"])]: descriptor,
    });
  });
});

function testToolProvider(path: string[]): ToolProviderDescriptor {
  return {
    path,
    callable: {
      type: "fetch",
      via: {
        type: "url",
        url: "https://example.com/tools",
      },
    },
  };
}

function committedEvent(args: { type: string; payload: unknown; offset?: number }): StreamEvent {
  return {
    streamPath: "/projects/prj_test/codemode-sessions/cblk_test",
    type: args.type,
    payload: args.payload,
    offset: args.offset ?? 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
