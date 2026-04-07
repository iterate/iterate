import { defineProcessor } from "ai-engineer-workshop";
import { readSlackWebhook, slackMessageAddedType } from "./slack-input-types.ts";

export function createSlackInputProcessor() {
  return defineProcessor(() => ({
    slug: "slack-input",
    initialState: null,

    async afterAppend({ append, event }) {
      const webhook = readSlackWebhook(event);
      if (webhook == null) {
        return;
      }

      // This processor only normalizes raw Slack-shaped JSON into one clean event.
      await append({
        event: {
          type: slackMessageAddedType,
          payload: {
            ...webhook,
            prompt: [
              "Please process this event.",
              "",
              "```yaml",
              `type: ${slackMessageAddedType}`,
              `text: ${JSON.stringify(webhook.text)}`,
              `responseUrl: ${JSON.stringify(webhook.responseUrl)}`,
              "```",
            ].join("\n"),
          },
        },
      });
    },
  }));
}
