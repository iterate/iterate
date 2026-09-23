// The Notes app's sessions across workers: signed in on its own origin, and through a project's
// config worker (apps/notes/config-worker.ts), each an OAuth grant of its own that the Dash's
// sessions page ends without touching the other.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
// eslint-disable-next-line iterate/no-capnweb-http-batch -- One operator fixture installs the proxy; all app interactions are real browser RPC.
import { newHttpBatchRpcSession } from "capnweb";
import { transformSync } from "esbuild";
import type { IterateApi } from "iterate/next/api";
import { projectUrlOf } from "iterate/next/project-ingress";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";

// the note's textbox is named by the file it edits (apps/notes/src/routes/_auth/projects.$slug.tsx)
const noteFile = "/repos/config/notes/log.md";

test("the Notes app keeps a note on its own origin, and ending its session in the Dash signs it out there", async ({
  page,
  helpers,
}) => {
  const { notes, dash } = appClients();
  await using fixture = await helpers.createFixture("notes");
  const note = `Written on the Notes app: ${fixture.project.slug}`;
  await page.goto(notes.origin);
  await page
    .getByRole("link", { name: "Log in with iterate", exact: true })
    .click({ noWaitAfter: true });
  await consent(page, notes);
  await saveNote(page, note);
  await page.reload();
  await page
    .getByRole("status")
    .filter({ hasText: /^At commit / })
    .waitFor();
  expect(await page.getByRole("textbox", { name: noteFile, exact: true }).inputValue()).toBe(note);
  // The Dash lists the Notes session among the person's sessions; logging it out there signs the
  // Notes app out: its next page asks for consent again. The Dash's own session carries on.
  await endSessionInDash(page, dash, notes.host);
  await page.goto(`${notes.origin}/projects`);
  await consentPage(page, notes);
  await page.goto(`${dash.origin}/sessions`);
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
});

test("the Notes app works through a project config worker, and its session there ends on its own", async ({
  page,
  context,
  helpers,
}) => {
  const { adminApiSecret, ingressRouting, osBaseUrl: origin } = readOsPlaywrightAuthConfig();
  // parked: under `paths` routing (every preview) Notes cannot be proxied at /projects/<p>/notes/:
  // it ignores ITERATE_BASE_PATH_HEADER, its links and assets are root-absolute — #2908, pending the
  // path-routed hosting decision. No CI lane runs this until then. — revisit by 2026-10-21
  test.skip(
    ingressRouting?.type !== "subdomains",
    "Notes is not base-path aware under a proxied project path (#2908)",
  );
  const { notes, dash } = appClients();
  await using fixture = await helpers.createFixture("notes-proxy");
  const { project } = fixture;
  const note = `Written on the independent app: ${project.slug}`;
  // the same app on the project's `notes` label: notes--<project>.<hostname>
  const proxiedUrl = projectUrlOf(ingressRouting, origin, { project: project.slug, app: "notes" })!;
  const proxied = { origin: proxiedUrl.origin, name: notes.name, host: proxiedUrl.host };
  // The repository's actual config-worker source, preserving its auth.require gate, pointed at the
  // Notes app under test (the source names production's).
  const source = transformSync(
    readFileSync(resolve(import.meta.dirname, "../../apps/notes/config-worker.ts"), "utf8"),
    { loader: "ts", format: "esm" },
  ).code.replace('"notes.iterate.workers.dev"', JSON.stringify(notes.host));
  // eslint-disable-next-line iterate/no-capnweb-http-batch -- One operator fixture installs the proxy; all app interactions are real browser RPC.
  using operator = newHttpBatchRpcSession<IterateApi>(
    new Request(`${origin}/api`, { headers: { authorization: `Bearer ${adminApiSecret}` } }),
  );
  const projectContext = operator
    .authenticate({ type: "admin-secret", secret: adminApiSecret })
    .projects.get(project.id);
  // Both rules in ONE batch (an HTTP-batch session is one-shot): install the config worker, and point
  // the `notes` app label at it — so the app's host reaches the config worker with the app slug in
  // x-iterate-app, and it fetches through to the Notes worker.
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
  // On its own origin: one note.
  await page.goto(notes.origin);
  await page
    .getByRole("link", { name: "Log in with iterate", exact: true })
    .click({ noWaitAfter: true });
  await consent(page, notes);
  await saveNote(page, note);
  // Through the project: a grant of its own, the same note, and an edit.
  await page.goto(`${proxied.origin}/projects`);
  await consent(page, proxied);
  expect(await page.getByRole("textbox", { name: noteFile, exact: true }).inputValue()).toBe(note);
  await saveNote(page, `${note}; edited through the project proxy`);
  await page.goto(`${notes.origin}/projects`);
  await page
    .getByRole("status")
    .filter({ hasText: /^At commit / })
    .waitFor();
  expect(await page.getByRole("textbox", { name: noteFile, exact: true }).inputValue()).toBe(
    `${note}; edited through the project proxy`,
  );
  // Ending the proxy's session leaves the independently granted Notes session usable.
  await endSessionInDash(page, dash, proxied.host);
  await page.goto(`${proxied.origin}/projects`);
  await consentPage(page, proxied);
  await page.goto(`${notes.origin}/projects`);
  await page.getByRole("textbox", { name: noteFile, exact: true }).waitFor();
  const sessionCookies = (await context.cookies()).filter((cookie) =>
    cookie.name.startsWith("__Host-itx-session"),
  );
  expect(sessionCookies.filter((cookie) => !cookie.httpOnly || !cookie.secure)).toEqual([]);
});

