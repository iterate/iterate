// Implements the "slack-agent" processor on itx.
//
// Behavioral reference: the pre-migration slack-agent processor (git history).
// Emitted event types, payloads, and idempotency keys are stable wire formats.
//
// Side-effect policy:
// - Slack Web API calls (status updates, reactions) run inside
//   `blockProcessorWhile` so the checkpoint only advances once they finished;
//   sequences like "commit agent input, then add the eyes reaction" keep their
//   legacy ordering by sharing one blocking closure.
// - Replay runs the same idempotency-keyed side effects as live delivery. The
//   processor checkpoint is the guardrail; failed batches replay from the last
//   fully processed offset.
// - The Slack calls themselves are acknowledgement/cosmetic lanes and must be
//   REFOLD-SAFE (docs/writing-stream-processors.md, "Refold safety"): the 👀
//   ack only fires for fresh webhooks (webhookAckIsFresh), and the assistant
//   status is repainted once per at-head batch from the latest announced
//   status instead of once per event.
//
// The "is thinking..." status is a pure PAINT of the agent processor's own
// `agent/status-changed` announcements. The agent owns the busy/idle
// derivation (LLM lifecycle, running scripts, queued triggers) AND the
// trailing idle debounce, so this processor keeps no lifecycle fold and no
// clear obligation of its own — busy paints the status, idle clears it, and
// the announcement's sinceOffset guard (see the event's contract) keeps a
// stale idle from overwriting newer work.

import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS } from "../capability-host/capability-host-processor-contract.ts";
import { StreamProcessor } from "../streams/stream-processor.ts";
import {
  mergeAgentStatusPatch,
  type AgentFileAttachment,
} from "../agents/agent-processor-contract.ts";
import {
  readRecord,
  readString,
  slackConnectionFromAgentPath,
  webhookAckIsFresh,
} from "./utils.ts";
import {
  SlackAgentProcessorContract,
  type SlackAgentProcessorState,
} from "./slack-agent-processor-contract.ts";
import { agentBusyPhaseLabel } from "~/lib/feed-format.ts";

/** One file shared on a Slack message, as the webhook carries it. */
type SlackSharedFile = { mimetype?: string; name?: string; urlPrivate: string };

