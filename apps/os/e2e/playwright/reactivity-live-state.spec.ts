// The live-state primitive in a REAL browser: the reactivity playground renders
// three subscriptions and this proves they update without a reload — a stateless
// ticker advancing on its own, and a DO-backed counter incrementing on click.
// The node itx e2e (live-state.e2e.test.ts) proves the wire (snapshot → diffs,
// shared DO counter, stateless ticker); this proves the useLiveState hook paints
// them live.
//
// Gated like petshop: set REACTIVITY_APP_URL to a signed-in reactivity page on a
// deployed preview, e.g.
//   REACTIVITY_APP_URL="https://os.iterate-preview-3.com/projects/<slug>/reactivity" \
//     pnpm --dir apps/os playwright reactivity-live-state
import { expect, test } from "@playwright/test";

test("reactivity playground: the stateless ticker advances and the DO counter increments live", async ({
  page,
}) => {
  const appUrl = process.env.REACTIVITY_APP_URL;
  test.skip(!appUrl, "set REACTIVITY_APP_URL to a signed-in reactivity page");

  await page.goto(appUrl!);

  // The page connects (status flips to "live" once the subscriptions establish).
  await expect(page.getByTestId("reactivity-status")).toHaveText("live", { timeout: 15_000 });

  // STATELESS: the ticker advances on its own — no interaction, no reload. Read
  // it, wait, read again, expect a strictly greater number.
  const ticker = page.getByTestId("livedemo-ticker");
  await expect(ticker).not.toHaveText("…");
  const first = Number(await ticker.textContent());
  await expect
    .poll(async () => Number(await ticker.textContent()), { timeout: 10_000 })
    .toBeGreaterThan(first);

  // DO-BACKED: clicking Increment bumps the project DO's counter, and the push
  // repaints the count without a reload.
  const count = page.getByTestId("livedemo-count");
  await expect(count).not.toHaveText("…");
  const before = Number(await count.textContent());
  await page.getByTestId("livedemo-increment").click();
  await expect
    .poll(async () => Number(await count.textContent()), { timeout: 10_000 })
    .toBe(before + 1);
});
