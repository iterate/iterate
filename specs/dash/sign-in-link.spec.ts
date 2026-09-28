// A PR body's `Sign in ↗` (apps/os/scripts/preview.ts `signInLinks`): an app's own sign-in that
// names the PR's test person. The link is public and grants nothing. An admin signed in to the
// issuer opens it, the consent page opens on "Sign in as someone else" with that person filled in,
// and one confirm signs the Dash in as them, inside their project, for an hour. On a preview a
// reviewer signs in to the issuer through prd (apps/os/src/admin-sign-in.ts), which no spec can
// hold, so this spec signs in as the preview's test admin with the password; the second spec checks
// that the sign-in page sends prd's admins to prd, asking only who they are.
import { expect } from "@playwright/test";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { TEST_EMAIL_DOMAIN } from "../../apps/os/src/test-email-domain.ts";
import { signInWithPassword } from "../test-support/issuer.ts";
import { openOperatorSession } from "../test-support/operator.ts";
import { test } from "../test-support/test.ts";

// the admin a per-commit deployment and local dev both list (envs.ts `previewDeployment`,
// apps/os/scripts/generate-wrangler-config.ts)
const ADMIN_EMAIL = `admin@${TEST_EMAIL_DOMAIN}`;

test("the PR body's Sign in link: an admin confirms once, and the Dash is the test person's, inside their project", async ({
  page,
  helpers,
}) => {
  const dash = helpers.appOrigin("dash");
  // the PR's test person and their project, as CI seeds them (preview.ts `seedSignIn`)
  const slug = uniqueFixtureSlug("pr-link");
  const person = `${slug}@${TEST_EMAIL_DOMAIN}`;
  using operator = openOperatorSession();
  using _project = await operator
    .authenticate({ email: person })
    .projects.create({ project: slug });

  await page.goto(
    `${dash}/.auth/login?${new URLSearchParams({ next: `/projects/${slug}`, login_hint: person })}`,
  );
  // the link signs nobody in: the issuer asks who this browser is first
  await signInWithPassword(page, ADMIN_EMAIL);
  // an admin, the consent page opens on signing the Dash in as the person the link names
  await page
    .getByRole("button", { name: `Sign iterate Dash in as ${person} for an hour`, exact: true })
    .click({ noWaitAfter: true });
  // every client app's shell (packages/ui app-shell.tsx) names the active project in its switcher,
  // and an impersonated session names the admin beside the person
  await page.getByRole("button", { name: "Switch project" }).filter({ hasText: slug }).waitFor();
  await page.getByText(`You are ${ADMIN_EMAIL}`).waitFor();
  const landed = new URL(page.url());
  expect({ origin: landed.origin, pathname: landed.pathname }).toEqual({
    origin: dash,
    pathname: `/projects/${slug}`,
  });
});

test("on a preview, the sign-in page sends prd's admins to prd, asking only who they are, as the preview's own client", async ({
  page,
  helpers,
}) => {
  const dash = helpers.appOrigin("dash");
  test.skip(
    !new URL(dash).hostname.endsWith(".workers.dev"),
    "only a preview's admins sign in through prd",
  );
  await page.goto(`${dash}/.auth/login?next=%2F`);
  const signIn = page.getByRole("link", { name: "Continue with os.iterate.com", exact: true });
  const start = new URL((await signIn.getAttribute("href"))!, page.url());
  const response = await page.request.get(start.href, { maxRedirects: 0 });
  const authorize = new URL(response.headers().location!);
  expect({
    status: response.status(),
    at: `${authorize.origin}${authorize.pathname}`,
    clientId: authorize.searchParams.get("client_id"),
    resource: authorize.searchParams.getAll("resource"),
  }).toEqual({
    status: 302,
    at: `${PRD_ISSUER}/oauth2/auth`,
    clientId: `${start.origin}/.auth/admin-sign-in/client.json`,
    resource: [`${PRD_ISSUER}/oauth2/userinfo`],
  });
});

/** Where every per-commit deployment's admins sign in (envs.ts `previewDeployment`'s `adminIssuer`). */
const PRD_ISSUER = "https://os.iterate.com";
