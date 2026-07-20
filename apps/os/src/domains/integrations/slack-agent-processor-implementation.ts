// Implements the "slack-agent" processor on itx.
//
// Side-effect policy:
// - Slack Web API presentation calls (status updates, titles, reactions) run
//   after the durable work they acknowledge inside the same
//   `blockProcessorWhile` closure, preserving that ordering.
// - Known idempotent Slack outcomes are successful no-ops. Unexpected failures
//   are reported once and treated as settled because this is a cosmetic lane;
//   they must not stall the durable message/agent pipeline in a retry loop.
// - The Slack calls themselves are acknowledgement/cosmetic lanes and must be
//   REFOLD-SAFE (docs/writing-stream-processors.md, "Refold safety"): the 👀
//   ack only fires for fresh webhooks (webhookAckIsFresh), and the assistant
//   activity is repainted once per at-head pass (`processEvent` under
//   `delivery.caughtUp`) from the current summary/runtime instead of once per
//   event.
//
// Slack's "is thinking..." status is intentionally transient. Non-zero
// projected runtime paints summary.activity (or a factual fallback); the
// debounced zero snapshot clears both status and 👀 even when semantic
// summary says the agent is waiting for a user, timer, or external event.

import {
  AGENT_SUMMARY_UPDATED_EVENT_TYPE,
  isAgentRuntimeZero,
  ZERO_AGENT_RUNTIME,
  type AgentRuntime,
} from "@iterate-com/shared/agent-events";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { StreamProcessor } from "iterate/processors";
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

/** One file shared on a Slack message, as the webhook carries it. */
type SlackSharedFile = { mimetype?: string; name?: string; urlPrivate: string };

export class SlackAgentProcessor extends StreamProcessor<
  SlackAgentProcessorContract,
  {
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
    /** Downloads Slack-shared files into project file storage (see
     * storeSlackFilesForAgent in slack-api.ts). `storageKey` is stable per
     * webhook event so replays overwrite instead of duplicating. */
    getAgentRuntimeTransition?(): AgentRuntimeTransition | undefined;
    storeSlackFiles?(input: {
      connection: string;
      files: SlackSharedFile[];
      storageKey: string;
    }): Promise<AgentFileAttachment[]>;
  }
