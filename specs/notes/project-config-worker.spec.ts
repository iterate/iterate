// The Notes app on its own origin and through a project's config worker (apps/notes/config-worker.ts):
// one note, written on either, read on both, and the proxy's session revoked on its own.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
// eslint-disable-next-line iterate/no-capnweb-http-batch -- One operator fixture installs the proxy; all app interactions are real browser RPC.
import { newHttpBatchRpcSession } from "capnweb";
import { transformSync } from "esbuild";
import type { IterateApi } from "iterate/next/api";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";

const stamp = () => `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;

// parked: stale since #2853 and never run in CI (runE2e set no NOTES_BASE_URL): the OS home page is
// headless (no "New project" form or "open" link), OS has no /sessions page, and previews route
// projects by paths (/projects/<p>/notes/) where the Notes app is not base-path aware; the rewrite
// also points config-worker.ts at the preview's Notes app — revisit by 2026-10-07
test.fixme("the Notes app works on its own origin and through a project config worker", async ({
  page,
  context,
}) => {
  test.skip(
    !process.env.NOTES_BASE_URL,
    "This acceptance case needs the independently deployed Notes worker",
  );
  const { adminApiSecret, osBaseUrl: origin } = readOsPlaywrightAuthConfig();
  const notesOrigin = new URL(process.env.NOTES_BASE_URL!).origin;
  const email = `notes-${stamp()}@example.com`;
  const project = `notes-${stamp()}`;
  const note = `Written on the independent app: ${stamp()}`;
  // the note's textbox is named by the file it edits (apps/notes/src/routes/_auth/notes.tsx)
  const noteFile = "/repos/config/notes/log.md";
  await page.goto(`${origin}/login`);
  await signIn(page, email);
  await page.getByRole("textbox", { name: "New project" }).fill(project);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByRole("link", { name: "open", exact: true }).waitFor();
  const projectOrigin = new URL(
    (await page.getByRole("link", { name: "open", exact: true }).getAttribute("href"))!,
  ).origin;
  // The notes app on this project is served at the app-slug host notes--<project>.<base> (the edge
  // hands the config worker x-iterate-app: notes), not the apex — the apex has no app label.
  const appOrigin = projectOrigin.replace(`${project}.`, `notes--${project}.`);
  const source = transformSync(
    readFileSync(resolve(import.meta.dirname, "../../apps/notes/config-worker.ts"), "utf8"),
    { loader: "ts", format: "esm" },
  ).code;
  // Install the repository's actual config-worker source, preserving its auth.require gate.
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- One operator fixture installs the proxy; all app interactions are real browser RPC.
  using operator = newHttpBatchRpcSession<IterateApi>(
    new Request(`${origin}/api`, { headers: { authorization: `Bearer ${adminApiSecret}` } }),
  );
  const projectContext = operator
    .authenticate({ type: "admin-secret", secret: adminApiSecret })
    .projects.get(project);
  // Both rules in ONE batch (an HTTP-batch session is one-shot): install the config worker, and point
  // the `notes` app label at it — so notes--<project>.<base> reaches the config worker with the app
  // slug in x-iterate-app, and it fetches through to the Notes worker.
  await Promise.all([
    projectContext.append({
      type: "events.iterate.com/project/ingress-configured",
      payload: { target: ["itx", "workers", ["get", { source: { "cap.js": source } }]] },
    }),
    projectContext.provide("itx.apps.notes", [
      "itx",
      "workers",
      ["get", { source: { "cap.js": source } }],
    ]),
  ]);
  await page.goto(notesOrigin);
  await page.getByRole("link", { name: "Log in with iterate", exact: true }).click();
  await page
    .getByRole("heading", {
      name: `${new URL(notesOrigin).host} wants to access your account`,
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
  await page.getByRole("textbox", { name: noteFile, exact: true }).fill(note);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Committed / })
    .waitFor();
  await page.reload();
  expect(await page.getByRole("textbox", { name: noteFile, exact: true }).inputValue()).toBe(note);
  await page.goto(`${appOrigin}/notes`);
  await page
    .getByRole("heading", {
      name: `${new URL(appOrigin).host} wants to access your account`,
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
  expect(await page.getByRole("textbox", { name: noteFile, exact: true }).inputValue()).toBe(note);
  await page
    .getByRole("textbox", { name: noteFile, exact: true })
    .fill(`${note}; edited through the project proxy`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Committed / })
    .waitFor();
  await page.goto(`${notesOrigin}/notes`);
  expect(await page.getByRole("textbox", { name: noteFile, exact: true }).inputValue()).toBe(
    `${note}; edited through the project proxy`,
  );
  await page.goto(`${origin}/sessions`);
  const appSession = page.getByRole("row").filter({ hasText: new URL(appOrigin).host });
  await appSession.getByRole("button", { name: "Log out", exact: true }).click();
  await page.goto(`${appOrigin}/notes`);
  await page
    .getByRole("heading", {
      name: `${new URL(appOrigin).host} wants to access your account`,
      exact: true,
    })
    .waitFor();
  // The independently granted Notes session remains usable after proxy revocation.
  await page.goto(`${notesOrigin}/notes`);
  await page.getByRole("textbox", { name: noteFile, exact: true }).waitFor();
  const cookies = await context.cookies();
  expect(
    cookies
      .filter((cookie) => cookie.name.startsWith("__Host-itx-session"))
      .every((cookie) => cookie.httpOnly && cookie.secure),
  ).toBe(true);
});

/** Sign in on the page the way a person does: the email, the password, Sign in — the password
 *  field is shown immediately only when email-code sign-in is unavailable. */
async function signIn(page: Page, email: string) {
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  const password = page.getByLabel("Password", { exact: true });
  if (!(await password.isVisible()))
    await page.getByRole("button", { name: "Use password instead", exact: true }).click();
  await password.fill(readOsPlaywrightAuthConfig().loginPassword);
  // noWaitAfter: the post navigates; the next locator waits for it (the spinner-waiter counts a
  // navigation in flight as loading), not the click's tight action timeout
  await page.getByRole("button", { name: "Sign in", exact: true }).click({ noWaitAfter: true });
}
