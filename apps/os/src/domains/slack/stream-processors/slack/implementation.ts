// Implements the "slack" webhook-router processor.
//
// Emitted event types, payloads, and idempotency keys are stable wire formats
// — changing them breaks dedup against events already committed to streams.

import { z } from "zod";
import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import {
  assertNever,
  buildProcessorIdempotencyKey,
} from "@iterate-com/streams/shared/stream-processors";
import type { StreamEventInput } from "@iterate-com/streams/shared/event";
import { SlackProcessorContract, type SlackProcessorState } from "./contract.ts";
export { SlackProcessorContract } from "./contract.ts";

export type SlackProcessorContract = typeof SlackProcessorContract;

export type SlackProcessorDeps = {
  /**
   * Acknowledge a routed webhook to the source platform (e.g. the 👀
   * reaction) as soon as the router has decided where it goes, instead of
   * waiting for the routed stream's own processors to wake — several Durable
   * Object cold starts later on a fresh thread. The host owns filtering
   * (which webhooks deserve an ack) and delivery; the router only reports
   * "this webhook is being forwarded". Best-effort: failures must not affect
   * routing.
   */
  acknowledgeRoutedWebhook?(input: { payload: unknown }): Promise<void> | void;
  /**
   * Pre-warm the Durable Objects that will subscribe to a newly routed
   * stream, concurrently with the bootstrap append that creates it. Without
   * this the chain is serial: thread stream cold start, then its dial wakes
   * the slack-agent host, then the agent host — each a fresh isolate.
   * Best-effort: the subscription dial remains the source of truth.
   */
  prewarmRoutedStreamHosts?(input: { streamPath: string }): Promise<void> | void;
};

export class SlackProcessor extends StreamProcessor<SlackProcessorContract, SlackProcessorDeps> {
  readonly contract = SlackProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<SlackProcessorContract>["reduce"]>[0],
  ): SlackProcessorState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/slack/connected":
        return {
          ...state,
          connection: {
            status: "connected" as const,
            connectionId: event.payload.connectionId,
            externalId: event.payload.externalId,
            ...(event.payload.teamId == null ? {} : { teamId: event.payload.teamId }),
            ...(event.payload.teamName == null ? {} : { teamName: event.payload.teamName }),
          },
        };
      case "events.iterate.com/slack/disconnected":
        return {
          ...state,
          connection: {
            status: "disconnected" as const,
            ...(event.payload.connectionId == null
              ? {}
              : { connectionId: event.payload.connectionId }),
            ...(event.payload.externalId == null ? {} : { externalId: event.payload.externalId }),
            ...(event.payload.teamId == null ? {} : { teamId: event.payload.teamId }),
            ...(event.payload.teamName == null ? {} : { teamName: event.payload.teamName }),
          },
        };
      case "events.iterate.com/slack/thread-route-configured":
        return {
          ...state,
          routes: {
            ...state.routes,
            [`${event.payload.channel}:${event.payload.threadTs}`]: event.payload.streamPath,
          },
        };
      case "events.iterate.com/slack/webhook-received":
        return state;
      default:
        return assertNever(event);
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<SlackProcessorContract>["processEvent"]>[0],
  ): void {
    const { event, state } = args;
    if (event.type !== "events.iterate.com/slack/webhook-received") return;

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

    // Independent of the forwarding appends below so the user-visible ack
    // races ahead of (possibly cold) stream creation rather than behind it.
    args.runInBackground(async () => {
      await this.deps.acknowledgeRoutedWebhook?.({ payload: event.payload });
    });

    const forwardedWebhookEvent: StreamEventInput = {
      type: "events.iterate.com/slack/webhook-received",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: this.contract,
        key: "forward-slack-webhook",
        sourceEvent: event,
      }),
      payload: event.payload,
    };

    if (state.routes[route.key] == null && route.canCreateRoute) {
      /**
       * The route event stays on `/integrations/slack`. It is router state:
       * "when a future Slack webhook gives us this same Slack thread key,
       * forward it to this stream path."
       */
      const routeEvent: StreamEventInput = {
        type: "events.iterate.com/slack/thread-route-configured",
        idempotencyKey: `slack-route:${route.key}`,
        payload: {
          channel: route.channel,
          threadTs: route.threadTs,
          streamPath,
        },
      };
      // The hosts that will subscribe to the new stream cold-start in
      // parallel with its creation instead of serially after its first dial.
      args.runInBackground(async () => {
        await this.deps.prewarmRoutedStreamHosts?.({ streamPath });
      });
      // Durable obligation, NOT best-effort: this forward is the only copy of
      // the Slack message on its way to the agent. Run it under
      // `blockProcessorWhile` so a failed append holds the checkpoint and the
      // host replays this webhook until it lands. `runInBackground` would
      // swallow the error, advance the checkpoint, and silently drop the
      // message — which is exactly the prd outage of 2026-06-15: the first
      // message on a freshly-created project hit a cold cross-worker
      // StreamsCapability RPC that threw after ~4s, the forward was dropped, and
      // the agent never saw it (the thread stream was created by the prewarm
      // below but never received the webhook). The ack/prewarm above stay
      // best-effort and remain on `runInBackground`.
      //
      // Every append carries an idempotency key derived from the source event,
      // so the replay dedupes instead of double-forwarding.
      args.blockProcessorWhile(async () => {
        await this.ctx.stream.append({ event: routeEvent });
        await this.ctx.stream.appendBatch({
          streamPath,
          events: [routeEvent, forwardedWebhookEvent],
        });
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
    // Durable obligation — same reasoning as the route-creation forward above.
    // Block the checkpoint so a failed append replays the webhook instead of
    // dropping it; the idempotency key makes the replay a no-op if it landed.
    args.blockProcessorWhile(async () => {
      await this.ctx.stream.append({ streamPath, event: forwardedWebhookEvent });
    });
  }
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
    return slackRouteFromEvent(parsed.data.event);
  }

  return slackRouteFromInteraction(body);
}

function slackRouteFromEvent(slackEvent: Record<string, unknown>): SlackRoute | null {
  const item = readRecord(slackEvent.item);
  if (item != null && typeof item.channel === "string" && typeof item.ts === "string") {
    return {
      canCreateRoute: false,
      channel: item.channel,
      key: `${item.channel}:${item.ts}`,
      threadTs: item.ts,
    };
  }

  if (typeof slackEvent.channel !== "string") return null;

  const message = readRecord(slackEvent.message);
  let slackThreadTs: string | undefined;
  if (message != null && typeof message.thread_ts === "string") {
    slackThreadTs = message.thread_ts;
  }
  if (slackThreadTs == null && typeof slackEvent.thread_ts === "string") {
    slackThreadTs = slackEvent.thread_ts;
  }
  if (slackThreadTs == null && typeof slackEvent.ts === "string") {
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