> {
  readonly contract = SlackAgentProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<
    StreamProcessor<SlackAgentProcessorContract>["reduce"]
  >[0]): SlackAgentProcessorState {
    switch (event.type) {
      case "events.iterate.com/slack-agent/created":
        if (state.birthCertificate !== null) {
          throw new Error("Slack agent processor received more than one slack-agent/created event");
        }
        return {
          ...state,
          birthCertificate: event.payload,
          channel: event.payload.config.channel,
          threadTs: event.payload.config.threadTs,
        };
      case AGENT_SUMMARY_UPDATED_EVENT_TYPE: {
        const summary = applyAgentSummaryUpdate(state.summary, event.payload);
        return summary === state.summary ? state : { ...state, summary };
      }
      case "events.iterate.com/slack/thread-route-configured":
        return {
          ...state,
          channel: event.payload.channel,
          streamPath: event.payload.streamPath,
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
        return state;
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<SlackAgentProcessorContract>["processEvent"]>[0],
  ): undefined {
    const { event, state } = args;
    if (event !== null && event.type === "events.iterate.com/slack-agent/created") return;
    if (state.birthCertificate === null) return;
    // Presence facts paint once from the complete at-head fold. A revival fact
    // also reconciles the current state so a replacement incarnation clears
    // or restores presentation left behind by the one that died.
    if (
      event !== null &&
      (event.type === AGENT_SUMMARY_UPDATED_EVENT_TYPE ||
        event.type === "events.iterate.com/stream/processor-revived")
    ) {
      this.#unpaintedPresenceFact = event;
      if (event.type === "events.iterate.com/stream/processor-revived") {
        this.#unpaintedRevival = true;
      }
      if (
        event.type === "events.iterate.com/stream/processor-revived" ||
        (event.type === AGENT_SUMMARY_UPDATED_EVENT_TYPE && Object.hasOwn(event.payload, "title"))
      ) {
        this.#unpaintedTitleReconcile = true;
      }
    }
    // Per-event blockers register FIRST: `blockProcessorWhile` runs in FIFO
    // registration order, so the at-head repaint below must come after them.
    if (event !== null) this.#processConsumedEvent(args, event);
    // AT-HEAD repaint: `delivery.caughtUp` means `args.state` is the whole
    // observed fold. It rides the last consumed event or the runner's
    // eventless pass. ONE blocking closure — the runner awaits it as this head
    // event's own work before the frame's deferred commit. The reconcile owns
    // Slack's outcome classification: idempotent outcomes are quiet success,
    // while unexpected cosmetic failures are reported once and settled so
    // they cannot wedge the durable agent pipeline.
    if (args.delivery.caughtUp) {
      args.blockProcessorWhile(() => this.#reconcilePresence(args));
    }
  }

  /** The per-event switch, extracted so its early `return`s exit only this
   * helper and can never skip the at-head registration in `processEvent`. */
  #processConsumedEvent(
    args: Parameters<StreamProcessor<SlackAgentProcessorContract>["processEvent"]>[0],
    event: NonNullable<
      Parameters<StreamProcessor<SlackAgentProcessorContract>["processEvent"]>[0]["event"]
    >,
  ): void {
    const { append, blockProcessorWhile, state } = args;
    const { birthCertificate } = state;
    if (birthCertificate === null) return; // narrowing only; the caller guards
    switch (event.type) {
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
        return;
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
          blockProcessorWhile(appendAgentMessage);
          return;
        }

        const slackEvent = parsed.data.event;
        const target = slackAgentTargetFromWebhookPayload(event.payload);
        const botUserId = state.botUserId ?? botUserIdFromPayload(event.payload);
        const botBotId = state.botBotId ?? botBotIdFromPayload(event.payload);
        if (isOwnBotMessage(slackEvent, { botBotId, botUserId })) return;
        if (isBotAction(slackEvent, botUserId)) return;

        const eventType = readStringField(slackEvent, "type");
        // `app_mention` is Slack's dedicated "someone mentioned this app"
        // delivery; treat it like a message for transcription + LLM wake.
        if (eventType !== "message" && eventType !== "app_mention") {
          blockProcessorWhile(async () => {
            await appendAgentMessage({
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            });
          });
          return;
        }

        const channel = target?.channel ?? state.channel ?? readStringField(slackEvent, "channel");
        const threadTs =
          target?.threadTs ??
          state.threadTs ??
          readStringField(slackEvent, "thread_ts") ??
          readNestedMessageStringField(slackEvent, "thread_ts") ??
          readStringField(slackEvent, "ts");
        const messageText = readStringField(slackEvent, "text")?.trim();
        const bangCommand = compileBangCommand({
          channel,
          connection: birthCertificate.config.connection,
          message: messageText,
          threadTs,
        });
        if (bangCommand != null) {
          // Explicit !commands are directed at the bot even without an
          // @mention. The script request must commit before the eyes reaction
          // signals receipt, so both run in one blocking closure.
          blockProcessorWhile(async () => {
            await append({
              type: "events.iterate.com/capability-host/script-run-requested",
              idempotencyKey: this.idempotencyKey("bang-command", event),
              payload: {
                code: bangCommand.code,
                executionId: `slack-bang-command-${event.offset}`,
                expiresAt: (this.deps.now ?? Date.now)() + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
              },
            });
            await this.#replaceEyesReactionForMessageTarget(
              birthCertificate.config.connection,
              target,
              event,
              args.previousState.eyesReactionMessageTs,
            );
          });
          return;
        }

        // Cost gate: do not spend model tokens until someone @mentions us
        // (or Slack delivers app_mention). After that activation, later
        // messages in this thread also wake the agent so multi-turn work does
        // not require re-mentioning. Unmentioned pre-activation traffic is
        // still transcribed as non-triggering history.
        const mentioned =
          eventType === "app_mention" || slackTextMentionsBot(messageText, botUserId);
        const shouldTriggerLlm = mentioned || state.conversationActive;

        // Same ordering requirement: the agent-context append commits before the
        // eyes reaction tells the user their message was picked up. Files
        // shared on the message are materialized into project file storage
        // first so the input event carries the attachments. A failed download
        // can be PERMANENT (Slack tombstones files, tokens get revoked), so
        // throwing would wedge this frame forever; instead the message goes
        // through WITH an explicit loss note — never a silent drop. Eyes only
        // on mentions — follow-ups after activation wake the agent without
        // the 👀 noise.
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
              args.previousState.eyesReactionMessageTs,
            );
          }
        });
        return;
      }
      // Presence facts were memoized above the switch; the revival
      // fact needs no per-event handling (its delivery only guarantees the
      // at-head repaint pass).
      default:
        return;
    }
  }

  /** Latest presence or revival fact deferred until an at-head repaint. */
  #unpaintedPresenceFact: { createdAt: string; type: string } | undefined;
  /** A revival occurred somewhere in the pending batch. Kept separately from
   * the latest fact because a following summary update must not hide the
   * obligation to clear a dead incarnation's Slack status. */
  #unpaintedRevival = false;
  /** A title patch or revival requires an at-head title reconciliation even
   * when the current title is absent: Slack clears a thread title by receiving
   * the same setTitle call with an empty title. */
  #unpaintedTitleReconcile = false;
  /** Exact transient status this incarnation attempted to paint. Written only
   * after the dependency settles, and used to dedupe runtime count transitions
   * that leave the human-readable activity unchanged. */
  #paintedActivityText: string | undefined;
  /** The title this incarnation painted, so repeated repaints of an unchanged
   * title cost no Slack calls. */
  #paintedTitle: string | undefined;

  #runtimePresentationGeneration = 0;
  #runtimeIdleTimer: ReturnType<typeof setTimeout> | undefined;
  #runtimePresentationChain = Promise.resolve();

  /**
   * Present a committed Agent-runner transition without journaling it. Active
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
    const delay = Math.max(0, Date.parse(transition.since) + 1_000 - (this.deps.now ?? Date.now)());
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
    const displayState = deriveAgentDisplayState(runtime);
    const fallbackActivity =
      displayState === "running_code"
        ? "Running code"
        : displayState === "waiting_for_model"
          ? "Waiting for the model"
          : displayState === "queued"
            ? "Preparing the next step"
            : undefined;

    if (fallbackActivity !== undefined) {
      if (!hasAssistantThreadUi || generation !== this.#runtimePresentationGeneration) return;
      const paintedText = (summary.activity ?? fallbackActivity) + "…";
      if (paintedText === this.#paintedActivityText) return;
      await this.#callSlackApi(connection, "assistant.threads.setStatus", {
        channel_id: channel,
        thread_ts: threadTs,
        status: paintedText,
        loading_messages: [paintedText],
      });
      if (generation === this.#runtimePresentationGeneration) {
        this.#paintedActivityText = paintedText;
      }
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

  /**
   * Paint current summary/runtime once per at-head pass. Freshness gates only
   * additive transient status. A revival clears presentation left by a dead
   * incarnation; ordinary zero-runtime settlement belongs exclusively to
   * presentRuntimeTransition so its handoff debounce cannot be bypassed by an
   * unrelated summary delivery.
   */
  async #reconcilePresence(
    args: Parameters<StreamProcessor<SlackAgentProcessorContract>["processEvent"]>[0],
  ): Promise<void> {
    const latest = this.#unpaintedPresenceFact;
    const revival = this.#unpaintedRevival;
    const titleReconcile = this.#unpaintedTitleReconcile;
    this.#unpaintedPresenceFact = undefined;
    this.#unpaintedRevival = false;
    this.#unpaintedTitleReconcile = false;
    if (latest == null) return;
    if (args.state.birthCertificate === null) return;
    const connection = args.state.birthCertificate.config.connection;
    const { channel, channelType, eyesReactionMessageTs, summary, threadTs } = args.state;
    if (channel == null || threadTs == null) return;
    const fresh = webhookAckIsFresh(latest, (this.deps.now ?? Date.now)());
    const hasAssistantThreadUi = slackConversationHasAssistantThreadUi({ channel, channelType });

    // A title is durable current-state paint, unlike Slack's transient status.
    // Reconcile once from the complete at-head fold, including explicit clear
    // patches and revival. The painted-title record is written after the
    // processor classifies the Slack outcome; an unexpected cosmetic failure
    // is reported once rather than retried forever.
    const title = summary.title;
    const slackTitle = title ?? "";
    if (
      hasAssistantThreadUi &&
      slackTitle !== this.#paintedTitle &&
      (title !== undefined || titleReconcile || this.#paintedTitle !== undefined)
    ) {
      await this.#callSlackApi(connection, "assistant.threads.setTitle", {
        channel_id: channel,
        thread_ts: threadTs,
        title: slackTitle,
      });
      this.#paintedTitle = slackTitle;
    }

    const displayState = deriveAgentDisplayState(
      this.deps.getAgentRuntimeTransition?.()?.runtime ?? ZERO_AGENT_RUNTIME,
    );
    const fallbackActivity =
      displayState === "running_code"
        ? "Running code"
        : displayState === "waiting_for_model"
          ? "Waiting for the model"
          : displayState === "queued"
            ? "Preparing the next step"
            : undefined;

    if (fallbackActivity !== undefined) {
      if (!fresh || !hasAssistantThreadUi) return;
      const text = summary.activity ?? fallbackActivity;
      const paintedText = `${text}…`;
      if (paintedText === this.#paintedActivityText) return;
      await this.#callSlackApi(connection, "assistant.threads.setStatus", {
        channel_id: channel,
        thread_ts: threadTs,
        status: paintedText,
        loading_messages: [paintedText],
      });
      this.#paintedActivityText = paintedText;
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
    if (!webhookAckIsFresh(event, (this.deps.now ?? Date.now)())) return;
    await this.#callSlackApi(connection, "reactions.add", {
      channel: target.channel,
      name: "eyes",
      timestamp: target.messageTs,
    });
  }

  async #callSlackApi(connection: string, method: string, body: Record<string, unknown>) {
    if (body.timestamp == null && (method === "reactions.add" || method === "reactions.remove")) {
      return;
    }
    if (this.deps.callSlackApi == null) return;

    try {
      await this.deps.callSlackApi({ body, connection, method });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        method === "reactions.add" &&
        (message.includes("already_reacted") || message.includes("not_reactable"))
      ) {
        return;
      }
      if (method === "reactions.remove" && message.includes("no_reaction")) return;
      console.error("[slack-agent] Slack side effect failed", {
        error,
        method,
        path: this.path,
      });
    }
  }
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
  if (readStringField(slackEvent, "subtype") === "bot_message") return true;
  if (readStringField(slackEvent, "bot_id") != null) return true;
  if (readRecordField(slackEvent, "bot_profile") != null) return true;
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
  const msgBotId = readStringField(slackEvent, "bot_id");
  if (identity.botBotId != null && msgBotId != null) {
    comparedIdentity = true;
    if (msgBotId === identity.botBotId) return true;
  }

  const msgUserId =
    readStringField(slackEvent, "user") ??
    readStringField(readRecordField(slackEvent, "bot_profile"), "user_id");
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
  return readStringField(slackEvent, "user") === botUserId;
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

function readStringField(value: unknown, key: string): string | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function readRecordField(value: unknown, key: string): Record<string, unknown> | null {
  if (value == null || typeof value !== "object") return null;
  return readRecord((value as Record<string, unknown>)[key]);
}

function readNestedMessageStringField(value: unknown, key: string): string | undefined {
  if (value == null || typeof value !== "object") return undefined;
  return readStringField((value as Record<string, unknown>).message, key);
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
  if (!slackWebhookMentionsOurBot(payload, botUserId)) return null;
  return { channel: target.channel, timestamp: target.messageTs };
}
