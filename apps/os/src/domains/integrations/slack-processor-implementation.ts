// Implements the "slack" webhook-router processor on itx.
//
// Behavioral reference: the pre-migration slack processor (git history).
// Emitted event types, payloads, and idempotency keys are stable wire formats.

import { z } from "zod";
import { StreamProcessor } from "../streams/stream-processor.ts";
import type { EmittedInput } from "../streams/processor-contracts.ts";
import {
  agentCreationForPath,
  slackAgentSystemPrompt,
  SLACK_AGENT_SYSTEM_PROMPT_REVISION,
} from "../agents/agent-defaults.ts";
import { SlackAgentProcessorContract } from "./slack-agent-processor-contract.ts";
import { readRecord, readString, slackThreadStreamPath, webhookAckIsFresh } from "./utils.ts";
import { SlackProcessorContract, type SlackProcessorState } from "./slack-processor-contract.ts";

type SlackProcessorDeps = {
  /**
   * Acknowledge a routed webhook to the source platform (the 👀 reaction) as
   * soon as the router has decided where it goes, instead of waiting for the
   * routed stream's own processors to wake — several Durable Object cold
   * starts later on a fresh thread. The host owns filtering (which webhooks
   * deserve an ack) and delivery; the router only reports "this webhook is
   * being forwarded". Best-effort: failures must not affect routing.
   */
  acknowledgeRoutedWebhook?(input: { connection: string; payload: unknown }): Promise<void> | void;
  /** Injectable clock for the acknowledgement freshness gate. */
  now?: () => number;
};

export class SlackProcessor extends StreamProcessor<SlackProcessorContract, SlackProcessorDeps> {
  readonly contract = SlackProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<SlackProcessorContract>["reduce"]>[0]): SlackProcessorState {
    switch (event.type) {
      case "events.iterate.com/slack/created":
        if (state.birthCertificate !== null) {
          throw new Error("Slack processor received more than one slack/created event");
        }
        return { ...state, birthCertificate: event.payload };
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
        return state;
    }
  }

  protected override processEvent({
    append,
    appendTo,
    blockProcessorWhile,
    event,
    runInBackground,
    state,
  }: Parameters<StreamProcessor<SlackProcessorContract>["processEvent"]>[0]): undefined {
    // Event-less at-head pass: this processor has no at-head work.
    if (event === null) return;
    if (event.type === "events.iterate.com/slack/created") return;
    const connection = state.birthCertificate?.config.connection;
    if (connection === undefined) return;
    if (event.type !== "events.iterate.com/slack/webhook-received") return;

    /**
     * The router deliberately does not decide whether a Slack webhook is
     * meaningful to the agent. Its only job is to ask: can this webhook
     * be keyed as `channel:thread_ts`, and have we already learned where
     * that Slack thread should be forwarded? The named connection (from the
     * host DO's own name) qualifies newly created thread paths.
     */
    const route = slackRouteFromWebhookBody(event.payload.body, connection);
    if (route == null) return;

    const streamPath = state.routes[route.key] ?? route.streamPath;
    if (streamPath == null) return;

    // Independent of the forwarding appends below so the user-visible ack
    // races ahead of (possibly cold) stream creation rather than behind it.
    // Fresh webhooks only: a refold or late wake replays historical webhooks,
    // and re-acking those would resurrect 👀 on old messages, one Slack call
    // per journaled webhook (see WEBHOOK_ACK_FRESHNESS_MS). The forwards below
    // deliberately have no such gate — they are durable, idempotency-keyed
    // obligations whose replays dedupe at the append layer.
    if (webhookAckIsFresh(event, (this.deps.now ?? Date.now)())) {
      runInBackground(async () => {
        await this.deps.acknowledgeRoutedWebhook?.({ connection, payload: event.payload });
      });
    }

    const forwardedWebhookEvent = {
      type: "events.iterate.com/slack/webhook-received" as const,
      idempotencyKey: this.idempotencyKey("forward-webhook", event),
      payload: event.payload,
    };

    if (state.routes[route.key] == null && route.canCreateRoute) {
      /**
       * The route event stays on `/integrations/slack`. It is router state:
       * "when a future Slack webhook gives us this same Slack thread key,
       * forward it to this stream path."
       */
      const routeEvent = {
        type: "events.iterate.com/slack/thread-route-configured" as const,
        idempotencyKey: `slack-route:${route.key}`,
        payload: {
          channel: route.channel,
          threadTs: route.threadTs,
          streamPath,
        },
      };
      // Durable obligation, NOT best-effort: this forward is the only copy of
      // the Slack message on its way to the agent. Run it under
      // `blockProcessorWhile` so a failed append holds the checkpoint and the
      // host replays this webhook until it lands (see the 2026-06-15 prd
      // outage: a fire-and-forget forward threw once and the message was lost
      // before the agent). Every append carries an idempotency key derived
      // from the source event, so the replay dedupes instead of
      // double-forwarding.
      blockProcessorWhile(async () => {
        await append(routeEvent);
        if (this.projectId === null) {
          throw new Error("Slack router cannot create a project agent without a project id");
        }
        await appendTo(
          streamPath,
          ...slackAgentCreationEvents({
            channel: route.channel,
            connection,
            path: streamPath,
            projectId: this.projectId,
            threadTs: route.threadTs,
          }),
          routeEvent,
          forwardedWebhookEvent,
        );
      });
      return;
    }

    /**
     * The routed stream receives the original Slack webhook unchanged.
     * The downstream `slack-agent` processor owns interpretation: it can
     * turn messages, app mentions, reactions, edits, or future Slack event
     * shapes into agent context without this router needing to understand
     * agent semantics.
     */
    // Durable obligation — same reasoning as the route-creation forward above.
    blockProcessorWhile(async () => {
      await appendTo(streamPath, forwardedWebhookEvent);
    });
  }
}

