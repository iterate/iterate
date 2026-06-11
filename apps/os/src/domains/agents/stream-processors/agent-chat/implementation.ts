// Implements the "agent-chat" processor as a class-based StreamProcessor.
//
// The chat surfaces append raw chat-domain events; this processor transcribes
// them into Agent input rows.
//
// Appended event types, payload shapes, and idempotency-key derivations
// (`agent-chat/<key>@<sourceOffset>`) are stable wire formats — changing them
// breaks dedup against events already committed to streams.

import {
  assertNever,
  buildProcessorIdempotencyKey,
} from "@iterate-com/streams/shared/stream-processors";
import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import { AgentChatProcessorContract, type AgentChatChannel } from "./contract.ts";

export { AgentChatProcessorContract } from "./contract.ts";

export type AgentChatProcessorContract = typeof AgentChatProcessorContract;

export class AgentChatProcessor extends StreamProcessor<AgentChatProcessorContract> {
  readonly contract = AgentChatProcessorContract;

  protected override processEvent(
    args: Parameters<StreamProcessor<AgentChatProcessorContract>["processEvent"]>[0],
  ): void {
    const { event } = args;
    switch (event.type) {
      case "events.iterate.com/agent-chat/user-message-added":
        // Blocking: a dropped rewrite is a lost user message, so the checkpoint
        // must not advance past a failed append.
        args.blockProcessorWhile(async () => {
          await this.#appendEventTypeExplanation({ eventType: event.type });
          await this.ctx.stream.append({
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
        });
        return;
      case "events.iterate.com/agent-chat/assistant-response-added":
        args.blockProcessorWhile(async () => {
          await this.#appendEventTypeExplanation({ eventType: event.type });
          await this.ctx.stream.append({
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
                llmRequestPolicy: { behaviour: "dont-trigger-request" },
              },
            },
          });
        });
        return;
      default:
        return assertNever(event);
    }
  }

  async #appendEventTypeExplanation(args: { eventType: string }) {
    await this.ctx.stream.append({
      event: {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: buildProcessorIdempotencyKey({
          processor: AgentChatProcessorContract,
          key: `event-type-explainer/${args.eventType}`,
        }),
        payload: {
          content: eventTypeExplanation(args.eventType),
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
    });
  }
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
    `  ${args.bodyTag}: |-`,
    ...args.body.split("\n").map((line) => `    ${line}`),
  ];
  return ["```yaml", ...yamlLines, "```"].join("\n");
}

function yamlScalar(value: string): string {
  if (/^[a-zA-Z0-9._/@:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
