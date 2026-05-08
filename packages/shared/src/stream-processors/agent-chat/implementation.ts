import {
  assertNever,
  buildProcessorIdempotencyKey,
  implementProcessor,
  type ProcessorStreamApi,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { AgentChatProcessorContract, type AgentChatChannel } from "./contract.ts";

type AgentChatStreamApi = ProcessorStreamApi<typeof AgentChatProcessorContract>;

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

    async afterAppend({ event, state, streamApi }) {
      await standardProcessorBehavior.afterAppend({
        contract: AgentChatProcessorContract,
        state,
        streamApi,
      });

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
          return;
        case "events.iterate.com/agent-chat/user-message-added":
          await appendEventTypeExplanation({ eventType: event.type, streamApi });
          await streamApi.append({
            event: {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: AgentChatProcessorContract,
                key: "render-message",
                sourceEvent: event,
              }),
              payload: {
                content: eventBlock({
                  offset: event.offset,
                  type: event.type,
                  channel: event.payload.channel,
                  bodyTag: "content",
                  body: event.payload.content,
                }),
              },
            },
          });
          return;
        case "events.iterate.com/agent-chat/assistant-response-added":
          await appendEventTypeExplanation({ eventType: event.type, streamApi });
          await streamApi.append({
            event: {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: AgentChatProcessorContract,
                key: "render-response",
                sourceEvent: event,
              }),
              payload: {
                content: eventBlock({
                  offset: event.offset,
                  type: event.type,
                  channel: event.payload.channel,
                  bodyTag: "message",
                  body: event.payload.message,
                }),
                triggerLlmRequest: { behaviour: "dont-trigger-request" },
              },
            },
          });
          return;
        default:
          return assertNever(event);
      }
    },
  });
}

async function appendEventTypeExplanation(args: {
  streamApi: AgentChatStreamApi;
  eventType: string;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: AgentChatProcessorContract,
        key: `event-type-explainer/${args.eventType}`,
      }),
      payload: {
        content: eventTypeExplanation(args.eventType),
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    },
  });
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
