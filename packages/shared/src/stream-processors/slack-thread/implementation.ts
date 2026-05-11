import type { SlackEvent } from "@slack/types";
import { z } from "zod";
import { buildProcessorIdempotencyKey, implementProcessor } from "../stream-processor.ts";
import { SlackThreadProcessorContract } from "./contract.ts";

export function createSlackThreadProcessor() {
  return implementProcessor(SlackThreadProcessorContract, {
    async afterAppend({ event, streamApi }) {
      switch (event.type) {
        case "events.iterate.com/slack/webhook-received": {
          /**
           * `slack` forwards the original Slack Events API callback to this
           * stream without changing it. This processor is intentionally the
           * first and only place in this POC that turns that Slack-shaped fact
           * into agent-shaped input.
           *
           * Example forwarded message body:
           *
           * ```json
           * {
           *   "type": "event_callback",
           *   "event": {
           *     "type": "app_mention",
           *     "channel": "C123",
           *     "ts": "1772136258.963519",
           *     "text": "<@U_BOT> ship it"
           *   }
           * }
           * ```
           *
           * The agent receives the Slack event mostly verbatim, wrapped with
           * enough source metadata to make future prompt formatting obvious.
           * We do not request Slack reactions or thread status here; the agent
           * will eventually do Slack writes through tools.
           */
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
                  "Slack event received for this agent thread.",
                  "",
                  "Response target:",
                  `- channel: ${channel ?? "unknown"}`,
                  `- thread_ts: ${threadTs ?? "unknown"}`,
                  "",
                  "When responding in Slack, use `ctx.slack.chat.postMessage({ channel, thread_ts, text })` with the response target above.",
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
