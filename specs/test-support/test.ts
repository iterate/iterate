import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test as base, type Page } from "@playwright/test";
import {
  addPlugins,
  hydrationWaiter,
  spinnerWaiter,
  uiErrorReporter,
  videoMode,
} from "middlewright";
import { REPO_ROOT, waitForLocalOsBaseUrl } from "./local-dev.ts";

const execFileAsync = promisify(execFile);

export const test = base.extend({
  baseURL: async ({ browserName: _browserName }, use) => {
    await use(await waitForLocalOsBaseUrl());
  },
  page: async ({ page: basePage }, use, testInfo) => {
    await using page = await addPlugins({
      page: basePage,
      testInfo,
      plugins: [
        hydrationWaiter({ timeout: 30_000 }),
        uiErrorReporter(),
        spinnerWaiter({ spinnerTimeout: 30_000 }),
        process.env.VIDEO_MODE === "1" && videoMode({ skipStackFrames: ["test-support/test.ts"] }),
      ],
      boxedStackPrefixes: (defaults) => [...defaults, import.meta.dirname],
    });

    await use(page);
  },
});

export function uniqueSlug(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
}

export async function signInWithLocalAuth(page: Page) {
  const suffix = uniqueSlug("pw");
  const email = `testuser+${suffix}test@gmail.com`;
  const seed = await seedLocalAuth({
    bootstrapProjectSlug: uniqueSlug("playwright-bootstrap"),
    email,
    organizationName: `Playwright ${suffix}`,
    organizationSlug: suffix,
  });

  await page.context().clearCookies();
  await page.goto("/api/iterate-auth/login?return_to=/projects");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.getByTestId("email-input").fill(email);
  await page.getByTestId("email-submit-button").click();
  await page.getByTestId("email-otp-input").fill("424242");
  await page.getByTestId("email-verify-button").click();
  await continueOAuthProjectAccess(page);
  await page.getByRole("heading", { exact: true, name: "Projects" }).waitFor();
  await page.getByText(email).waitFor();

  return seed;
}

export async function createProject(page: Page, projectSlug: string) {
  await page
    .getByRole("button", { name: "Create new project" })
    .or(page.getByRole("button", { name: "New project" }))
    .first()
    .click();
  await page.getByLabel("Slug").fill(projectSlug);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(
    new RegExp(`/projects/${projectSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`),
  );
}

async function seedLocalAuth(input: {
  bootstrapProjectSlug: string;
  email: string;
  organizationName: string;
  organizationSlug: string;
}) {
  const seedArgs = [
    "exec",
    "tsx",
    "./specs/seed-local-auth.ts",
    "--email",
    input.email,
    "--organization-name",
    input.organizationName,
    "--organization-slug",
    input.organizationSlug,
    "--project-slug",
    input.bootstrapProjectSlug,
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_CONFIG_ITERATE_AUTH__ISSUER: "http://localhost:7101/api/auth",
    SERVICE_AUTH_TOKEN:
      process.env.OS_PLAYWRIGHT_LOCAL_AUTH_SERVICE_TOKEN ||
      "os-playwright-local-auth-service-token",
    ITERATE_OAUTH_ISSUER: "http://localhost:7101/api/auth",
  };
  const direct =
    env.APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN ||
    env.ITERATE_AUTH_SERVICE_TOKEN ||
    env.SERVICE_AUTH_TOKEN;
  const command = direct ? "pnpm" : "doppler";
  const args = direct
    ? seedArgs
    : [
        "run",
        "--preserve-env=APP_CONFIG_ITERATE_AUTH__ISSUER,ITERATE_OAUTH_ISSUER,SERVICE_AUTH_TOKEN",
        "--",
        "pnpm",
        "--dir",
        "../..",
        ...seedArgs,
      ];

  const { stdout } = await execFileAsync(command, args, {
    cwd: direct ? REPO_ROOT : `${REPO_ROOT}/apps/auth`,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  const json = stdout
    .trim()
    .split("\n")
    .findLast((line) => line.trim().startsWith("{"));
  if (!json) {
    throw new Error(`local auth seed did not return JSON: ${stdout.trim()}`);
  }
  return JSON.parse(json) as {
    email: string;
    organization: { id: string; name: string; slug: string };
    project: { id: string; slug: string };
    user: { id: string; email: string };
  };
}

async function continueOAuthProjectAccess(page: Page) {
  const projectAccessContinue = page.getByRole("button", { exact: true, name: "Continue" });
  if (await projectAccessContinue.isVisible().catch(() => false)) {
    await projectAccessContinue.click();
  }

  await page.getByRole("button", { name: "Allow access" }).click();
}
