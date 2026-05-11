import type { SlackEvent } from "@slack/types";
import { z } from "zod";
import { buildProcessorIdempotencyKey, implementProcessor } from "../stream-processor.ts";
import { SlackThreadProcessorContract } from "./contract.ts";

export function createSlackThreadProcessor() {
  return implementProcessor(SlackThreadProcessorContract, {
    async afterAppend({ event, streamApi }) {
      switch (event.type) {
        case "events.iterate.com/slack/webhook-received": {
          const parsed = z
            .object({
              type: z.literal("event_callback"),
              event: z.record(z.string(), z.unknown()),
            })
            .loose()
            .safeParse(event.payload.body);
          if (!parsed.success) return;

          const slackEvent = parsed.data.event as unknown as SlackEvent;
          if (isBotMessage(slackEvent)) return;

          const bangCommand = compileBangCommand(slackEvent);
          if (bangCommand != null) {
            await streamApi.append({
              event: {
                type: "events.iterate.com/codemode/script-execution-requested",
                idempotencyKey: buildProcessorIdempotencyKey({
                  processor: SlackThreadProcessorContract,
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

          const channel = readStringField(slackEvent, "channel");
          const threadTs =
            readStringField(slackEvent, "thread_ts") ??
            readNestedMessageStringField(slackEvent, "thread_ts") ??
            readStringField(slackEvent, "ts");

          await streamApi.append({
            event: {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: SlackThreadProcessorContract,
                key: "slack-webhook-to-agent-input",
                sourceEvent: event,
              }),
              payload: {
                content: [
                  "Slack message received.",
                  "",
                  "Response target:",
                  `- channel: ${channel ?? "unknown"}`,
                  `- thread_ts: ${threadTs ?? "unknown"}`,
                  "",
                  "Slack event:",
                  "```json",
                  JSON.stringify(slackEvent, null, 2),
                  "```",
                ].join("\n"),
              },
            },
          });
          return;
        }
        default:
          return;
      }
    },
  });
}

function isBotMessage(slackEvent: SlackEvent): boolean {
  if (readStringField(slackEvent, "subtype") === "bot_message") return true;
  if (readStringField(slackEvent, "bot_id") != null) return true;
  return false;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function readNestedMessageStringField(value: unknown, key: string): string | undefined {
  if (value == null || typeof value !== "object") return undefined;
  return readStringField((value as Record<string, unknown>).message, key);
}

function compileBangCommand(slackEvent: SlackEvent): { code: string } | null {
  const message = readStringField(slackEvent, "text")?.trim();
  if (!message) return null;

  const withoutMention = message.replace(/^<@[^>]+>\s*/i, "").trim();
  if (!withoutMention.startsWith("!")) return null;

  const rawCommand = withoutMention.slice(1).trim();
  if (!rawCommand) return null;

  let expression = rawCommand.startsWith("ctx.") ? rawCommand : `ctx.${rawCommand}`;
  if (!expression.includes("(")) expression = `${expression}()`;

  const lines = [
    "async (ctx) => {",
    `  // this snippet was invoked as a bang-command by the slack processor in response to the user typing ${JSON.stringify(message)}; bang-commands are deterministic commands often requested by the user to e.g. debug a session`,
    `  const result = await ${expression};`,
    "  if (result === undefined) return;",
    '  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);',
    "  const thread = await ctx.slack.threadInfo();",
    "  await ctx.slack.chat.postMessage({",
    "    channel: thread.channel,",
    "    thread_ts: thread.thread_ts,",
    "    text,",
    "  });",
    "}",
  ];
  return { code: lines.join("\n") };
}
