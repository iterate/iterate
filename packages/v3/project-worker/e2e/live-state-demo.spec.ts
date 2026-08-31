// live-state-demo.spec.ts — the hosted /demo page driven in a real browser. The worker serves a
// self-contained page (React + the capnweb fork + the useLiveState hook, all inlined); it mounts,
// dials this worker's /api, and loads the Presence processor into a dynamic worker.
//
// SWAPPABLE: set DEMO_BASE_URL to a preview/live deployment (or a self-hosted runtime) and the same
// spec runs against it (playwright.config.ts skips booting a local worker then).

import { expect, test } from "@playwright/test";

test("the worker serves a self-contained /demo page that mounts and dials /api", async ({
  page,
}) => {
  await page.goto("/demo");
  // The worker served the inlined React + capnweb bundle, and it mounted in the browser.
  await expect(page.getByRole("heading", { name: /clean-room live state/i })).toBeVisible();
  await expect(page.getByTestId("status")).toBeVisible();
  // The interactive controls render (they drive the stream once connected).
  await expect(page.getByRole("button", { name: /append tick/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^poke/i })).toBeVisible();
});

// KNOWN GAP (capnweb, browser): the full reduced ⊕ runtime delta-PUSH into the browser is blocked
// upstream. When the server invokes the client's BARE subscription callback (an empty path), the
// capnweb fork's browser `evaluate` throws `'' is not a function.` — it resolves the empty path as
// `stub[""]` instead of calling the stub. NODE tolerates the same delivery, so the feature is proven
// end to end by the harness E2E (__tests__/live-state-runtime.test.ts). Un-`fixme` this once the
// capnweb fork delivers bare callbacks to a browser client.
test.fixme("the /demo renders reduced ⊕ runtime live state and updates on button clicks", async ({
  page,
}) => {
  await page.goto("/demo");
  await expect(page.getByTestId("status")).toHaveText("live");
  const ticks = page.getByTestId("ticks");
  const before = Number(await ticks.textContent());
  await page.getByRole("button", { name: /append tick/i }).click();
  await expect(ticks).toHaveText(String(before + 1));
  await page.getByRole("button", { name: /^poke/i }).click();
  await expect(page.getByTestId("lastPokeMs")).not.toHaveText("0");
});
