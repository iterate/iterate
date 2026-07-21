import {
  isAgentRuntimeZero,
  ZERO_AGENT_RUNTIME,
  type AgentRuntime,
} from "@iterate-com/shared/agent-events";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import { DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS } from "../capability-host/capability-host-processor-contract.ts";
import type {
  AgentFileAttachment,
  AgentRuntimeTransition,
} from "../agents/agent-processor-contract.ts";
import { applyAgentSummaryUpdate, deriveAgentDisplayState } from "../agents/agent-presence.ts";
import { readRecord, readString, webhookAckIsFresh } from "./utils.ts";
import {
  SlackAgentProcessorContract,
  type SlackAgentProcessorState,
} from "./slack-agent-processor-contract.ts";

/**
 * The "slack-agent" processor: the Slack FACET on one routed agent stream
 * (`/agents/slack/{connection}/{channel}/ts-{threadTs}`).
 *
 * HOW IT WORKS, end to end:
 *
 * The upstream `slack` router has already forwarded raw Slack webhooks to
 * this stream. The pure `reduce` keeps the thread's coordinates (channel,
 * thread ts, conversation type), our bot's identity (learned from webhook
 * authorizations, so the agent never wakes itself), the mention-activation
 * flag, the message currently wearing our 👀 reaction, and the agent's
 * canonical summary (reduced from `agent/summary-updated` patches).
 *
 * `processEvent` owns the Slack-specific consequences, one lane per
 * guarantee:
 *
 * - TRANSCRIPTION (durable, `blockProcessorWhile`): every forwarded webhook
 *   is transcribed into `agents/context-added` — the webhook's only path into
 *   agent context, so a dropped append would lose the message silently. LLM
 *   turns are mention-gated: a human must @mention the bot (or Slack must
 *   deliver `app_mention`) before a transcription triggers a turn; after that
 *   activation, later thread messages also wake the agent so multi-turn work
 *   does not require re-mentioning. Unmentioned pre-activation traffic is
 *   transcribed as `dont-trigger-request` history — a later mention has
 *   thread context without spending model tokens early. Files shared on a
 *   message are materialized into project file storage FIRST so the context
 *   item carries the attachments; a failed download can be permanent (Slack
 *   tombstones files), so the message goes through WITH an explicit loss note
 *   instead of wedging the frame.
 *
 * - BANG COMMANDS (durable, `blockProcessorWhile`): a `!command` message
 *   compiles straight into a `capability-host/script-run-requested` instead
 *   of agent context — explicit commands are directed at the bot even without
 *   an @mention. The request body is deterministic (expiry anchored to the
 *   webhook's createdAt, never `now`), so an at-least-once redelivery
 *   re-appends the identical event and dedupes on its idempotency key.
 *
 * - ACKNOWLEDGEMENT (best-effort, freshness-gated): the 👀 reaction says
 *   "your message was just picked up", so only fresh webhooks earn one
 *   (`webhookAckIsFresh`) — a full replay of the stream re-runs processEvent
 *   over historical webhooks and must not resurrect reactions on old
 *   messages. The reaction rides the SAME blocking closure as the append it
 *   acknowledges, AFTER it, so receipt is never signalled for a message that
 *   failed to commit.
 *
 * - PRESENCE PAINT (best-effort, latest-fact-wins, `runInBackground`):
 *   summary facts and the platform revival fact are memoized per delivery
 *   and painted ONCE per at-head pass (`delivery.caughtUp`) from the
 *   complete reduced state — a droppable attempt, so a hanging Slack call
 *   never head-of-line-blocks the durable lanes above. The paints: the
 *   thread title via `assistant.threads.setTitle` (durable current-state
 *   paint, repainted by a fresh incarnation), the activity text via the
 *   transient thread status (freshness-gated). A revival clears presentation
 *   a dead incarnation left behind. Known idempotent Slack outcomes
 *   (`already_reacted`, `no_reaction`) are quiet no-ops; unexpected cosmetic
 *   failures are reported once and settled so they can never wedge the
 *   durable message/agent pipeline.
 *
 * Alongside stream delivery, the HOST drives one extra presentation lane:
 * `presentRuntimeTransition` paints committed Agent-runner runtime
 * transitions (running code / waiting for model / …) onto the transient
 * status without appending anything — active work paints immediately, the
 * zero snapshot waits one second so an immediate handoff cannot flash an
 * idle status.
 */
export class SlackAgentProcessor extends StreamProcessor<
  SlackAgentProcessorContract,
  SlackAgentProcessorDeps
