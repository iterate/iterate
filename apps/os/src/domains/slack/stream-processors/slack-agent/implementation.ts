// Implements the "slack-agent" processor on the class-based StreamProcessor
// model. Migrated from
// `packages/shared/src/stream-processors/slack-agent/implementation.ts`;
// emitted event types/payloads and idempotency keys are unchanged.
//
// Side-effect policy (see migration log D5/D6):
// - Slack Web API calls (status updates, reactions) run inside
//   `blockProcessorWhile` so the checkpoint only advances once they finished;
//   sequences like "commit agent input, then add the eyes reaction" keep their
//   legacy ordering by sharing one blocking closure.
// - Pure follow-up appends carry idempotency keys derived from the source
//   event and run through `runInBackground`.
// - The old `firstAttachAfterAppend` 60s lookback is replaced by the base
//   class's `sideEffectsAfterOffset` anchor, set by the host to the
//   subscription-configured offset.

import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import {
  assertNever,
  buildProcessorIdempotencyKey,
} from "@iterate-com/streams/shared/stream-processors";
import { SlackAgentProcessorContract, type SlackAgentProcessorState } from "./contract.ts";
export { SlackAgentProcessorContract } from "./contract.ts";

export type SlackAgentProcessorContract = typeof SlackAgentProcessorContract;

export type SlackAgentProcessorDeps = {
  callSlackApi?(method: string, body: Record<string, unknown>): Promise<void>;
};

export class SlackAgentProcessor extends StreamProcessor<
  SlackAgentProcessorContract,
  SlackAgentProcessorDeps
