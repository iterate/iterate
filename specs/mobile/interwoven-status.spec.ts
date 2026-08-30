// Repro for the on-device stale-status bug (task
// mobile-interwoven-status.md): a turn whose script sends a chat message
// mid-turn AND returns a value splits into two activity cards with the
// reply bubble between them (known behavior — the reducer settles the live
// activity to flush the deferred bubble, and the next round's request
// births a new card). The bug: the SECOND card keeps wearing round 1's
// status even after its own script's first line set a new one.
//
//   user: "Inspect the refund API"
//   round 1 <codemode: Inspecting the refund API>
//     sendMessage("Checking that now.") + held GET /step-one + return value
//   → reply bubble flushes, card 1 settles, card 2 is born
//   round 2 <codemode: Extracting the voice brief>
//     held GET /step-two, sendMessage("All done."), return
//
// The key assertion: while round 2's script runs, the LIVE card shows
// round 2's status — not round 1's.

import { expect } from "@playwright/test";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { test } from "../test-support/test.ts";

test("a mid-turn reply doesn't strand the next round on the previous status", async ({
  page,
  helpers,
}) => {
  await using fixture = await helpers.createMobileFixture("mobile-interwoven");

  const stepOneHold = Promise.withResolvers<void>();
  const stepTwoHold = Promise.withResolvers<void>();
  await using api = await withTunnel({
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/step-one")) {
        await stepOneHold.promise;
        return Response.json({ found: true });
      }
      if (url.pathname.endsWith("/step-two")) {
        await stepTwoHold.promise;
        return Response.json({ brief: "the voice brief" });
      }
      return Response.json({ error: "unknown endpoint" }, { status: 404 });
    },
  });

  const agent = await fixture.createAgent({
    // big debounce so the between-rounds windows are observable
    llmRequestDebounceMs: 4_000,
  });
  await page.goto(agent.mobileUrl);

  // Round 1: status, the mid-turn reply (the weave), a held fetch, and a
  // returned value — the promise of another round.
  agent.responses.setOnce(`
    async (itx) => {
      await itx.agent.append({
        type: "events.iterate.com/agent/summary-updated",
        payload: { title: "Refund API check", activity: "Inspecting the refund API" },
      });
      await itx.chat.sendMessage("Checking that now.");
      const response = await fetch(${JSON.stringify(api.url + "/step-one")});
      return await response.json();
    }
  `);
  // Round 2: a NEW status on its first line, then a held fetch, a final
  // reply, and no return — turn over.
  agent.responses.set(`
    async (itx) => {
      await itx.agent.append({
        type: "events.iterate.com/agent/summary-updated",
        payload: { activity: "Extracting the voice brief" },
      });
      const response = await fetch(${JSON.stringify(api.url + "/step-two")});
      await itx.chat.sendMessage("All done.");
      return;
    }
  `);

  // insertText, not fill: RN-web's controlled multiline TextInput
  // intermittently fails fill's post-check (see approvals.spec.ts).
  await page.getByPlaceholder("Message").click();
  await page.keyboard.insertText("Inspect the refund API");
  await page.getByRole("button", { name: "Send" }).click();

  // ── Round 1 held mid-fetch: one live card wearing round 1's status.
  const liveCard = page.getByTestId(/^activity-card-/).filter({ has: page.getByLabel("Loading") });
  await liveCard.getByText("Inspecting the refund API").waitFor();
  await liveCard.getByLabel("running code").waitFor();

  // ── Release step one: the script settles WITH a value, which flushes the
  // deferred reply and splits the turn — bubble between two cards.
  stepOneHold.resolve();
  await page.getByText("Checking that now.").waitFor();

  // ── Round 2's script runs (held on step two). THE BUG: the live card kept
  // showing "Inspecting the refund API" here. It must wear round 2's status
  // once the script's first-line summary append folds (plus the 250ms
  // display debounce, which the held fetch outlasts by design).
  await liveCard.getByLabel("running code").waitFor();
  await liveCard.getByText("Extracting the voice brief").waitFor();
  // Pin the second card's identity now, for the post-settle header check.
  // timeout: attribute read of rendered state, outside the spinner-waiter
  const secondCardId = await liveCard.getAttribute("data-testid", { timeout: 10_000 });

  // ── Release step two: the turn ends; the SECOND card settles into round
  // 2's status, not round 1's.
  stepTwoHold.resolve();
  await page.getByText("All done.").waitFor();
  const secondCard = page.getByTestId(secondCardId!);
  await secondCard.getByLabel("Loading").waitFor({ state: "hidden" });
  await secondCard.getByText("Extracting the voice brief", { exact: false }).waitFor();

  // ── The weave itself: reply bubble between two settled cards (current,
  // deliberate split behavior — this assertion documents it).
  expect(await page.getByTestId(/^activity-card-/).count()).toBe(2);
});
