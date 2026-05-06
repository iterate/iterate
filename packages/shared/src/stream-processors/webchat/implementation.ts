import {
  assertNever,
  buildDerivedIdempotencyKey,
  implementProcessor,
  type ProcessorStreamApi,
} from "../stream-processor.ts";
import { CoreProcessorRegisteredEventType } from "../core/contract.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { WebchatProcessorContract } from "./contract.ts";

type WebchatStreamApi = ProcessorStreamApi<typeof WebchatProcessorContract>;

/**
 * Backend implementation for the webchat processor.
 *
 * This processor has no runtime dependencies today. It owns webchat-specific
 * raw events and renders them into ordinary Agent input rows. That keeps the
 * Agent processor focused on LLM scheduling over curated model context.
 */
export function createWebchatProcessor() {
  return implementProcessor(WebchatProcessorContract, {
    firstAttachAfterAppend: { mode: "lookback", milliseconds: 60_000 },

    async afterAppend({ event, state, streamApi }) {
      await standardProcessorBehavior.afterAppend({
        contract: WebchatProcessorContract,
        state,
        streamApi,
      });

      switch (event.type) {
        case CoreProcessorRegisteredEventType:
          return;
        case "events.iterate.com/webchat/user-message-added":
          await appendEventTypeExplanation({ eventType: event.type, streamApi });
          await streamApi.append({
            event: {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: buildDerivedIdempotencyKey({
                slug: WebchatProcessorContract.slug,
                purpose: "render-message",
                event,
              }),
              payload: {
                content: eventBlock({
                  offset: event.offset,
                  type: event.type,
                  bodyTag: "content",
                  body: event.payload.content,
                }),
              },
            },
          });
          return;
        case "events.iterate.com/webchat/agent-response-added":
          await appendEventTypeExplanation({ eventType: event.type, streamApi });
          await streamApi.append({
            event: {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: buildDerivedIdempotencyKey({
                slug: WebchatProcessorContract.slug,
                purpose: "render-response",
                event,
              }),
              payload: {
                content: eventBlock({
                  offset: event.offset,
                  type: event.type,
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
  streamApi: WebchatStreamApi;
  eventType: string;
}) {
  await args.streamApi.append({
    event: {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: `stream-processor:${WebchatProcessorContract.slug}:event-type-explainer:${args.eventType}`,
      payload: {
        content: eventTypeExplanation(args.eventType),
        triggerLlmRequest: { behaviour: "dont-trigger-request" },
      },
    },
  });
}

function eventTypeExplanation(eventType: string): string {
  if (eventType === "events.iterate.com/webchat/user-message-added") {
    return eventTypeExplanationBlock({
      type: eventType,
      meaning: "This represents a message received from the webchat user.",
    });
  }

  return eventTypeExplanationBlock({
    type: eventType,
    meaning:
      "This represents a message sent by codemode through `webchat.sendMessage({ message })`.",
  });
}

function eventTypeExplanationBlock(args: { type: string; meaning: string }): string {
  return `First \`${args.type}\` event. ${args.meaning}`;
}

function eventBlock(args: { offset: number; type: string; bodyTag: string; body: string }): string {
  const yamlLines = [
    "event:",
    `  offset: ${args.offset}`,
    `  type: ${yamlScalar(args.type)}`,
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
