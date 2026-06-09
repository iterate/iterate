import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

const testRoot = fileURLToPath(new URL(".", import.meta.url));
const baseUrl =
  process.env.OS_CAPABILITY_PROTOTYPE_BASE_URL?.trim().replace(/\/+$/, "") ||
  process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "") ||
  "";
const adminApiSecret =
  process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
  process.env.OS_ADMIN_API_SECRET?.trim() ||
  process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
  "";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 60_000,
    passWithNoTests: true,
    projects: [
      {
        test: {
          include: [`${testRoot}/prototype.e2e.ts`],
          name: "node",
          testTimeout: 60_000,
        },
      },
      {
        define: {
          __CAPABILITY_PROTOTYPE_BROWSER_E2E__: JSON.stringify({ adminApiSecret, baseUrl }),
        },
        test: {
          browser: {
            commands: {
              async setCapabilityPrototypeAdminCookie(
                context: any,
                input: { secret: string; url: string },
              ) {
                const url = new URL(input.url);
                const page = context.provider.getPage(context.sessionId);
                await page.context().addCookies([
                  {
                    httpOnly: true,
                    name: "iterate-admin-auth",
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
          include: [`${testRoot}/browser.e2e.ts`],
          name: "browser",
          testTimeout: 60_000,
        },
      },
    ],
  },
});
