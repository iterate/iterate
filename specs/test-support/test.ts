import { test as base, type Page, type TestInfo } from "@playwright/test";
import {
  CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER,
  cloudflareWorkerVersionOverrideHeaders,
} from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import {
  addPlugins,
  hydrationWaiter,
  spinnerWaiter,
  uiErrorReporter,
  videoMode,
} from "middlewright";
import { resolvePreviewRolloutWaitMs } from "@iterate-com/shared/test-support/preview-rollout-gate";
import { createProjectFixture as createForgedProjectFixture } from "./forged-session.ts";
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
      options?: { projectCount?: number },
    ) => Promise<Awaited<ReturnType<typeof createForgedProjectFixture>>>;
  };
  page: Awaited<ReturnType<typeof addPagePlugins>>;
  previewRolloutTimeoutBudget: void;
}>({
  context: async ({ context }, use) => {
    if (Object.keys(cloudflareWorkerVersionOverrideHeaders(process.env)).length > 0) {
      await context.route("**/*", async (route) => {
        const request = route.request();

        // Playwright's context-wide headers also reach cross-origin fetches,
        // where this non-safelisted header forces a CORS preflight. Preserve
        // it for navigations, same-origin HTTP, and (outside HTTP routing) the
        // OS WebSocket handshake; remove it from cross-origin subresources.
        if (request.isNavigationRequest()) {
          await route.continue();
          return;
        }

        const frame = request.serviceWorker() === null ? request.frame() : null;
        const sameOrigin =
          frame !== null && new URL(request.url()).origin === new URL(frame.url()).origin;
        if (sameOrigin) {
          await route.continue();
          return;
        }

        const headers = request.headers();
        delete headers[CLOUDFLARE_WORKERS_VERSION_OVERRIDES_HEADER.toLowerCase()];
        await route.continue({ headers });
      });
    }
    await use(context);
  },
  helpers: async ({ baseURL, page }, use) => {
    if (!baseURL) throw new Error("Playwright baseURL fixture is required.");
    await use({
      createFixture: (slugPrefix, options) =>
        base.step("create project fixture", () =>
          createForgedProjectFixture(slugPrefix, { baseURL, page, ...options }),
        ),
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
  previewRolloutTimeoutBudget: [
    async ({ browserName: _browserName }, use, testInfo) => {
      // The project-create gate is intentional harness time, not product test
      // time. Preserve every test's configured execution budget while still
      // making the wait visible inside its trace and wall-clock telemetry.
      const rolloutWaitMs = resolvePreviewRolloutWaitMs({ environment: process.env });
      if (rolloutWaitMs > 0) testInfo.setTimeout(testInfo.timeout + rolloutWaitMs);
      await use();
    },
    { auto: true },
  ],
});
