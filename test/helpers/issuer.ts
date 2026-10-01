import type { Page } from "@playwright/test";
import { readOsPlaywrightAuthConfig } from "./auth-config.ts";

/** The OAuth client the issuer specs authorize: Claude's published client metadata document. */
export const claudeClient = "https://claude.ai/oauth/claude-code-client-metadata";

/**
 * Sign in on the issuer's sign-in page the way a person does: the email, the password (the
 * deployment's test password unless given), Sign in. The password field is shown at once only when
 * email-code sign-in is unavailable; otherwise it is the alternate method. For specs whose subject
 * is sign-in; any other spec starts signed in (`helpers.createFixture`, `helpers.createSession`).
 */
export async function signInWithPassword(page: Page, email: string, password?: string) {
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  const field = page.getByLabel("Password", { exact: true });
  if (!(await field.isVisible()))
    await page.getByRole("button", { name: "Use password instead", exact: true }).click();
  await field.fill(password || readOsPlaywrightAuthConfig().loginPassword);
  // noWaitAfter: the post navigates; the next locator waits for it (the spinner-waiter counts a
  // navigation in flight as loading), not the click's tight action timeout
  await page.getByRole("button", { name: "Sign in", exact: true }).click({ noWaitAfter: true });
}
