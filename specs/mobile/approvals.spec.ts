// The phone approver, end to end in a browser — and entirely INSIDE the
// conversation: a plain chat message ("Run the approve-me burst") reaches an
// agent on an intercepted/* model, served by THIS spec's itx.ai.intercept
// handler pairing each command with a codemode script. The script runs a
// burst deterministically, the requests park at the egress approval gate as ONE
// batch, and the approval dialog appears in-thread where the human is
// already looking. Approve all behind the Face ID stand-in (the web build
// gates authenticated key reads behind `confirm()`), then a second burst
// rejected with a typed reason the script's 403 body carries back into the
// thread.
//
// DETERMINISTIC turns, asserted from the journal: every llm-request in the
// thread names model intercepted/driver — a model no real provider can serve, only
// the handler in this process. The scripts narrate their own outcomes with
// `itx.chat.sendMessage(...)` and return nothing, so each turn's script ends
// the loop and no second request follows.
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
import { withApprovalDeliveryDiagnostic } from "./approval-delivery-diagnostics.ts";

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
    const projectSlug = `mobile-approvals-${Date.now().toString(36)}-${testInfo.parallelIndex}`;
    await page.addInitScript((deviceId) => {
      localStorage.setItem("iterate.secure-store.iterate.mobileDeviceId.v1", deviceId);
    }, DEVICE_ID);
    await page.goto("/");
    await page.getByPlaceholder("https://os.iterate.com").fill(osBaseUrl);
    // Explicit timeout: without one, waitForEvent inherits the global 1s
    // actionTimeout — but this is an EVENT wait, not a UI action (the
    // spinner-waiter never sees it), and the popup only opens after signIn's
    // three sequential auth round trips (issuer discovery -> OIDC config ->
    // client registration; measured >1s against a cold local dev worker).
    // Cross-server waits get a 15s timeout — no spinner-waiter covers them.
    const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
    await page.getByRole("button", { name: "Sign in" }).click();
    const popup = await popupPromise;
    const emailLoginButton = popup.getByTestId("email-login-button");
    // The popup event fires before its cross-server auth navigation mounts
    // the login choices. Wait for that durable UI fact, then keep the click
    // itself under the normal 1s action budget. The popup is a raw Page —
    // no spinner-waiter middleware — so the timeout must be explicit.
    await emailLoginButton.waitFor({ state: "visible", timeout: 15_000 });
    await emailLoginButton.click();
    await signUpWithEmailOtp(popup, {
      email: uniqueSignupEmail("mobile-approvals"),
      projectSlug,
      testInfo,
    });
    // Cross-server tier, like waitForEvent("popup") above: the popup is a
    // separate Page outside the plugged middleware (no spinner-waiter to
    // extend), and these clicks land after auth-worker navigations that run
    // cold on fresh preview deploys — CI-proven >1s.
    // Project selection auto-continues for test identities (project-access.tsx).
    await popup.getByRole("button", { name: "Allow access" }).click({ timeout: 15_000 }); // timeout: popup page has no spinner-waiter

    // Opening the project auto-enrolls this browser's approval key — no
    // manual enroll step anywhere below. The first project list rides a COLD
    // itx WebSocket to the deployment (~20-30s against preview slots) — a
    // product-latency problem worth fixing at the source, not something more
    // spinner UI can paper over.
    // The app auto-opens the account's only project — no picker tap.
    await page.getByText("New chat").waitFor();
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
    // Point the chat's agent at an intercepted/* model (an ordinary journaled config
    // event) and drop the newborn debounce so each command's turn opens fast.
    // The client defers creation to the first message, so birth the agent
    // explicitly first (get-or-create, the same create call the client uses).
    using agent = itx.agents.get(agentPath);
    await agent.create();
    await agent.append({
      type: "events.iterate.com/agent/configured",
      payload: { config: { llm: { model: "intercepted/driver" }, llmRequestDebounceMs: 250 } },
    });

    // Each script narrates its own outcome (success or error) and returns
    // nothing — an undefined script result ends the turn loop, so no second
    // request follows. Before the burst, the script maintains the agent
    // status exactly the way a real agent turn would
    // (AGENT_SUMMARY_INSTRUCTION): summary-updated appends, fields updating
    // independently — the status the approvals screen pins to this batch's
    // card.
    const burstScript = (marker: string, statusUpdates: object[]) =>
      [
        "```ts",
        `async (itx) => { ${statusUpdates
          .map(
            (update) =>
              `await itx.agent.append({ type: "events.iterate.com/agent/summary-updated", payload: ${JSON.stringify(update)} }); `,
          )
          .join(
            "",
          )}const burst = async () => { const responses = await Promise.all(Array.from({length: 3}, (_, index) => fetch(${JSON.stringify(echo.url)} + "?${marker}=" + index, {method: "POST", body: "${marker} " + index}))); const outcomes = await Promise.all(responses.map(async (response) => ({status: response.status, body: await response.json()}))); return "${marker} outcomes: " + JSON.stringify(outcomes); }; await itx.chat.sendMessage(await burst().catch(String)); }`,
        "```",
      ].join("\n");

    // The "model": commands pair with scripts right here, in-test, over the
    // live capnweb hop — the interception this repo grew for exactly this.
    const bursts: Record<string, { marker: string; statusUpdates: object[] }> = {
      "Run the approve-me burst": {
        marker: "approve-me",
        statusUpdates: [
          { title: "Refund sweep", activity: "Emailing 3 customers about order refunds" },
        ],
      },
      "Run the reject-me burst": {
        marker: "reject-me",
        statusUpdates: [
          { title: "Invoice chase", activity: "Preparing payment reminders" },
          { activity: "Requesting payment for 3 overdue invoices" },
        ],
      },
    };
    using _interception = await itx.ai.intercept(async ({ source, body }) => {
      if (source !== "agent-turn") throw new Error(`unexpected source: ${source}`);
      const message = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const burst = bursts[message.trim()];
      if (!burst) throw new Error(`unexpected message: ${message}`);
      return burstScript(burst.marker, burst.statusUpdates);
    });

    const readOutcomeMessages = async () =>
      (
        await itx.streams.get(agentPath).getEvents({
          eventTypes: ["events.iterate.com/agents/web-message-sent"],
        })
      )
        .map((event) => (event.payload as { message: string }).message)
        .filter((message) => message.includes(" outcomes: "));

    // The approve burst: the command's turn is served by the handler above, the
    // burst parks as one batch, and the dialog appears in-thread while the
    // working indicator honestly spins — no spinner-waiter escapes needed.
    await sendChatMessage(page, "Run the approve-me burst");
    await waitForBatchCardButton({
      agentPaths: [agentPath],
      deviceId: DEVICE_ID,
      itx,
      name: "Approve all 3 (Face ID)",
      page,
    });
    await decideBatch(page, "Approve all 3 (Face ID)", "approved", (dialog) => dialog.accept());

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
      )
      .toBe(1);

    // Reject lane: same shape, typed reason, and a two-append status story —
    // the first append sets title + activity, then an activity-only update
    // as the phase changes (the fold must keep the standing title).
    const reason = "wrong recipient — use the staging address";
    await sendChatMessage(page, "Run the reject-me burst");
    await waitForBatchCardButton({
      agentPaths: [agentPath],
      deviceId: DEVICE_ID,
      itx,
      name: "Reject all",
      page,
    });
    await decideBatch(page, "Reject all", "rejected", (dialog) => dialog.accept(reason));

    // ── Asserted from the protocol: each script narrated its outcomes into
    // the thread — the approved burst with 200s, the rejected one with 403s
    // whose bodies carry the human's reason verbatim (the cue an agent would
    // read to retry differently).
    await expect.poll(async () => (await readOutcomeMessages()).length).toBe(2);
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

    // The headline guarantee, journal-certified: the ENTIRE conversation —
    // two commands, two bursts, two decisions, two narrated outcomes — opened
    // exactly two LLM requests, both on intercepted/driver, a model only THIS spec's
    // handler can serve. Nothing nondeterministic ever ran.
    const llmRequests = await itx.streams.get(agentPath).getEvents({
      eventTypes: ["events.iterate.com/agent/llm-request-requested"],
    });
    expect(llmRequests.map((event) => (event.payload as { model: string }).model)).toEqual([
      "intercepted/driver",
      "intercepted/driver",
    ]);

    // A decision releases the script immediately, while the notification
    // intent is projected by a separate root-stream processor. Synchronize
    // on the reject batch's exact device copy before asking the mounted UI to
    // project two rows; once this durable boundary exists, the normal 1s UI
    // action budget remains the assertion for the client projection itself.
    const rootStream = itx.streams.get("/");
    const approvalRequests = await rootStream.getEvents({
      eventTypes: ["events.iterate.com/project/human-approval-requested"],
    });
    expect(approvalRequests).toHaveLength(2);
    const rejectedApprovalRequest = approvalRequests.at(-1)!;
    await itx.streams.get(`/devices/${DEVICE_ID}`).waitForEvent({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/notification/requested"],
      predicate: (event) =>
        (event.payload as { approvalRequestEventOffset?: number }).approvalRequestEventOffset ===
        rejectedApprovalRequest.offset,
      timeoutMs: 15_000,
    });

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
    await approvedCard.waitFor();
    await rejectedCard.waitFor();
    await approvedCard.click();
    await approvedCard.getByRole("button", { name: "Approvals" }).click();
    await approvedCard.getByText("Approved", { exact: true }).waitFor();
    await approvedCard.getByText("The mobile approvals spec holds these for a human").waitFor();
    // Collapse it back so the thread reads clean for the next act.
    await approvedCard.getByText("✓", { exact: true }).click();

    // ── The context travels to the NOTIFICATIONS view — the approvals
    // surface now that the standalone screen is retired: each batch's row
    // expands into its full history, wearing the thread's STATUS at the time
    // of its run — thread name + the agent-maintained title/activity, shown
    // IN FULL — so "what was this run even doing?" reads without opening the
    // thread.
    await page.goBack(); // chat → chat list: browser history IS the app's back stack on web
    await page.getByLabel("Open project menu").filter({ visible: true }).click();
    await page.getByRole("button", { name: "/notifications" }).click();
    // Main also journals each scripted outcome message as an "Agent replied"
    // notification. Select only the approval-batch rows: newest first, the
    // reject burst sits above the approve burst.
    const batchRows = page
      .getByTestId(/^notification-row-/)
      .filter({ has: page.getByText("Approvals needed", { exact: true }) });
    await withApprovalDeliveryDiagnostic({
      description: "The second approval notification row did not render.",
      deviceId: DEVICE_ID,
      itx,
      streamPaths: [agentPath],
      wait: () => batchRows.nth(1).waitFor(),
    });
    const threadName = agentPath.replace(/^\/agents\//, "");
    // The line is a link (tap = open the thread), one per card, each unique
    // by its lane's status title. Full-text equality, not substring: a
    // clipped status is the bug this assertion exists to catch. The reject
    // card also proves the fold — the standing title joined with the LATER
    // activity-only update.
    const approveContext = page.getByRole("link", { name: /Refund sweep/ });
    const rejectContext = page.getByRole("link", { name: /Invoice chase/ });
    // Inspect one row at a time, as a person does. Each expansion contains the
    // full batch and can push its sibling outside FlatList's rendered window;
    // collapsing it first keeps the next row mounted and actionable.
    await batchRows.first().click();
    await rejectContext.waitFor();
    expect(await rejectContext.textContent()).toBe(
      `${threadName} · Invoice chase — Requesting payment for 3 overdue invoices`,
    );
    await batchRows.first().click();
    await batchRows.nth(1).click();
    await approveContext.waitFor();
    expect(await approveContext.textContent()).toBe(
      `${threadName} · Refund sweep — Emailing 3 customers about order refunds`,
    );

    // Tapping the line deep-links back into the thread it snapshotted.
    await approveContext.click();
    await page.getByPlaceholder("Message").waitFor();
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
function waitForBatchCardButton(input: {
  agentPaths: string[];
  deviceId: string;
  itx: Parameters<typeof withApprovalDeliveryDiagnostic>[0]["itx"];
  name: string;
  page: Page;
}) {
  return withApprovalDeliveryDiagnostic({
    description: `The approval button "${input.name}" did not render in the thread.`,
    deviceId: input.deviceId,
    itx: input.itx,
    streamPaths: input.agentPaths,
    wait: () => input.page.getByRole("button", { name: input.name }).waitFor(),
  });
}

/**
 * Press a batch-card decision button and see the card's approval glyph land —
 * the ✓/✗ on the activity card's header (visible collapsed or expanded, so it
 * survives the card folding up when the run settles). The decided event rides
 * the live root-stream connection back, an append round-trip plus a push;
 * the button's "Signing…"/"Deciding…"/"Recording decision…" copy is live
 * loading UI the whole way, so the spinner-waiter keeps the glyph wait open.
 * Retried because RN-web's Pressable occasionally drops a synthesized press
 * outright — no handler call at all — and a decision must not silently
 * not-happen. `answerDialog` re-arms per attempt: each press summons a fresh
 * Face ID confirm / reason prompt; the handler is removed after every attempt
 * so a stale one cannot answer the NEXT lane's dialog with the wrong response.
 */
async function decideBatch(
  page: Page,
  buttonName: string,
  outcome: "approved" | "rejected",
  answerDialog: (dialog: import("@playwright/test").Dialog) => Promise<void> | void,
) {
  const button = page.getByRole("button", { name: buttonName });
  // Pin THIS batch's activity card before the press, via the ◷ it wears
  // while its batch awaits a human (the decide dialog is the card's SIBLING,
  // so the button itself can't anchor the lookup). Waiting for ◷ to flip to
  // ✓/✗ on the SAME card is the product story — and it keeps a leftover
  // glyph from an earlier lane's decision from vouching for this one.
  const cardId = await page
    .getByTestId(/^activity-card-/)
    .filter({ has: page.getByLabel("approval pending", { exact: true }) })
    // timeout: plain attribute read of already-rendered state — no spinner-waiter middleware on getAttribute; 10s guards CI jitter
    .getAttribute("data-testid", { timeout: 10_000 });
  const glyph = page.getByTestId(cardId!).getByLabel(outcome, { exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const handler = (dialog: import("@playwright/test").Dialog) =>
      void Promise.resolve(answerDialog(dialog)).catch(() => {});
    page.once("dialog", handler);
    try {
      await button.click().catch(() => {});
      await glyph.waitFor();
      return;
    } catch {
      // Press lost or decision not landed — re-arm and press again. The
      // door honors the FIRST decision, so a duplicate press is harmless.
    } finally {
      page.off("dialog", handler);
    }
  }
  throw new Error(`The "${buttonName}" decision never showed a ${outcome} glyph after 3 presses.`);
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
