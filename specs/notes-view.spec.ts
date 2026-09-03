import { expect } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { E2E_HEAVY_TEST_TIMEOUT_MS } from "@iterate-com/shared/test-support/e2e-policy";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { appUrl, docsOriginForBaseUrl } from "./test-support/app-hosts.ts";
import {
  signUpWithEmailOtp,
  startEmailOtpSignIn,
  uniqueSignupEmail,
} from "./test-support/email-otp-signup.ts";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

// The Docs app's Notes view: the long-running log opens under today's
// heading, typing lands in /repos/config/notes/log.md, a new note becomes a
// file in notes/, and the day's commit is AMENDED for later edits rather
// than stacked — proven against the real repo history, not the UI's word
// for it. Signs in the same way as the Docs review proof: a real member,
// email OTP, no minted session.
test("write in the notes view and amend the day's commit", async ({ baseURL, page }, testInfo) => {
  test.setTimeout(E2E_HEAVY_TEST_TIMEOUT_MS);
  test.skip(
    !(await startEmailOtpSignIn(page, testInfo)),
    "Email OTP sign-in is disabled for this deployment (APP_CONFIG_EMAIL_OTP_ENABLED on auth / APP_CONFIG_ITERATE_AUTH__EMAIL_OTP_ENABLED on OS).",
  );

  const slug = uniqueFixtureSlug("notes-view");
  await signUpWithEmailOtp(page, {
    email: uniqueSignupEmail("notes-view"),
    projectSlug: slug,
    testInfo,
  });
  // The project switcher naming the new project is the sign it exists; its
  // agent and worker keep booting in the background (a cold local server
  // takes a while) and the docs host below carries its own cold-build budget.
  await page.getByRole("button", { name: slug }).waitFor({ timeout: 60_000 }); // timeout: manual — the post-onboarding redirect shows no spinner-waiter-visible UI

  using itx = await connectAdminItx(baseURL!);
  using project = itx.projects.get(slug);
  await project.kv.set("docs-app-origin", docsOriginForBaseUrl(baseURL!));

  const notesUrl = new URL(appUrl("docs", slug, baseURL!));
  notesUrl.pathname = "/notes";
  notesUrl.searchParams.set("repo", "/repos/config");
  await page.goto(notesUrl.toString());
  // The same cold build the other seeded-app proofs sit through: the
  // building page's spinner carries the wait, ceiling raised to match.
  await spinnerWaiter.settings.run({ spinnerTimeout: 130_000 }, async () => {
    await page.getByRole("heading", { name: "Sign in to iterate" }).waitFor();
  });
  await page.getByRole("link", { name: "Continue with iterate" }).click({ timeout: 30_000 }); // timeout: cross-origin auth callback + cold build — spinner-waiter would fast-fail it
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page
      .locator("header")
      .getByRole("heading", { name: "/repos/config/notes/log.md" })
      .waitFor({ timeout: 120_000 }); // timeout: manual cold-build budget — spinner-waiter is disabled for this wait
  });

  // The PR walkthrough is about the notes view, not account provisioning
  // and cold-start setup that this end-to-end proof also covers.
  page.videoMode?.setStartTime();

  // The log opens under today's heading with the caret at the end; the
  // heading alone starts no commit timer.
  const editor = page.locator(".cm-content");
  await editor.waitFor({ timeout: 30_000 }); // timeout: the editor chunk + collab attach show no spinner-waiter-visible UI
  await editor.getByText(/^## \d{4}-\d{2}-\d{2}$/).waitFor();
  await page.getByText("Uncommitted", { exact: true }).waitFor();
  await editor.click();
  // Select-all + ArrowRight parks the cursor at the end on macOS and Linux.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("first entry");
  await editor.getByText("first entry", { exact: true }).waitFor({ timeout: 10_000 }); // timeout: tight manual budget — CodeMirror keystroke echo has no loading UI for the spinner-waiter
  await page.getByText(/Uncommitted · commits in/).waitFor();

  // "@" completes agents (the seeded project has its onboarding agent) and
  // the mention becomes a pill over plain text.
  await page.keyboard.type(" cc @onb");
  const completion = page.locator(".cm-tooltip-autocomplete");
  await completion.waitFor({ timeout: 15_000 }); // timeout: one agents() round-trip feeds the list — no spinner-waiter-visible UI
  await completion.getByText("/agents/onboarding").waitFor();
  // CodeMirror ignores Enter for 75ms after the list last changed (its
  // interactionDelay guard against accepting a list that just moved).
  await page.waitForTimeout(200); // timeout: CodeMirror's interactionDelay guard — no spinner-waiter-visible UI covers it
  await page.keyboard.press("Enter");
  await editor.locator(".cm-reference-agent", { hasText: "@/agents/onboarding" }).waitFor();

  // Edits are durable the moment they land: a reload finds them still
  // uncommitted (the platform's status, not this tab's memory) and re-arms
  // the countdown.
  await page.reload();
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.getByText(/Uncommitted · commits in/).waitFor({ timeout: 60_000 }); // timeout: manual — the vessel re-dials on reload with no spinner-waiter-visible UI
  });
  await editor.getByText("first entry cc").waitFor({ timeout: 30_000 }); // timeout: collab re-attach after reload — no spinner-waiter-visible UI

  // Commit now skips the 30s wait: an ordinary commit on top of the seed.
  await page.getByRole("button", { name: "Commit now" }).click();
  await page.getByText(/^committed [0-9a-f]{7}$/).waitFor({ timeout: 60_000 }); // timeout: a real commit to the Artifacts repo — no spinner-waiter-visible UI

  // More text the same day AMENDS that commit.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("\nsecond entry");
  await editor.getByText("second entry", { exact: true }).waitFor({ timeout: 10_000 }); // timeout: tight manual budget — CodeMirror keystroke echo has no loading UI for the spinner-waiter
  await page.getByRole("button", { name: "Commit now" }).click();
  await page.getByText(/^amended [0-9a-f]{7}$/).waitFor({ timeout: 60_000 }); // timeout: a real (amending) commit to the Artifacts repo — no spinner-waiter-visible UI

  // A new note is a new file in notes/, opened right away.
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("textbox", { name: "New note title" }).fill("Ideas");
  await page.keyboard.press("Enter");
  await page
    .locator("header")
    .getByRole("heading", { name: "/repos/config/notes/ideas.md" })
    .waitFor();
  await editor.getByText("# Ideas", { exact: true }).waitFor({ timeout: 30_000 }); // timeout: a fresh collab session on the new file — no spinner-waiter-visible UI
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("an idea");
  await editor.getByText("an idea", { exact: true }).waitFor({ timeout: 10_000 }); // timeout: tight manual budget — CodeMirror keystroke echo has no loading UI for the spinner-waiter
  await page.getByRole("button", { name: "Commit now" }).click();
  await page.getByText(/^amended [0-9a-f]{7}$/).waitFor({ timeout: 60_000 }); // timeout: a real (amending) commit to the Artifacts repo — no spinner-waiter-visible UI

  // Back in the log, the `+` menu links the new note: `[[` completion lists
  // it, the link is a pill, and clicking the pill opens the note.
  await page.getByRole("button", { name: "Log" }).click();
  await editor.getByText("second entry").waitFor({ timeout: 30_000 }); // timeout: switching notes opens a new session — no spinner-waiter-visible UI
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("\nsee ");
  await page.getByRole("button", { name: "Insert" }).click();
  const linkItem = page.getByRole("menuitem", { name: "Link a note or task" });
  await linkItem.waitFor({ timeout: 10_000 }); // timeout: the menu mounts in a portal a tick after the click — no spinner-waiter-visible UI
  await linkItem.click();
  await completion.waitFor({ timeout: 15_000 }); // timeout: the folder listing feeds the list — no spinner-waiter-visible UI
  await page.keyboard.type("idea");
  await completion.getByText("ideas", { exact: true }).waitFor();
  await page.waitForTimeout(200); // timeout: the same CodeMirror interactionDelay guard — no spinner-waiter-visible UI covers it
  await page.keyboard.press("Enter");
  const noteLink = editor.locator(".cm-reference-note", { hasText: "[[notes/ideas.md]]" });
  await noteLink.waitFor();
  await page.getByRole("button", { name: "Commit now" }).click();
  await page.getByText(/^amended [0-9a-f]{7}$/).waitFor({ timeout: 60_000 }); // timeout: a real (amending) commit to the Artifacts repo — no spinner-waiter-visible UI
  await noteLink.click();
  await page
    .locator("header")
    .getByRole("heading", { name: "/repos/config/notes/ideas.md" })
    .waitFor();

  // The repo's own history is the proof: ONE notes commit carrying both
  // files, directly on top of the seed.
  using repo = project.repos.get("/repos/config");
  const history = await repo.log({ limit: 5 });
  expect(history.commits.filter((commit) => commit.message.startsWith("Notes: "))).toHaveLength(1);
  expect(history.commits[0]?.message).toMatch(/^Notes: \d{4}-\d{2}-\d{2}$/);
  const log = await repo.readFile({ path: "notes/log.md" });
  expect(log?.content).toMatch(
    /^## \d{4}-\d{2}-\d{2}\n\nfirst entry cc @\/agents\/onboarding \nsecond entry\nsee \[\[notes\/ideas\.md\]\]\n?$/,
  );
  const ideas = await repo.readFile({ path: "notes/ideas.md" });
  expect(ideas?.content).toMatch(/^# Ideas\n\nan idea\n?$/);

  // Reloading finds nothing pending: the overlay was cleared by the commit.
  await page.reload();
  await spinnerWaiter.settings.run({ disabled: true }, async () => {
    await page.getByText("Up to date").waitFor({ timeout: 60_000 }); // timeout: manual — the vessel re-dials on reload with no spinner-waiter-visible UI
  });
  // Substring matches on purpose: the pre-reload session's caret lingers as
  // a peer-cursor widget on the last line for a few seconds, so that line's
  // text is briefly more than the words alone.
  await editor.getByText("an idea").waitFor({ timeout: 30_000 }); // timeout: collab re-attach after reload — no spinner-waiter-visible UI
  await page.getByRole("button", { name: "Log" }).click();
  await editor.getByText("second entry").waitFor({ timeout: 30_000 }); // timeout: switching notes opens a new session — no spinner-waiter-visible UI
});
