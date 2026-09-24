import { test as base, expect, type Page, type TestInfo as _TestInfo } from "@playwright/test";
import {
  addPlugins,
  hydrationWaiter,
  spinnerWaiter,
  uiErrorReporter,
  videoMode,
} from "middlewright";
import { createProjectFixture, createSessionFixture } from "./forged-session.ts";
import { openOperatorSession, type OperatorSession } from "./operator.ts";
import { screenshot } from "./screenshot.ts";

const addPagePlugins = (page: Page, testInfo: _TestInfo) => {
  return addPlugins({
    page,
    testInfo,
    plugins: [
      hydrationWaiter({ timeout: 30_000 }),
      uiErrorReporter(),
      spinnerWaiter({ spinnerTimeout: 30_000 }),
      screenshot(),
      process.env.VIDEO_MODE === "1" &&
        videoMode({
          // the harness's own actions, and the fixture's sign-in to an app, are not the demo
          skipStackFrames: ["test-support/test.ts", "test-support/forged-session.ts"],
          deadAirThreshold: 300,
          finalHold: 1,
          highlight: { mode: "pointer", duration: 1000 },
        }),
    ],
    boxedStackPrefixes: (defaults) => [...defaults, import.meta.dirname],
  });
};

export const test = base.extend<{
  /** The operator's session on the platform under test (the admin bearer): every project. For
   *  state no fixture makes; a fixture's own project is `fixture.itx`. */
  operator: ReturnType<OperatorSession["authenticate"]>;
  helpers: {
    /** A fresh person with a fresh project, signed in without driving the UI; `itx` is that
     *  project as the operator. With `app` (a client app's URL, usually the project's `baseURL`),
     *  also signed in to that app and on its page for the project; uncaught page errors then fail
     *  the spec. */
    createFixture: (
      slugPrefix: string,
      options?: { app?: string },
    ) => Promise<Awaited<ReturnType<typeof createProjectFixture>>>;
    /** A browser signed in as a fresh person with no project, without driving the sign-in page. */
    createSession: (slugPrefix: string) => ReturnType<typeof createSessionFixture>;
    /** The origin of a client app deployed against the platform under test, from its
     *  `<APP>_BASE_URL`. Locally a missing app skips the spec; in CI it fails, because the
     *  preview's e2e job always sets the variable. */
    appOrigin: (app: "notes" | "voice" | "dash") => string;
  };
  page: Awaited<ReturnType<typeof addPagePlugins>>;
}>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern; the operator's session has none
  operator: async ({}, use) => {
    using session = openOperatorSession();
    await use(session.authenticate());
  },
  helpers: async ({ page }, use) => {
    // A client app's uncaught errors fail its spec (docs/browser-testing.md: fail on page and
    // hydration errors), counted from before the fixture's sign-in to the end of the test.
    const appPageErrors: string[] = [];
    // opened by the first createFixture, so a spec that makes none opens no socket
    let operatorSession: OperatorSession | undefined;
    try {
      await use({
        createFixture: (slugPrefix, options) =>
          base.step("create project fixture", () => {
            if (options?.app) page.on("pageerror", (error) => appPageErrors.push(error.message));
            operatorSession ||= openOperatorSession();
            return createProjectFixture(slugPrefix, {
              page,
              operator: operatorSession,
              ...options,
            });
          }),
        createSession: (slugPrefix) =>
          base.step("create signed-in session", () => createSessionFixture(slugPrefix, { page })),
        appOrigin: (app) => {
          const variable = `${app.toUpperCase()}_BASE_URL`;
          const name = `${app[0]!.toUpperCase()}${app.slice(1)}`;
          const url = process.env[variable];
          base.skip(
            !process.env.CI && !url,
            `The ${name} specs need the ${name} app deployed against the platform under test`,
          );
          if (!url) throw new Error(`${variable}: the preview's ${name} app is not set`);
          return new URL(url).origin;
        },
      });
    } finally {
      operatorSession?.[Symbol.dispose]();
    }
    expect(appPageErrors, "uncaught errors on the app's pages").toEqual([]);
  },
  page: async ({ page: basePage }, use, testInfo) => {
    // A spec that opens a second tab does so via `context.newPage()`, which
    // returns a RAW page without our middlewright plugins — so its `waitFor()`s
    // fall back to the config's deliberately-tight actionTimeout, far too
    // short to establish a second live stream subscription (the spinner-waiter
    // extends waits while a "connecting…" spinner shows; a raw page has no such
    // safety net). Give every extra page the same plugins as the primary.
    // `basePage` already exists here (Playwright's built-in `page` fixture
    // created it via `context.newPage()` before this fixture ran), so patching
    // `newPage` now only wraps pages the spec opens LATER — the primary page is
    // never double-wrapped.
    const context = basePage.context();
    const rawNewPage = context.newPage.bind(context);
    const extraPageDisposers: Array<() => Promise<void>> = [];
    context.newPage = async () => {
      const extraPage = await addPagePlugins(await rawNewPage(), testInfo);
      extraPageDisposers.push(() => extraPage[Symbol.asyncDispose]());
      return extraPage;
    };
    await using page = await addPagePlugins(basePage, testInfo);
    try {
      await use(page);
    } finally {
      // The spec usually closes its extra pages itself; dispose the plugin
      // wrappers too (lifecycle cleanup only — a no-op with video off),
      // tolerating an already-closed page.
      for (const dispose of extraPageDisposers) await dispose().catch(() => {});
    }
  },
});

export declare namespace test {
  type Page = Awaited<ReturnType<typeof addPagePlugins>>;
  type TestInfo = _TestInfo;
}
