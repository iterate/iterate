import { test } from "./test-support/test.ts";

test("agent replies to a browser chat message in the feed", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("agent-chat");

  const agent = await fixture.createAgent({ useRealLlm: true });

  await page.goto(agent.webUrl);

  const composer = page.getByPlaceholder("Message this agent");
  await composer.waitFor();
  await composer.fill("Name the most obvious bendy yellow fruit");
  await page.getByRole("button", { name: "Send message" }).click();

  const userMessages = page.locator(`[data-testid="agent-feed-message"][data-kind="user"]`);
  await userMessages.getByText("bendy yellow fruit").waitFor();

  await page.getByText(/banana/i).waitFor();
});
