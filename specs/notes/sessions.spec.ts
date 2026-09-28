// The Notes app's session: Notes is served only through a project's config worker
// (apps/notes/config-worker.ts), on its host's sign-in — a project host's own grant under subdomains,
// the platform's under paths — which the Dash's sessions page ends.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { transformSync } from "esbuild";
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../test-support/auth-config.ts";
import { test } from "../test-support/test.ts";
import { workerBaseUrl } from "../test-support/worker-base-url.ts";

// the note's textbox is named by the file it edits (apps/notes/src/routes/_auth/projects.$slug.tsx)
const noteFile = "/repos/config/notes/log.md";

test("the Notes app works through a project config worker, keeps a note, and ending its session in the Dash signs it out there", async ({
  page,
  context,
  helpers,
}) => {
  const { ingressRouting } = readOsPlaywrightAuthConfig();
  // the Notes Worker the config worker fetches through to, and the Dash that ends the session
  const notes = new URL(helpers.appOrigin("notes"));
  const dash = client(helpers.appOrigin("dash"), "iterate Dash");
  await using fixture = await helpers.createFixture("notes-proxy");
  const { project } = fixture;
  const note = `Written through the project: ${project.slug}`;
  // the app on the project's `notes` routing slug: notes--<project>.<hostname> under subdomains,
  // <platform>/projects/<project>/notes/ under paths (apps/notes/src/base-path.ts)
  const proxied = (path: string) =>
    projectUrlOf(ingressRouting, workerBaseUrl, {
      project: project.slug,
      routingSlug: "notes",
      path,
    })!;
  // WHOSE SIGN-IN the app runs on: its host's `/.auth/*` (apps/os/src/worker.ts). Under subdomains
  // that host is an origin of its own, a client of its own whose document names no app, so consent
  // names it by its host. Under paths it is the platform's origin, whose sign-in the fixture already
  // holds: no consent, and the Dash lists that session as "iterate".
  const ownOrigin = ingressRouting?.type === "subdomains";
  const proxiedHost = proxied("/").host;
  const proxiedClient = ownOrigin
    ? { origin: proxied("/").origin, name: proxiedHost, host: proxiedHost }
    : { origin: workerBaseUrl, name: "iterate", host: new URL(workerBaseUrl).host };
  // The repository's actual config-worker source, preserving its auth.require gate, pointed at the
  // Notes Worker under test: its host and protocol (the source names production's, over https; a
  // local Notes answers http).
  const source = transformSync(
    readFileSync(resolve(import.meta.dirname, "../../apps/notes/config-worker.ts"), "utf8"),
    { loader: "ts", format: "esm" },
  )
    .code.replace('"notes.iterate.com"', JSON.stringify(notes.host))
    .replace('url.protocol = "https:"', `url.protocol = ${JSON.stringify(notes.protocol)}`);
  expect(source).toContain(`url.host = ${JSON.stringify(notes.host)}`);
  // The fixture's operator handle publishes the config worker: every host of the project reaches it,
  // the `notes` routing slug with `x-iterate-routing-slug: notes`, and it fetches through to the
  // Notes Worker. Every app interaction after this is real browser RPC.
  // after the project's own saga has published its seed, which would otherwise land after and win
  await fixture.itx.waitForEvent({
    type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
    afterOffset: 0,
    timeoutMs: 60_000,
  });
  // Notes writes to this same repo. Store the worker there so each note's commit keeps publishing
  // it, rather than replacing a one-off ingress override with the seeded worker.
  await fixture.itx.invoke([
    "itx",
    "repos",
    ["get", "/repos/config"],
    ["writeFile", "worker.ts", source],
  ]);
  await page.goto(proxied("/projects").href);
  if (ownOrigin) await consent(page, proxiedClient);
  await saveNote(page, note);
  await page.reload();
  await page
    .getByRole("status")
    .filter({ hasText: /^At commit / })
    .waitFor();
  expect(await page.getByRole("textbox", { name: noteFile, exact: true }).inputValue()).toBe(note);
  // The Dash lists the Notes session among the person's sessions; logging it out there signs Notes
  // out: at consent under subdomains, at the platform's sign-in page under paths.
  await endSessionInDash(page, dash, proxiedClient);
  await page.goto(proxied("/projects").href);
  if (ownOrigin) await consentPage(page, proxiedClient);
  else await page.getByRole("textbox", { name: "Email", exact: true }).waitFor();
  const sessionCookies = (await context.cookies()).filter((cookie) =>
    cookie.name.startsWith("__Host-itx-session"),
  );
  expect(sessionCookies.filter((cookie) => !cookie.httpOnly || !cookie.secure)).toEqual([]);
});

/** An OAuth client as the issuer's consent page names it: the app's name, its domain beneath. */
type Client = { origin: string; name: string; host: string };

/** An app deployed against the platform under test, as `Client`. */
function client(origin: string, name: string): Client {
  return { origin, name, host: new URL(origin).host };
}

/** The issuer's consent page for `client`: its name in the heading, always, and beneath it the
 *  domain its metadata came from, which the issuer shows only for an https client id
 *  (apps/os/src/client-display.ts) — not a local app's http origin. */
async function consentPage(page: Page, client: Client) {
  await page
    .getByRole("heading", { name: `${client.name} wants to access your account`, exact: true })
    .waitFor();
  if (new URL(client.origin).protocol === "https:")
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

/** Sign in to the Dash as the same person and log out the session `client` holds. Its row names
 *  the client, always; the domain beneath follows the consent page's https rule. */
async function endSessionInDash(page: Page, dash: Client, client: Client) {
  // the sessions page itself: signed out of the Dash, it signs in first and comes back
  await page.goto(`${dash.origin}/sessions`);
  await consent(page, dash);
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  // by its whole name: the platform's own session, "iterate", is a prefix of every app's
  const session = page
    .getByRole("list", { name: "Sessions" })
    .getByRole("listitem")
    .filter({ has: page.getByText(client.name, { exact: true }) });
  await session.getByRole("button", { name: "Log out", exact: true }).click();
  // the list reloads without it
  await expect.poll(() => session.count()).toBe(0);
}
