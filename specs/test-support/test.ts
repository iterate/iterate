import { test as base, type Page, type TestInfo } from "@playwright/test";
import {
  addPlugins,
  hydrationWaiter,
  spinnerWaiter,
  uiErrorReporter,
  videoMode,
} from "middlewright";
import {
  createProjectFixture as createForgedProjectFixture,
  type ProjectIdentity,
} from "./forged-session.ts";
import { screenshot } from "./screenshot.ts";

const addPagePlugins = (page: Page, testInfo: TestInfo) =>
  addPlugins({
    page,
    testInfo,
    plugins: [
      hydrationWaiter({ timeout: 30_000 }),
      uiErrorReporter(),
      spinnerWaiter({ spinnerTimeout: 30_000 }),
      screenshot(),
      process.env.VIDEO_MODE === "1" &&
        videoMode({
          skipStackFrames: ["test-support/test.ts"],
          deadAirThreshold: 300,
          finalHold: 1,
          highlight: { mode: "pointer", duration: 1000 },
        }),
    ],
    boxedStackPrefixes: (defaults) => [...defaults, import.meta.dirname],
  });

export const test = base.extend<{
  helpers: {
    createFixture: (
      slugPrefix: string,
      opts?: { project: ProjectIdentity },
    ) => Promise<Awaited<ReturnType<typeof createForgedProjectFixture>>>;
  };
  page: Awaited<ReturnType<typeof addPagePlugins>>;
}>({
  helpers: async ({ baseURL, page }, use) => {
    if (!baseURL) throw new Error("Playwright baseURL fixture is required.");
    await use({
      createFixture: (slugPrefix, opts) =>
        createForgedProjectFixture(slugPrefix, { baseURL, page, project: opts?.project }),
    });
  },
  page: async ({ page: basePage }, use, testInfo) => {
    // A spec that opens a second tab does so via `context.newPage()`, which
    // returns a RAW page without our middlewright plugins — so its `waitFor()`s
    // fall back to the config's deliberately-tight 750ms actionTimeout, far too
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
