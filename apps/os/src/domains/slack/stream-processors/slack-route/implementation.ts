// Implements the "slack-route" processor (contract.ts) — the thread router
// that used to be the bespoke SlackProcessor on /integrations/slack, now a
// provider-specific processor on the account stream consuming the generic
// capture envelope. Routing semantics, idempotency keys, and the forwarded
// wire format are unchanged, so the slack-agent pipeline downstream is
// untouched.

import { z } from "zod";
import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import {
  assertNever,
  buildProcessorIdempotencyKey,
} from "@iterate-com/streams/shared/stream-processors";
import type { StreamEventInput } from "@iterate-com/streams/shared/event";
import { SlackRouteProcessorContract, type SlackRouteProcessorState } from "./contract.ts";
import { DEFAULT_INTEGRATION_ACCOUNT } from "~/domains/integrations/integration-events.ts";
export { SlackRouteProcessorContract } from "./contract.ts";

export type SlackRouteProcessorContract = typeof SlackRouteProcessorContract;

export type SlackRouteProcessorDeps = {
  /** Events that must land on a routed stream before the first forwarded
   * Slack webhook (subscriptions, agent bootstrap). Host-supplied. */
  createRoutedStreamBootstrapEvents?(input: {
    channel: string;
    streamPath: string;
    threadTs: string;
  }): Promise<StreamEventInput[]> | StreamEventInput[];
  /** Acknowledge a routed webhook to Slack (the 👀 reaction) as soon as the
   * router decides — best-effort, never affects routing. */
  acknowledgeRoutedWebhook?(input: { payload: unknown }): Promise<void> | void;
  /** Pre-warm the Durable Objects that will subscribe to a newly routed
   * stream, concurrently with its bootstrap append. Best-effort. */
  prewarmRoutedStreamHosts?(input: { streamPath: string }): Promise<void> | void;
};

export class SlackRouteProcessor extends StreamProcessor<
  SlackRouteProcessorContract,
  SlackRouteProcessorDeps
> {
  readonly contract = SlackRouteProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<SlackRouteProcessorContract>["reduce"]>[0],
  ): SlackRouteProcessorState {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/slack/thread-route-configured":
        return {
          ...state,
          routes: {
            ...state.routes,
            [`${event.payload.channel}:${event.payload.threadTs}`]: event.payload.streamPath,
          },
        };
      case "events.iterate.com/integration/event-received":
        return state;
      default:
        return assertNever(event);
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<SlackRouteProcessorContract>["processEvent"]>[0],
  ): void {
    const { event, state } = args;
    if (event.type !== "events.iterate.com/integration/event-received") return;

    /**
     * The router deliberately does not decide whether a Slack webhook is
     * meaningful to the agent. Its only job: can this webhook be keyed as
     * `channel:thread_ts`, and have we already learned where that thread
     * should be forwarded?
     */
    const slackBody = event.payload.body;
    // Thread streams nest under the ACCOUNT (stamped by the ingress router
    // on forward), so any number of connected workspaces coexist:
    // /agents/slack/{account}/{channel}/ts-{ts}.
    const account = event.payload.account ?? DEFAULT_INTEGRATION_ACCOUNT;
    const route = slackRouteFromWebhookBody(slackBody, account);
    if (route == null) return;

    const streamPath = state.routes[route.key] ?? route.streamPath;
    if (streamPath == null) return;

    // The forwarded payload keeps the LEGACY wire shape ({ body }) so the
    // slack-agent processor downstream is byte-compatible.
    const forwardedPayload = { body: slackBody as Record<string, unknown> };

    // Independent of the forwarding appends so the user-visible ack races
    // ahead of (possibly cold) stream creation rather than behind it.
    args.runInBackground(async () => {
      await this.deps.acknowledgeRoutedWebhook?.({ payload: forwardedPayload });
    });

    const forwardedWebhookEvent: StreamEventInput = {
      type: "events.iterate.com/slack/webhook-received",
      idempotencyKey: buildProcessorIdempotencyKey({
        processor: this.contract,
        key: "forward-slack-webhook",
        sourceEvent: event,
      }),
      payload: forwardedPayload,
    };

    if (state.routes[route.key] == null && route.canCreateRoute) {
      const routeEvent: StreamEventInput = {
        type: "events.iterate.com/slack/thread-route-configured",
        idempotencyKey: `slack-route:${route.key}`,
        payload: {
          channel: route.channel,
          threadTs: route.threadTs,
          streamPath,
        },
      };
      args.runInBackground(async () => {
        await this.deps.prewarmRoutedStreamHosts?.({ streamPath });
      });
      args.runInBackground(async () => {
        await this.ctx.stream.append({ event: routeEvent });
        await this.ctx.stream.appendBatch({
          streamPath,
          events: [
            ...((await this.deps.createRoutedStreamBootstrapEvents?.({
              channel: route.channel,
              streamPath,
              threadTs: route.threadTs,
            })) ?? []),
            routeEvent,
            forwardedWebhookEvent,
          ],
        });
      });
      return;
    }

    args.runInBackground(async () => {
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

function slackRouteFromWebhookBody(body: unknown, account: string): SlackRoute | null {
  const parsed = z
    .object({
      type: z.literal("event_callback"),
      event: z.record(z.string(), z.unknown()),
    })
    .loose()
    .safeParse(body);
  if (parsed.success) {
    return slackRouteFromEvent(parsed.data.event, account);
  }
  return slackRouteFromInteraction(body, account);
}

function slackRouteFromEvent(
  slackEvent: Record<string, unknown>,
  account: string,
): SlackRoute | null {
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
    account,
    canCreateRoute: true,
    channel: slackEvent.channel,
    threadTs: slackThreadTs,
  });
}

function slackRouteFromInteraction(body: unknown, account: string): SlackRoute | null {
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
    account,
    canCreateRoute: true,
    channel,
    threadTs,
  });
}

function routeFromChannelAndThread(input: {
  account: string;
  canCreateRoute: boolean;
  channel: string;
  threadTs: string;
}): SlackRoute {
  return {
    canCreateRoute: input.canCreateRoute,
    channel: input.channel,
    key: `${input.channel}:${input.threadTs}`,
    streamPath: `/agents/slack/${sanitizePathPart(input.account)}/${sanitizePathPart(input.channel)}/ts-${sanitizePathPart(input.threadTs)}`,
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