> {
  readonly contract = SlackAgentProcessorContract;

  // ------------------------------------------------------------ in-memory paint memos
  // Runtime state: dies with the isolate, never persisted. A fresh incarnation
  // starts blank and re-derives its paints from the reduced state (title) or
  // simply does not repeat them (freshness-gated status/reactions).

  /** Latest presence or revival fact deferred until an at-head repaint. */
  #unpaintedPresenceFact: { createdAt: string; type: string } | undefined;
  /** A revival occurred somewhere in the pending batch. Kept separately from
   * the latest fact because a following summary update must not hide the
   * obligation to clear a dead incarnation's Slack status. */
  #unpaintedRevival = false;
  /** A title patch or revival requires an at-head title repaint even when the
   * current title is absent: Slack clears a thread title by receiving the
   * same setTitle call with an empty title. */
  #titleRepaintDue = false;
  /** Exact transient status this incarnation attempted to paint. Written only
   * after the dependency settles, and used to dedupe runtime count transitions
   * that leave the human-readable activity unchanged. */
  #paintedActivityText: string | undefined;
  /** The title this incarnation painted, so repeated repaints of an unchanged
   * title cost no Slack calls. */
  #paintedTitle: string | undefined;

  // ------------------------------------------------------------ processEvent
  // One flat switch. Early exits inside the webhook case `break` (never
  // `return`), so the at-head repaint registration below the switch always
  // runs. The repaint reads only the reduced state and the paint memos, so
  // it does not depend on the frame's blockers having committed first.
  protected override processEvent(args: ProcessEventArgs<SlackAgentProcessorContract>): undefined {
    const { append, blockProcessorWhile, delivery, event, previousState, runInBackground, state } =
      args;
    const { birthCertificate } = state;
    if (birthCertificate === null) return;

    switch (event?.type) {
      case "events.iterate.com/agent/summary-updated": {
        // Presence facts are memoized here and painted once per at-head pass
        // (latest fact wins) instead of once per event.
        this.#unpaintedPresenceFact = event;
        if (Object.hasOwn(event.payload, "title")) this.#titleRepaintDue = true;
        break;
      }
      case "events.iterate.com/stream/processor-revived": {
        // The platform revival fact: its at-head pass also clears or restores
        // presentation left behind by the incarnation that died.
        this.#unpaintedPresenceFact = event;
        this.#unpaintedRevival = true;
        this.#titleRepaintDue = true;
        break;
      }
      case "events.iterate.com/slack/thread-route-configured": {
        // Route context is captured in reduce(). The integration contributes
        // only the typed external fact; title, activity, and summary belong to
        // the agent/human-authored summary event.
        const channel = event.payload.channel;
        const connection = birthCertificate.config.connection;
        blockProcessorWhile(async () => {
          const name = (await this.deps.fetchSlackChannelName?.({ channel, connection })) ?? null;
          await append({
            type: "events.iterate.com/agent/binding-set",
            idempotencyKey: this.idempotencyKey("binding"),
            payload: {
              type: "slack_thread",
              connection,
              channelId: channel,
              threadTs: event.payload.threadTs,
              ...(name === null ? {} : { channelName: name }),
            },
          });
        });
        break;
      }
      case "events.iterate.com/slack/webhook-received": {
        // The webhook transcribes into application-supplied developer
        // context; actor/refs retain its untrusted external provenance.
        // The sender is extracted here, once, wherever the payload shape
        // carries it (event_callback events vs interactivity payloads), so
        // button presses and reactions keep their sender too.
        const senderUserId = slackWebhookSenderUserId(event.payload.body);
        const appendAgentMessage = async (
          input: {
            /** Explicit trailing note (e.g. attachment loss) — data loss must
             * be visible in the transcription, never silent. */
            contentNote?: string;
            files?: AgentFileAttachment[];
            llmRequestPolicy?: { behaviour: "dont-trigger-request" };
          } = {},
        ) => {
          await append({
            type: "events.iterate.com/agents/context-added",
            idempotencyKey: this.idempotencyKey("webhook-to-agent-context", event),
            payload: {
              role: "developer",
              content:
                input.contentNote === undefined
                  ? slackWebhookAgentInput(event.payload)
                  : `${slackWebhookAgentInput(event.payload)}\n\n${input.contentNote}`,
              actor: {
                type: "slack",
                ...(senderUserId == null ? {} : { userId: senderUserId }),
              },
              refs: [
                {
                  type: "event",
                  streamPath: event.path,
                  offset: event.offset,
                  eventType: event.type,
                },
              ],
              ...(input.files == null || input.files.length === 0 ? {} : { files: input.files }),
              ...(input.llmRequestPolicy == null
                ? {}
                : { llmRequestPolicy: input.llmRequestPolicy }),
            },
          });
        };

        const parsed = z
          .object({
            type: z.literal("event_callback"),
            event: z.record(z.string(), z.unknown()),
          })
          .loose()
          .safeParse(event.payload.body);
        if (!parsed.success) {
          // Interactivity payloads (block_actions, …) and other non-event
          // shapes transcribe as-is, with the default triggering policy.
          blockProcessorWhile(async () => {
            await appendAgentMessage();
          });
          break;
        }

        const slackEvent = parsed.data.event;
        const target = slackAgentTargetFromWebhookPayload(event.payload);
        const botUserId = state.botUserId ?? botUserIdFromPayload(event.payload);
        const botBotId = state.botBotId ?? botBotIdFromPayload(event.payload);
        if (isOwnBotMessage(slackEvent, { botBotId, botUserId })) break;
        if (isBotAction(slackEvent, botUserId)) break;

        const eventType = readString(slackEvent.type);
        // `app_mention` is Slack's dedicated "someone mentioned this app"
        // delivery; treat it like a message for transcription + LLM wake.
        if (eventType !== "message" && eventType !== "app_mention") {
          blockProcessorWhile(async () => {
            await appendAgentMessage({
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            });
          });
          break;
        }

        const channel = target?.channel ?? state.channel ?? readString(slackEvent.channel);
        const threadTs =
          target?.threadTs ??
          state.threadTs ??
          readString(slackEvent.thread_ts) ??
          readString(readRecord(slackEvent.message)?.thread_ts) ??
          readString(slackEvent.ts);
        const messageText = readString(slackEvent.text)?.trim();
        const bangCommand = compileBangCommand({
          channel,
          connection: birthCertificate.config.connection,
          message: messageText,
          threadTs,
        });
        if (bangCommand != null) {
          // Explicit !commands are directed at the bot even without an
          // @mention.
          blockProcessorWhile(async () => {
            await append({
              type: "events.iterate.com/capability-host/script-run-requested",
              idempotencyKey: this.idempotencyKey("bang-command", event),
              payload: {
                code: bangCommand.code,
                executionId: `slack-bang-command-${event.offset}`,
                // Anchored to the webhook's createdAt, never `now`: an
                // at-least-once redelivery re-appends the IDENTICAL body and
                // dedupes on the key — a `now`-stamped expiry would make the
                // re-append a same-key conflict and wedge the frame forever.
                expiresAt: Date.parse(event.createdAt) + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
              },
            });
            await this.#replaceEyesReactionForMessageTarget(
              birthCertificate.config.connection,
              target,
              event,
              previousState.eyesReactionMessageTs,
            );
          });
          break;
        }

        // Cost gate: do not spend model tokens until someone @mentions us
        // (or Slack delivers app_mention). After that activation, later
        // messages in this thread also wake the agent so multi-turn work does
        // not require re-mentioning. Unmentioned pre-activation traffic is
        // still transcribed as non-triggering history.
        const mentioned =
          eventType === "app_mention" || slackTextMentionsBot(messageText, botUserId);
        const shouldTriggerLlm = mentioned || state.conversationActive;

        // Files shared on the message are materialized into project file
        // storage first so the input event carries the attachments. A failed
        // download can be PERMANENT (Slack tombstones files, tokens get
        // revoked), so throwing would wedge this frame forever; instead the
        // message goes through WITH an explicit loss note — never a silent
        // drop. Eyes only on mentions — follow-ups after activation wake the
        // agent without the 👀 noise.
        blockProcessorWhile(async () => {
          const sharedFiles = readSlackMessageFiles(slackEvent);
          let files: AgentFileAttachment[] | undefined;
          let attachmentFailureNote: string | undefined;
          if (sharedFiles.length > 0 && this.deps.storeSlackFiles != null) {
            try {
              files = await this.deps.storeSlackFiles({
                connection: birthCertificate.config.connection,
                files: sharedFiles,
                storageKey: `slack-${event.offset}`,
              });
            } catch (error) {
              console.error("[slack-agent] failed to store shared files", {
                count: sharedFiles.length,
                error,
              });
              attachmentFailureNote = `[${sharedFiles.length} attachment(s) could not be loaded: ${
                error instanceof Error ? error.message : String(error)
              }]`;
            }
          }
          await appendAgentMessage({
            ...(attachmentFailureNote === undefined ? {} : { contentNote: attachmentFailureNote }),
            ...(files == null ? {} : { files }),
            ...(shouldTriggerLlm
              ? {}
              : { llmRequestPolicy: { behaviour: "dont-trigger-request" as const } }),
          });
          if (mentioned) {
            await this.#replaceEyesReactionForMessageTarget(
              birthCertificate.config.connection,
              target,
              event,
              previousState.eyesReactionMessageTs,
            );
          }
        });
        break;
      }
      // slack-agent/created: existence marker, reduce-only.
    }

    // AT-HEAD repaint: `delivery.caughtUp` means `state` is the whole observed
    // reduction. It rides the last consumed event or the runner's eventless
    // pass. A droppable background attempt — a hanging Slack call must never
    // head-of-line-block transcription and sends. What recovers a dropped
    // attempt: the title repaints on the next at-head pass (the painted-title
    // memo dies with the incarnation, and a revival sets #titleRepaintDue);
    // a lost transient status costs seconds of stale indicator until the next
    // pass; a lost revival clear re-arms because dying while owing this
    // keepalive-backed work produces another revival fact.
    if (delivery.caughtUp) {
      runInBackground(() => this.#repaintPresence(args));
    }
  }

  // ------------------------------------------------------------------ reduce
  protected override reduce({
    event,
    state,
  }: ReduceArgs<SlackAgentProcessorContract>): SlackAgentProcessorState {
    switch (event.type) {
      case "events.iterate.com/slack-agent/created":
        if (state.birthCertificate !== null) return state;
        return {
          ...state,
          birthCertificate: event.payload,
          channel: event.payload.config.channel,
          threadTs: event.payload.config.threadTs,
        };
      case "events.iterate.com/agent/summary-updated": {
        const summary = applyAgentSummaryUpdate(state.summary, event.payload);
        return summary === state.summary ? state : { ...state, summary };
      }
      case "events.iterate.com/slack/thread-route-configured":
        return {
          ...state,
          channel: event.payload.channel,
          threadTs: event.payload.threadTs,
        };
      case "events.iterate.com/slack/webhook-received": {
        const target = slackAgentTargetFromWebhookPayload(event.payload);
        if (target == null) return state;
        const botUserId = state.botUserId ?? botUserIdFromPayload(event.payload);
        const botBotId = state.botBotId ?? botBotIdFromPayload(event.payload);
        const channelType = slackChannelTypeFromWebhookPayload(event.payload);
        const mentioned = slackWebhookMentionsOurBot(event.payload, botUserId);
        const getsEyesReaction =
          !target.isBotMessage &&
          !target.isReactionEvent &&
          target.messageTs !== undefined &&
          (mentioned ||
            slackWebhookCompilesBangCommand(
              event.payload,
              state.birthCertificate?.config.connection,
              target,
            ));
        return {
          ...state,
          ...(botBotId == null ? {} : { botBotId }),
          ...(botUserId == null ? {} : { botUserId }),
          channel: target.channel,
          ...(channelType == null ? {} : { channelType }),
          conversationActive: state.conversationActive || mentioned,
          ...(getsEyesReaction ? { eyesReactionMessageTs: target.messageTs } : {}),
          threadTs: target.threadTs,
        };
      }
      default:
        // stream/processor-revived: consumed only for its delivery turn.
        return state;
    }
  }

  // ------------------------------------------- host-driven runtime presentation

  #runtimePresentationGeneration = 0;
  #runtimeIdleTimer: ReturnType<typeof setTimeout> | undefined;
  #runtimePresentationChain = Promise.resolve();

  /**
   * Present a committed Agent-runner transition without appending it. Active
   * work paints immediately; zero waits until one second after the transition
   * so an immediate handoff cannot flash an idle status.
   */
  presentRuntimeTransition(
    state: SlackAgentProcessorState,
    transition: AgentRuntimeTransition,
  ): void {
    if (state.birthCertificate === null) return;
    const generation = ++this.#runtimePresentationGeneration;
    if (this.#runtimeIdleTimer !== undefined) {
      clearTimeout(this.#runtimeIdleTimer);
      this.#runtimeIdleTimer = undefined;
    }
    const present = () => {
      this.#runtimePresentationChain = this.#runtimePresentationChain
        .then(() => this.#paintRuntime(state, transition.runtime, generation))
        .catch((error) => {
          console.error("[slack-agent] runtime presentation failed", {
            error,
            path: this.path,
          });
        });
    };
    if (!isAgentRuntimeZero(transition.runtime)) {
      present();
      return;
    }
    // One second of hold-off before painting idle: long enough to absorb an
    // immediate work handoff (script settles, next LLM call starts), short
    // enough that a genuinely idle thread clears promptly.
    const delay = Math.max(0, Date.parse(transition.since) + 1_000 - this.#now());
    this.#runtimeIdleTimer = setTimeout(() => {
      this.#runtimeIdleTimer = undefined;
      present();
    }, delay);
  }

  disposeRuntimePresentation(): void {
    ++this.#runtimePresentationGeneration;
    if (this.#runtimeIdleTimer !== undefined) {
      clearTimeout(this.#runtimeIdleTimer);
      this.#runtimeIdleTimer = undefined;
    }
  }

  /** Test/host barrier for the currently queued presentation attempt. */
  waitForRuntimePresentation(): Promise<void> {
    return this.#runtimePresentationChain;
  }

  async #paintRuntime(
    state: SlackAgentProcessorState,
    runtime: AgentRuntime,
    generation: number,
  ): Promise<void> {
    if (generation !== this.#runtimePresentationGeneration || state.birthCertificate === null) {
      return;
    }
    const { channel, channelType, eyesReactionMessageTs, summary, threadTs } = state;
    if (channel == null || threadTs == null) return;
    const connection = state.birthCertificate.config.connection;
    const hasAssistantThreadUi = slackConversationHasAssistantThreadUi({
      channel,
      channelType,
    });
    const fallbackActivity = fallbackActivityForRuntime(runtime);

    if (fallbackActivity !== undefined) {
      if (!hasAssistantThreadUi || generation !== this.#runtimePresentationGeneration) return;
      await this.#paintActivityStatus({
        activity: summary.activity,
        channel,
        connection,
        fallbackActivity,
        threadTs,
      });
      return;
    }

    if (generation !== this.#runtimePresentationGeneration) return;
    if (this.#paintedActivityText === undefined && eyesReactionMessageTs == null) return;
    await this.#clearStatus({
      channel,
      connection,
      ...(eyesReactionMessageTs == null ? {} : { eyesReactionMessageTs }),
      hasAssistantThreadUi,
      threadTs,
    });
    if (generation === this.#runtimePresentationGeneration) {
      this.#paintedActivityText = undefined;
    }
  }

  // ------------------------------------------------------ Slack paint helpers

  async #paintActivityStatus(input: {
    activity: string | undefined;
    channel: string;
    connection: string;
    fallbackActivity: string;
    threadTs: string;
  }): Promise<void> {
    const paintedText = `${input.activity ?? input.fallbackActivity}…`;
    if (paintedText === this.#paintedActivityText) return;
    if (this.deps.callSlackApi == null) return;
    await this.#callSlackApi(input.connection, "assistant.threads.setStatus", {
      channel_id: input.channel,
      thread_ts: input.threadTs,
      status: paintedText,
      loading_messages: [paintedText],
    });
    // The memo records only a paint call this invocation actually made;
    // freshness and generation gates never write it on skipped work.
    this.#paintedActivityText = paintedText;
  }

  /**
   * Paint current summary/runtime once per at-head pass. Freshness gates only
   * additive transient status. A revival clears presentation left by a dead
   * incarnation; ordinary zero-runtime settlement belongs exclusively to
   * presentRuntimeTransition so its handoff debounce cannot be bypassed by an
   * unrelated summary delivery.
   */
  async #repaintPresence(args: ProcessEventArgs<SlackAgentProcessorContract>): Promise<void> {
    const latest = this.#unpaintedPresenceFact;
    const revival = this.#unpaintedRevival;
    const titleRepaint = this.#titleRepaintDue;
    this.#unpaintedPresenceFact = undefined;
    this.#unpaintedRevival = false;
    this.#titleRepaintDue = false;
    if (latest == null) return;
    if (args.state.birthCertificate === null) return;
    const connection = args.state.birthCertificate.config.connection;
    const { channel, channelType, eyesReactionMessageTs, summary, threadTs } = args.state;
    if (channel == null || threadTs == null) return;
    const fresh = webhookAckIsFresh(latest, this.#now());
    const hasAssistantThreadUi = slackConversationHasAssistantThreadUi({ channel, channelType });

    // A title is durable current-state paint, unlike Slack's transient status.
    // Paint it once from the complete at-head reduction, including explicit
    // clear patches and revival. The painted-title record is written after the
    // processor classifies the Slack outcome; an unexpected cosmetic failure
    // is reported once rather than retried forever.
    const title = summary.title;
    const slackTitle = title ?? "";
    if (
      hasAssistantThreadUi &&
      slackTitle !== this.#paintedTitle &&
      (title !== undefined || titleRepaint || this.#paintedTitle !== undefined)
    ) {
      await this.#callSlackApi(connection, "assistant.threads.setTitle", {
        channel_id: channel,
        thread_ts: threadTs,
        title: slackTitle,
      });
      this.#paintedTitle = slackTitle;
    }

    const fallbackActivity = fallbackActivityForRuntime(
      this.deps.getAgentRuntimeTransition?.()?.runtime ?? ZERO_AGENT_RUNTIME,
    );

    if (fallbackActivity !== undefined) {
      if (!fresh || !hasAssistantThreadUi) return;
      await this.#paintActivityStatus({
        activity: summary.activity,
        channel,
        connection,
        fallbackActivity,
        threadTs,
      });
      return;
    }

    if (!revival) return;
    await this.#clearStatus({
      channel,
      connection,
      ...(eyesReactionMessageTs == null ? {} : { eyesReactionMessageTs }),
      hasAssistantThreadUi,
      threadTs,
    });
    this.#paintedActivityText = undefined;
  }

  async #clearStatus(target: {
    channel: string;
    connection: string;
    eyesReactionMessageTs?: string;
    hasAssistantThreadUi: boolean;
    threadTs: string;
  }) {
    if (target.hasAssistantThreadUi) {
      await this.#callSlackApi(target.connection, "assistant.threads.setStatus", {
        channel_id: target.channel,
        thread_ts: target.threadTs,
        status: "",
      });
    }
    if (target.eyesReactionMessageTs != null) {
      await this.#callSlackApi(target.connection, "reactions.remove", {
        channel: target.channel,
        name: "eyes",
        timestamp: target.eyesReactionMessageTs,
      });
    }
  }

  /** Keep at most one outstanding 👀 per thread. The router may already have
   * fast-acked the new mention, so removing the previous target and adding the
   * new one are both deliberately idempotent. */
  async #replaceEyesReactionForMessageTarget(
    connection: string,
    target: SlackAgentTarget | null,
    event: { createdAt: string },
    previousMessageTs: string | undefined,
  ) {
    if (
      target == null ||
      target.isBotMessage ||
      target.isReactionEvent ||
      target.messageTs == null
    ) {
      return;
    }
    if (previousMessageTs != null && previousMessageTs !== target.messageTs) {
      await this.#callSlackApi(connection, "reactions.remove", {
        channel: target.channel,
        name: "eyes",
        timestamp: previousMessageTs,
      });
    }
    // The 👀 ack means "your message was just picked up" — only fresh
    // webhooks qualify for a new reaction. A stale replacement still removes
    // the old ack so it cannot survive forever.
    if (!webhookAckIsFresh(event, this.#now())) return;
    await this.#callSlackApi(connection, "reactions.add", {
      channel: target.channel,
      name: "eyes",
      timestamp: target.messageTs,
    });
  }

  /** The one Slack Web API door. Owns outcome classification: known
   * idempotent outcomes are quiet no-ops, unexpected failures are reported
   * once and settled — this is a cosmetic lane and must never wedge the
   * durable pipeline in a retry loop. */
  async #callSlackApi(connection: string, method: string, body: Record<string, unknown>) {
    if (body.timestamp == null && (method === "reactions.add" || method === "reactions.remove")) {
      return;
    }
    if (this.deps.callSlackApi == null) return;

    try {
      await this.deps.callSlackApi({ body, connection, method });
    } catch (error) {
      const slackErrorCode = readString(readRecord(error)?.slackErrorCode);
      if (
        method === "reactions.add" &&
        (slackErrorCode === "already_reacted" || slackErrorCode === "not_reactable")
      ) {
        return;
      }
      if (method === "reactions.remove" && slackErrorCode === "no_reaction") return;
      console.error("[slack-agent] Slack side effect failed", {
        error,
        method,
        path: this.path,
      });
    }
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

