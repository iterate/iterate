// The phone approver, end to end in a browser — and entirely INSIDE the
// conversation: `/script` typed into the chat composer runs a burst
// deterministically, the requests park at the egress door as ONE batch, and
// the approval dialog appears in-thread where the human is already looking.
// Approve all behind the Face ID stand-in (the web build gates authenticated
// key reads behind `confirm()`), then a second burst rejected with a typed
// reason the script's 403 body carries back into the thread.
//
// ZERO model turns, asserted: the scripts narrate their own outcomes with
// `itx.chat.sendMessage(...)` and return nothing, so the settled result
// render has nothing to append and no LLM request ever opens. Every event in
// the thread is deterministic.
//
// No spinner-waiter escapes anywhere: the running-code activity spinner is
// honest product UI spanning command → run → parked-at-the-door → decision,
// so every wait extends against a real spinner.
//
// Web-platform approximations, deliberate and dev-only: secure storage is
// localStorage with confirm()-gated reads (apps/mobile/src/lib/secure-store.ts),
// and pushes don't exist on web — the spec enrolls this browser's device
// identity server-side so each batch's notification journals a row for the
// final act: the Notifications view (the approvals surface, now that the
// standalone screen is retired), where each row expands into the batch's
// history wearing the thread's status at the time.

import { expect, type Page } from "@playwright/test";
import { connectItxReady } from "iterate/node";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { resolveAdminSecret } from "../test-support/forged-session.ts";
import { test } from "../test-support/test.ts";

// The browser's device identity, fixed BEFORE the app boots (the web build's
// secure store is localStorage), so the server-side enrollment below and the
// Notifications view read the same device stream.
const DEVICE_ID = "spec-web-approver";

