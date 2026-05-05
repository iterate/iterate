import type { SlackEvent } from "@slack/types";
import { z } from "zod";
import { buildDerivedIdempotencyKey, implementProcessor } from "../stream-processor.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { SlackProcessorContract } from "./contract.ts";

export function createSlackProcessor() {
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
          const parsed = z
            .object({
              type: z.literal("event_callback"),
              event: z.record(z.string(), z.unknown()),
            })
            .loose()
            .safeParse(event.payload.body);
          if (!parsed.success) return;

          const slackEvent = parsed.data.event as unknown as SlackEvent;
          let routeKey: string | undefined;
          let routeChannel: string | undefined;
          let routeThreadTs: string | undefined;
          let routeStreamPath: string | undefined;

          /**
           * Reaction webhooks put the referenced message under `item`. That
           * `item.ts` is the message timestamp, so it can be used to look up an
           * existing route for reactions on root Slack messages that already
           * started an agent thread.
           *
           * Example:
           *
           * ```json
           * {
           *   "event": {
           *     "type": "reaction_added",
           *     "item": { "type": "message", "channel": "C123", "ts": "1772136258.963519" }
           *   }
           * }
           * ```
           *
           * We do not create new routes from reaction payloads because Slack
           * does not tell us the parent thread when the reaction is on a reply.
           */
          if (
            "item" in slackEvent &&
            typeof slackEvent.item === "object" &&
            slackEvent.item != null &&
            "channel" in slackEvent.item &&
            typeof slackEvent.item.channel === "string" &&
            "ts" in slackEvent.item &&
            typeof slackEvent.item.ts === "string"
          ) {
            routeKey = `${slackEvent.item.channel}:${slackEvent.item.ts}`;
          }

          /**
           * Message-like Slack webhooks usually carry `channel` and either
           * `thread_ts` or `ts` at the top level. Some Slack update events wrap
           * the actual message in `message`, so prefer `message.thread_ts` when
           * Slack gives it to us.
           *
           * Example root message:
           *
           * ```json
           * {
           *   "event": {
           *     "type": "message",
           *     "channel": "C123",
           *     "ts": "1772136258.963519",
           *     "text": "hello"
           *   }
           * }
           * ```
           *
           * Example thread reply:
           *
           * ```json
           * {
           *   "event": {
           *     "type": "message",
           *     "channel": "C123",
           *     "thread_ts": "1772136258.963519",
           *     "ts": "1772136260.000000"
           *   }
           * }
           * ```
           *
           * This stays structural on purpose: adding a new Slack webhook type
           * should not require teaching this processor a new `case` if Slack
           * already provides the same channel/thread coordinates.
           */
          if (
            routeKey == null &&
            "channel" in slackEvent &&
            typeof slackEvent.channel === "string"
          ) {
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
            if (slackThreadTs != null) {
              routeKey = `${slackEvent.channel}:${slackThreadTs}`;
              routeChannel = slackEvent.channel;
              routeThreadTs = slackThreadTs;
              routeStreamPath = `/agents/slack/ts-${slackThreadTs.replaceAll(".", "-")}`;
            }
          }

          if (routeKey == null) return;
          const streamPath = state.routes[routeKey] ?? routeStreamPath;
          if (streamPath == null) return;

          /**
           * The route event stays on `/slack/webhooks`. It is router state:
           * "when a future Slack webhook gives us this same Slack thread key,
           * forward it to this stream path." The destination stream only needs
           * the raw Slack webhook, because `slack-thread` transcribes from the
           * Slack event body itself.
           */
          if (state.routes[routeKey] == null && routeChannel != null && routeThreadTs != null) {
            await streamApi.append({
              event: {
                type: "events.iterate.com/slack/thread-route-configured",
                idempotencyKey: `slack-thread-route:${routeKey}`,
                payload: {
                  channel: routeChannel,
                  threadTs: routeThreadTs,
                  streamPath,
                },
              },
            });
          }

          /**
           * The routed stream receives the original Slack webhook unchanged.
           * The downstream `slack-thread` processor owns interpretation: it can
           * turn messages, app mentions, reactions, edits, or future Slack event
           * shapes into agent input without this router needing to understand
           * agent semantics.
           */
          await streamApi.append({
            streamPath,
            event: {
              type: "events.iterate.com/slack/webhook-received",
              idempotencyKey: buildDerivedIdempotencyKey({
                slug: SlackProcessorContract.slug,
                purpose: "forward-slack-webhook",
                event,
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