// -----------------------------------------------------------------------------
// Injected dependencies.
// -----------------------------------------------------------------------------

/** One file shared on a Slack message, as the webhook carries it. */
type SlackSharedFile = { mimetype?: string; name?: string; urlPrivate: string };

type SlackAgentProcessorDeps = {
  /** The Slack Web API transport for best-effort presentation calls
   * (reactions, thread status/title). The agent's actual replies go through
   * the itx Slack capability in its scripts, which fails loudly on its own. */
  callSlackApi?(input: {
    body: Record<string, unknown>;
    connection: string;
    method: string;
  }): Promise<void>;
  /** Resolves a channel id to its optional display name for the typed
   * binding. The production host returns null for every failed Slack lookup
   * so enrichment cannot block the binding; injected dependency failures
   * still reject the processor batch. */
  fetchSlackChannelName?(input: { channel: string; connection: string }): Promise<string | null>;
  /** Injectable clock for the acknowledgement freshness gates. */
  now?: () => number;
  /** The Agent runner's current runtime transition, read at repaint time so
   * the at-head status paint reflects actual in-flight work. */
  getAgentRuntimeTransition?(): AgentRuntimeTransition | undefined;
  /** Downloads Slack-shared files into project file storage (see
   * storeSlackFilesForAgent in slack-api.ts). `storageKey` is stable per
   * webhook event so replays overwrite instead of duplicating. */
  storeSlackFiles?(input: {
    connection: string;
    files: SlackSharedFile[];
    storageKey: string;
  }): Promise<AgentFileAttachment[]>;
};

