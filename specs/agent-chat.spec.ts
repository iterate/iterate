import { spinnerWaiter } from "middlewright";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

// The feed marks settled chat messages with data-testid="agent-feed-message"
// + data-kind (agent-feed.tsx) — the intentional spec hooks, preferred over
// styling classes.
const assistantMessage = '[data-testid="agent-feed-message"][data-kind="assistant"]';
const userMessage = '[data-testid="agent-feed-message"][data-kind="user"]';
const ONBOARDING_AGENT_PATH = "/agents/onboarding";
const WEB_MESSAGE_SENT = "events.iterate.com/agents/web-message-sent";

test("onboarding agent replies to a chat message in the feed", async ({
  helpers,
  page,
  baseURL,
}) => {
  // Two full onboarding LLM turns (unprompted greeting can itself be multi-
  // script) plus UI paint. Under preview load a turn can exceed 90s, so this
  // gets the heavy-test ceiling (mirrors E2E_HEAVY_TEST_TIMEOUT_MS for the
  // vitest agent tests) — NOT more: with one retry, this spec's timeout is
  // the preview lane's worst-case tail (2× this value), and a wedged
  // onboarding agent should fail loudly, not stretch the lane.
  test.setTimeout(240_000);
  await using fixture = await helpers.createFixture("agent-chat");
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");

  // Backend wait (itx) is the durable signal that a turn finished; UI assert
  // confirms the feed painted the same event. Decouples LLM latency from
  // "did the stream subscription land in the browser".
  using admin = await connectAdminItx(baseURL);
  using project = admin.projects.get(fixture.project.id);
  using agent = project.agents.get(ONBOARDING_AGENT_PATH);

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
    // afterOffset: 0 — greeting may already be committed before we open the
    // wait (createFixture finishes after agent birth + kickoff).
    const greeting = await agent.stream.waitForEvent({
      afterOffset: 0,
      eventTypes: [WEB_MESSAGE_SENT],
      timeoutMs: 120_000,
    });
    await page.locator(assistantMessage).first().waitFor({ timeout: 30_000 });

    await page.getByPlaceholder("Message this agent").fill(message);
    await page.getByRole("button", { name: "Send message" }).click();

    await page.locator(userMessage).getByText(marker).waitFor({ timeout: 30_000 });

    await agent.stream.waitForEvent({
      afterOffset: greeting.offset,
      eventTypes: [WEB_MESSAGE_SENT],
      timeoutMs: 120_000,
      predicate: (event) => {
        const text = (event.payload as { message?: unknown } | undefined)?.message;
        return typeof text === "string" && text.includes(marker);
      },
    });
    await page
      .locator(assistantMessage)
      .filter({ hasText: marker })
      .first()
      .waitFor({ timeout: 30_000 });
  });
});
