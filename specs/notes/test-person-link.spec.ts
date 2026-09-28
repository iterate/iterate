// A PR body's Notes `Sign in ↗` (apps/os/scripts/preview.ts `signInLinks`). Notes has no sign-in of
// its own: under paths ingress it runs on the platform's session, so the link is the platform's
// sign-in page naming the PR's test person, landing on Notes in their project. The link grants
// nothing: an admin signs in as themselves, is offered signing in as the person, and confirms once.
// On a preview a reviewer signs in through prd, which no spec can hold, so this spec signs in as the
// preview's test admin with the password (as specs/dash/sign-in-link.spec.ts does). Who is offered
// nothing: specs/os/sign-in-as-test-person.spec.ts.
import { expect } from "@playwright/test";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { proxiedAppRoute, proxiedAppSignInLink } from "../../apps/os/scripts/preview-config.ts";
import { TEST_EMAIL_DOMAIN } from "../../apps/os/src/test-email-domain.ts";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { signInWithPassword } from "../test-support/issuer.ts";
import { openOperatorSession } from "../test-support/operator.ts";
import { test } from "../test-support/test.ts";
import { workerBaseUrl } from "../test-support/worker-base-url.ts";

// the admin a per-commit deployment and local dev both list (envs.ts `previewDeployment`,
// apps/os/scripts/generate-wrangler-config.ts)
const ADMIN_EMAIL = `admin@${TEST_EMAIL_DOMAIN}`;

test("the PR body's Notes link: an admin confirms once on the platform's sign-in page, and Notes is the test person's, in their project", async ({
  page,
  helpers,
}) => {
  const { ingressRouting } = readOsPlaywrightAuthConfig();
  test.skip(
    ingressRouting?.type !== "paths",
    "under subdomains a project's app is an origin of its own, with its own sign-in",
  );
  // the PR's test person and their project, serving the Notes under test as CI's seed does
  // (preview.ts `seedSignIn`)
  const slug = uniqueFixtureSlug("pr-notes");
  const person = `${slug}@${TEST_EMAIL_DOMAIN}`;
  using operator = openOperatorSession();
  using project = await operator.authenticate({ email: person }).projects.create({ project: slug });
  await project.fetchRoutes.set("notes", proxiedAppRoute("notes", helpers.appOrigin("notes")));
  // the project's config worker, which forwards the route, is published once it is created
  await project.waitForEvent({
    type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
    afterOffset: 0,
    timeoutMs: 60_000,
  });

  await page.goto(
    proxiedAppSignInLink({
      platform: workerBaseUrl,
      ingressRouting,
      project: slug,
      app: "notes",
      loginHint: person,
    }),
  );
  // the link signs nobody in: the platform asks who this browser is first
  await signInWithPassword(page, ADMIN_EMAIL);
  await page
    .getByRole("button", { name: `Sign in as ${person} for an hour`, exact: true })
    .click({ noWaitAfter: true });
  // Notes, on the person's note, and its shell names the admin beside them
  await page.getByRole("textbox", { name: "/repos/config/notes/log.md", exact: true }).waitFor();
  await page.getByText(`You are ${ADMIN_EMAIL}`).waitFor();
  const landed = new URL(page.url());
  expect({ origin: landed.origin, pathname: landed.pathname }).toEqual({
    origin: new URL(workerBaseUrl).origin,
    pathname: `/projects/${slug}/notes/projects/${slug}`,
  });
});
