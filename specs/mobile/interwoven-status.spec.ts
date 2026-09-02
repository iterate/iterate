// A turn whose script replies mid-turn AND returns a value splits into two
// cards with the bubble between them — and each card must wear its OWN
// round's status. Regression guard for the stale-status bug: the status
// append can journal after the settle that flushed the card, and only the
// source.script stamp places it on the right one.

import { expect } from "@playwright/test";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { test } from "../test-support/test.ts";

test("a mid-turn reply doesn't strand the next round on the previous status", async ({
  page,
  helpers,
}) => {
  await using fixture = await helpers.createMobileFixture("mobile-interwoven");

  // Each endpoint holds its response until the spec releases it.
  const stepOneHold = Promise.withResolvers<void>();
  const stepTwoHold = Promise.withResolvers<void>();
  await using api = await withTunnel(async function (request) {
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
  });

  // The held fetches pin every asserted state — no raised debounce needed.
  const agent = await fixture.createAgent();
  await page.goto(agent.mobileUrl);

  agent.responses.setOnce(`
    async (itx) => {
      await itx.agent.append({
        type: "events.iterate.com/agent/summary-updated",
        payload: { title: "Refund API check", activity: "Inspecting the refund API" },
      });
      await itx.chat.sendMessage("Checking that now.");
      const response = await fetch("${api.url}/step-one");
      return await response.json();
    }
  `);
  agent.responses.set(`
    async (itx) => {
      await itx.agent.append({
        type: "events.iterate.com/agent/summary-updated",
        payload: { activity: "Extracting the voice brief" },
      });
      const response = await fetch("${api.url}/step-two");
      await itx.chat.sendMessage("All done.");
      return;
    }
  `);

  // ── Round 1 held mid-fetch: one live card, round 1's status.
  await page.getByPlaceholder("Message").click();
  await page.keyboard.insertText("Inspect the refund API");
  await page.getByRole("button", { name: "Send" }).click();
  const liveCard = page.getByTestId(/^activity-card-/).filter({ has: page.getByLabel("Loading") });
  await liveCard.getByText("Inspecting the refund API").waitFor();
  await liveCard.getByLabel("running code").waitFor();

  // ── Release: the returned value + deferred reply split the turn.
  stepOneHold.resolve();
  await page.getByText("Checking that now.").waitFor();

  // ── Round 2 held mid-fetch: the SECOND card wears round 2's status.
  await liveCard.getByLabel("running code").waitFor();
  await liveCard.getByText("Extracting the voice brief").waitFor();
  // timeout: attribute read of rendered state, outside the spinner-waiter
  const secondCardId = await liveCard.getAttribute("data-testid", { timeout: 10_000 });

  // ── Turn over: the second card settles into round 2's status, not round 1's.
  stepTwoHold.resolve();
  await page.getByText("All done.").waitFor();
  const secondCard = page.getByTestId(secondCardId!);
  await secondCard.getByLabel("Loading").waitFor({ state: "hidden" });
  await secondCard.getByText("Extracting the voice brief", { exact: false }).waitFor();
  expect(await page.getByTestId(/^activity-card-/).count()).toBe(2);
});
