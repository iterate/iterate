// The platform's sign-in page and a link naming a test person (`/login?login_hint=`, the PR body's
// `Sign in ↗` for an app with no sign-in of its own): it offers signing in as them to a platform
// admin, for a person under the deployment's test email domain, and to nobody else, for nobody
// else. The link grants nothing either way. The admin confirming it and landing on the app:
// specs/notes/test-person-link.spec.ts.
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { expect } from "@playwright/test";
import { TEST_EMAIL_DOMAIN } from "../../apps/os/src/test-email-domain.ts";
import { signInWithPassword } from "../test-support/issuer.ts";
import { openOperatorSession } from "../test-support/operator.ts";
import { test } from "../test-support/test.ts";

// the admin a per-commit deployment and local dev both list (envs.ts `previewDeployment`,
// apps/os/scripts/generate-wrangler-config.ts)
const ADMIN_EMAIL = `admin@${TEST_EMAIL_DOMAIN}`;

test("someone who is not an admin following a test person's link signs in as themselves, and is offered nothing", async ({
  page,
}) => {
  const slug = uniqueFixtureSlug("link-member");
  const person = `${slug}@${TEST_EMAIL_DOMAIN}`;
  using operator = openOperatorSession();
  using _project = await operator
    .authenticate({ email: person })
    .projects.create({ project: slug });
  const someone = `${uniqueFixtureSlug("not-admin")}@${TEST_EMAIL_DOMAIN}`;

  await page.goto(`/login?${new URLSearchParams({ next: "/", login_hint: person })}`);
  await signInWithPassword(page, someone);
  // back on the sign-in page, which a link naming a test person returns to: signed in as
  // themselves, with only the way on
  await page.getByText(`Signed in as ${someone}.`).waitFor();
  await page.getByRole("link", { name: "Continue", exact: true }).waitFor();
  expect(await page.getByRole("button", { name: `Sign in as ${person} for an hour` }).count()).toBe(
    0,
  );
});

test("an admin is offered signing in as the test person a link names, and never as someone outside the test email domain", async ({
  page,
}) => {
  const slug = uniqueFixtureSlug("link-admin");
  const person = `${slug}@${TEST_EMAIL_DOMAIN}`;
  const outsider = `${slug}@example.com`;
  using operator = openOperatorSession();
  using _theirs = await operator.authenticate({ email: person }).projects.create({ project: slug });
  using _outsiders = await operator
    .authenticate({ email: outsider })
    .projects.create({ project: `${slug}-outside` });
  const link = (hint: string) => `/login?${new URLSearchParams({ next: "/", login_hint: hint })}`;

  await page.goto(link(person));
  await signInWithPassword(page, ADMIN_EMAIL);
  await page
    .getByRole("button", { name: `Sign in as ${person} for an hour`, exact: true })
    .waitFor();
  // a real person, as on prd, which has no test email domain: the admin stays themselves
  await page.goto(link(outsider));
  await page.getByText(`Signed in as ${ADMIN_EMAIL}.`).waitFor();
  await page.getByRole("link", { name: "Continue", exact: true }).waitFor();
  expect(await page.getByRole("button", { name: /^Sign in as / }).count()).toBe(0);
});
