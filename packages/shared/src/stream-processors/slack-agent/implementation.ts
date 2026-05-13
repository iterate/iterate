import type { SlackEvent } from "@slack/types";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { buildProcessorIdempotencyKey, implementProcessor } from "../stream-processor.ts";
import { standardProcessorBehavior } from "../core/standard-processor-behavior.ts";
import { SlackAgentProcessorContract } from "./contract.ts";

export type SlackAgentProcessorDeps = {
  callSlackApi?(method: string, body: Record<string, unknown>): Promise<void>;
};

export function createSlackAgentProcessor(deps: SlackAgentProcessorDeps = {}) {
  return implementProcessor(SlackAgentProcessorContract, {
    async afterAppend({ event, state, streamApi }) {
      await standardProcessorBehavior.afterAppend({
        contract: SlackAgentProcessorContract,
        state,
        streamApi,
      });

      switch (event.type) {
        case "events.iterate.com/slack/thread-route-configured":
          await streamApi.append({
            event: {
              type: "events.iterate.com/codemode/tool-provider-registered",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: SlackAgentProcessorContract,
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
          return;
        case "events.iterate.com/slack/webhook-received": {
          const parsed = z
            .object({
              type: z.literal("event_callback"),
              event: z.record(z.string(), z.unknown()),
            })
            .loose()
            .safeParse(event.payload.body);
          if (!parsed.success) {
            await streamApi.append({
              event: {
                type: "events.iterate.com/agent/input-added",
                idempotencyKey: buildProcessorIdempotencyKey({
                  processor: SlackAgentProcessorContract,
                  key: "slack-webhook-to-agent-input",
                  sourceEvent: event,
                }),
                payload: {
                  content: slackWebhookAgentInput(event.payload),
                },
              },
            });
            return;
          }

          const slackEvent = parsed.data.event as unknown as SlackEvent;
          const target = slackAgentTargetFromWebhookPayload(event.payload);
          if (target != null && !target.isBotMessage && !target.isReactionEvent) {
            await callSlackApi(deps, "reactions.add", {
              channel: target.channel,
              name: "eyes",
              timestamp: target.messageTs,
            });
          }
          if (isBotMessage(slackEvent)) return;
          if (isBotAction(slackEvent, state.botUserId)) return;

          const channel =
            target?.channel ?? state.channel ?? readStringField(slackEvent, "channel");
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
            await streamApi.append({
              event: {
                type: "events.iterate.com/codemode/script-execution-requested",
                idempotencyKey: buildProcessorIdempotencyKey({
                  processor: SlackAgentProcessorContract,
                  key: "slack-bang-command-to-codemode-script",
                  sourceEvent: event,
                }),
                payload: {
                  code: bangCommand.code,
                  scriptExecutionId: `slack-bang-command-${event.offset}`,
                },
              },
            });
            return;
          }

          await streamApi.append({
            event: {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: SlackAgentProcessorContract,
                key: "slack-webhook-to-agent-input",
                sourceEvent: event,
              }),
              payload: {
                content: slackWebhookAgentInput(event.payload),
              },
            },
          });
          return;
        }
        case "events.iterate.com/codemode/function-call-requested":
          if (!isSlackAgentThreadInfoCall(event.payload)) return;
          await streamApi.append({
            event: {
              type: "events.iterate.com/codemode/function-call-completed",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: SlackAgentProcessorContract,
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
          return;
        case "events.iterate.com/agent/status-updated":
        case "events.iterate.com/codemode/script-execution-requested":
        case "events.iterate.com/codemode/script-execution-completed": {
          const update = slackAgentStatusForEvent(event);
          if (update == null || state.channel == null || state.threadTs == null) return;
          await callSlackApi(deps, "assistant.threads.setStatus", {
            channel_id: state.channel,
            thread_ts: state.threadTs,
            ...update.status,
          });
          if (update.clear && state.latestMessageTs != null) {
            await callSlackApi(deps, "reactions.remove", {
              channel: state.channel,
              name: "eyes",
              timestamp: state.latestMessageTs,
            });
          }
          return;
        }
        default:
          return;
      }
    },
  });
}

async function callSlackApi(
  deps: SlackAgentProcessorDeps,
  method: string,
  body: Record<string, unknown>,
) {
  if (body.timestamp == null && (method === "reactions.add" || method === "reactions.remove")) {
    return;
  }
  if (deps.callSlackApi == null) return;

  try {
    await deps.callSlackApi(method, body);
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

function slackWebhookAgentInput(payload: unknown) {
  return [
    "`events.iterate.com/slack/webhook-received` event received",
    "",
    "Slack reply guidance: do not chime in just because this event arrived. Reply only when the bot was explicitly mentioned, the user directly asks or instructs you, or the surrounding thread context clearly calls for agent action. If this is FYI-only, output an empty codemode block and do not call `ctx.slack.chat.postMessage`.",
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

function isBotMessage(slackEvent: SlackEvent): boolean {
  if (readStringField(slackEvent, "subtype") === "bot_message") return true;
  if (readStringField(slackEvent, "bot_id") != null) return true;
  if (readRecordField(slackEvent, "bot_profile") != null) return true;
  return false;
}

/**
 * Returns true when the Slack event was performed by our own bot user (e.g.
 * our bot adding a reaction).
 */
function isBotAction(slackEvent: SlackEvent, botUserId: string | undefined): boolean {
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
