import { test as base, expect, type Page, type TestInfo as _TestInfo } from "@playwright/test";
import {
  addPlugins,
  hydrationWaiter,
  spinnerWaiter,
  uiErrorReporter,
  videoMode,
} from "middlewright";
import {
  createProjectFixture as createForgedProjectFixture,
  createSessionFixture,
} from "./forged-session.ts";
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
  helpers: {
    /** A fresh person with fresh projects, signed in without driving the UI. With `app` (a client
     *  app's URL, usually the project's `baseURL`), also signed in to that app and on its page for
     *  the project; uncaught page errors then fail the spec. */
    createFixture: (
      slugPrefix: string,
      options?: { projectCount?: number; app?: string },
    ) => Promise<Awaited<ReturnType<typeof createForgedProjectFixture>>>;
    /** A browser signed in as a fresh person with no project, without driving the sign-in page. */
    createSession: (slugPrefix: string) => ReturnType<typeof createSessionFixture>;
  };
  page: Awaited<ReturnType<typeof addPagePlugins>>;
}>({
  helpers: async ({ page }, use) => {
    // A client app's uncaught errors fail its spec (docs/browser-testing.md: fail on page and
    // hydration errors), counted from before the fixture's sign-in to the end of the test.
    const appPageErrors: string[] = [];
    await use({
      createFixture: (slugPrefix, options) =>
        base.step("create project fixture", () => {
          if (options?.app) page.on("pageerror", (error) => appPageErrors.push(error.message));
          return createForgedProjectFixture(slugPrefix, { page, ...options });
        }),
      createSession: (slugPrefix) =>
        base.step("create signed-in session", () => createSessionFixture(slugPrefix, { page })),
    });
    expect(appPageErrors, "uncaught errors on the app's pages").toEqual([]);
  },
  page: async ({ page: basePage }, use, testInfo) => {
    // A spec that opens a second tab does so via `context.newPage()`, which
    // returns a RAW page without our middlewright plugins — so its `waitFor()`s
    // fall back to the config's deliberately-tight actionTimeout, far too
    // short to establish a second live stream subscription (this is exactly how
    // reactivity.spec.ts "delivers an appended event to another open tab"
    // flaked: the first tab reached "live" because the spinner-waiter extends
    // its waits while the "connecting…" spinner shows, the second tab had no
    // such safety net). Give every extra page the same plugins as the primary.
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
