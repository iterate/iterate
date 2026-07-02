import { spinnerWaiter } from "middlewright";
import { test } from "./test-support/test.ts";

// The feed marks settled chat messages with data-testid="agent-feed-message"
// + data-kind (agent-feed.tsx) — the intentional spec hooks, preferred over
// styling classes.
const assistantMessage = '[data-testid="agent-feed-message"][data-kind="assistant"]';
const userMessage = '[data-testid="agent-feed-message"][data-kind="user"]';

test("onboarding agent replies to a chat message in the feed", async ({ helpers, page }) => {
  // Deviation from the suite's default timeout: two full LLM turns (the
  // unprompted greeting + our reply) don't fit the default budget.
  test.setTimeout(240_000);
  await using fixture = await helpers.createFixture("agent-chat");

  await page.goto(`/projects/${fixture.project.slug}/agents/streams/agents/onboarding`);

  // Phrasing mirrors the agents e2e suite: the onboarding prompt pulls the
  // model hard toward its own script, so the ask must be explicit about
  // sending a visible chat message with the token.
  const marker = `pong-${crypto.randomUUID().slice(0, 8)}`;
  const message = [
    `Please send a visible web chat message containing exactly this token: ${marker}`,
    "Use the chat tool. Do not only describe what you would do.",
  ].join("\n");

  // LLM round-trips are genuinely slow, so the waits here are generous but
  // bounded. Deviation from the suite's default middleware: the feed's live
  // "Thinking…" state renders two spinner-matching elements at once, which
  // trips spinner-waiter's strict-mode isVisible — use its documented
  // per-call override to sit this spec out.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    // The onboarding agent greets unprompted; let that turn settle first so
    // our message starts a clean turn instead of merging into the greeting.
    await page.locator(assistantMessage).first().waitFor({ timeout: 90_000 });

    await page.getByPlaceholder("Message this agent").fill(message);
    await page.getByRole("button", { name: "Send message" }).click();

    await page.locator(userMessage).getByText(marker).waitFor({ timeout: 30_000 });
    await page
      .locator(assistantMessage)
      .filter({ hasText: marker })
      .first()
      .waitFor({ timeout: 90_000 });
  });
});