// -----------------------------------------------------------------------------
// Pure helpers.
// -----------------------------------------------------------------------------

/** The factual status fallback for a runtime shape, used when the agent has
 * not authored an activity line of its own. Undefined = runtime is zero. */
function fallbackActivityForRuntime(runtime: AgentRuntime): string | undefined {
  const displayState = deriveAgentDisplayState(runtime);
  return displayState === "running_code"
    ? "Running code"
    : displayState === "waiting_for_model"
      ? "Waiting for the model"
      : displayState === "queued"
        ? "Preparing the next step"
        : undefined;
}

/**
 * The human sender of a slack webhook, wherever the payload shape carries
 * it: event_callback events (messages, reactions, joins) put it at
 * `event.user`; interactivity payloads (block_actions, view submissions)
 * at `user.id`. Undefined when the payload names no human (or is off-shape).
 */
function slackWebhookSenderUserId(body: unknown): string | undefined {
  const record = readRecord(body);
  if (record == null) return undefined;
  return (
    readString(readRecord(record.event)?.user) ??
    readString(readRecord(record.user)?.id) ??
    undefined
  );
}

/**
 * Envelope keys stripped from the model-facing transcript. `token` is
 * Slack's webhook VERIFICATION SECRET — dumping it re-sends the secret to
 * the LLM provider on every turn of every Slack agent. The rest is routing
 * plumbing (event ids, authorization lists, dedup context) that drowns the
 * message without telling the model anything actionable.
 */
