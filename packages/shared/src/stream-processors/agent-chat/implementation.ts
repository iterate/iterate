import {
  assertNever,
  buildProcessorIdempotencyKey,
  implementProcessor,
  type ProcessorStreamApi,
} from "../stream-processor.ts";
import {
  CoreProcessorErrorOccurredEventType,
  CoreProcessorRegisteredEventType,
} from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { AgentChatProcessorContract, type AgentChatChannel } from "./contract.ts";

type AgentChatStreamApi = ProcessorStreamApi<typeof AgentChatProcessorContract>;
type AgentChatAppendInput = Parameters<
  NonNullable<AgentChatStreamApi["appendBatch"]>
>[0]["events"][number];

/**
 * Backend implementation for the agent-chat processor.
 *
 * The chat surfaces append raw chat-domain events; this processor transcribes
 * them into Agent input rows. A future terminal app could itself run as a
 * processor that watches stream state and appends `agent-chat` events, but the
 * current TUI stays a direct event producer.
 */
export function createAgentChatProcessor() {
  return implementProcessor(AgentChatProcessorContract, {
    firstAttachAfterAppend: { mode: "lookback", milliseconds: 60_000 },

    async afterAppend({ event, previousState, state, streamApi, waitUntil }) {
      await standardProcessorBehavior.afterAppend({
        contract: AgentChatProcessorContract,
        state,
        streamApi,
      });

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
          return;
        case "events.iterate.com/agent-chat/user-message-added":
          await scheduleAgentInputEvents({
            streamApi,
            events: buildAgentInputEventsForChatEvent({
              event,
              hasAlreadyExplained: previousState.explainedEventTypes.includes(event.type),
            }),
            sourceOffset: event.offset,
            waitUntil,
          });
          return;
        case "events.iterate.com/agent-chat/assistant-response-added":
          await scheduleAgentInputEvents({
            streamApi,
            events: buildAgentInputEventsForChatEvent({
              event,
              hasAlreadyExplained: previousState.explainedEventTypes.includes(event.type),
            }),
            sourceOffset: event.offset,
            waitUntil,
          });
          return;
        default:
          return assertNever(event);
      }
    },

    async afterAppendBatch({ reductions, streamApi, waitUntil }) {
      const state = reductions.at(-1)?.state;
      if (state != null) {
        await standardProcessorBehavior.afterAppend({
          contract: AgentChatProcessorContract,
          state,
          streamApi,
        });
      }

      const events = reductions.flatMap((reduction) => {
        switch (reduction.event.type) {
          case CoreProcessorRegisteredEventType:
            return [];
          case "events.iterate.com/agent-chat/user-message-added":
          case "events.iterate.com/agent-chat/assistant-response-added":
            return buildAgentInputEventsForChatEvent({
              event: reduction.event,
              hasAlreadyExplained: reduction.previousState.explainedEventTypes.includes(
                reduction.event.type,
              ),
            });
          default:
            return assertNever(reduction.event);
        }
      });
      if (events.length > 0) {
        await scheduleAgentInputEvents({
          streamApi,
          events,
          sourceOffset: reductions.at(-1)!.event.offset,
          waitUntil,
        });
      }
    },
  });
}

async function scheduleAgentInputEvents(args: {
  streamApi: AgentChatStreamApi;
  events: AgentChatAppendInput[];
  sourceOffset: number;
  waitUntil?: (promise: Promise<unknown>) => void;
}) {
  const promise = appendAgentInputEvents({
    events: args.events,
    streamApi: args.streamApi,
  }).catch(
    async (error) =>
      await appendAgentChatTranscriptionError({
        error,
        sourceOffset: args.sourceOffset,
        streamApi: args.streamApi,
      }),
  );

  if (args.waitUntil == null) {
    await promise;
    return;
  }

  args.waitUntil(promise);
}

