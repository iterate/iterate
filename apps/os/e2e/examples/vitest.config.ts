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
import { E2E_REPO_ROOT_KEY, E2E_RUN_SLUG_KEY } from "../test-support/provide-keys.ts";
import { createVitestRunSlug } from "../test-support/vitest-naming.ts";
import { resolveBaseUrl } from "../test-support/dev-server.ts";

const e2eRoot = fileURLToPath(new URL("..", import.meta.url));
const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const vitestRunSlug = createVitestRunSlug();
const vitestRunRoot = createVitestRunRoot("os-itx-e2e-");
const ITX_ADMIN_AUTH_COOKIE = "iterate-admin-auth";
const baseUrl = resolveBaseUrl(appRoot) ?? "";

console.log(`[vitest-artifacts] run root: ${vitestRunRoot}`);
console.log(`[vitest] run slug: ${vitestRunSlug}`);

const sharedProvide = {
  [E2E_PROJECT_ROOT_KEY]: e2eRoot,
  [E2E_REPO_ROOT_KEY]: repoRoot,
  [E2E_RUN_ROOT_KEY]: vitestRunRoot,
  [E2E_RUN_SLUG_KEY]: vitestRunSlug,
};
const sharedResolve = {
  alias: {
    "~": resolve(appRoot, "src"),
  },
};

export default defineConfig({
  test: {
    // Every test creates its own uniquely-suffixed project, so files only
    // share the deployed worker and can run in parallel. Preview CI opts in
    // (see scripts/preview/preview.ts); local runs default to sequential so a
    // single dev server isn't hammered and output stays readable.
    // Parallel in CI (files are independent projects); sequential locally so a
    // dev-server target is not hammered.
    fileParallelism: process.env.CI === "true",
    sequence: { concurrent: process.env.CI === "true" },
    maxConcurrency: 10,
    hookTimeout: 45_000,
    passWithNoTests: true,
    projects: [
      {
        resolve: sharedResolve,
        test: {
          environment: "node",
          hookTimeout: 45_000,
          include: ["./e2e/examples/*.e2e.test.ts"],
          maxConcurrency: 10,
          name: "node",
          sequence: { concurrent: process.env.CI === "true" },
          provide: sharedProvide,
          testTimeout: 45_000,
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
          include: ["./e2e/examples/examples-browser.test.ts"],
          name: "browser",
          provide: sharedProvide,
          testTimeout: 45_000,
        },
      },
    ],
    testTimeout: 45_000,
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
