import { expect, test, type Page } from "@playwright/test";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import type { VideoModePageExtension } from "middlewright";
import type { OperatorSession } from "./operator.ts";
import { readOsPlaywrightAuthConfig } from "./auth-config.ts";

/**
 * A browser signed in as a fresh person who owns a fresh project, without driving the sign-in page
 * or the consent flow — for specs whose subject is something else. `itx` is the project's root
 * context as the operator, for seeding state the spec does not drive through the UI. With `app`,
 * that person is also signed in to the client app and on its page for the project (`signInToApp`).
 * Dispose with `await using fixture = await helpers.createFixture(...)`.
 */
export async function createProjectFixture(
  slugPrefix: string,
  input: {
    page: Page;
    operator: OperatorSession;
    /** A client app (any URL on its origin) to sign in to and open on the project's page. */
    app?: string;
  },
) {
  const slug = uniqueFixtureSlug(slugPrefix);
  const email = `forged-${slug}@example.com`;
  await mintIterateSession({ email, page: input.page });
  const project = await createOwnedProject({ operator: input.operator, email, slug });
  if (input.app) await signInToApp({ page: input.page, app: input.app, project });

  return {
    project,
    itx: input.operator.authenticate().projects.get(project.id),
    [Symbol.asyncDispose]() {
      // A fixture's project is left behind (a spec that deletes one does so itself): a preview's
      // state goes with the preview, and a failed spec's project stays to be read.
      return Promise.resolve();
    },
  };
}

/**
 * The fixture's person signed in to a client app and on its page for `project`: the app's own
 * sign-in route (`/.auth/login`), which the issuer answers with consent because the person is signed
 * in there already, then Authorize. A demo video (VIDEO_MODE=1) starts on the app's page, not on
 * consent. Signing in to an app is itself the subject of specs/notes/sessions.spec.ts, and consent
 * of specs/os/auth.spec.ts.
 */
async function signInToApp(input: { page: Page; app: string; project: { slug: string } }) {
  const { page, project } = input;
  const origin = new URL(input.app).origin;
  const next = `/projects/${project.slug}`;
  await test.step("sign in to the app", async () => {
    await page.goto(`${origin}/.auth/login?${new URLSearchParams({ next })}`);
    await page.getByRole("button", { name: "Review permissions", exact: true }).click();
    // noWaitAfter: Authorize posts and the issuer hands the browser back to the app; the wait
    // below covers that navigation (the spinner-waiter counts one in flight as loading)
    await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
    // every client app's shell (packages/ui app-shell.tsx) names the active project in its switcher
    await page
      .getByRole("button", { name: "Switch project" })
      .filter({ hasText: project.slug })
      .waitFor();
  });
  const landed = new URL(page.url());
  expect({ origin: landed.origin, pathname: landed.pathname }).toEqual({ origin, pathname: next });
  // the harness leaves this file's clicks unhighlighted (test.ts `skipStackFrames`): the renderer
  // would pull the start back to a highlighted consent click
  (page as Page & Partial<VideoModePageExtension>).videoMode?.setStartTime();
}

/** A browser signed in as a fresh person with no project yet — the consent page's onboarding
 *  step, without driving the sign-in page. */
export function createSessionFixture(slugPrefix: string, input: { page: Page }) {
  return mintIterateSession({
    email: `forged-${uniqueFixtureSlug(slugPrefix)}@example.com`,
    page: input.page,
  });
}

/**
 * The fixture's browser session. OS has no token to forge — a browser session is an OAuth grant
 * the issuer makes on sign-in — so this posts the deployment's test password the way the sign-in
 * page does (`login.password`), and the issuer's session cookie lands in the page's browser
 * context. The sign-in page itself is the subject of specs/os/issuer-pages.spec.ts.
 */
async function mintIterateSession(input: { email: string; page: Page }) {
  // the OS platform, whichever app host the spec's project targets
  const { osBaseUrl, loginPassword } = readOsPlaywrightAuthConfig();
  return test.step("sign in with the deployment's test password", async () => {
    const origin = new URL(osBaseUrl).origin;
    const login = await input.page.request.post(`${origin}/login`, {
      headers: { Origin: origin },
      form: { email: input.email, password: loginPassword, next: "/" },
      maxRedirects: 0,
      // A page.request call inherits the tight actionTimeout, but this is fixture setup over HTTP
      // (the sign-in makes an OAuth grant). timeout: no loading UI exists for the spinner-waiter
      timeout: 15_000,
    });
    // A sign-in the platform failed answers 303 back to the sign-in page, its error in the query
    // (apps/os src/issuer-session.ts): the location is the failure's own words.
    if (login.status() !== 302)
      throw new Error(
        `sign-in answered ${login.status()} to ${login.headers().location ?? "no location"}: ${await login.text()}`,
      );
  });
}

async function createOwnedProject(input: {
  operator: OperatorSession;
  email: string;
  slug: string;
}) {
  // create() resolves only after the project-creation saga commits, so no separate lifecycle
  // poll is needed.
  return test.step("create project fixture over /api", async () => {
    // Created as that person, so it lands in an organization they own; its minted id is how a
    // project is addressed — the slug only labels its hosts.
    const { projectId } = await input.operator
      .authenticate({ email: input.email })
      .projects.create({ project: input.slug })
      .whoami();
    return { id: projectId, slug: input.slug };
  });
}
