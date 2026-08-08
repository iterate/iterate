import { spinnerWaiter } from "middlewright";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

// The feed marks settled chat messages with data-testid="agent-feed-message"
// + data-kind (agent-feed.tsx) — the intentional spec hooks, preferred over
// styling classes.
const assistantMessage = '[data-testid="agent-feed-message"][data-kind="assistant"]';
const userMessage = '[data-testid="agent-feed-message"][data-kind="user"]';
const WEB_MESSAGE_SENT = "events.iterate.com/agents/web-message-sent";

test("agent replies to a browser chat message in the feed", async ({ helpers, page, baseURL }) => {
  // One LLM turn plus UI paint.
  test.setTimeout(240_000);
  await using fixture = await helpers.createFixture("agent-chat");
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");

  // Backend wait (itx) is the durable signal that a turn finished; UI assert
  // confirms the feed painted the same event. Decouples LLM latency from
  // "did the stream subscription land in the browser".
  using admin = await connectAdminItx(baseURL);
  using project = admin.projects.get(fixture.project.id);
  const agentPath = `/agents/e2e-chat-${crypto.randomUUID().slice(0, 8)}`;
  using agent = project.agents.get(agentPath);
  await agent.create();
  const existingEvents = await agent.stream.getEvents({ limit: 500 });
  const afterOffset = existingEvents.at(-1)?.offset ?? 0;

  await page.goto(`/projects/${fixture.project.slug}/agents/streams${agentPath}`);

  // The token is a plain word, NOT a random slug: models echo simple words
  // into chat text reliably, but
  // preview-tier models drop uuid-ish tokens (observed live on llama-4-scout
  // 2026-07-10: three marker-less replies to a `pong-8f3a2b1c` ask). The spec
  // proves message->reply routing; content fidelity for machine-significant
  // strings is proven by the vitest agent tests, whose markers ride inside
  // script code where models copy them faithfully. No collision risk: each
  // spec instance owns a fresh agent stream.
  const marker = "kumquat";
  const message = [
    `Please send a visible web chat message containing exactly this word: ${marker}`,
    "Use the chat tool. Do not only describe what you would do.",
  ].join("\n");

  // LLM round-trips are genuinely slow, so the waits here are generous but
  // bounded. Deviation from the suite's default middleware: the feed's live
  // "Thinking…" state renders two spinner-matching elements at once, which
  // trips spinner-waiter's strict-mode isVisible — use its documented
  // per-call override to sit this spec out.
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    const composer = page.getByPlaceholder("Message this agent");
    // This is route readiness, not an LLM wait; bound it explicitly before
    // interacting with the deliberately tight default action budget.
    await composer.waitFor({ timeout: 30_000 });
    await composer.fill(message);
    await page.getByRole("button", { name: "Send message" }).click({ timeout: 30_000 });

    await page.locator(userMessage).getByText(marker).waitFor({ timeout: 30_000 });

    await agent.stream.waitForEvent({
      afterOffset,
      eventTypes: [WEB_MESSAGE_SENT],
      timeoutMs: 120_000,
      predicate: (event) => {
        const text = (event.payload as { message?: unknown } | undefined)?.message;
        return typeof text === "string" && text.toLowerCase().includes(marker);
      },
    });
    await page
      .locator(assistantMessage)
      .filter({ hasText: marker })
      .first()
      .waitFor({ timeout: 30_000 });
  });
});