const SLACK_ENVELOPE_NOISE = new Set([
  "token",
  "api_app_id",
  "authorizations",
  "authed_users",
  "authed_teams",
  "event_context",
  "context_team_id",
  "context_enterprise_id",
  "event_id",
  "event_time",
  "is_ext_shared_channel",
]);

/** Event keys stripped for the same reason: `blocks` is the rich-text AST of
 * the `text` field it sits next to (pure duplication at 10-50x the tokens);
 * the rest is client/team bookkeeping. */
const SLACK_EVENT_NOISE = new Set([
  "blocks",
  "client_msg_id",
  "source_team",
  "user_team",
  "team",
  "display_as_bot",
  "is_locked",
  "subscribed",
]);

/** Slack file objects carry dozens of thumbnail/preview fields; the model
 * needs identity and type — the bytes ride separately as itx.files
 * attachments on the same message. */
const SLACK_FILE_KEYS = ["id", "name", "title", "mimetype", "filetype", "size", "mode"] as const;

/**
 * The model-facing transcript of one Slack webhook: the event's facts,
 * curated rather than the raw wire payload (same posture as the email
 * door's transcriber). Curation is by removal, not a whitelist, so rare
 * event shapes (reactions, joins, interactivity payloads) keep their fields
 * instead of arriving empty.
 */
