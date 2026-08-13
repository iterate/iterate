// Chat titles through the real phone-sized web build: a fresh chat starts as
// its raw stream path (mobile/<timestamp> — all the client has before the
// agent's first turn), then a `/script` maintains the agent status exactly
// the way a real agent turn would (AGENT_SUMMARY_INSTRUCTION appends
// agent/summary-updated) — and the title takes over both surfaces this
// branch teaches to read it: the thread header live off the event stream,
// and the chat list row via the title now carried by itx.agents.list().
//
// ZERO model turns: the script returns nothing, so no context is appended
// and no LLM request ever opens. Every event in the thread is deterministic.

import { expect, type Page } from "@playwright/test";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { test } from "../test-support/test.ts";

const TITLE = "Refund sweep for March";

test("a chat wears its agent-set title in the thread header and chat list", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const projectSlug = `mobile-chat-titles-${Date.now().toString(36)}`;

  await signUpToProject(page, testInfo, osBaseUrl, projectSlug);
  // Video-mode demos start at the interesting part: the chat list, not the
  // OAuth signup ceremony.
  page.videoMode?.setStartTime();

  // ── A brand-new chat: the only name that exists yet is the stream path.
  await page.getByText("New chat").click();
  await page.getByPlaceholder("Message").waitFor();
  const agentPath = decodeURIComponent(new URL(page.url()).searchParams.get("path")!);
  const pathFallback = agentPath.replace(/^\/agents\//, "");
  await page.getByText(pathFallback).first().waitFor();

  // ── The agent's first turn, minus the model: append the same
  // summary-updated fact a real turn opens with. Returning nothing keeps the
  // thread deterministic — no settlement context, no LLM request.
  await sendChatMessage(
    page,
    `/script await itx.agent.append({ type: "events.iterate.com/agent/summary-updated", payload: ${JSON.stringify(
      { title: TITLE, activity: "Emailing customers about refunds" },
    )} });`,
  );

  // The header reads the title live off the thread's own event stream — no
  // refetch, no navigation. The working indicator spins while the script
  // runs, so this wait rides real product UI.
  await page.getByText(TITLE).first().waitFor();

  // ── Back on the chat list, the row wears the title — served by the live
  // agent catalog (itx.agents.liveState); the path is demoted to nothing
  // (it stays reachable from the thread's ••• menu). expect.poll, not a bare
  // locator wait: the remounted list first paints its cached query data and
  // the live snapshot arrives over the socket with no spinner in between —
  // an async server push, so it gets the repo's 15s cross-server tier.
  await page.goBack(); // chat → chat list: browser history IS the app's back stack on web
  await page.getByText("New chat").waitFor();
  await expect.poll(() => page.getByText(TITLE).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => page.getByText(pathFallback).count()).toBe(0);
});

/** Type into the chat composer and send. `insertText` rather than `fill`:
 * RN-web's controlled multiline TextInput intermittently fails playwright
 * fill's post-check under the harness even when visible/enabled/editable all
 * probe true; typing through the focused element sidesteps that. */
async function sendChatMessage(page: Page, message: string) {
  await page.getByPlaceholder("Message").click();
  await page.keyboard.insertText(message);
  await page.getByRole("button", { name: "Send" }).click();
}

async function signUpToProject(
  page: any,
  testInfo: any,
  osBaseUrl: string,
  projectSlug: string,
): Promise<void> {
  await page.goto("/");
  await page.getByPlaceholder("https://os.iterate.com").fill(osBaseUrl);
  // timeout: OIDC discovery + client registration have no loading UI for the spinner waiter
  const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  const popup = await popupPromise;
  // timeout: the popup is outside the wrapped page, so no spinner waiter covers it
  await popup.getByTestId("email-login-button").click({ timeout: 15_000 });
  await signUpWithEmailOtp(popup, {
    // A constant prefix, NOT the slug: the signup display name embeds this,
    // and a slug-containing name makes getByText(projectSlug) ambiguous.
    email: uniqueSignupEmail("mobile-chat-titles"),
    projectSlug,
    testInfo,
  });
  // timeout: same unwrapped popup — the spinner waiter cannot see it.
  await popup.getByRole("button", { name: "Continue" }).click({ timeout: 15_000 });
  // timeout: same unwrapped popup — the spinner waiter cannot see it.
  await popup.getByRole("button", { name: "Allow access" }).click({ timeout: 15_000 });
  await page.getByText(projectSlug).click();
  await page.getByText("New chat").waitFor();
}

async function resolveOsBaseUrl(): Promise<string> {
  const configured = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}
