// A PR body's Notes `Sign in ↗` (where it goes and why: scripts/os/preview-config.ts
// `signInLinkOf`). No spec can hold a prd session, so once the page leads with os.iterate.com this
// one signs in another way: the preview's test admin, with the password.
import { expect } from "@playwright/test";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { proxiedAppRoute, signInLinkOf } from "../../../scripts/os/preview-config.ts";
import { TEST_EMAIL_DOMAIN } from "../../../core/os/src/test-email-domain.ts";
import { readOsPlaywrightAuthConfig } from "../../helpers/auth-config.ts";
import { signInWithPassword } from "../../helpers/issuer.ts";
import { openOperatorSession } from "../../helpers/operator.ts";
import { test } from "../../helpers/test.ts";
import { workerBaseUrl } from "../../helpers/worker-base-url.ts";

// the admin a per-commit deployment and local dev both list (envs.ts `previewDeployment`,
// core/os/scripts/generate-wrangler-config.ts)
const ADMIN_EMAIL = `admin@${TEST_EMAIL_DOMAIN}`;
// where every per-commit deployment's admins sign in (envs.ts `previewDeployment`'s `adminIssuer`)
const PRD_ISSUER_HOST = "os.iterate.com";

test("the PR body's Notes link: the sign-in leads with os.iterate.com, an admin signs in as themselves, and Notes opens on the PR's project", async ({
  page,
  helpers,
}) => {
  const { ingressRouting } = readOsPlaywrightAuthConfig();
  test.skip(
    ingressRouting?.type !== "paths",
    "under subdomains a project's app is an origin of its own, with its own sign-in",
  );
  const notes = helpers.appOrigin("notes");
  // the PR's test person and their project, as CI's seed makes them (preview.ts `seedSignIn`):
  // serving the Notes under test, with the admin a member
  const slug = uniqueFixtureSlug("pr-notes");
  const person = `${slug}@${TEST_EMAIL_DOMAIN}`;
  using operator = openOperatorSession();
  const theirs = operator.authenticate({ email: person });
  using project = await theirs.projects.create({ project: slug });
  await project.fetchRoutes.set("notes", proxiedAppRoute("notes", notes));
  const { orgId } = (await theirs.projects.list()).find((record) => record.slug === slug)!;
  const everything = operator.authenticate();
  const admin = await everything.users.create({ email: ADMIN_EMAIL });
  await everything.organizations.addMember(orgId, { userId: admin.id });
  // the project's config worker, which forwards the route, is published once it is created
  await project.waitForEvent({
    type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
    afterOffset: 0,
    timeoutMs: 60_000,
  });

  await page.goto(
    signInLinkOf({
      app: { name: "notes", url: notes },
      platform: workerBaseUrl,
      ingressRouting,
      project: slug,
      email: person,
      providerHint: PRD_ISSUER_HOST,
    }),
  );
  // signed out, the platform's sign-in leads with the way a reviewer signs in, and keeps the rest
  // one click away
  await page.getByRole("link", { name: `Sign in with ${PRD_ISSUER_HOST}`, exact: true }).waitFor();
  expect(await page.getByRole("textbox", { name: "Email", exact: true }).count()).toBe(0);
  await page
    .getByRole("link", { name: "sign in another way", exact: true })
    .click({ noWaitAfter: true });
  // then comes back to the note
  await signInWithPassword(page, ADMIN_EMAIL);
  await page.getByRole("textbox", { name: "/repos/config/notes/log.md", exact: true }).waitFor();
  await page.getByRole("button", { name: "Switch project" }).filter({ hasText: slug }).waitFor();
  const landed = new URL(page.url());
  expect({ origin: landed.origin, pathname: landed.pathname }).toEqual({
    origin: new URL(workerBaseUrl).origin,
    pathname: `/projects/${slug}/notes/projects/${slug}`,
  });
});