function slackWebhookAgentInput(payload: unknown) {
  return [
    "`events.iterate.com/slack/webhook-received` event received",
    "",
    "```yaml",
    stringifyYaml(curateSlackWebhookPayload(payload)).trimEnd(),
    "```",
  ].join("\n");
}

function curateSlackWebhookPayload(payload: unknown): unknown {
  const record = readRecord(payload);
  if (record == null) return payload;
  // headers are transport dedup facts (event id, request timestamp) — the
  // curated body already carries everything the model can act on.
  const { headers: _headers, ...envelope } = record;
  const body = readRecord(record.body);
  if (body == null) return envelope;
  const curatedBody: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (SLACK_ENVELOPE_NOISE.has(key)) continue;
    curatedBody[key] = key === "event" ? curateSlackEvent(value) : value;
  }
  return { ...envelope, body: curatedBody };
}

function curateSlackEvent(event: unknown): unknown {
  const record = readRecord(event);
  if (record == null) return event;
  const curated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SLACK_EVENT_NOISE.has(key)) continue;
    curated[key] = key === "files" && Array.isArray(value) ? value.map(curateSlackFile) : value;
  }
  return curated;
}

function curateSlackFile(file: unknown): unknown {
  const record = readRecord(file);
  if (record == null) return file;
  const curated: Record<string, unknown> = {};
  for (const key of SLACK_FILE_KEYS) {
    if (record[key] !== undefined) curated[key] = record[key];
  }
  return curated;
}

