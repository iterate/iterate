// A PR body's Notes `Sign in ↗` (apps/os/scripts/preview.ts `signInLinks`): Notes in the PR's test
// project, on the platform. Notes has no sign-in of its own: under paths ingress it runs on the
// platform's, so a signed-out browser is sent to the platform's sign-in and back. A reviewer signs
// in as themselves, one of the deployment's admins, whom CI's seed made members of the project. On a
// preview a reviewer signs in through prd, which no spec can hold, so this spec signs in as the
// preview's test admin with the password (as specs/dash/sign-in-link.spec.ts does).
import { expect } from "@playwright/test";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { proxiedAppRoute, signInLinkOf } from "../../apps/os/scripts/preview-config.ts";
import { TEST_EMAIL_DOMAIN } from "../../apps/os/src/test-email-domain.ts";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { signInWithPassword } from "../test-support/issuer.ts";
import { openOperatorSession } from "../test-support/operator.ts";
import { test } from "../test-support/test.ts";
import { workerBaseUrl } from "../test-support/worker-base-url.ts";

// the admin a per-commit deployment and local dev both list (envs.ts `previewDeployment`,
// apps/os/scripts/generate-wrangler-config.ts)
const ADMIN_EMAIL = `admin@${TEST_EMAIL_DOMAIN}`;

test("the PR body's Notes link: an admin signs in as themselves and Notes opens on the PR's project", async ({
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
    }),
  );
  // signed out, the platform asks who this browser is, then comes back to the note
  await signInWithPassword(page, ADMIN_EMAIL);
  await page.getByRole("textbox", { name: "/repos/config/notes/log.md", exact: true }).waitFor();
  await page.getByRole("button", { name: "Switch project" }).filter({ hasText: slug }).waitFor();
  const landed = new URL(page.url());
  expect({ origin: landed.origin, pathname: landed.pathname }).toEqual({
    origin: new URL(workerBaseUrl).origin,
    pathname: `/projects/${slug}/notes/projects/${slug}`,
  });
});