test("approve and reject script bursts from inside the chat thread", async ({ page }, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const echo = await startEgressEcho();
  try {
    // ── Sign up through the REAL flow: server picker → OAuth popup → email
    // OTP (fixed dev code) → org+project onboarding → project access →
    // consent → back in the app.
    const projectSlug = `mobile-approvals-${Date.now().toString(36)}`;
    await page.addInitScript((deviceId) => {
      localStorage.setItem("iterate.secure-store.iterate.mobileDeviceId.v1", deviceId);
    }, DEVICE_ID);
    await page.goto("/");
    await page.getByPlaceholder("https://os.iterate.com").fill(osBaseUrl);
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Sign in" }).click();
    const popup = await popupPromise;
    await popup.getByTestId("email-login-button").click();
    await signUpWithEmailOtp(popup, {
      email: uniqueSignupEmail("mobile-approvals"),
      projectSlug,
      testInfo,
    });
    await popup.getByRole("button", { name: "Continue" }).click({ timeout: 30_000 });
    await popup.getByRole("button", { name: "Allow access" }).click({ timeout: 30_000 });

    // Opening the project auto-enrolls this browser's approval key — no
    // manual enroll step anywhere below. The first project list rides a COLD
    // itx WebSocket to the deployment (~20-30s against preview slots) — a
    // product-latency problem worth fixing at the source, not something more
    // spinner UI can paper over.
    await page.getByText(projectSlug).click({ timeout: 60_000 });
    await page.getByText("New chat").waitFor({ timeout: 30_000 });
    const projectId = new URL(page.url()).pathname.split("/")[2]!;

    // ── Admin-side policy, the one non-user step: a hold rule on the echo
    // host so the bursts park for a human.
    using itx = await connectItxReady({
      auth: { type: "admin-secret", secret: await resolveAdminSecret() },
      baseUrl: osBaseUrl,
      projectId,
    });
    const [rulesConfigured] = await itx.streams.get("/").append({
      type: "events.iterate.com/project/egress-rules-configured",
      payload: {
        rules: [
          {
            ruleKey: "spec-needs-a-human",
            description: "The mobile approvals spec holds these for a human",
            match: { hosts: [new URL(echo.url).hostname] },
            verdict: "hold",
            approvalTimeoutMs: 120_000,
            // Generous window so a busy CI runner's burst still lands in ONE
            // batch — the 100ms default is tuned for production latencies.
            debounceMs: 2_000,
          },
        ],
      },
    });
    await itx.processor.waitUntilProcessed({ offset: rulesConfigured!.offset, timeoutMs: 15_000 });
    // Enroll this browser's device identity server-side (the web build has
    // no push channel of its own) so every batch's notification opens a row
    // on the device stream — what the Notifications view reads below. The
    // in-thread dialogs claim both batches, so the rows settle suppressed
    // and the undeliverable token is never dialed.
    await itx.devices.get(DEVICE_ID).enroll({
      appVersion: "spec",
      expoPushToken: `ExponentPushToken[${DEVICE_ID}-never-deliverable]`,
      label: "Spec web approver",
      notificationsStatus: "granted",
      platform: "ios",
    });
    // Outwait the egress gate's ~5s rules cache before the first burst —
    // marked dead air so the rendered video skips the on-screen idle.
    const outwaitRulesCache = () => new Promise((resolve) => setTimeout(resolve, 6_000));
    await (page.videoMode ? page.videoMode.deadAir(outwaitRulesCache) : outwaitRulesCache());

    // ── Into the conversation: everything below happens in ONE chat thread.
    await page.getByText("New chat").click();
    await page.getByPlaceholder("Message").waitFor();
    const agentPath = decodeURIComponent(new URL(page.url()).searchParams.get("path")!);
    // The script narrates its own outcome (success or error) and returns
    // nothing — an undefined settlement result appends no context, so no
    // model turn follows. The thread stays 100% deterministic. Before the
    // burst, the script maintains the agent status exactly the way a real
    // agent turn would (AGENT_SUMMARY_INSTRUCTION): summary-updated appends,
    // fields updating independently — the status the approvals screen pins
    // to this batch's card.
    const burstCommand = (marker: string, statusUpdates: object[]) =>
      `/script ${statusUpdates
        .map(
          (update) =>
            `await itx.agent.append({ type: "events.iterate.com/agent/summary-updated", payload: ${JSON.stringify(update)} }); `,
        )
        .join(
          "",
        )}const burst = async () => { const responses = await Promise.all(Array.from({length: 3}, (_, index) => fetch(${JSON.stringify(echo.url)} + "?${marker}=" + index, {method: "POST", body: "${marker} " + index}))); const outcomes = await Promise.all(responses.map(async (response) => ({status: response.status, body: await response.json()}))); return "${marker} outcomes: " + JSON.stringify(outcomes); }; await itx.chat.sendMessage(await burst().catch(String));`;

    const readOutcomeMessages = async () =>
      (
        await itx.streams.get(agentPath).getEvents({
          eventTypes: ["events.iterate.com/agents/web-message-sent"],
        })
      )
        .map((event) => (event.payload as { message: string }).message)
        .filter((message) => message.includes(" outcomes: "));

    // Approve lane: the command runs deterministically (no model turn), the
    // burst parks as one batch, and the dialog appears in-thread while the
    // working indicator honestly spins — no spinner-waiter escapes needed.
    await sendChatMessage(
      page,
      burstCommand("approve-me", [
        { title: "Refund sweep", activity: "Emailing 3 customers about order refunds" },
      ]),
    );
    await waitForBatchCardButton(page, "Approve all 3 (Face ID)");
    await decideBatch(page, "Approve all 3 (Face ID)", (dialog) => dialog.accept());

    // Run 1 must SETTLE before lane 2's command goes in: the settle event
    // is the upper bound of batch 1's thread-context fold (asserted on the
    // approvals screen below), so lane 2's status appends must land after
    // it. Settlement also implies run 1's narration already appended — the
    // script sends it before returning.
    await expect
      .poll(
        async () =>
          (
            await itx.streams.get(agentPath).getEvents({
              eventTypes: ["events.iterate.com/capability-host/script-run-settled"],
            })
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1);

    // Reject lane: same shape, typed reason, and a two-append status story —
    // the first append sets title + activity, then an activity-only update
    // as the phase changes (the fold must keep the standing title).
    const reason = "wrong recipient — use the staging address";
    await sendChatMessage(
      page,
      burstCommand("reject-me", [
        { title: "Invoice chase", activity: "Preparing payment reminders" },
        { activity: "Requesting payment for 3 overdue invoices" },
      ]),
    );
    await waitForBatchCardButton(page, "Reject all");
    await decideBatch(page, "Reject all", (dialog) => dialog.accept(reason));

    // ── Asserted from the protocol: each script narrated its outcomes into
    // the thread — the approved burst with 200s, the rejected one with 403s
    // whose bodies carry the human's reason verbatim (the cue an agent would
    // read to retry differently).
    await expect
      .poll(async () => (await readOutcomeMessages()).length, { timeout: 60_000 })
      .toBe(2);
    const outcomes = Object.fromEntries(
      (await readOutcomeMessages()).map((message) => {
        const [marker, json] = message.split(" outcomes: ");
        return [
          marker,
          JSON.parse(json!) as Array<{ status: number; body: Record<string, unknown> }>,
        ];
      }),
    );
    expect(outcomes["approve-me"]!.map((entry) => entry.status)).toEqual([200, 200, 200]);
    expect(outcomes["reject-me"]!.map((entry) => entry.status)).toEqual([403, 403, 403]);
    expect(outcomes["reject-me"]![0]!.body).toMatchObject({ deniedBy: "human", reason });

    // The headline guarantee: the ENTIRE conversation — two commands, two
    // bursts, two decisions, two narrated outcomes — never opened a single
    // LLM request.
    const llmRequests = await itx.streams.get(agentPath).getEvents({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
    });
    expect(llmRequests).toEqual([]);

    // ── The run's approvals read IN CONTEXT: each settled "ran code" card
    // wears a status glyph while collapsed (✓ for the approved lane, ✗ for
    // the rejected one), and its code step expands into Script | Approvals
    // tabs — the Approvals tab rendering the batch through the same shared
    // body as the Notifications expansion, decision badge and policy
    // included.
    const approvedCard = page
      .getByTestId(/^activity-card-/)
      .filter({ has: page.getByText("✓", { exact: true }) });
    const rejectedCard = page
      .getByTestId(/^activity-card-/)
      .filter({ has: page.getByText("✗", { exact: true }) });
    await approvedCard.waitFor({ timeout: 5_000 });
    await rejectedCard.waitFor({ timeout: 5_000 });
    await approvedCard.click({ timeout: 5_000 });
    await approvedCard.getByRole("button", { name: "Approvals" }).click({ timeout: 5_000 });
    await approvedCard.getByText("Approved", { exact: true }).waitFor({ timeout: 5_000 });
    await approvedCard
      .getByText("The mobile approvals spec holds these for a human")
      .waitFor({ timeout: 5_000 });
    // Collapse it back so the thread reads clean for the next act.
    await approvedCard.getByText("✓", { exact: true }).click({ timeout: 5_000 });

    // ── The context travels to the NOTIFICATIONS view — the approvals
    // surface now that the standalone screen is retired: each batch's row
    // expands into its full history, wearing the thread's STATUS at the time
    // of its run — thread name + the agent-maintained title/activity, shown
    // IN FULL — so "what was this run even doing?" reads without opening the
    // thread.
    await page.goBack(); // chat → chat list: browser history IS the app's back stack on web
    await page.getByLabel("Open project menu").click({ timeout: 5_000 });
    await page.getByRole("button", { name: "Notifications" }).click({ timeout: 5_000 });
    // Newest first: the reject burst's row sits above the approve burst's.
    const batchRows = page.getByTestId(/^notification-row-/);
    await batchRows.nth(1).waitFor({ timeout: 15_000 });
    await batchRows.first().click({ timeout: 5_000 });
    await batchRows.nth(1).click({ timeout: 5_000 });
    const threadName = agentPath.replace(/^\/agents\//, "");
    // The line is a link (tap = open the thread), one per card, each unique
    // by its lane's status title. Full-text equality, not substring: a
    // clipped status is the bug this assertion exists to catch. The reject
    // card also proves the fold — the standing title joined with the LATER
    // activity-only update.
    const approveContext = page.getByRole("link", { name: /Refund sweep/ });
    const rejectContext = page.getByRole("link", { name: /Invoice chase/ });
    await approveContext.waitFor({ timeout: 15_000 });
    await rejectContext.waitFor({ timeout: 15_000 });
    expect(await approveContext.textContent()).toBe(
      `${threadName} · Refund sweep — Emailing 3 customers about order refunds`,
    );
    expect(await rejectContext.textContent()).toBe(
      `${threadName} · Invoice chase — Requesting payment for 3 overdue invoices`,
    );

    // Tapping the line deep-links back into the thread it snapshotted.
    await approveContext.click({ timeout: 5_000 });
    await page.getByPlaceholder("Message").waitFor({ timeout: 15_000 });
    expect(decodeURIComponent(new URL(page.url()).searchParams.get("path")!)).toBe(agentPath);
  } finally {
    await echo.close();
  }
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

/**
 * Wait for a batch-card button while the burst coalesces at the egress door.
 * The chat's working indicator + the live "running code…" activity cover this
 * wait with real spinners the whole way — the card mounts while the parked
 * script run still spins.
 */
function waitForBatchCardButton(page: Page, name: string) {
  return page.getByRole("button", { name }).waitFor({ timeout: 30_000 });
}

/**
 * Press a batch-card decision button and see the card OUT of the thread (the
 * decided event rides the live root-stream connection back, so departure is
 * an append round-trip plus a push). Retried because RN-web's Pressable
 * occasionally drops a synthesized press outright — no handler call at all —
 * and a decision must not silently not-happen. `answerDialog` re-arms per
 * attempt: each press summons a fresh Face ID confirm / reason prompt.
 *
 * The click's own errors are swallowed — departure of the button is the one
 * honest success signal. The dialog handler is removed after every attempt:
 * a stale armed handler would win the race for the NEXT lane's dialog and
 * answer it with the wrong response.
 */
async function decideBatch(
  page: Page,
  buttonName: string,
  answerDialog: (dialog: import("@playwright/test").Dialog) => Promise<void> | void,
) {
  const button = page.getByRole("button", { name: buttonName });
  for (let attempt = 0; attempt < 3; attempt++) {
    const handler = (dialog: import("@playwright/test").Dialog) =>
      void Promise.resolve(answerDialog(dialog)).catch(() => {});
    page.once("dialog", handler);
    try {
      await button.click({ timeout: 10_000 }).catch(() => {});
      await button.waitFor({ state: "detached", timeout: 15_000 });
      return;
    } catch {
      // Press lost or decision not landed — re-arm and press again. The
      // door honors the FIRST decision, so a duplicate press is harmless.
    } finally {
      page.off("dialog", handler);
    }
  }
  throw new Error(`The "${buttonName}" decision never left the thread after 3 presses.`);
}

/** The OS deployment the mobile app should sign into: the same target the
 * web specs run against (APP_CONFIG_BASE_URL in CI, the local dev server
 * otherwise) — the mobile project's own baseURL is the Expo Web origin. */
async function resolveOsBaseUrl(): Promise<string> {
  const configured = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}

/** Same fixture as apps/os/e2e's startEgressEcho, reimplemented locally:
 * importing that file drags in its WebSocket-echo helper, which is typed
 * against Cloudflare Workers globals this tsconfig doesn't have. withTunnel
 * (captun) keeps the echo reachable from deployed preview workers too. */
function startEgressEcho() {
  return withTunnel({
    path: "/egress-echo",
    async fetch(request) {
      const body = await request.text();
      return Response.json({ body });
    },
  });
}
