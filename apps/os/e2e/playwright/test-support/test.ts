import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test as base, type Page } from "@playwright/test";
import {
  addPlugins,
  hydrationWaiter,
  spinnerWaiter,
  uiErrorReporter,
  videoMode,
} from "middlewright";
import { REPO_ROOT, waitForLocalOsBaseUrl } from "./local-dev.ts";

const execFileAsync = promisify(execFile);

export { expect };

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

export async function signInWithMintedOrg(page: Page) {
  const baseUrl = await waitForLocalOsBaseUrl();
  const suffix = uniqueSlug("pw");
  const email = `${suffix}+test@nustom.com`;
  const organization = {
    id: `org_${suffix.replace(/-/g, "_")}`,
    name: `Playwright ${suffix}`,
    role: "admin",
    slug: suffix,
  };
  const browserSignInUrl = await mintBrowserSignInUrl({
    baseUrl,
    email,
    organization,
    returnTo: "/projects",
  });

  await page.context().clearCookies();
  await page.goto(browserSignInUrl);
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();

  return { email, organization };
}

export async function createProject(page: Page, projectSlug: string) {
  await page
    .getByRole("link", { name: "Create new project" })
    .or(page.getByRole("link", { name: "New project" }))
    .first()
    .click();
  await page.getByLabel("Slug").fill(projectSlug);
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL(
    new RegExp(`/projects/${projectSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`),
  );
}

async function mintBrowserSignInUrl(input: {
  baseUrl: string;
  email: string;
  organization: { id: string; name: string; role: string; slug: string };
  returnTo: string;
}) {
  const authMintArgs = [
    "auth:mint",
    "--browser-url",
    "--base-url",
    input.baseUrl,
    "--email",
    input.email,
    "--orgs",
    JSON.stringify([input.organization]),
    "--return-to",
    input.returnTo,
  ];
  const env = { ...process.env };
  const command = env.AUTH_FORGE_PRIVATE_JWK ? "pnpm" : "doppler";
  const args = env.AUTH_FORGE_PRIVATE_JWK
    ? authMintArgs
    : [
        "run",
        "--project",
        "os",
        "--config",
        env.OS_PLAYWRIGHT_DOPPLER_CONFIG || env.DOPPLER_CONFIG || "dev",
        "--",
        "pnpm",
        ...authMintArgs,
      ];

  const { stdout } = await execFileAsync(command, args, {
    cwd: REPO_ROOT,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  const url = stdout.trim();
  if (!URL.canParse(url)) {
    throw new Error(`auth:mint did not return a browser URL: ${url}`);
  }
  return url;
}