function isBotMessage(slackEvent: Record<string, unknown>): boolean {
  if (readString(slackEvent.subtype) === "bot_message") return true;
  if (readString(slackEvent.bot_id) != null) return true;
  if (readRecord(slackEvent.bot_profile) != null) return true;
  return false;
}

// Returns true only when the message came from our own bot. Slack's
// `authorizations` payload often carries the authorized bot `user_id` without a
// `bot_id`, so fall back to comparing the message's bot user identity before
// considering other bot messages safe to forward. If Slack gives us no
// comparable identity, treat the bot message as our own to avoid self-wake.
function isOwnBotMessage(
  slackEvent: Record<string, unknown>,
  identity: { botBotId: string | undefined; botUserId: string | undefined },
): boolean {
  if (!isBotMessage(slackEvent)) return false;

  let comparedIdentity = false;
  const msgBotId = readString(slackEvent.bot_id);
  if (identity.botBotId != null && msgBotId != null) {
    comparedIdentity = true;
    if (msgBotId === identity.botBotId) return true;
  }

  const msgUserId =
    readString(slackEvent.user) ?? readString(readRecord(slackEvent.bot_profile)?.user_id);
  if (identity.botUserId != null && msgUserId != null) {
    comparedIdentity = true;
    if (msgUserId === identity.botUserId) return true;
  }

  return !comparedIdentity;
}

/**
 * Returns true when the Slack event was performed by our own bot user (e.g.
 * our bot adding a reaction).
 */
function isBotAction(slackEvent: Record<string, unknown>, botUserId: string | undefined): boolean {
  if (botUserId == null) return false;
  return readString(slackEvent.user) === botUserId;
}

/** The `files` array on a Slack message event, reduced to what storage needs. */
function readSlackMessageFiles(slackEvent: Record<string, unknown>): SlackSharedFile[] {
  const files = slackEvent.files;
  if (!Array.isArray(files)) return [];
  const shared: SlackSharedFile[] = [];
  for (const file of files) {
    const record = readRecord(file);
    const urlPrivate = readString(record?.url_private);
    if (record == null || urlPrivate == null) continue;
    const mimetype = readString(record.mimetype);
    const name = readString(record.name);
    shared.push({
      ...(mimetype == null ? {} : { mimetype }),
      ...(name == null ? {} : { name }),
      urlPrivate,
    });
  }
  return shared;
}

export function compileBangCommand(input: {
  channel: string | undefined;
  /** The Slack connection recovered from the agent stream path; the debug
   * reply posts through it. */
  connection: string | null | undefined;
  message: string | undefined;
  threadTs: string | undefined;
}): { code: string } | null {
  if (!input.message) return null;
  const withoutMention = input.message.replace(/^<@[^>]+>\s*/i, "").trim();
  if (!withoutMention.startsWith("!")) return null;

  const rawCommand = withoutMention.slice(1).trim();
  if (!rawCommand) return null;

  if (rawCommand === "debug" || rawCommand === "debug()") {
    if (input.channel == null || input.threadTs == null || input.connection == null) return null;
    return {
      code: [
        "async (itx) => {",
        "  const debug = await itx.debug();",
        `  await itx.integrations.slack.get(${JSON.stringify(input.connection)}).chat.postMessage({`,
        `    channel: ${JSON.stringify(input.channel)},`,
        `    thread_ts: ${JSON.stringify(input.threadTs)},`,
        "    text: `Debug info:\\n${debug}`,",
        "  });",
        "}",
      ].join("\n"),
    };
  }

  let expression = rawCommand.startsWith("itx.")
    ? rawCommand
    : rawCommand.startsWith("ctx.")
      ? `itx.${rawCommand.slice(4)}`
      : `itx.${rawCommand}`;
  if (!expression.includes("(")) expression = `${expression}()`;

  const lines = ["async (itx) => {", `  await ${expression};`, "}"];
  return { code: lines.join("\n") };
}

type SlackAgentTarget = {
  channel: string;
  isBotMessage: boolean;
  isReactionEvent: boolean;
  messageTs?: string;
  threadTs: string;
};

function botUserIdFromPayload(payload: unknown): string | undefined {
  const body = readRecord(readRecord(payload)?.body);
  const authorizations = body?.authorizations;
  if (!Array.isArray(authorizations)) return undefined;
  const botAuth = authorizations.find(
    (auth) => readRecord(auth)?.is_bot === true && typeof readRecord(auth)?.user_id === "string",
  );
  return botAuth == null ? undefined : readString(readRecord(botAuth)?.user_id);
}

