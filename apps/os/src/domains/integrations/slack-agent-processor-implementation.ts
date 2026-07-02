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
//
// Adaptation from legacy: the itx agent contract has no
// `agent/status-updated` event. The Slack "is thinking..." status now keys off
// the agent's own LLM request lifecycle (`llm-request-requested` /
// `llm-request-completed`), and "is using tools..." off the itx script
// execution journal, which is what those statuses meant downstream anyway.

import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { StreamProcessor } from "../streams/stream-processor.ts";
import { readRecord, readString } from "./utils.ts";
import {
  SlackAgentProcessorContract,
  type SlackAgentProcessorState,
} from "./slack-agent-processor-contract.ts";

export type SlackAgentProcessorDeps = {
  callSlackApi?(method: string, body: Record<string, unknown>): Promise<void>;
};

export class SlackAgentProcessor extends StreamProcessor<
  typeof SlackAgentProcessorContract,
  SlackAgentProcessorDeps
> {
  readonly contract = SlackAgentProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<
    StreamProcessor<typeof SlackAgentProcessorContract>["reduce"]
  >[0]): SlackAgentProcessorState {
    switch (event.type) {
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
  }: Parameters<
    StreamProcessor<typeof SlackAgentProcessorContract>["processEvent"]
  >[0]): undefined {
    switch (event.type) {
      case "events.iterate.com/slack/thread-route-configured":
        // Route context (channel/thread_ts/streamPath) is captured in reduce().
        return;
      case "events.iterate.com/slack/webhook-received": {
        const appendAgentInput = async (
          input: { llmRequestPolicy?: { behaviour: "dont-trigger-request" } } = {},
        ) => {
          await append({
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `slack-agent:webhook-to-agent-input:${event.offset}`,
            payload: {
              content: slackWebhookAgentInput(event.payload),
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
          blockProcessorWhile(appendAgentInput);
          return;
        }

        const slackEvent = parsed.data.event;
        const target = slackAgentTargetFromWebhookPayload(event.payload);
        const botBotId = state.botBotId ?? botBotIdFromPayload(event.payload);
        if (isOwnBotMessage(slackEvent, botBotId)) return;
        if (isBotAction(slackEvent, state.botUserId)) return;
        if (readStringField(slackEvent, "type") !== "message") {
          blockProcessorWhile(async () => {
            await appendAgentInput({
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            });
            await this.#addEyesReactionForMessageTarget(target);
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
          message: readStringField(slackEvent, "text")?.trim(),
          threadTs,
        });
        if (bangCommand != null) {
          // The script request must commit before the eyes reaction signals
          // receipt, so both run in one blocking closure.
          blockProcessorWhile(async () => {
            await append({
              type: "events.iterate.com/itx/script-execution-requested",
              idempotencyKey: `slack-agent:bang-command:${event.offset}`,
              payload: {
                code: bangCommand.code,
                executionId: `slack-bang-command-${event.offset}`,
              },
            });
            await this.#addEyesReactionForMessageTarget(target);
          });
          return;
        }

        // Same ordering requirement: the agent input append commits before the
        // eyes reaction tells the user their message was picked up.
        blockProcessorWhile(async () => {
          await appendAgentInput();
          await this.#addEyesReactionForMessageTarget(target);
        });
        return;
      }
      case "events.iterate.com/agent/llm-request-requested":
      case "events.iterate.com/agent/llm-request-completed":
      case "events.iterate.com/itx/script-execution-requested":
      case "events.iterate.com/itx/script-execution-completed": {
        const update = slackAgentStatusForEvent(event);
        if (update == null || state.channel == null || state.threadTs == null) return;
        const { channel, latestMessageTs, threadTs } = state;
        blockProcessorWhile(async () => {
          await this.#callSlackApi("assistant.threads.setStatus", {
            channel_id: channel,
            thread_ts: threadTs,
            ...update.status,
          });
          if (update.clear && latestMessageTs != null) {
            await this.#callSlackApi("reactions.remove", {
              channel,
              name: "eyes",
              timestamp: latestMessageTs,
            });
          }
        });
        return;
      }
      default:
        return;
    }
  }

  async #addEyesReactionForMessageTarget(target: SlackAgentTarget | null) {
    if (target == null || target.isBotMessage || target.isReactionEvent) return;
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

function slackWebhookAgentInput(payload: unknown) {
  return [
    "`events.iterate.com/slack/webhook-received` event received",
    "",
    "```yaml",
    stringifyYaml(payload).trimEnd(),
    "```",
  ].join("\n");
}

function isBotMessage(slackEvent: Record<string, unknown>): boolean {
  if (readStringField(slackEvent, "subtype") === "bot_message") return true;
  if (readStringField(slackEvent, "bot_id") != null) return true;
  if (readRecordField(slackEvent, "bot_profile") != null) return true;
  return false;
}

// Returns true only when the message came from our own bot (same bot_id as the
// authorized app). Falls back to blocking all bots when our bot_id is unknown.
function isOwnBotMessage(
  slackEvent: Record<string, unknown>,
  botBotId: string | undefined,
): boolean {
  if (botBotId == null) return isBotMessage(slackEvent);
  const msgBotId = readStringField(slackEvent, "bot_id");
  if (msgBotId == null) return false;
  return msgBotId === botBotId;
}

/**
 * Returns true when the Slack event was performed by our own bot user (e.g.
 * our bot adding a reaction).
 */
function isBotAction(slackEvent: Record<string, unknown>, botUserId: string | undefined): boolean {
  if (botUserId == null) return false;
  return readStringField(slackEvent, "user") === botUserId;
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
  message: string | undefined;
  threadTs: string | undefined;
}): { code: string } | null {
  if (!input.message) return null;
  const withoutMention = input.message.replace(/^<@[^>]+>\s*/i, "").trim();
  if (!withoutMention.startsWith("!")) return null;

  const rawCommand = withoutMention.slice(1).trim();
  if (!rawCommand) return null;

  if (rawCommand === "debug" || rawCommand === "debug()") {
    if (input.channel == null || input.threadTs == null) return null;
    return {
      code: [
        "async (itx) => {",
        "  const debug = await itx.describe();",
        "  await itx.slack.chat.postMessage({",
        `    channel: ${JSON.stringify(input.channel)},`,
        `    thread_ts: ${JSON.stringify(input.threadTs)},`,
        "    text: `Debug info:\\n${JSON.stringify(debug, null, 2)}`,",
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
      return { clear: true, status: { status: "" } };
    case "events.iterate.com/itx/script-execution-requested":
      return {
        clear: false,
        status: { status: "is using tools...", loading_messages: ["Using tools..."] },
      };
    case "events.iterate.com/itx/script-execution-completed":
      return { clear: true, status: { status: "" } };
    default:
      return null;
  }
}
