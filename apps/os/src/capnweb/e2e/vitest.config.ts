import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import {
  appendConsoleLineSync,
  createVitestRunRoot,
  E2E_PROJECT_ROOT_KEY,
  E2E_RUN_ROOT_KEY,
} from "@iterate-com/shared/test-support/vitest-e2e";
import { E2E_REPO_ROOT_KEY, E2E_RUN_SLUG_KEY } from "../../../e2e/test-support/provide-keys.ts";
import { createVitestRunSlug } from "../../../e2e/test-support/vitest-naming.ts";

const e2eRoot = fileURLToPath(new URL("../../../e2e", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));
const vitestRunSlug = process.env.OS_E2E_RUN_SLUG?.trim() || createVitestRunSlug();
const vitestRunRoot = createVitestRunRoot("os-capnweb-e2e-");
const CAPNWEB_ADMIN_AUTH_COOKIE = "iterate-admin-auth";

console.log(`[vitest-artifacts] run root: ${vitestRunRoot}`);
console.log(`[vitest] run slug: ${vitestRunSlug}`);

const sharedProvide = {
  [E2E_RUN_ROOT_KEY]: vitestRunRoot,
  [E2E_PROJECT_ROOT_KEY]: e2eRoot,
  [E2E_RUN_SLUG_KEY]: vitestRunSlug,
  [E2E_REPO_ROOT_KEY]: repoRoot,
};

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 120_000,
    passWithNoTests: true,
    projects: [
      {
        test: {
          environment: "node",
          hookTimeout: 120_000,
          include: ["./src/capnweb/e2e/captnweb.e2e.test.ts"],
          name: "node",
          provide: sharedProvide,
          testTimeout: 120_000,
        },
      },
      {
        define: {
          __CAPNWEB_BROWSER_E2E__: JSON.stringify({
            adminApiSecret:
              process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
              process.env.OS_ADMIN_API_SECRET?.trim() ||
              process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
              process.env.OS_E2E_BEARER_TOKEN?.trim() ||
              "",
            baseUrl: process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "") || "",
          }),
        },
        test: {
          browser: {
            commands: {
              async setCapnwebAdminCookie(context: any, input: { secret: string; url: string }) {
                const url = new URL(input.url);
                const page = context.provider.getPage(context.sessionId);
                await page.context().addCookies([
                  {
                    httpOnly: true,
                    name: CAPNWEB_ADMIN_AUTH_COOKIE,
                    sameSite: url.protocol === "https:" ? "None" : "Lax",
                    secure: url.protocol === "https:",
                    url: url.origin,
                    value: Buffer.from(
                      JSON.stringify({
                        scopes: { projects: "all" },
                        secret: input.secret,
                      }),
                    ).toString("base64url"),
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
          include: ["./src/capnweb/e2e/captnweb.browser.test.ts"],
          name: "browser",
          provide: sharedProvide,
          testTimeout: 120_000,
        },
      },
    ],
    testTimeout: 120_000,
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
