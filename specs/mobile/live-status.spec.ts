// The live activity card's status row, held open at every phase and read like
// a user would. One chat turn on an intercepted/* model runs two codemode
// rounds, and the spec controls the clock at each hand-off:
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

import { expect, type Page } from "@playwright/test";
import { connectItxReady } from "iterate/node";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { resolveAdminSecret } from "../test-support/forged-session.ts";
import { test } from "../test-support/test.ts";

const STATUS_ROUND_ONE = "Sweeping March refunds";
const STATUS_ROUND_TWO = "Sweeping April refunds";
const REPLY = "Refund sweep complete";
// The "processing" gap lasts exactly this long — generous enough for the ↻
// assertions to land, short enough to keep the spec tight. It also delays the
// turn's FIRST request by the same amount; the itx-side event waits bridge
// that window (no spinner covers a debounce).
const DEBOUNCE_MS = 4_000;

test("the live card wears the agent-set status and a phase glyph per round", async ({
  page,
}, testInfo) => {
  // timeout: signup + cold itx WebSocket (the mobile-spec fixed costs) plus
  // one two-round turn that deliberately waits out two 4s debounce windows.
  test.setTimeout(120_000);
  const osBaseUrl = await resolveOsBaseUrl();

  // The round-1 script parks on this fetch until the spec releases it.
  let releaseScriptHold!: () => void;
  const scriptHoldReleased = new Promise<void>((resolve) => (releaseScriptHold = resolve));
  const echo = await withTunnel({
    path: "/live-status-hold",
    async fetch() {
      await scriptHoldReleased;
      return Response.json({ swept: 3 });
    },
  });
  try {
    const projectSlug = `mobile-live-status-${Date.now().toString(36)}-${testInfo.parallelIndex}`;
    await signUpToProject(page, testInfo, osBaseUrl, projectSlug);
    const projectId = new URL(page.url()).pathname.split("/")[2]!;

    using itx = await connectItxReady({
      auth: { type: "admin-secret", secret: await resolveAdminSecret() },
      baseUrl: osBaseUrl,
      projectId,
    });

    // ── One chat thread; its agent on the intercepted model this spec serves.
    await page.getByText("New chat").click();
    await page.getByPlaceholder("Message").waitFor();
    const agentPath = decodeURIComponent(new URL(page.url()).searchParams.get("path")!);
    using agent = itx.agents.get(agentPath);
    await agent.create();
    // No approvals-style isolate warm-up run: it journals a script-run on the
    // agent stream and renders as a stray second activity card, and every
    // cold-start window here is bridged by an itx-side event wait anyway.
    await agent.append({
      type: "events.iterate.com/agent/configured",
      payload: {
        config: { llm: { model: "intercepted/status" }, llmRequestDebounceMs: DEBOUNCE_MS },
      },
    });

    // Round 2's request stays "waiting" until the spec lets the handler answer.
    let releaseRoundTwo!: () => void;
    const roundTwoReleased = new Promise<void>((resolve) => (releaseRoundTwo = resolve));
    let calls = 0;
    using _interception = await itx.ai.intercept(async ({ source }) => {
      if (source !== "agent-turn") throw new Error(`unexpected source: ${source}`);
      calls += 1;
      if (calls === 1) {
        // First line: the status append a real turn opens with
        // (AGENT_SUMMARY_INSTRUCTION). Then the held fetch; the returned
        // value is what promises the platform another round.
        return [
          "```ts",
          `async (itx) => { await itx.agent.append({ type: "events.iterate.com/agent/summary-updated", payload: { title: "Refund sweep", activity: ${JSON.stringify(STATUS_ROUND_ONE)} } }); const response = await fetch(${JSON.stringify(echo.url)}); return await response.json(); }`,
          "```",
        ].join("\n");
      }
      await roundTwoReleased;
      // Round 2 updates the status, replies, and returns nothing — the turn ends.
      return [
        "```ts",
        `async (itx) => { await itx.agent.append({ type: "events.iterate.com/agent/summary-updated", payload: { activity: ${JSON.stringify(STATUS_ROUND_TWO)} } }); await itx.chat.sendMessage(${JSON.stringify(REPLY)}); }`,
        "```",
      ].join("\n");
    });

    const stream = itx.streams.get(agentPath);
    const beforeTurn = (await stream.getEvents({ limit: 500 })).at(-1)?.offset ?? 0;
    await sendChatMessage(page, "Sweep the March refunds");

    // ── Round 1, held open mid-script. The debounce window has no product
    // spinner, so synchronize itx-side on the status append itself — proof
    // the script is past line 1 — before reading the UI (which by then wears
    // the live card's honest spinner).
    await stream.waitForEvent({
      afterOffset: beforeTurn,
      eventTypes: ["events.iterate.com/agent/summary-updated"],
      timeoutMs: 60_000,
    });
    const card = page.getByTestId(/^activity-card-/);
    await card.getByText(STATUS_ROUND_ONE).waitFor();
    await card.getByLabel("running code", { exact: true }).waitFor();

    // ── Release the hold: the script settles with a value, and for the next
    // debounce window the card shows the processing glyph — still under the
    // agent's own status text, set a round ago in this same turn.
    releaseScriptHold();
    const settled = await stream.waitForEvent({
      afterOffset: beforeTurn,
      eventTypes: ["events.iterate.com/capability-host/script-run-settled"],
      timeoutMs: 60_000,
    });
    await card.getByLabel("processing result", { exact: true }).waitFor();
    await card.getByText(STATUS_ROUND_ONE).waitFor();

    // ── The debounce elapses, round 2's request opens, and the handler is
    // parked: nothing stronger than "waiting" is known, so no glyph — the
    // status text carries the row alone.
    await stream.waitForEvent({
      afterOffset: settled.offset,
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
      timeoutMs: 60_000,
    });
    await page.getByTestId("live-phase-glyph").waitFor({ state: "hidden" });
    await card.getByText(STATUS_ROUND_ONE).waitFor();

    // ── Round 2 answers: status updates, the reply lands, the card settles.
    releaseRoundTwo();
    await page.getByText(REPLY).waitFor();
    await card.getByLabel("Loading").waitFor({ state: "hidden" });

    // ── The settled card's collapsed summary is the last status this turn
    // set; tapping the chevron expands it into two rounds wearing bare
    // number headers.
    await card.getByText(STATUS_ROUND_TWO, { exact: false }).waitFor();
    await card.getByText("▸").click();
    await card.getByText("1", { exact: true }).waitFor();
    await card.getByText("2", { exact: true }).waitFor();
    await card.getByText(/Round \d/).waitFor({ state: "hidden" });

    // ── Journal check: exactly two requests, both on the intercepted model
    // only this spec's handler can serve — the whole turn was deterministic.
    const requests = await stream.getEvents({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
    });
    expect(
      requests.filter((event) => event.offset > beforeTurn).map((event) => event.payload),
    ).toMatchObject([{ model: "intercepted/status" }, { model: "intercepted/status" }]);
  } finally {
    await echo.close();
  }
});

/** Type into the chat composer and send — insertText, not fill (see
 * approvals.spec.ts: RN-web's controlled multiline TextInput intermittently
 * fails fill's post-check). */
async function sendChatMessage(page: Page, message: string) {
  await page.getByPlaceholder("Message").click();
  await page.keyboard.insertText(message);
  await page.getByRole("button", { name: "Send" }).click();
}

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
