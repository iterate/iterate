import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import {
  appendConsoleLineSync,
  createVitestRunRoot,
  E2E_PROJECT_ROOT_KEY,
  E2E_RUN_ROOT_KEY,
} from "@iterate-com/shared/test-support/vitest-e2e";
import { E2E_REPO_ROOT_KEY, E2E_RUN_SLUG_KEY } from "./test-support/provide-keys.ts";
import { createVitestRunSlug } from "./test-support/vitest-naming.ts";
import { resolveBaseUrl } from "./test-support/dev-server.ts";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const e2eRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const vitestRunSlug = createVitestRunSlug();
const vitestRunRoot = createVitestRunRoot("os-e2e-");
const ITX_ADMIN_AUTH_COOKIE = "iterate-admin-auth";
const baseUrl = resolveBaseUrl(appRoot) ?? "";

console.log(`[vitest-artifacts] run root: ${vitestRunRoot}`);
console.log(`[vitest] run slug: ${vitestRunSlug}`);

const ci = process.env.CI === "true";

const sharedProvide = {
  [E2E_RUN_ROOT_KEY]: vitestRunRoot,
  [E2E_PROJECT_ROOT_KEY]: e2eRoot,
  [E2E_RUN_SLUG_KEY]: vitestRunSlug,
  [E2E_REPO_ROOT_KEY]: repoRoot,
};
const sharedResolve = {
  alias: {
    "~": resolve(appRoot, "src"),
  },
};

// One e2e suite, two projects. Both drive a real deployed OS
// (APP_CONFIG_BASE_URL — local dev, preview, or prod); the split is only the
// runtime the test code executes in. `pnpm e2e` runs everything; preview CI
// runs `pnpm e2e --project node` (the browser catalogue is also covered by the
// root Playwright REPL specs, so it stays out of the preview lane).
export default defineConfig({
  test: {
    // Run-scheduler options live at the ROOT test level — this is where vitest
    // reads them, even with `projects`. (Setting them only inside a project is
    // silently ignored and the suite falls back to sequential.) Parallel in
    // CI: each test provisions its own project against a deployed slot, so
    // files — and tests within a file — are independent. Sequential locally so
    // a single dev server isn't hammered and output stays readable.
    fileParallelism: ci,
    // Cap the stampede: all files first-touching a freshly deployed slot at
    // once is what pushes cold creates past the (deliberately tight) saga
    // timeout. Preview CI also warms the slot with one sequential
    // onboarding-smoke create before the suites. See
    // tasks/os-cold-create-latency.md.
    maxWorkers: 4,
    sequence: { concurrent: ci },
    // Bounds concurrent tests per file. Each test creates a project (a whole
    // DO chain), so with maxWorkers:4 the slot sees ~4×this many concurrent
    // creates, and the slot is the bottleneck, not the runner. main runs
    // reliably at ~4 concurrent (maxWorkers only, no intra-file concurrency);
    // pushing higher overloaded it ("Durable Object storage operation
    // exceeded timeout" at ~24; a timing-sensitive teardown test failed at
    // ~12). 2 keeps peak ~8 — still ~2.5× faster than sequential — and
    // retry:1 mops up the occasional slow-slot flake. The real fix is
    // splitting the itx monolith into files (tasks/os-cold-create-latency.md).
    maxConcurrency: 2,
    // One retry in CI: tests are self-contained (fresh project per test), so a
    // rare load-induced flake re-runs in seconds instead of failing the suite.
    retry: ci ? 1 : 0,
    passWithNoTests: true,
    projects: [
      {
        resolve: sharedResolve,
        test: {
          name: "node",
          environment: "node",
          // The engine e2e suites and the itx catalogue matrix are both node
          // black boxes against the deployed slot — one lane.
          include: ["./e2e/vitest/**/*.test.ts", "./e2e/examples/*.e2e.test.ts"],
          setupFiles: ["./e2e/vitest/setup.ts"],
          provide: sharedProvide,
          // Generous: e2e runs against live deployments, concurrently with the
          // Playwright specs in preview CI — cold slots under combined load
          // need headroom, and slow-but-passing beats flaky.
          hookTimeout: 240_000,
          testTimeout: 240_000,
        },
      },
      {
        define: {
          __ITX_BROWSER_E2E__: JSON.stringify({
            adminApiSecret: process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ?? "",
            baseUrl,
          }),
        },
        resolve: sharedResolve,
        test: {
          name: "browser",
          include: ["./e2e/examples/examples-browser.test.ts"],
          provide: sharedProvide,
          testTimeout: 45_000,
          hookTimeout: 45_000,
          browser: {
            commands: {
              // Browser WebSockets cannot set Authorization headers, so the
              // admin cookie goes in via Playwright's context (see the
              // browser test for why /admin-cookie alone isn't enough here).
              async setItxAdminCookie(context: any, input: { secret: string; url: string }) {
                const url = new URL(input.url);
                const page = context.provider.getPage(context.sessionId);
                await page.context().addCookies([
                  {
                    httpOnly: true,
                    name: ITX_ADMIN_AUTH_COOKIE,
                    sameSite: url.protocol === "https:" ? "None" : "Lax",
                    secure: url.protocol === "https:",
                    url: url.origin,
                    value: Buffer.from(JSON.stringify({ secret: input.secret })).toString(
                      "base64url",
                    ),
                  },
                ]);
                const cookies = await page.context().cookies(url.origin);
                return {
                  cookies: cookies.map((cookie: { name: string; value: string }) => ({
                    name: cookie.name,
                    value: cookie.value,
                  })),
                  ok: true,
                };
              },
            },
            enabled: true,
            headless: true,
            instances: [{ browser: "chromium" }],
            provider: playwright(),
          },
        },
      },
    ],
    onConsoleLog(log, type, entity) {
      if (entity?.type !== "test") return;

      appendConsoleLineSync({
        runRoot: vitestRunRoot,
        projectRoot: e2eRoot,
        moduleId: entity.module.moduleId,
        testFullName: entity.fullName,
        testId: entity.id,
        log,
        type,
      });
    },
  },
});
