import { expect } from "@playwright/test";
import { test } from "./test-support/test.ts";

// Sessions are lazy: waking a Stream Durable Object BIRTHS it, so the REPL
// must not touch a session stream until the first Run. Merely visiting the
// REPL (bare or via New REPL) creates nothing; the first Run births exactly
// one stream, at the path the URL shows.
test("the REPL creates no session stream until the first Run", async ({ helpers, page }) => {
  await using fixture = await helpers.createFixture("repl-lazy");
  using project = await fixture.projectItx();
  const replStreams = async () =>
    (await project.streams.list())
      .map((stream) => stream.path)
      .filter((path) => path.startsWith("/repl/"));

  await test.step("bare /repl with no sessions renders unborn — URL stays bare", async () => {
    await page.goto(`/projects/${fixture.project.slug}/repl`);
    await page.getByRole("button", { name: "Run", exact: true }).waitFor();
    await page.getByTestId("itx-repl-editor").locator(".cm-content").waitFor();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(`/projects/${fixture.project.slug}/repl`);
  });

  await test.step("New REPL navigates to a fresh session URL — still nothing created", async () => {
    await page.getByTestId("itx-repl-new-session").click();
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/repl\/20[\w-]+z$/);
    // Deliberate settle window: an accidental wake (a read connection, a
    // preamble fetch) would journal stream/created within this. Proving
    // ABSENCE needs wall-clock — there is no UI to wait for.
    // timeout: absence window, nothing for the spinner-waiter to extend
    await page.waitForTimeout(1_500);
    await expect.poll(replStreams, { timeout: 5_000 }).toEqual([]); // timeout: poll budget — expect.poll is outside the spinner-waiter's reach
  });

  await test.step("the first Run births exactly one stream, at the URL's path", async () => {
    await page.getByTestId("itx-repl-editor").locator(".cm-content").fill("1 + 1");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    // timeout: the first Run does cold-project scope birth + typecheck + worker spin-up — far past the spinner-waiter's 30s ceiling
    await page
      .locator('[data-entry-index="0"][data-status="success"]')
      .waitFor({ timeout: 90_000 });
    const sessionSuffix = new URL(page.url()).pathname.split("/repl/")[1]!;
    await expect.poll(replStreams, { timeout: 30_000 }).toEqual([`/repl/${sessionSuffix}`]); // timeout: poll budget — expect.poll is outside the spinner-waiter's reach
  });
});
