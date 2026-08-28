// The live activity card's status row, held open at every phase and read
// entirely from the UI. One chat turn on an intercepted/* model runs two
// codemode rounds, and the spec controls the clock at each hand-off:
//
// - "running code" is pinned open by the round-1 script awaiting a fetch
//   against THIS spec's tunnel — the response resolves only when the spec
//   releases it (the egress hold as a plain-JS lock).
// - the "processing" gap (script settled WITH a returned value ⇒ another LLM
//   round is owed, but no request journaled yet) is pinned open by a raised
//   llmRequestDebounceMs — the gap IS the debounce window.
// - round 2's "waiting" is pinned open by the interceptor handler awaiting a
//   spec-side gate before returning its script.
//
// Through all of it the card's text is the AGENT-SET status ("Sweeping March
// refunds" — the summary-updated append on the running script's first line),
// not the generic "running code…", and the phase glyph next to the spinner
// tracks ▶ running → ↻ processing → (nothing) waiting. After the turn
// settles, the expanded card's two rounds wear bare "1"/"2" headers.
//
// Every wait is a UI wait: the working row now spans the request debounce
// (this branch's turnPending fold) and the live card's spinner covers the
// rest, so the spinner-waiter budgets everything — no journal waits, no
// manual timeouts.

import { expect } from "@playwright/test";
import { connectItxReady } from "iterate/node";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { createAgentHelper, resolveAdminSecret } from "../test-support/forged-session.ts";
import { test } from "../test-support/test.ts";

test("the live card wears the agent-set status and a phase glyph per round", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();

  // The round-1 script parks on this fetch until the spec resolves the hold.
  const scriptHold = Promise.withResolvers<void>();
  await using echo = await withTunnel({
    path: "/live-status-hold",
    async fetch() {
      await scriptHold.promise;
      return Response.json({ swept: 3 });
    },
  });

  const projectSlug = `mobile-live-status-${Date.now().toString(36)}-${testInfo.parallelIndex}`;
  await signUpToProject(page, testInfo, osBaseUrl, projectSlug);
  const projectId = new URL(page.url()).pathname.split("/")[2]!;

  using itx = await connectItxReady({
    auth: { type: "admin-secret", secret: await resolveAdminSecret() },
    baseUrl: osBaseUrl,
    projectId,
  });

  // ── One chat thread; its agent on an intercepted model served by the
  // shared harness (the agent-side half of helpers.createFixture — the
  // fixture's forged sessions can't sign the MOBILE app in, so the project
  // comes from the UI signup and the harness takes the app-minted path).
  await page.getByText("New chat").click();
  await page.getByPlaceholder("Message").waitFor();
  const agentPath = decodeURIComponent(new URL(page.url()).searchParams.get("path")!);
  await using agentHelper = createAgentHelper({
    baseUrl: osBaseUrl,
    projectId,
    projectSlug,
    slugPrefix: "mobile-live-status",
    getAgent: (path) => itx.agents.get(path),
  });
  const agent = await agentHelper.createAgent({
    path: agentPath,
    // The 4s debounce IS the observable "processing" window (and, before
    // round 1, a working-row window) — generous enough to assert against,
    // short enough to keep the spec tight.
    llmRequestDebounceMs: 4_000,
  });

  // Round 1: the status append a real turn opens with
  // (AGENT_SUMMARY_INSTRUCTION), then the held fetch; the returned value is
  // what promises the platform another round. (A retried attempt replays the
  // same script — the queue fingerprints calls.)
  agent.responses.setOnce(
    `async (itx) => { await itx.agent.append({ type: "events.iterate.com/agent/summary-updated", payload: { title: "Refund sweep", activity: "Sweeping March refunds" } }); const response = await fetch(${JSON.stringify(echo.url)}); return await response.json(); }`,
  );
  // Round 2 stays "waiting" until the spec resolves the gate, then updates
  // the status, replies, and returns nothing — turn over.
  const roundTwoGate = Promise.withResolvers<void>();
  agent.responses.set(async () => {
    await roundTwoGate.promise;
    return [
      "```ts",
      `async (itx) => {
        await itx.agent.append({
          type: "events.iterate.com/agent/summary-updated",
          payload: { activity: "Sweeping April refunds" },
        });
        await itx.chat.sendMessage("Refund sweep complete");
      }`,
      "```",
    ].join("\n");
  });

  // ── Send, then round 1 held open mid-script: the working row spins through
  // the debounce, the live card takes over, and the summary row reads the
  // agent-set status under the ▶ glyph.
  // insertText, not fill: RN-web's controlled multiline TextInput
  // intermittently fails fill's post-check (see approvals.spec.ts).
  await page.getByPlaceholder("Message").click();
  await page.keyboard.insertText("Sweep the March refunds");
  await page.getByRole("button", { name: "Send" }).click();
  const card = page.getByTestId(/^activity-card-/);
  await card.getByText("Sweeping March refunds").waitFor();
  await card.getByLabel("running code", { exact: true }).waitFor();

  // ── Release the hold: the script settles with a value, and for the next
  // debounce window the card shows ↻ — still under the agent's own status
  // text, set a round ago in this same turn.
  scriptHold.resolve();
  await card.getByLabel("processing result", { exact: true }).waitFor();
  await card.getByText("Sweeping March refunds").waitFor();

  // ── The debounce elapses, round 2's request opens, and the handler is
  // parked: nothing stronger than "waiting" is known, so the glyph retires
  // and the status text carries the row alone.
  await page.getByTestId("live-phase-glyph").waitFor({ state: "hidden" });
  await card.getByText("Sweeping March refunds").waitFor();

  // ── Round 2 answers: status updates, the reply lands, the card settles
  // into the last status this turn set.
  roundTwoGate.resolve();
  await page.getByText("Refund sweep complete").waitFor();
  await card.getByLabel("Loading").waitFor({ state: "hidden" });
  await card.getByText("Sweeping April refunds", { exact: false }).waitFor();

  // ── Tapping the chevron expands two rounds wearing bare number headers.
  await card.getByText("▸").click();
  await card.getByText("1", { exact: true }).waitFor();
  await card.getByText("2", { exact: true }).waitFor();
  await card.getByText(/Round \d/).waitFor({ state: "hidden" });

  // ── Journal check: exactly two requests, both on the intercepted model
  // only this spec's queue can serve — the whole turn was deterministic.
  const requests = await itx.streams.get(agentPath).getEvents({
    eventTypes: ["events.iterate.com/agent/llm-request-requested"],
  });
  expect(requests.map((event) => event.payload)).toMatchObject([
    { model: "intercepted/typed" },
    { model: "intercepted/typed" },
  ]);
});

/** The real signup flow, same shape as chat-titles.spec.ts: server picker →
 * OAuth popup → email OTP → consent → chat list. */
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
  const popup = await popupPromise;
  await popup.getByTestId("email-login-button").click();
  await signUpWithEmailOtp(popup, {
    // A constant prefix, NOT the slug: the signup display name embeds this,
    // and a slug-containing name makes getByText(projectSlug) ambiguous.
    email: uniqueSignupEmail("mobile-live-status"),
    projectSlug,
    testInfo,
  });
  // Project selection auto-continues for test identities — consent is next.
  await popup.getByRole("button", { name: "Allow access" }).click();
  await page.getByText("New chat").waitFor();
  page.videoMode?.setStartTime();
}

/** The OS deployment the mobile app signs into (same resolution as the other
 * mobile specs): APP_CONFIG_BASE_URL in CI, the local dev server otherwise. */
async function resolveOsBaseUrl(): Promise<string> {
  const configured = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}