/** True when message text encodes a Slack user mention of our bot (`<@U…>`). */
function slackTextMentionsBot(text: string | undefined, botUserId: string | undefined): boolean {
  if (text == null || botUserId == null || botUserId.length === 0) return false;
  // Slack encodes mentions as <@U123> or <@U123|display name>.
  return text.includes(`<@${botUserId}>`) || text.includes(`<@${botUserId}|`);
}

/**
 * True when this webhook is an @mention of our bot: either Slack's
 * `app_mention` event type, or a `message` whose text contains `<@botUserId>`.
 */
function slackWebhookMentionsOurBot(payload: unknown, botUserId: string | undefined): boolean {
  const body = readRecord(readRecord(payload)?.body);
  const slackEvent = readRecord(body?.event);
  if (slackEvent == null) return false;
  if (readString(slackEvent.type) === "app_mention") return true;
  return slackTextMentionsBot(readString(slackEvent.text), botUserId);
}

function slackWebhookCompilesBangCommand(
  payload: unknown,
  connection: string | null | undefined,
  target: SlackAgentTarget,
): boolean {
  const body = readRecord(readRecord(payload)?.body);
  const slackEvent = readRecord(body?.event);
  if (slackEvent == null) return false;
  const eventType = readString(slackEvent.type);
  if (eventType !== "message" && eventType !== "app_mention") return false;
  return (
    compileBangCommand({
      channel: target.channel,
      connection,
      message: readString(slackEvent.text)?.trim(),
      threadTs: target.threadTs,
    }) !== null
  );
}

function botBotIdFromPayload(payload: unknown): string | undefined {
  const body = readRecord(readRecord(payload)?.body);
  const authorizations = body?.authorizations;
  if (!Array.isArray(authorizations)) return undefined;
  const botAuth = authorizations.find(
    (auth) => readRecord(auth)?.is_bot === true && typeof readRecord(auth)?.bot_id === "string",
  );
  return botAuth == null ? undefined : readString(readRecord(botAuth)?.bot_id);
}

function slackAgentTargetFromWebhookPayload(payload: unknown): SlackAgentTarget | null {
  const body = readRecord(readRecord(payload)?.body);
  const slackEvent = readRecord(body?.event);
  if (slackEvent == null) return null;

  const item = readRecord(slackEvent.item);
  const message = readRecord(slackEvent.message);
  const channel =
    readString(slackEvent.channel) ?? readString(item?.channel) ?? readString(message?.channel);
  const threadTs =
    readString(slackEvent.thread_ts) ??
    readString(message?.thread_ts) ??
    readString(slackEvent.ts) ??
    readString(item?.ts) ??
    readString(message?.ts);
  if (channel == null || threadTs == null) return null;

  const type = readString(slackEvent.type);
  const messageTs = readString(slackEvent.ts) ?? readString(message?.ts);
  return {
    channel,
    isBotMessage:
      readString(slackEvent.subtype) === "bot_message" ||
      readString(slackEvent.bot_id) != null ||
      readRecord(slackEvent.bot_profile) != null,
    isReactionEvent: type === "reaction_added" || type === "reaction_removed",
    ...(messageTs == null ? {} : { messageTs }),
    threadTs,
  };
}

function slackChannelTypeFromWebhookPayload(payload: unknown): string | undefined {
  const body = readRecord(readRecord(payload)?.body);
  return readString(readRecord(body?.event)?.channel_type) ?? undefined;
}

/** Slack's Assistant thread UI is available on app direct-message threads,
 * not ordinary channel mentions. Message webhooks name this as `im`; the `D`
 * fallback covers interactivity payloads and older events without
 * `channel_type` (Slack reserves D-prefixed conversation IDs for DMs). */
function slackConversationHasAssistantThreadUi(input: {
  channel: string;
  channelType?: string;
}): boolean {
  return input.channelType === "im" || (input.channelType == null && input.channel.startsWith("D"));
}

/**
 * Payload-only gate for the integration-level fast acknowledgement: the 👀
 * reaction added at the routing hop, before the routed thread stream and its
 * slack-agent host even exist. Mirrors `#replaceEyesReactionForMessageTarget`'s
 * gating using only what the webhook itself carries — bot-authored messages,
 * reaction events, actions performed by the authorized bot user, and messages
 * that do not @mention our bot are skipped. 👀 is a "we heard you" signal for
 * mention-activated turns only; ambient channel traffic must not get it. The
 * slack-agent processor still adds the same reaction once the routed stream
 * catches up; Slack's `already_reacted` makes the pair idempotent.
 */
export function eyesReactionTargetFromWebhookPayload(
  payload: unknown,
): { channel: string; timestamp: string } | null {
  const target = slackAgentTargetFromWebhookPayload(payload);
  if (target == null || target.isBotMessage || target.isReactionEvent) return null;
  if (target.messageTs == null) return null;
  const body = readRecord(readRecord(payload)?.body);
  const slackEvent = readRecord(body?.event);
  const eventUserId = readString(slackEvent?.user);
  const botUserId = botUserIdFromPayload(payload);
  if (eventUserId != null && botUserId != null && eventUserId === botUserId) return null;
  // Fast-ack only when this delivery is a mention of us. Follow-ups after
  // thread activation still wake the agent, but they do not re-add 👀 at the
  // router hop (the agent-side path also eyes only on mentions).
  return slackWebhookMentionsOurBot(payload, botUserId)
    ? { channel: target.channel, timestamp: target.messageTs }
    : null;
}
