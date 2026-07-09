import { test as base, type Page, type TestInfo } from "@playwright/test";
import {
  addPlugins,
  hydrationWaiter,
  spinnerWaiter,
  uiErrorReporter,
  videoMode,
} from "middlewright";
import { createProjectFixture as createForgedProjectFixture } from "./forged-session.ts";

type ForgedProjectFixture = Awaited<ReturnType<typeof createForgedProjectFixture>>;

const addPagePlugins = async (page: Page, testInfo: TestInfo) => {
  const pageWithPlugins = await addPlugins({
    page,
    testInfo,
    plugins: [
      hydrationWaiter({ timeout: 30_000 }),
      uiErrorReporter(),
      spinnerWaiter({ spinnerTimeout: 30_000 }),
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
  armVideoAutoStart(pageWithPlugins);
  return pageWithPlugins;
};

/**
 * Trim the blank startup lead-in from `VIDEO_MODE=1` demo videos.
 *
 * The raw webm begins at browser-context creation, so a recording opens on a
 * few seconds of `about:blank` + loading shell before the app navigates,
 * hydrates and paints (the forged-session cookie is set with no navigation, so
 * there's nothing to see up front). After the first `goto`, once the app flips
 * its server-rendered `<body data-hydrated="false">` marker to "true" — the
 * same hydration contract `hydrationWaiter` gates on — mark that moment as the
 * default video start, so demos open on real content.
 *
 * Best-effort and last-write-wins: a spec that wants a different anchor just
 * calls `page.videoMode.setStartTime()` afterwards (as `repl-examples` does),
 * and because that runs later it overrides this default. A no-op unless
 * `VIDEO_MODE=1` put a `videoMode` control on the page, and detection never
 * throws into the test.
 */
const armVideoAutoStart = (page: PageWithVideoMode) => {
  const control = page.videoMode;
  if (!control) return;

  const goto = page.goto.bind(page);
  let armed = true;
  page.goto = async (url, options) => {
    const response = await goto(url, options);
    if (armed) {
      armed = false;
      await page
        .locator('[data-hydrated="false"]')
        .waitFor({ state: "hidden", timeout: 30_000 })
        .catch(() => {});
      control.setStartTime();
    }
    return response;
  };
};

type PageWithVideoMode = Page & { videoMode?: { setStartTime: (ms?: number) => void } };

export const test = base.extend<{
  helpers: {
    createFixture: (slugPrefix: string) => Promise<ForgedProjectFixture>;
  };
  page: Awaited<ReturnType<typeof addPagePlugins>>;
}>({
  helpers: async ({ baseURL, page }, use) => {
    if (!baseURL) throw new Error("Playwright baseURL fixture is required.");
    await use({
      createFixture: (slugPrefix) => createForgedProjectFixture(slugPrefix, { baseURL, page }),
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

export function uniqueSlug(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
}