> {
  readonly contract = SlackAgentProcessorContract;

  protected override reduce(
    args: Parameters<StreamProcessor<SlackAgentProcessorContract>["reduce"]>[0],
  ): SlackAgentProcessorState {
    const { event, state } = args;
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
      case "events.iterate.com/agent/status-updated":
      case "events.iterate.com/codemode/script-execution-requested":
      case "events.iterate.com/codemode/script-execution-completed":
      case "events.iterate.com/codemode/function-call-requested":
        return state;
      default:
        return assertNever(event);
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<SlackAgentProcessorContract>["processEvent"]>[0],
  ): void {
    const { event, state } = args;
    switch (event.type) {
      case "events.iterate.com/slack/thread-route-configured":
        args.runInBackground(async () => {
          await this.ctx.stream.append({
            event: {
              type: "events.iterate.com/codemode/tool-provider-registered",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: this.contract,
                key: "register-slack-agent-tool-provider",
                sourceEvent: event,
              }),
              payload: {
                path: ["slack", "agent"],
                invocation: { kind: "event" },
                instructions:
                  "Use ctx.slack.agent.threadInfo() only when you need route context that is not already in the Slack webhook payload. Slack agents MUST respond on the same thread_ts that received the message; otherwise they will not receive responses from that thread. Unless explicitly required, always include thread_ts in Slack replies. Do not post to Slack unless the bot was explicitly mentioned, a user directly asks or instructs you, or the surrounding thread context clearly calls for agent action. Normal Slack replies can use channel/thread_ts from the webhook event directly.",
              },
            },
          });
        });
        return;
      case "events.iterate.com/slack/webhook-received": {
        const appendAgentInput = async () => {
          await this.ctx.stream.append({
            event: {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: this.contract,
                key: "slack-webhook-to-agent-input",
                sourceEvent: event,
              }),
              payload: {
                content: slackWebhookAgentInput(event.payload),
              },
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
          args.runInBackground(appendAgentInput);
          return;
        }

        const slackEvent = parsed.data.event;
        const target = slackAgentTargetFromWebhookPayload(event.payload);
        const botBotId = state.botBotId ?? botBotIdFromPayload(event.payload);
        if (isOwnBotMessage(slackEvent, botBotId)) return;
        if (isBotAction(slackEvent, state.botUserId)) return;

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
          args.blockProcessorWhile(async () => {
            await this.ctx.stream.append({
              event: {
                type: "events.iterate.com/codemode/script-execution-requested",
                idempotencyKey: buildProcessorIdempotencyKey({
                  processor: this.contract,
                  key: "slack-bang-command-to-codemode-script",
                  sourceEvent: event,
                }),
                payload: {
                  code: bangCommand.code,
                  scriptExecutionId: `slack-bang-command-${event.offset}`,
                },
              },
            });
            await this.#addEyesReactionForMessageTarget(target);
          });
          return;
        }

        // Same ordering requirement: the agent input append commits before the
        // eyes reaction tells the user their message was picked up.
        args.blockProcessorWhile(async () => {
          await appendAgentInput();
          await this.#addEyesReactionForMessageTarget(target);
        });
        return;
      }
      case "events.iterate.com/codemode/function-call-requested":
        if (!isSlackAgentThreadInfoCall(event.payload)) return;
        args.runInBackground(async () => {
          await this.ctx.stream.append({
            event: {
              type: "events.iterate.com/codemode/function-call-completed",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: this.contract,
                key: "slack-agent-thread-info-function-call-completed",
                sourceEvent: event,
              }),
              payload: {
                durationMs: 0,
                functionCallId: event.payload.functionCallId,
                functionPath: event.payload.functionPath,
                invocationKind: event.payload.invocationKind,
                outcome:
                  state.channel == null || state.threadTs == null
                    ? {
                        status: "threw" as const,
                        error:
                          "ctx.slack.agent.threadInfo() is only available after Slack route context is configured.",
                      }
                    : {
                        status: "returned" as const,
                        value: {
                          channel: state.channel,
                          thread_ts: state.threadTs,
                          ...(state.streamPath == null ? {} : { streamPath: state.streamPath }),
                        },
                      },
                path: event.payload.path,
                providerPath: event.payload.providerPath,
                ...(event.payload.scriptExecutionId == null
                  ? {}
                  : { scriptExecutionId: event.payload.scriptExecutionId }),
              },
            },
          });
        });
        return;
      case "events.iterate.com/agent/status-updated":
      case "events.iterate.com/codemode/script-execution-requested":
      case "events.iterate.com/codemode/script-execution-completed": {
        const update = slackAgentStatusForEvent(event);
        if (update == null || state.channel == null || state.threadTs == null) return;
        const { channel, latestMessageTs, threadTs } = state;
        args.blockProcessorWhile(async () => {
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
        return assertNever(event);
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

function isSlackAgentThreadInfoCall(payload: {
  functionPath: readonly string[];
  invocationKind: string;
  providerPath: readonly string[];
}) {
  return (
    payload.invocationKind === "event" &&
    payload.providerPath.join(".") === "slack.agent" &&
    payload.functionPath.join(".") === "threadInfo"
  );
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

function compileBangCommand(input: {
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
        "async (ctx) => {",
        "  const debug = await ctx.debug();",
        "  await ctx.slack.chat.postMessage({",
        `    channel: ${JSON.stringify(input.channel)},`,
        `    thread_ts: ${JSON.stringify(input.threadTs)},`,
        "    text: `Debug info:\\n${debug}`,",
        "  });",
        "}",
      ].join("\n"),
    };
  }

  let expression = rawCommand.startsWith("ctx.") ? rawCommand : `ctx.${rawCommand}`;
  if (!expression.includes("(")) expression = `${expression}()`;

  const lines = ["async (ctx) => {", `  await ${expression};`, "}"];
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

  const messageTs = readString(slackEvent.ts) ?? readString(message?.ts);
  return {
    channel,
    ...(messageTs == null ? {} : { messageTs }),
    threadTs,
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

function slackAgentStatusForEvent(event: { payload: unknown; type: string }): {
  clear: boolean;
  status: { loading_messages?: string[]; status: string };
} | null {
  if (event.type === "events.iterate.com/agent/status-updated") {
    const payload = readRecord(event.payload);
    if (readString(payload?.status) === "working") {
      return {
        clear: false,
        status: { status: "is thinking...", loading_messages: ["Thinking..."] },
      };
    }
    if (readString(payload?.status) === "idle") {
      return { clear: true, status: { status: "" } };
    }
  }

  if (event.type === "events.iterate.com/codemode/script-execution-requested") {
    return {
      clear: false,
      status: { status: "is using tools...", loading_messages: ["Using tools..."] },
    };
  }
  if (event.type === "events.iterate.com/codemode/script-execution-completed") {
    return { clear: true, status: { status: "" } };
  }

  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
