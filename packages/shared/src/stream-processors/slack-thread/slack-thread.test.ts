import { describe, expect, it } from "vitest";
import type { AppMentionEvent } from "@slack/types";
import {
  getInitialProcessorState,
  type ConsumedEvent,
  type ProcessorState,
  type ProcessorStreamApi,
  type StreamEvent,
  type StreamEventInput,
} from "../stream-processor.ts";
import { SlackThreadProcessorContract } from "./contract.ts";
import { createSlackThreadProcessor } from "./implementation.ts";

describe("createSlackThreadProcessor", () => {
  it("has no custom reduced state", () => {
    expect(getInitialProcessorState(SlackThreadProcessorContract)).toEqual({});
  });

  it("transcribes routed Slack mention webhooks into one agent input", async () => {
    const appended: Array<{ streamPath?: string; event: StreamEventInput }> = [];
    await createSlackThreadProcessor().implementation.afterAppend?.({
      event: threadEvent({
        offset: 10,
        type: "events.iterate.com/slack/webhook-received",
        payload: {
          body: {
            type: "event_callback",
            authorizations: [{ user_id: "U_BOT", is_bot: true }],
            event: {
              type: "app_mention",
              channel: "C123",
              user: "U_USER",
              ts: "1772136258.963519",
              event_ts: "1772136258.963519",
              text: "<@U_BOT> ship it",
            } satisfies AppMentionEvent,
          },
        },
      }),
      previousState: registeredSlackThreadState(),
      state: registeredSlackThreadState(),
      streamApi: testSlackThreadStreamApi(appended),
      signal: new AbortController().signal,
    });

    expect(appended.map((item) => item.event.type)).toEqual([
      "events.iterate.com/agent/input-added",
    ]);
    expect(appended[0].event.payload).toEqual({
      content: expect.stringContaining('"text": "<@U_BOT> ship it"'),
    });
  });
});

function registeredSlackThreadState(): ProcessorState<typeof SlackThreadProcessorContract> {
  return getInitialProcessorState(SlackThreadProcessorContract);
}

function testSlackThreadStreamApi(
  appended: Array<{ streamPath?: string; event: StreamEventInput }>,
): ProcessorStreamApi<typeof SlackThreadProcessorContract> {
  return testStreamApi(appended) as ProcessorStreamApi<typeof SlackThreadProcessorContract>;
}

function testStreamApi(appended: Array<{ streamPath?: string; event: StreamEventInput }>) {
  return {
    append: async ({ event, streamPath }: { event: StreamEventInput; streamPath?: string }) => {
      appended.push({ event, streamPath });
      return committedEvent(event, streamPath);
    },
    read: async () => [],
    subscribe: async function* () {},
  };
}

function threadEvent<T extends ConsumedEvent<typeof SlackThreadProcessorContract>>(args: {
  type: T["type"];
  payload: T["payload"];
  offset: number;
}) {
  return committedEvent(args, "/agents/slack/ts-1772136258-963519") as T;
}

function committedEvent(
  args: { type: string; payload: unknown; idempotencyKey?: string; offset?: number },
  streamPath = "/agents/slack/ts-1772136258-963519",
): StreamEvent {
  return {
    streamPath,
    type: args.type,
    payload: args.payload,
    idempotencyKey: args.idempotencyKey,
    offset: args.offset ?? 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
