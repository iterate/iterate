// The live activity card's status row through one three-round agent turn,
// with the spec controlling the clock at each hand-off:
//
// - "running" (▶) is pinned open by a script awaiting a fetch this spec
//   releases when ready (one hold per fetching round).
// - "processing" (↻ — script settled with a value, next round owed) is
//   pinned open by a raised llmRequestDebounceMs.
// - "waiting" (⧗) is pinned open by round 2's responder awaiting a gate.
//
// Throughout, the card's text is the AGENT-SET status, not the generic
// "running code…"; after the turn settles the expanded card's rounds wear
// bare "1"/"2"/"3" headers.

import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { test } from "../test-support/test.ts";

test("the live card wears the agent-set status and a phase glyph per round", async ({
  page,
  helpers,
}) => {
  await using fixture = await helpers.createMobileFixture("mobile-live-status");

  // Each endpoint holds its response until the spec releases it — the
  // scripts hang mid-fetch, honestly "running", as long as assertions need.
  const docsHold = Promise.withResolvers<void>();
  const sweepHold = Promise.withResolvers<void>();
  await using refundApi = await withTunnel(async function (request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/docs")) {
      await docsHold.promise;
      return Response.json({ sweep: "POST /sweep?month=<month> — sweeps that month's refunds" });
    }
    if (url.pathname.endsWith("/sweep") && request.method === "POST") {
      await sweepHold.promise;
      return Response.json({ month: url.searchParams.get("month"), swept: 3 });
    }
    return Response.json({ error: "unknown endpoint" }, { status: 404 });
  });

  const agent = await fixture.createAgent({
    // big debounce so we notice when we're waiting for the LLM request to start
    llmRequestDebounceMs: 4_000,
  });
  await page.goto(agent.mobileUrl);
  page.videoMode?.setStartTime();

  // Three scripts in turn order: the first two return a value (another round
  // owed), the last reports and returns nothing, ending the turn.
  agent.responses.setOnce(`
    async (itx) => {
      await itx.agent.append({
        type: "events.iterate.com/agent/summary-updated",
        payload: { title: "Refund sweep", activity: "Getting API documentation" },
      });
      const response = await fetch(${JSON.stringify(refundApi.url + "/docs")});
      return await response.json();
    }
  `);
  // Round 2 stays "waiting" until the spec resolves this gate.
  const roundTwoHold = Promise.withResolvers<void>();
  agent.responses.setOnce(async () => {
    await roundTwoHold.promise;
    return [
      "```ts",
      `async (itx) => {
        await itx.agent.append({
          type: "events.iterate.com/agent/summary-updated",
          payload: { activity: "Sweeping March refunds" },
        });
        const response = await fetch(
          ${JSON.stringify(refundApi.url + "/sweep?month=march")},
          { method: "POST" },
        );
        return await response.json();
      }`,
      "```",
    ].join("\n");
  });
  agent.responses.set(`
    async (itx) => {
      await itx.agent.append({
         type: "events.iterate.com/agent/summary-updated",
         payload: { activity: "Reporting results" },
      });
      await itx.chat.sendMessage("Swept 3 March refunds");
    }
  `);

  // ── Round 1 held open mid-fetch: the agent-set status under ▶.
  await page.getByPlaceholder("Message").click();
  await page.keyboard.insertText("Sweep the March refunds");
  await page.getByRole("button", { name: "Send" }).click();
  const card = page.getByTestId(/^activity-card-/);
  await card.getByText("Getting API documentation").waitFor();
  await card.getByLabel("running code").waitFor();

  // ── Release the docs: ↻ for the debounce window, status text holds.
  docsHold.resolve();
  await card.getByLabel("processing result").waitFor();
  await card.getByText("Getting API documentation").waitFor();

  // ── Round 2's request opens against the gated responder: ⧗.
  await card.getByLabel("waiting for a response").waitFor();
  await card.getByText("Getting API documentation").waitFor();

  // ── Round 2 answers; its script hangs on the held POST: ▶ again.
  roundTwoHold.resolve();
  await card.getByText("Sweeping March refunds").waitFor();
  await card.getByLabel("running code").waitFor();

  // ── Release the sweep: round 3 reports and ends the turn.
  sweepHold.resolve();
  await page.getByText("Swept 3 March refunds").waitFor();
  await card.getByLabel("Loading").waitFor({ state: "hidden" });
  await card.getByText("Reporting results", { exact: false }).waitFor();

  // ── Tapping the chevron expands three rounds wearing bare number headers.
  await card.getByText("▸").click();
  await card.getByText("1", { exact: true }).waitFor();
  await card.getByText("2", { exact: true }).waitFor();
  await card.getByText("3", { exact: true }).waitFor();
});
