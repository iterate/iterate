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
//   status is repainted once per at-head pass (`onCaughtUp`) from the latest
//   lifecycle fact instead of once per event.
//
// Adaptation from legacy: the itx agent contract has no
// `agent/status-updated` event. The Slack "is thinking..." status now keys off
// the agent's own LLM request lifecycle (`llm-request-requested` /
// `llm-request-completed`), and "is using tools..." off the itx script
// execution journal, which is what those statuses meant downstream anyway.

import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { StreamProcessor } from "../streams/stream-processor.ts";
import type { AgentFileAttachment } from "../agents/agent-processor-contract.ts";
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

/** One file shared on a Slack message, as the webhook carries it. */
type SlackSharedFile = { mimetype?: string; name?: string; urlPrivate: string };

/** Open (or supersede) the clear obligation exactly when the folded work set
 * becomes idle. The completion event's offset is its stable generation. */
function statusClearState(input: {
  event: { createdAt: string; offset: number };
  state: SlackAgentProcessorState;
}): SlackAgentProcessorState {
  const idle =
    input.state.activeLlmRequestOffsets.length === 0 &&
    input.state.activeScriptExecutionIds.length === 0;
  return {
    ...input.state,
    pendingStatusClear: idle
      ? {
          due: false,
          latestMessageTs: input.state.latestMessageTs,
          requestedAt: input.event.createdAt,
          triggerOffset: input.event.offset,
        }
      : undefined,
  };
}