export class SlackAgentProcessor extends StreamProcessor<
  SlackAgentProcessorContract,
  {
    callSlackApi?(method: string, body: Record<string, unknown>): Promise<void>;
    /** Resolves a channel id to its display name (conversations.info) for the
     * birth identity patch; null on any failure — the id then stands in. */
    fetchSlackChannelName?(channel: string): Promise<string | null>;
    /** Injectable clock for the acknowledgement freshness gates. */
    now?: () => number;
    /** Downloads Slack-shared files into project file storage (see
     * storeSlackFilesForAgent in slack-api.ts). `storageKey` is stable per
     * webhook event so replays overwrite instead of duplicating. */
    storeSlackFiles?(input: {
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
      case "events.iterate.com/agent/status-changed": {
        // The contract's shared merge fold: busy patches carry their
        // sinceOffset guard, authored title/note/shortStatus patches are
        // last-write-wins.
        const status = mergeAgentStatusPatch(state.status, event.payload);
        if (status === state.status) return state;
        return { ...state, ...(status === undefined ? {} : { status }) };
      }
      case "events.iterate.com/slack/thread-route-configured":
        return {
          ...state,
          channel: event.payload.channel,
          streamPath: event.payload.streamPath,
          threadTs: event.payload.threadTs,
        };
      case "events.iterate.com/slack/webhook-received": {
        const target = slackTargetFromPayload(event.payload);
        if (target == null) return state;
        const botUserId = state.botUserId ?? botUserIdFromPayload(event.payload);
        const botBotId = state.botBotId ?? botBotIdFromPayload(event.payload);
        const mentioned = slackWebhookMentionsOurBot(event.payload, botUserId);
        return {
          ...state,
          ...(botBotId == null ? {} : { botBotId }),
          ...(botUserId == null ? {} : { botUserId }),
          channel: target.channel,
          conversationActive: state.conversationActive || mentioned,
          ...(target.messageTs == null ? {} : { latestMessageTs: target.messageTs }),
          threadTs: target.threadTs,
        };
      }
      default:
        return state;
    }
  }

  protected override processEvent({
    append,
    blockProcessorWhile,
    event,
    state,
  }: Parameters<StreamProcessor<SlackAgentProcessorContract>["processEvent"]>[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/slack/thread-route-configured": {
        // Route context (channel/thread_ts/streamPath) is captured in
        // reduce(). The route additionally stamps the thread's roster
        // identity ONCE: the slack icon and a "#channel" title/note (the
        // agent's own setStatus patches win later by journal order).
        const channel = event.payload.channel;
        blockProcessorWhile(async () => {
          const name = (await this.deps.fetchSlackChannelName?.(channel).catch(() => null)) ?? null;
          const label = name === null ? channel : `#${name}`;
          await append({
            type: "events.iterate.com/agent/status-changed",
            idempotencyKey: this.idempotencyKey("status-identity"),
            payload: {
              icon: "slack",
              title: `${label} thread`,
              note: `Slack thread in ${label}`,
            },
          });
        });
        return;
      }
      case "events.iterate.com/slack/webhook-received": {
        // The webhook transcribes into the unified inbound message event —
        // Slack messages are messages FROM a user, `from` carries the facts.
        // The sender is extracted here, once, wherever the payload shape
        // carries it (event_callback events vs interactivity payloads), so
        // button presses and reactions keep their sender too.
        const senderUserId = slackWebhookSenderUserId(event.payload.body);
        const appendAgentMessage = async (
          input: {
            files?: AgentFileAttachment[];
            llmRequestPolicy?: { behaviour: "dont-trigger-request" };
          } = {},
        ) => {
          await append({
            type: "events.iterate.com/agents/message-received",
            idempotencyKey: this.idempotencyKey("webhook-to-agent-input", event),
            payload: {
              content: slackWebhookAgentInput(event.payload),
              from: { kind: "slack", ...(senderUserId == null ? {} : { userId: senderUserId }) },
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
          connection:
            state.streamPath == null ? null : slackConnectionFromAgentPath(state.streamPath),
          message: messageText,
          threadTs,
        });
        if (bangCommand != null) {
          // Explicit !commands are directed at the bot even without an
          // @mention. The script request must commit before the eyes reaction
          // signals receipt, so both run in one blocking closure.
          blockProcessorWhile(async () => {
            await append({
              type: "events.iterate.com/capability-host/script-execution-requested",
              idempotencyKey: this.idempotencyKey("bang-command", event),
              payload: {
                code: bangCommand.code,
                executionId: `slack-bang-command-${event.offset}`,
                expiresAt: (this.deps.now ?? Date.now)() + DEFAULT_SCRIPT_EXECUTION_EXPIRY_MS,
              },
            });
            await this.#addEyesReactionForMessageTarget(target, event);
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

        // Same ordering requirement: the agent input append commits before the
        // eyes reaction tells the user their message was picked up. Files
        // shared on the message are materialized into project file storage
        // first so the input event carries the attachments; a failed download
        // degrades to the plain webhook input (the YAML already names the
        // files) rather than wedging the processor. Eyes only on mentions —
        // follow-ups after activation wake the agent without the 👀 noise.
        blockProcessorWhile(async () => {
          const sharedFiles = readSlackMessageFiles(slackEvent);
          let files: AgentFileAttachment[] | undefined;
          if (sharedFiles.length > 0 && this.deps.storeSlackFiles != null) {
            try {
              files = await this.deps.storeSlackFiles({
                files: sharedFiles,
                storageKey: `slack-${event.offset}`,
              });
            } catch (error) {
              console.error("[slack-agent] failed to store shared files", {
                count: sharedFiles.length,
                error,
              });
            }
          }
          await appendAgentMessage({
            ...(files == null ? {} : { files }),
            ...(shouldTriggerLlm
              ? {}
              : { llmRequestPolicy: { behaviour: "dont-trigger-request" as const } }),
          });
          if (mentioned) {
            await this.#addEyesReactionForMessageTarget(target, event);
          }
        });
        return;
      }
      // Status announcements drive the assistant status, which is repainted
      // once per batch in processEventBatch — nothing per event.
      default:
        return;
    }
  }

  /** Latest status announcement deferred until an at-head repaint. */
  #unpaintedStatusFact: { createdAt: string; type: string } | undefined;
  /** Whether THIS incarnation painted a busy status: a stale idle
   * announcement must still clear what we ourselves put up, while a refold
   * (fresh instance, all facts stale) must repaint nothing at all. */
  #paintedBusyStatus = false;
  /** The title this incarnation painted, so repeated repaints of an unchanged
   * title cost no Slack calls. */
  #paintedTitle: string | undefined;

  /**
   * Paint the agent's announced status onto the assistant thread, once per
   * at-head batch (never per event, so a refold cannot replay historical
   * flips). Both directions are freshness-gated like every other
   * acknowledgement — a refold's months-old announcements must not burst
   * Slack calls across every historical thread — with one exception: a stale
   * idle still clears a busy status this incarnation painted.
   */
  protected override async processEventBatch(
    args: Parameters<StreamProcessor<SlackAgentProcessorContract>["processEventBatch"]>[0],
  ): Promise<void> {
    await super.processEventBatch(args);
    const latest =
      args.reducedEvents.findLast(
        ({ event }) => event.type === "events.iterate.com/agent/status-changed",
      )?.event ?? this.#unpaintedStatusFact;
    if (args.checkpointOffset < args.streamMaxOffset) {
      this.#unpaintedStatusFact = latest;
      return;
    }
    this.#unpaintedStatusFact = undefined;
    if (latest == null) return;
    const { channel, latestMessageTs, status, threadTs } = args.state;
    if (channel == null || threadTs == null) return;
    const fresh = webhookAckIsFresh(latest, (this.deps.now ?? Date.now)());

    // The agent-authored title paints whenever the folded title differs from
    // what this incarnation painted — freshness-gated with everything else,
    // so a refold never replays historical renames. The painted-title record
    // is written only AFTER the call succeeds: a rejected call fails the
    // batch, and the redelivered batch must retry the rename instead of
    // seeing it as already painted.
    const title = args.state.status?.title;
    if (fresh && title !== undefined && title !== this.#paintedTitle) {
      args.blockProcessorWhile(async () => {
        await this.#callSlackApi("assistant.threads.setTitle", {
          channel_id: channel,
          thread_ts: threadTs,
          title,
        });
        this.#paintedTitle = title;
      });
    }

    if (status?.busy) {
      if (!fresh) return;
      // The agent's own words win; otherwise the platform-derived phase says
      // what it is doing ("waiting for a response" / "running code").
      const text = status.shortStatus ?? agentBusyPhaseLabel(status.phase);
      args.blockProcessorWhile(async () => {
        await this.#callSlackApi("assistant.threads.setStatus", {
          channel_id: channel,
          thread_ts: threadTs,
          status: `is ${text}...`,
          loading_messages: [`${text}...`],
        });
        this.#paintedBusyStatus = true;
      });
      return;
    }
    // Only an EXPLICIT idle clears. An authored-only record (title/note/
    // shortStatus with busy never announced) says nothing about work, and
    // clearing on it would strip the 👀 ack for a message the agent has not
    // even picked up yet.
    if (status?.busy !== false) return;
    // A blocked turn ended WAITING on the human: say so instead of going
    // quiet. The 👀 still comes off — the message was handled — and the
    // next busy flip (the platform clears `blocked` in it) repaints.
    if (status.blocked === true) {
      if (!fresh && !this.#paintedBusyStatus) return;
      const text = status.shortStatus ?? "waiting for input";
      args.blockProcessorWhile(async () => {
        await this.#callSlackApi("assistant.threads.setStatus", {
          channel_id: channel,
          thread_ts: threadTs,
          status: `is ${text}...`,
          loading_messages: [`${text}...`],
        });
        if (latestMessageTs != null) {
          await this.#callSlackApi("reactions.remove", {
            channel,
            name: "eyes",
            timestamp: latestMessageTs,
          });
        }
        this.#paintedBusyStatus = true;
      });
      return;
    }
    if (!fresh && !this.#paintedBusyStatus) return;
    args.blockProcessorWhile(async () => {
      await this.#clearStatus({
        channel,
        ...(latestMessageTs == null ? {} : { latestMessageTs }),
        threadTs,
      });
      this.#paintedBusyStatus = false;
    });
  }

  async #clearStatus(target: { channel: string; latestMessageTs?: string; threadTs: string }) {
    await this.#callSlackApi("assistant.threads.setStatus", {
      channel_id: target.channel,
      thread_ts: target.threadTs,
      status: "",
    });
    if (target.latestMessageTs != null) {
      await this.#callSlackApi("reactions.remove", {
        channel: target.channel,
        name: "eyes",
        timestamp: target.latestMessageTs,
      });
    }
  }

  /** The 👀 ack means "your message was just picked up" — only fresh webhooks
   * qualify (see WEBHOOK_ACK_FRESHNESS_MS for why stale ones must not). */
  async #addEyesReactionForMessageTarget(
    target: SlackAgentTarget | null,
    event: { createdAt: string },
  ) {
    if (target == null || target.isBotMessage || target.isReactionEvent) return;
    if (!webhookAckIsFresh(event, (this.deps.now ?? Date.now)())) return;
    await this.#callSlackApi("reactions.add", {
      channel: target.channel,
      name: "eyes",
      timestamp: target.messageTs,
    });
  }

  async #callSlackApi(method: string, body: Record<string, unknown>) {
    if (body.timestamp == null && (method === "reactions.add" || method === "reactions.remove")) {
      return;
    }
    if (this.deps.callSlackApi == null) return;

    try {
      await this.deps.callSlackApi(method, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        method === "reactions.add" &&
        (message.includes("already_reacted") || message.includes("not_reactable"))
      ) {
        return;
      }
      if (method === "reactions.remove" && message.includes("no_reaction")) return;
      throw error;
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

function slackTargetFromPayload(payload: unknown): {
  channel: string;
  messageTs?: string;
  threadTs: string;
} | null {
  const target = slackAgentTargetFromWebhookPayload(payload);
  if (target == null) return null;
  return {
    channel: target.channel,
    ...(target.messageTs == null ? {} : { messageTs: target.messageTs }),
    threadTs: target.threadTs,
  };
}

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

/**
 * Payload-only gate for the integration-level fast acknowledgement: the 👀
 * reaction added at the routing hop, before the routed thread stream and its
 * slack-agent host even exist. Mirrors `#addEyesReactionForMessageTarget`'s
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
