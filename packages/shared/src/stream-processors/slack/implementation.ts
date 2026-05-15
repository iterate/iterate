import type { SlackEvent } from "@slack/types";
import { z } from "zod";
import {
  buildProcessorIdempotencyKey,
  implementProcessor,
  type EmittedInput,
} from "../stream-processor.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { SlackProcessorContract } from "./contract.ts";

export type SlackProcessorDeps = {
  createRoutedStreamBootstrapEvents?(input: {
    channel: string;
    streamPath: string;
    threadTs: string;
  }): EmittedInput<typeof SlackProcessorContract>[];
};

export function createSlackProcessor(deps: SlackProcessorDeps = {}) {
  return implementProcessor(SlackProcessorContract, {
    async afterAppend({ event, state, streamApi }) {
      await standardProcessorBehavior.afterAppend({
        contract: SlackProcessorContract,
        state,
        streamApi,
      });

      switch (event.type) {
        case "events.iterate.com/slack/webhook-received": {
          /**
           * The router deliberately does not decide whether a Slack webhook is
           * meaningful to the agent. Its only job is to ask: can this webhook
           * be keyed as `channel:thread_ts`, and have we already learned where
           * that Slack thread should be forwarded?
           */
          const route = slackRouteFromWebhookBody(event.payload.body);
          if (route == null) return;

          const streamPath = state.routes[route.key] ?? route.streamPath;
          if (streamPath == null) return;

          /**
           * The route event stays on `/integrations/slack`. It is router state:
           * "when a future Slack webhook gives us this same Slack thread key,
           * forward it to this stream path."
           */
          if (state.routes[route.key] == null && route.canCreateRoute) {
            const routeEvent: EmittedInput<typeof SlackProcessorContract> = {
              type: "events.iterate.com/slack/thread-route-configured",
              idempotencyKey: `slack-route:${route.key}`,
              payload: {
                channel: route.channel,
                threadTs: route.threadTs,
                streamPath,
              },
            };
            const forwardedWebhookEvent: EmittedInput<typeof SlackProcessorContract> = {
              type: "events.iterate.com/slack/webhook-received",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: SlackProcessorContract,
                key: "forward-slack-webhook",
                sourceEvent: event,
              }),
              payload: event.payload,
            };

            await streamApi.append({ event: routeEvent });
            await streamApi.appendBatch({
              streamPath,
              events: [
                ...(deps.createRoutedStreamBootstrapEvents?.({
                  channel: route.channel,
                  streamPath,
                  threadTs: route.threadTs,
                }) ?? []),
                routeEvent,
                forwardedWebhookEvent,
              ],
            });
            return;
          }

          /**
           * The routed stream receives the original Slack webhook unchanged.
           * The downstream `slack-agent` processor owns interpretation: it can
           * turn messages, app mentions, reactions, edits, or future Slack event
           * shapes into agent input without this router needing to understand
           * agent semantics.
           */
          await streamApi.append({
            streamPath,
            event: {
              type: "events.iterate.com/slack/webhook-received",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: SlackProcessorContract,
                key: "forward-slack-webhook",
                sourceEvent: event,
              }),
              payload: event.payload,
            },
          });
          return;
        }
        default:
          return;
      }
    },
  });
}

type SlackRoute = {
  canCreateRoute: boolean;
  channel: string;
  key: string;
  streamPath?: string;
  threadTs: string;
};

function slackRouteFromWebhookBody(body: unknown): SlackRoute | null {
  const parsed = z
    .object({
      type: z.literal("event_callback"),
      event: z.record(z.string(), z.unknown()),
    })
    .loose()
    .safeParse(body);
  if (parsed.success) {
    return slackRouteFromEvent(parsed.data.event as unknown as SlackEvent);
  }

  return slackRouteFromInteraction(body);
}

function slackRouteFromEvent(slackEvent: SlackEvent): SlackRoute | null {
  if (
    "item" in slackEvent &&
    typeof slackEvent.item === "object" &&
    slackEvent.item != null &&
    "channel" in slackEvent.item &&
    typeof slackEvent.item.channel === "string" &&
    "ts" in slackEvent.item &&
    typeof slackEvent.item.ts === "string"
  ) {
    return {
      canCreateRoute: false,
      channel: slackEvent.item.channel,
      key: `${slackEvent.item.channel}:${slackEvent.item.ts}`,
      threadTs: slackEvent.item.ts,
    };
  }

  if (!("channel" in slackEvent) || typeof slackEvent.channel !== "string") return null;

  let slackThreadTs: string | undefined;
  if (
    "message" in slackEvent &&
    typeof slackEvent.message === "object" &&
    slackEvent.message != null &&
    "thread_ts" in slackEvent.message &&
    typeof slackEvent.message.thread_ts === "string"
  ) {
    slackThreadTs = slackEvent.message.thread_ts;
  }
  if (
    slackThreadTs == null &&
    "thread_ts" in slackEvent &&
    typeof slackEvent.thread_ts === "string"
  ) {
    slackThreadTs = slackEvent.thread_ts;
  }
  if (slackThreadTs == null && "ts" in slackEvent && typeof slackEvent.ts === "string") {
    slackThreadTs = slackEvent.ts;
  }
  if (slackThreadTs == null) return null;

  return routeFromChannelAndThread({
    canCreateRoute: true,
    channel: slackEvent.channel,
    threadTs: slackThreadTs,
  });
}

function slackRouteFromInteraction(body: unknown): SlackRoute | null {
  const interaction = readRecord(body);
  if (interaction == null) return null;

  const channel = readString(readRecord(interaction.channel)?.id);
  const message = readRecord(interaction.message);
  const container = readRecord(interaction.container);
  const threadTs =
    readString(message?.thread_ts) ??
    readString(container?.thread_ts) ??
    readString(message?.ts) ??
    readString(container?.message_ts);
  if (channel == null || threadTs == null) return null;

  return routeFromChannelAndThread({
    canCreateRoute: true,
    channel,
    threadTs,
  });
}

function routeFromChannelAndThread(input: {
  canCreateRoute: boolean;
  channel: string;
  threadTs: string;
}): SlackRoute {
  return {
    canCreateRoute: input.canCreateRoute,
    channel: input.channel,
    key: `${input.channel}:${input.threadTs}`,
    streamPath: `/agents/slack/${sanitizePathPart(input.channel)}/ts-${sanitizePathPart(input.threadTs)}`,
    threadTs: input.threadTs,
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sanitizePathPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}