function slackAgentCreationEvents(input: {
  channel: string;
  connection: string;
  path: string;
  projectId: string;
  threadTs: string;
}): EmittedInput<SlackProcessorContract>[] {
  const creation = agentCreationForPath({
    agentPath: input.path,
    projectId: input.projectId,
    platformSystemPrompt: {
      content: slackAgentSystemPrompt(input.connection),
      id: "slack",
      revision: SLACK_AGENT_SYSTEM_PROMPT_REVISION,
    },
    sibling: {
      birthCertificate: SlackAgentProcessorContract.buildEvent({
        type: "events.iterate.com/slack-agent/created",
        idempotencyKey: `slack-agent/created:${input.projectId}:${input.path}`,
        payload: {
          config: {
            channel: input.channel,
            connection: input.connection,
            threadTs: input.threadTs,
          },
        },
      }),
      processorSlug: SlackAgentProcessorContract.slug,
    },
  });
  return creation.events satisfies EmittedInput<SlackProcessorContract>[];
}

type SlackRoute = {
  canCreateRoute: boolean;
  channel: string;
  key: string;
  streamPath?: string;
  threadTs: string;
};

function slackRouteFromWebhookBody(body: unknown, connection: string): SlackRoute | null {
  const parsed = z
    .object({
      type: z.literal("event_callback"),
      event: z.record(z.string(), z.unknown()),
    })
    .loose()
    .safeParse(body);
  if (parsed.success) {
    return slackRouteFromEvent(parsed.data.event, connection);
  }

  return slackRouteFromInteraction(body, connection);
}

function slackRouteFromEvent(
  slackEvent: Record<string, unknown>,
  connection: string,
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
    canCreateRoute: true,
    channel: slackEvent.channel,
    connection,
    threadTs: slackThreadTs,
  });
}

function slackRouteFromInteraction(body: unknown, connection: string): SlackRoute | null {
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
    connection,
    threadTs,
  });
}

function routeFromChannelAndThread(input: {
  canCreateRoute: boolean;
  channel: string;
  connection: string;
  threadTs: string;
}): SlackRoute {
  return {
    canCreateRoute: input.canCreateRoute,
    channel: input.channel,
    key: `${input.channel}:${input.threadTs}`,
    streamPath: slackThreadStreamPath({
      channel: input.channel,
      connection: input.connection,
      threadTs: input.threadTs,
    }),
    threadTs: input.threadTs,
  };
}
