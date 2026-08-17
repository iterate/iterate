import { z } from "zod";
import { StreamProcessor } from "iterate/processors";
import type { EmittedInput, ProcessEventArgs, ReduceArgs } from "iterate/processors";
import {
  agentCreationForPath,
  slackAgentSystemPrompt,
  SLACK_AGENT_SYSTEM_PROMPT_REVISION,
} from "../agents/agent-defaults.ts";
import { SlackAgentProcessorContract } from "./slack-agent-processor-contract.ts";
import { readRecord, readString, slackThreadStreamPath, webhookAckIsFresh } from "./utils.ts";
import { SlackProcessorContract, type SlackProcessorState } from "./slack-processor-contract.ts";

/**
 * The Slack webhook ROUTER, mounted on `/integrations/slack/{connection}`.
 *
 * HOW IT WORKS, end to end:
 *
 * The webhook door appends every raw Slack Events API callback to this stream
 * as `slack/webhook-received`. The router deliberately does not decide whether
 * a webhook is meaningful to an agent. Its only question is: can this webhook
 * be keyed as `channel:thread_ts`, and have we already learned where that
 * Slack thread forwards? The pure `reduce` keeps exactly that lookup table
 * (`state.routes`), built from `slack/thread-route-configured` facts on this
 * same stream.
 *
 * On a routable webhook whose thread has no route yet, `processEvent` births
 * the routed agent stream explicitly — agent + capability host + slack-agent
 * facet birth certificates, their subscriptions, and the Slack system prompt —
 * then appends the route fact here AND forwards the original webhook, all
 * before the cursor moves. On a webhook whose thread is already routed, only
 * the forward happens. The forwards are DURABLE OBLIGATIONS under
 * `blockProcessorWhile` (see the 2026-06-15 prd outage: a fire-and-forget
 * forward threw once and the only copy of the message was lost before the
 * agent); every append carries an idempotency key derived from the source
 * event, so a redelivery dedupes instead of double-forwarding.
 *
 * Alongside the durable lane runs one best-effort lane: as soon as the router
 * has decided a webhook is being forwarded, it asks the host to acknowledge it
 * to Slack (the fast 👀 reaction) via `acknowledgeRoutedWebhook` — so the
 * user-visible ack races ahead of (possibly cold) stream creation instead of
 * behind it. The ack is FRESHNESS-GATED (`webhookAckIsFresh`): a full replay
 * of this stream re-runs `processEvent` over historical webhooks, and
 * re-acking those would resurrect 👀 on old messages, one Slack call per
 * recorded webhook. The forwards need no such gate — their replays dedupe at
 * the append layer.
 *
 * The downstream `slack-agent` processor owns interpretation: it turns
 * messages, app mentions, reactions, edits, or future Slack event shapes into
 * agent context without this router understanding agent semantics.
 */
export class SlackProcessor extends StreamProcessor<SlackProcessorContract, SlackProcessorDeps> {
  readonly contract = SlackProcessorContract;

  protected override processEvent(args: ProcessEventArgs<SlackProcessorContract>): undefined {
    const { event, state, append, appendTo, blockProcessorWhile, runInBackground } = args;
    switch (event?.type) {
      case "events.iterate.com/slack/webhook-received": {
        const connection = state.birthCertificate?.config.connection;
        if (connection === undefined) return; // unborn: nothing routes yet
        const route = slackRouteFromWebhookBody(event.payload.body, connection);
        if (route === null) return; // not keyable as channel:thread_ts — not ours to forward
        const streamPath = state.routes[route.key] ?? route.streamPath;
        if (streamPath == null) return; // item-keyed (reaction etc.) with no learned route

        // Best-effort fast ack, independent of the forwarding appends below so
        // the user-visible 👀 races ahead of (possibly cold) stream creation
        // rather than behind it. Fresh webhooks only — a replay of historical
        // webhooks must not resurrect reactions on old messages (see the class
        // docstring; WEBHOOK_ACK_FRESHNESS_MS in integrations/utils.ts).
        if (webhookAckIsFresh(event, this.#now())) {
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
          // First contact with this thread: record the route here AND birth
          // the routed stream with [creation batch, route, webhook]. The
          // route event stays on `/integrations/slack/{connection}` — it is
          // router state: "when a future webhook gives us this same thread
          // key, forward it to this stream path."
          const routeEvent = {
            type: "events.iterate.com/slack/thread-route-configured" as const,
            idempotencyKey: `slack-route:${route.key}`,
            payload: {
              channel: route.channel,
              threadTs: route.threadTs,
              streamPath,
            },
          };
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

        // Known route: forward the original webhook unchanged.
        blockProcessorWhile(async () => {
          await appendTo(streamPath, forwardedWebhookEvent);
        });
        return;
      }
      // slack/created and slack/thread-route-configured matter only through
      // the reduction below; they have no per-event side effect.
    }
  }

  protected override reduce({
    event,
    state,
  }: ReduceArgs<SlackProcessorContract>): SlackProcessorState {
    switch (event.type) {
      case "events.iterate.com/slack/created":
        if (state.birthCertificate !== null) return state;
        return { ...state, birthCertificate: event.payload };
      case "events.iterate.com/slack/thread-route-configured":
        return {
          ...state,
          routes: {
            ...state.routes,
            [`${event.payload.channel}:${event.payload.threadTs}`]: event.payload.streamPath,
          },
        };
      default:
        // slack/webhook-received: consumed for its processEvent turn only.
        return state;
    }
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

// -----------------------------------------------------------------------------
// Injected dependencies.
// -----------------------------------------------------------------------------

type SlackProcessorDeps = {
  /**
   * Acknowledge a routed webhook to Slack (the fast 👀 reaction) as soon as
   * the router has decided where it goes, instead of waiting for the routed
   * stream's own processors to wake — several Durable Object cold starts
   * later on a fresh thread. The host owns filtering (which webhooks deserve
   * an ack) and delivery; the router only reports "this webhook is being
   * forwarded". Best-effort: failures must not affect routing.
   */
  acknowledgeRoutedWebhook?(input: { connection: string; payload: unknown }): Promise<void> | void;
  /** Injectable clock for the acknowledgement freshness gate. */
  now?: () => number;
};

// -----------------------------------------------------------------------------
// Pure helpers.
// -----------------------------------------------------------------------------

/** The complete creation batch for a fresh routed thread stream: agent +
 * capability host + slack-agent facet births, their subscriptions, the Slack
 * system prompt, and the typed thread binding. Every event's idempotency key
 * derives from stable coordinates (project, path, revision), so replayed
 * creations dedupe. */
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
    initialEvents: [
      {
        type: "events.iterate.com/agent/binding-set",
        idempotencyKey: `agent/binding:${input.projectId}:${input.path}`,
        payload: {
          type: "slack_thread",
          connection: input.connection,
          channelId: input.channel,
          threadTs: input.threadTs,
        },
      },
    ],
    systemPromptPolicy: {
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
      name: SlackAgentProcessorContract.slug,
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

/** Key a raw Slack callback body as `channel:thread_ts`, or null when the
 * body carries no thread coordinates (url_verification, member joins, …). */
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
  // Item-keyed events (reactions) name the message they are ABOUT. They can
  // forward to an existing route but must never create one: a reaction on an
  // unrouted message says nothing about wanting an agent there.
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

/** Interactivity payloads (block_actions, view submissions) carry their
 * thread coordinates on the message/container instead of an event record. */
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
