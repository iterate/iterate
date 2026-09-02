// A fresh chat starts as its raw stream path (all the client has before the
// agent's first turn), then an agent-set title takes over both surfaces that
// read it: the thread header live off the event stream, and the chat list
// row via the agent catalog. ZERO model turns — the spec appends the same
// summary-updated fact a real turn opens with.

import { spinnerWaiter } from "middlewright";
import { test } from "../test-support/test.ts";

const TITLE = "Refund sweep for March";

test("a chat wears its agent-set title in the thread header and chat list", async ({
  page,
  helpers,
}) => {
  await using fixture = await helpers.createMobileFixture("mobile-chat-titles");
  const { itx } = fixture;

  // Read the new chat's path off the screen the way a user would — the header
  // is the only place it exists yet (role=heading keeps this from matching
  // message text).
  await page.getByText("New chat").click();
  const pathHeading = page.getByRole("heading", { name: /^mobile\// });
  await pathHeading.waitFor();
  const pathFallback = await pathHeading.textContent();
  const agentPath = `/agents/${pathFallback}`;

  // The client defers agent creation to the first message — and this spec
  // never sends one, so birth the agent explicitly before appending.
  const agent = await itx.agents.get(agentPath).create();
  await agent.append({
    type: "events.iterate.com/agent/summary-updated",
    payload: { title: TITLE, activity: "Emailing customers about refunds" },
  });

  // The header reads the title live off the thread's own event stream.
  await page.getByRole("heading", { name: TITLE }).waitFor();

  // Back on the chat list, THIS chat's row wears the title. The rename races
  // the first paint with no product spinner in between, so the stale row
  // (still showing the raw path) is taught to the spinner waiter as loading
  // UI.
  await page.getByRole("link", { name: `${fixture.projectSlug}, back` }).click();
  await spinnerWaiter.settings.run(
    { spinnerSelectors: [`:has-text(${JSON.stringify(pathFallback)})`] },
    async () => {
      await page.getByTestId(`chat-list-row:${agentPath}`).getByText(TITLE).waitFor();
    },
  );
});
