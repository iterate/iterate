import { expect, test, type Page } from "@playwright/test";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import type { VideoModePageExtension } from "middlewright";
import { newHttpBatchRpcSession } from "capnweb";
import type { IterateApi } from "iterate/next/api";
import { readOsPlaywrightAuthConfig } from "./auth-config.ts";

export type MintedIterateSession = {
  email: string;
};

/**
 * A browser signed in as a fresh person who owns fresh projects, without driving the sign-in page
 * or the consent flow — for specs whose subject is something else. With `app`, that person is
 * also signed in to the client app and on its page for the project (`signInToApp`). Dispose with
 * `await using fixture = await helpers.createFixture(...)`.
 */
export async function createProjectFixture(
  slugPrefix: string,
  input: {
    page: Page;
    projectCount?: number;
    /** A client app (any URL on its origin) to sign in to and open on the project's page. */
    app?: string;
  },
) {
  // the OS platform, whichever app host the spec's project targets
  const baseUrl = readOsPlaywrightAuthConfig().osBaseUrl;

  const projectSlug = uniqueFixtureSlug(slugPrefix);
  const session = await mintIterateSession({
    baseUrl,
    email: `forged-${projectSlug}@example.com`,
    page: input.page,
  });
  const projects = await Promise.all(
    Array.from({ length: input.projectCount ?? 1 }, (_, index) =>
      createAdminProject({
        baseUrl,
        email: session.email,
        slug: index === 0 ? projectSlug : uniqueFixtureSlug(`${slugPrefix}-${index + 1}`),
      }),
    ),
  );
  if (input.app) await signInToApp({ page: input.page, app: input.app, project: projects[0]! });

  return {
    project: projects[0]!,
    projects,
    session,
    [Symbol.asyncDispose]() {
      // Disposable Playwright projects are left behind: OS has no project removal, and a
      // preview's state goes with the preview.
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
export async function createSessionFixture(
  slugPrefix: string,
  input: {
    page: Page;
  },
) {
  // the OS platform, whichever app host the spec's project targets
  const baseUrl = readOsPlaywrightAuthConfig().osBaseUrl;
  return mintIterateSession({
    baseUrl,
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
async function mintIterateSession(input: {
  baseUrl: string;
  email: string;
  page: Page;
}): Promise<MintedIterateSession> {
  const config = readOsPlaywrightAuthConfig();
  return test.step("sign in with the deployment's test password", async () => {
    const origin = new URL(input.baseUrl).origin;
    const login = await input.page.request.post(`${origin}/login`, {
      headers: { Origin: origin },
      form: { email: input.email, password: config.loginPassword, next: "/" },
      maxRedirects: 0,
      // A page.request call inherits the tight actionTimeout, but this is fixture setup over HTTP
      // (the sign-in makes an OAuth grant). timeout: no loading UI exists for the spinner-waiter
      timeout: 15_000,
    });
    if (login.status() !== 302)
      throw new Error(`sign-in answered ${login.status()}: ${await login.text()}`);
    return { email: input.email };
  });
}

async function createAdminProject(input: { baseUrl: string; email: string; slug: string }) {
  const config = readOsPlaywrightAuthConfig();
  // create() resolves only after the project-creation saga commits, so no separate lifecycle
  // poll is needed.
  return test.step("create project fixture over /api", async () => {
    // oxlint-disable-next-line iterate/no-capnweb-http-batch -- bounded fixture setup
    using session = newHttpBatchRpcSession<IterateApi>(
      new Request(`${new URL(input.baseUrl).origin}/api`, {
        headers: { authorization: `Bearer ${config.adminApiSecret}` },
      }),
    );
    // One pipelined round trip (an HTTP batch session ends with its first): create the project as
    // that person and read its minted id — a project is addressed by it; the slug labels its hosts.
    const { projectId } = await session
      .authenticate({
        type: "admin-secret",
        secret: config.adminApiSecret,
        as: { email: input.email },
      })
      .projects.create({ project: input.slug })
      .whoami();
    return { id: projectId, slug: input.slug };
  });
}