/** An OAuth client as the issuer's consent page names it: the app's name, its domain beneath. */
type Client = { origin: string; name: string; host: string };

/** The Notes and Dash apps deployed against the platform under test: a local run without them
 *  skips; in CI (the preview's e2e job sets both) a missing one fails. */
function appClients(): { notes: Client; dash: Client } {
  test.skip(
    !process.env.CI && !(process.env.NOTES_BASE_URL && process.env.DASH_BASE_URL),
    "The Notes session specs need the Notes and Dash apps deployed against the platform under test",
  );
  expect(process.env.NOTES_BASE_URL, "NOTES_BASE_URL: the preview's Notes app").toBeTruthy();
  expect(process.env.DASH_BASE_URL, "DASH_BASE_URL: the preview's Dash app").toBeTruthy();
  const client = (url: string, name: string) => ({
    origin: new URL(url).origin,
    name,
    host: new URL(url).host,
  });
  return {
    notes: client(process.env.NOTES_BASE_URL!, "Iterate Notes"),
    dash: client(process.env.DASH_BASE_URL!, "Iterate Dash"),
  };
}

/** The issuer's consent page for `client`: its name in the heading, its domain beneath. */
async function consentPage(page: Page, client: Client) {
  await page
    .getByRole("heading", { name: `${client.name} wants to access your account`, exact: true })
    .waitFor();
  await page.getByText(client.host, { exact: true }).waitFor();
}

/** Consent for a signed-in person who has a project: straight to review, then Authorize, which
 *  posts and hands the browser back to the client. */
async function consent(page: Page, client: Client) {
  await consentPage(page, client);
  await page.getByRole("button", { name: "Review permissions", exact: true }).click();
  await page.getByRole("button", { name: "Authorize", exact: true }).click({ noWaitAfter: true });
}

/** Write the note and commit it; the status names the commit. */
async function saveNote(page: Page, text: string) {
  await page.getByRole("textbox", { name: noteFile, exact: true }).fill(text);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Committed / })
    .waitFor();
}

/** Sign in to the Dash as the same person and log out the session `clientHost` holds. */
async function endSessionInDash(page: Page, dash: Client, clientHost: string) {
  // the sessions page itself: signed out of the Dash, it signs in first and comes back
  await page.goto(`${dash.origin}/sessions`);
  await consent(page, dash);
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  const session = page.getByRole("row").filter({ hasText: clientHost });
  await session.getByRole("button", { name: "Log out", exact: true }).click();
  // the list reloads without it
  await expect.poll(() => session.count()).toBe(0);
}
