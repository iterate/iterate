// The live activity card's status row, held open at every phase and read
// entirely from the UI. One chat turn on an intercepted/* model plays a
// coherent three-round story — the shape a real agent turn takes:
//
//   user: "Sweep the March refunds"
//   round 1 <codemode: Getting API documentation>  GET  the sweep API docs
//   round 2 <codemode: Sweeping March refunds>     POST /sweep?month=march
//   round 3 <codemode: Reporting results>          sendMessage, return
//
// and the spec controls the clock at each hand-off:
//
// - "running code" is pinned open by a script awaiting a fetch against THIS
//   spec's tunnel — the response resolves only when the spec releases it
//   (the egress hold as a plain-JS lock; one hold per fetching round).
// - the "processing" gap (script settled WITH a returned value ⇒ another LLM
//   round is owed, but no request journaled yet) is pinned open by a raised
//   llmRequestDebounceMs — the gap IS the debounce window.
// - round 2's "waiting" is pinned open by its queued responder awaiting a
//   spec-side gate before returning the script.
//
// Through all of it the card's text is the AGENT-SET status (the
// summary-updated append on each running script's first line), not the
// generic "running code…", and the phase glyph next to the spinner tracks
// ▶ running → ↻ processing → (nothing) waiting. After the turn settles, the
// expanded card's three rounds wear bare "1"/"2"/"3" headers.
//
// Every wait is a UI wait: the working row now spans the request debounce
// (this branch's turnPending fold) and the live card's spinner covers the
// rest, so the spinner-waiter budgets everything — no journal waits, no
// manual timeouts.

import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { test } from "../test-support/test.ts";

test("the live card wears the agent-set status and a phase glyph per round", async ({
  page,
  helpers,
}) => {
  await using fixture = await helpers.createMobileFixture("mobile-live-status");

  // The fake refund API. Each endpoint parks its response until the spec
  // resolves that round's hold — the scripts hang mid-fetch, honestly
  // "running", for exactly as long as the assertions need.
  const docsHold = Promise.withResolvers<void>();
  const sweepHold = Promise.withResolvers<void>();
  await using refundApi = await withTunnel({
    async fetch(request) {
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
    },
  });

  const agent = await fixture.createAgent({
    // big debounce so we notice when we're waiting for the LLM request to start
    llmRequestDebounceMs: 4_000,
  });
  await page.goto(agent.mobileUrl);

  // The turn's three scripts, queued in order. Each opens with the status
  // append a real turn opens with (AGENT_SUMMARY_INSTRUCTION); the first two
  // return a value — the promise of another round — and the last reports and
  // returns nothing, ending the turn. (A retried attempt replays the same
  // script — the queue fingerprints calls.)
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
  // Round 2 stays "waiting" until the spec resolves this gate — the window
  // where the card knows nothing stronger than "a request is open".
  const roundTwoGate = Promise.withResolvers<void>();
  agent.responses.setOnce(async () => {
    await roundTwoGate.promise;
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

  // ── Send, then round 1 held open mid-fetch: the working row spins through
  // the debounce, the live card takes over, and the summary row reads the
  // agent-set status under the ▶ glyph.
  // insertText, not fill: RN-web's controlled multiline TextInput
  // intermittently fails fill's post-check (see approvals.spec.ts).
  await page.getByPlaceholder("Message").click();
  await page.keyboard.insertText("Sweep the March refunds");
  await page.getByRole("button", { name: "Send" }).click();
  const card = page.getByTestId(/^activity-card-/);
  await card.getByText("Getting API documentation").waitFor();
  await card.getByLabel("running code").waitFor();

  // ── Release the docs: the script settles with a value, and for the next
  // debounce window the card shows ↻ — still under the agent's own status
  // text, set a round ago in this same turn.
  docsHold.resolve();
  await card.getByLabel("processing result").waitFor();
  await card.getByText("Getting API documentation").waitFor();

  // ── The debounce elapses, round 2's request opens, and its responder is
  // parked: nothing stronger than "waiting" is known, so the glyph retires
  // and the status text carries the row alone.
  await page.getByTestId("live-phase-glyph").waitFor({ state: "hidden" });
  await card.getByText("Getting API documentation").waitFor();

  // ── Round 2 answers and its script hangs on the held POST: the status
  // advances to the sweep and the ▶ glyph returns.
  roundTwoGate.resolve();
  await card.getByText("Sweeping March refunds").waitFor();
  await card.getByLabel("running code").waitFor();

  // ── Release the sweep: round 3 reports and ends the turn; the card
  // settles into the last status this turn set.
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
