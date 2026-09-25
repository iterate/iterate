// specs/AGENTS.md "After a click that navigates": a wait for what only the next page shows
// outlasts a post slower than the 1 s action timeout. The page being left answers "not there", and
// once the browser has the navigation, Playwright's queries wait for the next document.
import { test } from "./test.ts";

test.beforeEach(async ({ page }) => {
  // the logout answers after 2 s, twice the action timeout
  await page.route("https://app.test/logout", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fulfill({
      contentType: "text/html",
      body: `<main><button aria-label="Account">admin@example.com</button></main>`,
    });
  });
});

for (const [when, submit] of [
  ["at once", "this.form.requestSubmit()"],
  // the leaving page is still there when the wait first looks
  ["after the wait first looks", "setTimeout(() => this.form.requestSubmit(), 200)"],
] as const) {
  test(`a wait for what only the next page shows outlasts a slow post submitted ${when}`, async ({
    page,
  }) => {
    // the Dash viewed as someone: their "Account", and Stop impersonating, which posts to logout
    await page.setContent(
      `<main><button aria-label="Account">person@example.com</button><form method="post" action="https://app.test/logout"><button type="button" onclick="${submit}">Stop impersonating</button></form></main>`,
    );
    await page
      .getByRole("button", { name: "Stop impersonating", exact: true })
      .click({ noWaitAfter: true });
    await page
      .getByRole("button", { name: "Account", exact: true })
      .filter({ hasText: "admin@example.com" })
      .waitFor();
  });
}
