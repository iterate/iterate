// The Admin app (apps/admin): a platform admin — a person `APP_CONFIG.admins` lists, signed in with
// the `admin` scope — sees every project and person, opens any context of a project or of the
// global namespace, and views the Dash as someone else for an hour: the session is theirs, every
// event names the admin beside them, and Stop impersonating signs the Dash back in as the admin.
import { expect, type Page } from "@playwright/test";
import { signInWithPassword } from "../test-support/issuer.ts";
import { test } from "../test-support/test.ts";

// the admin a per-PR preview and local dev both list (apps/os/scripts/preview-config.ts
// `PREVIEW_ADMIN_EMAIL`, generate-wrangler-config.ts)
const ADMIN_EMAIL = "admin@preview.iterate.test";

test("an admin opens any project's contexts and the global namespace, and views the Dash as another person", async ({
  page,
  helpers,
}) => {
  const dash = helpers.appOrigin("dash");
  // someone else's project, with a context in it; this browser is signed in to the issuer as them
  await using fixture = await helpers.createFixture("admin-target");
  const person = `forged-${fixture.project.slug}@example.com`;
  await fixture.itx
    .cd("/demo/one")
    .append({ type: "manual/note-added", payload: { text: "the person's own note" } });

  await test.step("sign in to the Admin app as the admin", async () => {
    // the app asks for its scopes (`iterate admin`) as it signs in (apps/admin/src/scopes.ts)
    await page.goto("/projects");
    // noWaitAfter: Switch account posts to the issuer's logout, navigating to sign-in, which the
    // Email field waits for
    await page
      .getByRole("button", { name: "Switch account", exact: true })
      .click({ noWaitAfter: true });
    await signInWithPassword(page, ADMIN_EMAIL);
    await authorize(page);
    await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  });

  await test.step("every project, and any context of one", async () => {
    await page.getByRole("link", { name: fixture.project.slug, exact: true }).click();
    await page
      .getByRole("navigation", { name: "Contexts" })
      .getByRole("link", { name: "/demo/one", exact: true })
      .click();
    await page.getByRole("log", { name: "Events" }).getByText("the person's own note").waitFor();
  });

  await test.step("the global namespace: the person's account context", async () => {
    await page.getByRole("link", { name: "Global", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Contexts" })
      .getByRole("link", { name: /^\/users\// })
      .first()
      .waitFor();
  });

  // view the Dash as the person, append as them, stop
  await page.getByRole("link", { name: "Users", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: person })
    .getByRole("link", { name: "View dash as", exact: true })
    .click();
  // noWaitAfter: View as posts to the issuer, which hands the browser back to the Dash through its
  // sign-in callback; the next locator waits for that (the spinner-waiter counts a navigation in
  // flight as loading), not the click's tight action timeout
  await page
    .getByRole("button", { name: `View as ${person}`, exact: true })
    .click({ noWaitAfter: true });
  const marker = page.getByRole("button", { name: "Stop impersonating", exact: true });
  await page.getByText(`You are ${ADMIN_EMAIL}`).waitFor();

  await page.goto(`${dash}/projects/${fixture.project.slug}/contexts/demo/one`);
  await page.getByRole("button", { name: "Append event", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Events to append" })
    .fill("type: manual/note-added\npayload: { text: appended while viewing as them }\n");
  await page.getByRole("button", { name: "Append", exact: true }).click();
  await page
    .getByRole("log", { name: "Events" })
    .getByText("appended while viewing as them")
    .waitFor();
  // the person is the event's principal; the admin is recorded beside them
  const appended = (await fixture.itx.cd("/demo/one").readEvents(0, 100)).events.find((event) =>
    JSON.stringify(event.payload).includes("viewing as them"),
  );
  const principal = appended?.source?.principal;
  expect([principal?.email, principal?.impersonatedBy?.email]).toEqual([person, ADMIN_EMAIL]);

  // noWaitAfter: Stop impersonating posts to the Dash's logout and signs in again, navigating; the
  // page it leaves shows the person's "Account", so every wait from here names the admin
  await marker.click({ noWaitAfter: true });
  await authorize(page);
  // the Dash is the admin's again
  await page
    .getByRole("button", { name: "Account", exact: true })
    .filter({ hasText: ADMIN_EMAIL })
    .waitFor();

  // the Admin app kept its own session throughout
  await page.goto("/projects");
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
});

/** The issuer's consent for an app, when it asks: Review permissions, then Authorize. It waits for
 *  consent or the app signed in as the admin, never any "Account": a page being left that shows
 *  someone else's would satisfy the wait before the navigation ends
 *  (specs/test-support/navigating-post.spec.ts). */
async function authorize(page: Page) {
  const review = page.getByRole("button", { name: "Review permissions", exact: true });
  const signedIn = page
    .getByRole("button", { name: "Account", exact: true })
    .filter({ hasText: ADMIN_EMAIL });
  await review.or(signedIn).waitFor();
  if (!(await review.isVisible())) return;
  await review.click();
  // noWaitAfter: Authorize posts and the issuer hands the browser back to the app
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
}