export class SlackAgentProcessor extends StreamProcessor<
  SlackAgentProcessorContract,
  {
    callSlackApi?(method: string, body: Record<string, unknown>): Promise<void>;
    /** Injectable clock for the acknowledgement freshness gates. */
    now?: () => number;
    /** Trailing delay before clearing an idle assistant status. */
    statusClearDebounceMs?: number;
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
      case "events.iterate.com/agent/llm-request-requested":
        return {
          ...state,
          activeLlmRequestOffsets: [...state.activeLlmRequestOffsets, event.offset],
          pendingStatusClear: undefined,
        };
      case "events.iterate.com/agent/llm-request-completed":
        return statusClearState({
          event,
          state: {
            ...state,
            activeLlmRequestOffsets: state.activeLlmRequestOffsets.filter(
              (offset) => offset !== event.payload.llmRequestOffset,
            ),
          },
        });
      case "events.iterate.com/agent/llm-request-cancelled": {
        if (event.payload.phase !== "requested") return state;
        const cancelledRequestOffset = event.payload.llmRequestOffset;
        return statusClearState({
          event,
          state: {
            ...state,
            activeLlmRequestOffsets: state.activeLlmRequestOffsets.filter(
              (offset) => offset !== cancelledRequestOffset,
            ),
          },
        });
      }
      case "events.iterate.com/capability-host/script-execution-requested":
        return {
          ...state,
          activeScriptExecutionIds: state.activeScriptExecutionIds.includes(
            event.payload.executionId,
          )
            ? state.activeScriptExecutionIds
            : [...state.activeScriptExecutionIds, event.payload.executionId],
          pendingStatusClear: undefined,
        };
      case "events.iterate.com/capability-host/script-execution-completed":
        return statusClearState({
          event,
          state: {
            ...state,
            activeScriptExecutionIds: state.activeScriptExecutionIds.filter(
              (executionId) => executionId !== event.payload.executionId,
            ),
          },
        });
      case "events.iterate.com/slack-agent/status-clear-due":
        return state.pendingStatusClear?.triggerOffset === event.payload.triggerOffset
          ? { ...state, pendingStatusClear: { ...state.pendingStatusClear, due: true } }
          : state;
      case "events.iterate.com/slack-agent/status-clear-completed":
        return state.pendingStatusClear?.triggerOffset === event.payload.triggerOffset
          ? { ...state, pendingStatusClear: undefined }
          : state;
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
        return {
          ...state,
          ...(botBotId == null ? {} : { botBotId }),
          ...(botUserId == null ? {} : { botUserId }),
          channel: target.channel,
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
      case "events.iterate.com/slack/thread-route-configured":
        // Route context (channel/thread_ts/streamPath) is captured in reduce().
        return;
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
        if (readStringField(slackEvent, "type") !== "message") {
          blockProcessorWhile(async () => {
            await appendAgentMessage({
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            });
            await this.#addEyesReactionForMessageTarget(target, event);
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
        const bangCommand = compileBangCommand({
          channel,
          connection:
            state.streamPath == null ? null : slackConnectionFromAgentPath(state.streamPath),
          message: readStringField(slackEvent, "text")?.trim(),
          threadTs,
        });
        if (bangCommand != null) {
          // The script request must commit before the eyes reaction signals
          // receipt, so both run in one blocking closure.
          blockProcessorWhile(async () => {
            await append({
              type: "events.iterate.com/capability-host/script-execution-requested",
              idempotencyKey: this.idempotencyKey("bang-command", event),
              payload: {
                code: bangCommand.code,
                executionId: `slack-bang-command-${event.offset}`,
              },
            });
            await this.#addEyesReactionForMessageTarget(target, event);
          });
          return;
        }

        // Same ordering requirement: the agent input append commits before the
        // eyes reaction tells the user their message was picked up. Files
        // shared on the message are materialized into project file storage
        // first so the input event carries the attachments; a failed download
        // degrades to the plain webhook input (the YAML already names the
        // files) rather than wedging the processor.
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
          await appendAgentMessage(files == null ? {} : { files });
          await this.#addEyesReactionForMessageTarget(target, event);
        });
        return;
      }
      // LLM/script lifecycle facts drive the assistant status, which is
      // repainted once per at-head pass in onCaughtUp — nothing per event
      // beyond remembering the LATEST fact (later events overwrite earlier
      // ones, and the memo carries across behind-head frames so a lagging
      // fold still paints once it catches up).
      default:
        if (slackAgentStatusForEvent(event) != null) this.#unpaintedLifecycleFact = event;
        return;
    }
  }

  /** Latest lifecycle fact deferred until an at-head repaint. */
  #unpaintedLifecycleFact: { createdAt: string; type: string } | undefined;
  #statusClearAttempt:
    | {
        cancel(): void;
        triggerOffset: number;
      }
    | undefined;

  /**
   * The at-head pass, in two halves that preserve their legacy order:
   *
   * 1. REPAINT from folded active work, matching the web UI ("once at head,
   *    latest wins"). An LLM completion must not clear Slack while a script
   *    is running, and idle clears trail briefly so LLM → script → LLM
   *    hand-offs do not flicker. The latest lifecycle fact accumulates in
   *    `#unpaintedLifecycleFact` per event, so a fact delivered in a
   *    behind-head frame still paints exactly once when the cursor reaches
   *    head.
   * 2. The STATUS-CLEAR obligation: the fold owns the desired clear until a
   *    completion fact closes it. A delayed attempt may disappear with an
   *    isolate; recovery's `slack-agent/revived` delivery lands here in a
   *    fresh incarnation and re-derives it.
   */
  protected override async onCaughtUp(
    args: Parameters<StreamProcessor<SlackAgentProcessorContract>["onCaughtUp"]>[0],
  ): Promise<void> {
    const latest = this.#unpaintedLifecycleFact;
    this.#unpaintedLifecycleFact = undefined;
    const { channel, threadTs } = args.state;
    const hasScripts = args.state.activeScriptExecutionIds.length > 0;
    const hasLlm = args.state.activeLlmRequestOffsets.length > 0;

    if (hasScripts || hasLlm) {
      this.#cancelStatusClear();
      if (
        latest != null &&
        webhookAckIsFresh(latest, (this.deps.now ?? Date.now)()) &&
        channel != null &&
        threadTs != null
      ) {
        const status = hasScripts
          ? { status: "is using tools...", loading_messages: ["Using tools..."] }
          : { status: "is thinking...", loading_messages: ["Thinking..."] };
        args.blockProcessorWhile(() =>
          this.#callSlackApi("assistant.threads.setStatus", {
            channel_id: channel,
            thread_ts: threadTs,
            ...status,
          }),
        );
      }
    }

    const pending = args.state.pendingStatusClear;
    if (pending == null) {
      this.#cancelStatusClear();
      return;
    }
    const target =
      channel == null || threadTs == null
        ? null
        : { channel, latestMessageTs: pending.latestMessageTs, threadTs };
    const complete = async () => {
      if (target != null) await this.#clearStatus(target);
      await args.append({
        type: "events.iterate.com/slack-agent/status-clear-completed",
        idempotencyKey: this.idempotencyKey(`status-clear-completed@${pending.triggerOffset}`),
        payload: { triggerOffset: pending.triggerOffset },
      });
    };
    if (pending.due) {
      this.#cancelStatusClear();
      args.blockProcessorWhile(complete);
      return;
    }

    if (this.#statusClearAttempt?.triggerOffset === pending.triggerOffset) return;
    this.#cancelStatusClear();
    const dueAt = Date.parse(pending.requestedAt) + (this.deps.statusClearDebounceMs ?? 1_000);
    const delay = Math.max(0, dueAt - (this.deps.now ?? Date.now)());
    if (delay === 0) {
      args.blockProcessorWhile(complete);
      return;
    }

    const markDue = async () => {
      await args.append({
        type: "events.iterate.com/slack-agent/status-clear-due",
        idempotencyKey: this.idempotencyKey(`status-clear-due@${pending.triggerOffset}`),
        payload: { triggerOffset: pending.triggerOffset },
      });
    };

    let settleWait!: (run: boolean) => void;
    let settled = false;
    const wait = new Promise<boolean>((resolve) => {
      settleWait = resolve;
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      settleWait(true);
    }, delay);
    const attempt = {
      triggerOffset: pending.triggerOffset,
      cancel: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        settleWait(false);
      },
    };
    this.#statusClearAttempt = attempt;
    args.runInBackground(async () => {
      try {
        if (await wait) await markDue();
      } finally {
        if (this.#statusClearAttempt === attempt) this.#statusClearAttempt = undefined;
      }
    });
  }

  #cancelStatusClear() {
    this.#statusClearAttempt?.cancel();
    this.#statusClearAttempt = undefined;
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
 * reaction events, and actions performed by the authorized bot user are
 * skipped. The slack-agent processor still adds the same reaction once the
 * routed stream catches up; Slack's `already_reacted` makes the pair
 * idempotent.
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
  return { channel: target.channel, timestamp: target.messageTs };
}

function slackAgentStatusForEvent(event: { type: string }): {
  clear: boolean;
  status: { loading_messages?: string[]; status: string };
} | null {
  switch (event.type) {
    case "events.iterate.com/agent/llm-request-requested":
      return {
        clear: false,
        status: { status: "is thinking...", loading_messages: ["Thinking..."] },
      };
    case "events.iterate.com/agent/llm-request-completed":
    case "events.iterate.com/agent/llm-request-cancelled":
      return { clear: true, status: { status: "" } };
    case "events.iterate.com/capability-host/script-execution-requested":
      return {
        clear: false,
        status: { status: "is using tools...", loading_messages: ["Using tools..."] },
      };
    case "events.iterate.com/capability-host/script-execution-completed":
      return { clear: true, status: { status: "" } };
    default:
      return null;
  }
}
