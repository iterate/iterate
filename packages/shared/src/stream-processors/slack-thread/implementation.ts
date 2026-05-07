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
          await streamApi.append({
            event: {
              type: "events.iterate.com/agent/input-added",
              idempotencyKey: buildProcessorIdempotencyKey({
                processor: SlackThreadProcessorContract,
                key: "slack-webhook-to-agent-input",
                sourceEvent: event,
              }),
              payload: {
                content: `Slack webhook received:\n\`\`\`json\n${JSON.stringify(slackEvent, null, 2)}\n\`\`\``,
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