async function appendAgentInputEvents(args: {
  streamApi: AgentChatStreamApi;
  events: AgentChatAppendInput[];
}) {
  if (args.streamApi.appendBatch != null) {
    await args.streamApi.appendBatch({ events: args.events });
    return;
  }

  for (const event of args.events) {
    await args.streamApi.append({ event });
  }
}

async function appendAgentChatTranscriptionError(args: {
  error: unknown;
  sourceOffset: number;
  streamApi: AgentChatStreamApi;
}) {
  await args.streamApi.append({
    event: {
      type: CoreProcessorErrorOccurredEventType,
      idempotencyKey: `agent-chat/transcription-error@${args.sourceOffset}`,
      payload: {
        message: `agent-chat failed to append derived agent input events for offset ${args.sourceOffset}: ${errorMessage(args.error)}`,
        error: serializeError(args.error),
      },
    },
  });
}

function serializeError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function buildAgentInputEventsForChatEvent(args: {
  event:
    | {
        offset: number;
        type: "events.iterate.com/agent-chat/user-message-added";
        payload: { channel: AgentChatChannel; content: string };
      }
    | {
        offset: number;
        type: "events.iterate.com/agent-chat/assistant-response-added";
        payload: { channel: AgentChatChannel; message: string };
      };
  hasAlreadyExplained: boolean;
}): AgentChatAppendInput[] {
  const events: AgentChatAppendInput[] = [];
  const explanation = buildEventTypeExplanation({
    eventType: args.event.type,
    hasAlreadyExplained: args.hasAlreadyExplained,
  });
  if (explanation != null) {
    events.push(explanation);
  }

  if (args.event.type === "events.iterate.com/agent-chat/user-message-added") {
    events.push({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: AgentChatProcessorContract,
        key: "render-message",
        sourceEvent: args.event,
      }),
      payload: {
        content: eventBlock({
          offset: args.event.offset,
          type: args.event.type,
          channel: args.event.payload.channel,
          bodyTag: "content",
          body: args.event.payload.content,
        }),
      },
    });
  } else {
    events.push({
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: AgentChatProcessorContract,
        key: "render-response",
        sourceEvent: args.event,
      }),
      payload: {
        content: eventBlock({
          offset: args.event.offset,
          type: args.event.type,
          channel: args.event.payload.channel,
          bodyTag: "message",
          body: args.event.payload.message,
        }),
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    });
  }

  return events;
}

function buildEventTypeExplanation(args: {
  hasAlreadyExplained: boolean;
  eventType: string;
}): AgentChatAppendInput | null {
  if (args.hasAlreadyExplained) return null;

  return {
    type: "events.iterate.com/agent/input-added",
    idempotencyKey: buildProcessorIdempotencyKey({
      processor: AgentChatProcessorContract,
      key: `event-type-explainer/${args.eventType}`,
    }),
    payload: {
      content: eventTypeExplanation(args.eventType),
      triggerLlmRequest: { behaviour: "dont-trigger-request" },
    },
  };
}

function eventTypeExplanation(eventType: string): string {
  if (eventType === "events.iterate.com/agent-chat/user-message-added") {
    return "First `events.iterate.com/agent-chat/user-message-added` event. This represents a message received from a chat user.";
  }

  return "First `events.iterate.com/agent-chat/assistant-response-added` event. This represents a message sent by codemode through a chat response tool.";
}

function eventBlock(args: {
  offset: number;
  type: string;
  channel: AgentChatChannel;
  bodyTag: string;
  body: string;
}): string {
  const yamlLines = [
    "event:",
    `  offset: ${args.offset}`,
    `  type: ${yamlScalar(args.type)}`,
    `  channel: ${yamlScalar(args.channel)}`,
    ...yamlBlockScalar(args.bodyTag, args.body),
  ];
  return ["```yaml", ...yamlLines, "```"].join("\n");
}

function yamlScalar(value: string): string {
  if (/^[a-zA-Z0-9._/@:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function yamlBlockScalar(key: string, value: string): string[] {
  return [`  ${key}: |-`, ...value.split("\n").map((line) => `    ${line}`)];
}
