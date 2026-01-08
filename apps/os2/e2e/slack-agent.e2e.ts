import { test, expect } from "@playwright/test";

test.describe("slack agent integration", () => {
  test("agent responds to slack message via sendSlackMessage tool", async ({
    request,
    baseURL,
  }) => {
    const threadTs = `test-slack-${Date.now()}`;
    const channel = "C123TEST";

    const slackWebhook = {
      type: "event_callback",
      team_id: "T123TEST",
      event: {
        type: "message",
        ts: threadTs,
        channel,
        user: "U123USER",
        text: "what is one plus two?",
      },
    };

    const webhookResponse = await request.post(`${baseURL}/daemon/edge/slack`, {
      data: slackWebhook,
      headers: { "Content-Type": "application/json" },
    });

    expect(webhookResponse.ok()).toBe(true);

    let foundSlackResponse = false;
    let responseText = "";

    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const messagesResponse = await request.get(
        `${baseURL}/daemon/agents/${encodeURIComponent(threadTs)}?offset=-1`,
      );

      if (!messagesResponse.ok()) continue;

      const messages = await messagesResponse.json();

      for (const message of messages) {
        if (message?.type === "slack_message_to_send" && message?.text) {
          responseText = message.text.toLowerCase();
          if (responseText.includes("three") || responseText.includes("3")) {
            foundSlackResponse = true;
            break;
          }
        }
      }

      if (foundSlackResponse) break;
    }

    expect(foundSlackResponse).toBe(true);
    expect(responseText).toMatch(/three|3/i);
  });
});
