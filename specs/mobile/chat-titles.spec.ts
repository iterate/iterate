// Chat titles through the real phone-sized web build: a fresh chat starts as
// its raw stream path (mobile/<timestamp> — all the client has before the
// agent's first turn), then an admin itx appends the same summary-updated
// fact a real agent turn opens with (AGENT_SUMMARY_INSTRUCTION) — and the
// title takes over both surfaces this branch teaches to read it: the thread
// header live off the event stream, and the chat list row via the title now
// carried by itx.agents.list().
//
// ZERO model turns: no message is ever sent, no LLM request ever opens.
// Every event in the thread is deterministic. (This used the retired
// `/script` command before; the event under test is identical either way.)

import { spinnerWaiter } from "middlewright";
import { connectItxReady } from "iterate/node";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { resolveAdminSecret } from "../test-support/forged-session.ts";
import { test } from "../test-support/test.ts";

const TITLE = "Refund sweep for March";

test("a chat wears its agent-set title in the thread header and chat list", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const projectSlug = `mobile-chat-titles-${Date.now().toString(36)}`;

  await signUpToProject(page, testInfo, osBaseUrl, projectSlug);
  const projectId = new URL(page.url()).pathname.split("/")[2]!;

  // ── A brand-new chat: the only name that exists yet is the stream path,
  // worn by the thread header (react-navigation renders header titles with
  // role=heading, which also keeps this from matching message text). Read
  // the path off the screen the way a user would — URLs are an RN-web
  // artifact, not part of the UI.
  await page.getByText("New chat").click();
  const pathHeading = page.getByRole("heading", { name: /^mobile\// });
  await pathHeading.waitFor();
  const pathFallback = await pathHeading.textContent();
  const agentPath = `/agents/${pathFallback}`;

  // ── The agent's first turn, minus the model: append the same
  // summary-updated fact a real turn opens with. No message, no script — the
  // thread stays empty and deterministic while the title machinery runs.
  using itx = await connectItxReady({
    auth: { type: "admin-secret", secret: await resolveAdminSecret() },
    baseUrl: osBaseUrl,
    projectId,
  });
  // The client defers agent creation to the first message; with no message in
  // this spec, birth the agent explicitly (get-or-create, the same create
  // call the client uses) before appending to it.
  using agent = itx.agents.get(agentPath);
  await agent.create();
  await agent.append({
    type: "events.iterate.com/agent/summary-updated",
    payload: { title: TITLE, activity: "Emailing customers about refunds" },
  });

  // The header reads the title live off the thread's own event stream — no
  // refetch, no navigation. role=heading scopes the wait to the header.
  await page.getByRole("heading", { name: TITLE }).waitFor();

  // ── Back on the chat list (via the header back control — accessible name
  // "<previous screen title>, back", and role=link on web where
  // react-navigation gives it an href), THIS chat's row wears the title —
  // served by the live agent catalog (itx.agents.liveState). The push races
  // the first paint with no product spinner in between, so the not-yet-
  // renamed row (still showing the raw path) is taught to the spinner
  // waiter as loading UI: the wait budget extends while the stale row is
  // on screen, and no manual timeout is needed. The row-scoped locator
  // pins which chat got renamed (and stays unique while the popped thread
  // screen, whose header also says the title, is still mid-unmount); the
  // annotated waitFor carries the rendered cursor to the row, holding into
  // the final freeze-frame.
  await page.getByRole("link", { name: `${projectSlug}, back` }).click();
  await spinnerWaiter.settings.run(
    { spinnerSelectors: [`:has-text(${JSON.stringify(pathFallback)})`] },
    async () => {
      await page.getByTestId(`chat-list-row:${agentPath}`).getByText(TITLE).waitFor();
    },
  );
});

async function signUpToProject(
  page: test.Page,
  testInfo: test.TestInfo,
  osBaseUrl: string,
  projectSlug: string,
): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("https://os.iterate.com").fill(osBaseUrl);
  // timeout: OIDC discovery + client registration have no loading UI for the spinner waiter
  const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  // The popup arrives already middlewright-wrapped (popups auto-wrap since
  // middlewright#33), so the spinner/hydration waiters cover it — no manual
  // timeouts on popup actions.
  const popup = await popupPromise;
  await popup.getByTestId("email-login-button").click();
  await signUpWithEmailOtp(popup, {
    // A constant prefix, NOT the slug: the signup display name embeds this,
    // and a slug-containing name makes getByText(projectSlug) ambiguous.
    email: uniqueSignupEmail("mobile-chat-titles"),
    projectSlug,
    testInfo,
  });
  // Project selection auto-continues for test identities (project-access.tsx)
  // — consent is the next interactive page.
  await popup.getByRole("button", { name: "Allow access" }).click();
  // The app auto-opens the account's only project — no picker tap. (The old
  // picker tap was a strict-mode trap: the slug also appears in the note
  // composer's "→ /notes in <slug>" caption once the chat list is up.)
  await page.getByText("New chat").waitFor();
  // Video-mode demos start at the interesting part: the chat list, not the
  // OAuth signup ceremony.
  page.videoMode?.setStartTime();
}

async function resolveOsBaseUrl(): Promise<string> {
  const configured = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}
