import { test } from "./test-support/test.ts";

test("agent replies to a browser chat message in the feed", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("agent-chat");

  const agent = await fixture.createAgent({ useRealLlm: true });
  const existingEvents = await agent.stream.getEvents({ limit: 500 });
  const afterOffset = existingEvents.at(-1)?.offset ?? 0;

  await page.goto(agent.webUrl);

  const composer = page.getByPlaceholder("Message this agent");
  await composer.waitFor();
  await composer.fill("Name the most obvious bendy yellow fruit");
  await page.getByRole("button", { name: "Send message" }).click();

  const userMessages = page.locator(`[data-testid="agent-feed-message"][data-kind="user"]`);
  await userMessages.getByText("bendy yellow fruit").waitFor();

  await page.getByText(/banana/i).waitFor();

  // just for fun let's also make sure our waitForEvent is working, but the assertion above is the real playwright-y one
  await agent.stream.waitForEvent({
    afterOffset,
    eventTypes: ["events.iterate.com/agents/web-message-sent"],
    timeoutMs: 120_000,
    predicate: (event) => {
      const text = (event.payload as { message?: unknown } | undefined)?.message;
      return typeof text === "string" && /banana/i.test(text);
    },
  });
});
