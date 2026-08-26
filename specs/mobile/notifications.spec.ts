// Approval-push suppression, end to end in a browser, told through the new
// Notifications view: the SAME script-triggered approval batch either rings
// your phone or stays silent depending on where you're standing when it
// parks. Lane one — the user is sitting IN the agent thread when the batch
// arrives: the in-thread dialog renders, appends its `project/approval-presented`
// claim inside the device processor's grace window, and the pending push dies
// with the `suppressed` outcome ("Skipped — already on screen"). Lane
// two — the user is on the Notifications view (pointedly NOT the thread):
// nothing claims the batch, the grace window lapses, and the push goes out.
// And an ORPHAN lane, staged first: a batch parked BEFORE this device
// enrolls never journals a notification here (the device's intent
// subscription starts at enrollment), so the device list alone would give
// it no decision surface — it must ride in from the project root stream as
// a synthetic "Needs approval" row, decidable in place.
//
// Sign-up plumbing and the RN-web helpers (composer typing, batch-card
// waits) are lifted from specs/mobile/approvals.spec.ts.
//
// Web-platform approximations, deliberate and dev-only: the web build has no
// push channel, so the spec enrolls this browser's device identity
// server-side with a format-valid but undeliverable Expo token. Expo answers
// DeviceNotRegistered normally answers at send time (verified against the real
// API), so lane two reads "Send failed". If the vendor call crosses its
// bounded deadline after the durable attempt starts, the only honest terminal
// status is "Delivery uncertain" — it may have accepted the push, so the
// processor never retries. A real phone would normally read Sent/Delivered.

import { expect, type Locator, type Page } from "@playwright/test";
import { connectItxReady } from "iterate/node";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { resolveAdminSecret } from "../test-support/forged-session.ts";
import { test } from "../test-support/test.ts";
import { withApprovalDeliveryDiagnostic } from "./approval-delivery-diagnostics.ts";

// The browser's device identity, fixed BEFORE the app boots (the web build's
// secure store is localStorage), so the server-side enrollment below and the
// app's Notifications view read the same device stream.
const DEVICE_ID = "spec-web-phone";

test("the approval push is suppressed in the watched thread and sent when you're elsewhere", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const echo = await startEgressEcho();
  try {
    await page.addInitScript((deviceId) => {
      localStorage.setItem("iterate.secure-store.iterate.mobileDeviceId.v1", deviceId);
    }, DEVICE_ID);

    // ── Sign up through the REAL flow (same as approvals.spec.ts). NB: the
    // slug must not contain "notifications" — getByText matches substrings,
    // and the drawer assertion below must not collide with header titles.
    const projectSlug = `mobile-notifs-${Date.now().toString(36)}-${testInfo.parallelIndex}`;
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
      email: uniqueSignupEmail("mobile-notifs"),
      projectSlug,
      testInfo,
    });
    // Cross-server tier, like waitForEvent("popup") above: the popup is a
    // separate Page outside the plugged middleware (no spinner-waiter to
    // extend), and these clicks land after auth-worker navigations that run
    // cold on fresh preview deploys — CI-proven >1s.
    // Project selection auto-continues for test identities (project-access.tsx).
    await popup.getByRole("button", { name: "Allow access" }).click({ timeout: 15_000 }); // timeout: popup page has no spinner-waiter
    // The app auto-opens the account's only project — no picker tap.
    await page.getByText("New chat").waitFor();
    const projectId = new URL(page.url()).pathname.split("/")[2]!;

    // ── Admin-side setup: a hold rule on the echo host, and the device
    // enrollment the web build cannot do itself (no push channel on web).
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
            description: "The notifications spec holds these for a human",
            match: { hosts: [new URL(echo.url).hostname] },
            verdict: "hold",
            // Generous on purpose: the ORPHAN batch staged below is decided
            // LAST, after both push lanes and their expansions — a 120s
            // horizon could expire it mid-spec on a slow run.
            approvalTimeoutMs: 300_000,
            debounceMs: 2_000,
          },
        ],
      },
    });
    await itx.processor.waitUntilProcessed({ offset: rulesConfigured!.offset, timeoutMs: 15_000 });
    // Outwait the egress gate's ~5s rules cache before the first script —
    // marked dead air so the rendered video skips the on-screen idle.
    const outwaitRulesCache = () => new Promise((resolve) => setTimeout(resolve, 6_000));
    await (page.videoMode ? page.videoMode.deadAir(outwaitRulesCache) : outwaitRulesCache());

    const parkRequestBody = (marker: string) =>
      `await fetch(${JSON.stringify(echo.url)} + "?${marker}=1", { method: "POST", body: "${marker}" }).catch(() => {});`;
    const parkOneRequest = (marker: string) => `async () => { ${parkRequestBody(marker)} }`;

    // ── Stage the ORPHAN before the device exists: park a batch, and only
    // enroll once its push intent has been journaled on the root stream.
    // The device's notification-intent subscription starts at enrollment
    // ("start: now"), so an intent already appended never reaches this
    // device — the batch is permanently unrepresented in the device list,
    // exactly the gap the synthetic needs-approval row exists to cover.
    const orphanAgent = await itx.agents.get("/agents/orphan-thread").create();
    const orphanRunStarted = orphanAgent.stream.waitForEvent({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/capability-host/script-run-started"],
      timeoutMs: 15_000,
    });
    void orphanAgent.capabilityHost.runScript(parkOneRequest("orphan")).catch(() => {});
    const orphanStarted = await orphanRunStarted;
    const rootStream = itx.streams.get("/");
    // script-run-started is durable progress BEFORE the one-off Worker Loader
    // invokes the body. Four cold inline workers can legitimately queue there:
    // the restoration gate measured 17.4s from started to this approval, then
    // only 82ms from approval to notification. Give that cold-load boundary
    // ~2x its observed tail; the notification projection keeps its own 15s
    // deadline below, so this does not hide the delivery behavior under test.
    const orphanApproval = await rootStream.waitForEvent({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/project/human-approval-requested"],
      predicate: (event) => {
        const context = event.payload?.streamContext;
        return (
          typeof context === "object" &&
          context !== null &&
          "executionId" in context &&
          context.executionId === orphanStarted.payload?.executionId
        );
      },
      timeoutMs: 30_000,
    });
    await rootStream.waitForEvent({
      afterOffset: orphanApproval.offset,
      eventTypes: ["events.iterate.com/notification/requested"],
      predicate: (event) =>
        (event.payload as { approvalRequestEventOffset?: number }).approvalRequestEventOffset ===
        orphanApproval.offset,
      timeoutMs: 15_000,
    });
    await itx.devices.get(DEVICE_ID).enroll({
      appVersion: "spec",
      expoPushToken: `ExponentPushToken[${DEVICE_ID}-never-deliverable]`,
      label: "Spec web phone",
      notificationsStatus: "granted",
      platform: "ios",
    });

    // ── Lane one: the user is IN the thread when its batch parks. Open a
    // fresh chat, then run the script on exactly that agent path — the
    // in-thread dialog is the claim's trigger, so its render IS the product
    // moment under test.
    await page.getByText("New chat").click();
    await page.getByPlaceholder("Message").waitFor();
    const watchedPath = decodeURIComponent(new URL(page.url()).searchParams.get("path")!);
    const watchedAgent = itx.agents.get(watchedPath);
    // Start this lane through the visible composer: the message's turn runs
    // on the fake/* lane, whose model is THIS spec's interceptor pairing the
    // command with the park script — deterministic, and the run carries the
    // agent's own script provenance like a real turn. The agent is birthed
    // and pointed at fake/driver first (the client defers creation to the
    // first message, and the birth batch's model default must not outrank
    // the fake config).
    await watchedAgent.create();
    await watchedAgent.append({
      type: "events.iterate.com/agent/configured",
      payload: { config: { llm: { model: "fake/driver" }, llmRequestDebounceMs: 250 } },
    });
    using _interception = await itx.ai.intercept(async ({ source, body }) => {
      if (source !== "agent-turn") throw new Error(`unexpected source: ${source}`);
      const message = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (!/park one watched request/i.test(message)) {
        throw new Error(`unexpected message: ${message}`);
      }
      return ["```ts", `async (itx) => { ${parkRequestBody("watched")} }`, "```"].join("\n");
    });
    await sendChatMessage(page, "Park one watched request");
    await page.getByText("running code…").waitFor();
    const watchedRunStarted = watchedAgent.stream.waitForEvent({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/capability-host/script-run-started"],
      timeoutMs: 15_000,
    });
    await watchedRunStarted;
    await waitForBatchCardButton({
      agentPaths: [watchedPath],
      deviceId: DEVICE_ID,
      itx,
      name: "Approve (Face ID)",
      page,
    });

    // Off to the Notifications view (project screen → drawer). The claim has
    // fired; by the time we arrive the device processor has settled the push
    // obligation `suppressed` — the row says so, instead of a push having
    // interrupted whoever was reading the thread.
    await page.goBack();
    await page.getByLabel("Open project menu").filter({ visible: true }).click();
    // The drawer slides in over ~180ms and the press works mid-slide — but
    // clicking then bakes a half-open drawer into the recording (video-mode
    // freezes the click-moment screenshot under its synthetic pointer, which
    // reads as a clipped drawer to a reviewer). The product is fine: given a
    // beat, the panel settles at translateX(0) at this exact viewport. Wait
    // for the item to stop moving before pressing.
    const notificationsItem = page.getByRole("button", { name: "/notifications" });
    await notificationsItem.waitFor();
    await expect
      .poll(async () => {
        const before = (await notificationsItem.boundingBox())!.x;
        await page.waitForTimeout(120);
        const after = (await notificationsItem.boundingBox())!.x;
        return after - before;
      })
      .toBe(0);
    await notificationsItem.click();
    await page.getByText("Skipped — already on screen").waitFor();
    // The orphan batch is already here — nothing on this device's stream
    // mentions it, so its row is the synthetic one, riding in from the
    // project root stream and saying so.
    await page.getByText("Needs approval — no notification reached this device").waitFor();

    // ── Lane two: the user stays HERE while a different thread's batch
    // parks. No dialog renders, nothing claims the batch, the grace window
    // lapses, and the device processor sends the push — on the web build's
    // undeliverable token that terminally reads either an explicit rejection
    // or bounded uncertainty (see header).
    const elsewhereAgent = await itx.agents.get("/agents/elsewhere-thread").create();
    // The thread's agent-maintained status, appended ahead of the run so the
    // notification expansion's thread-context line has something real to
    // fold ("what was this run even doing?").
    await itx.streams.get("/agents/elsewhere-thread").append({
      type: "events.iterate.com/agent/summary-updated",
      payload: { title: "Sending the launch webhook", activity: "waiting on egress approval" },
    });
    const elsewhereRunStarted = elsewhereAgent.stream.waitForEvent({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/capability-host/script-run-started"],
      timeoutMs: 15_000,
    });
    void elsewhereAgent.capabilityHost.runScript(parkOneRequest("elsewhere")).catch(() => {});
    const elsewhereStarted = await elsewhereRunStarted;
    const elsewhereApproval = await rootStream.waitForEvent({
      afterOffset: orphanApproval.offset,
      eventTypes: ["events.iterate.com/project/human-approval-requested"],
      predicate: (event) => {
        const context = event.payload?.streamContext;
        return (
          typeof context === "object" &&
          context !== null &&
          "executionId" in context &&
          context.executionId === elsewhereStarted.payload?.executionId
        );
      },
      timeoutMs: 30_000,
    });
    // Until the push pipeline journals onto THIS device's stream, nothing on
    // the device represents it — the script start, egress hold, debounce and
    // grace window are server work with no on-screen counterpart, exactly
    // like a real phone idling before a push arrives. Separate the durable
    // attempt boundary from the vendor call: approval debounce + the 1.5s
    // suppression grace happen before this event, and Expo then has its own
    // bounded 15s answer deadline. An aggregate 15s poll from script launch
    // races that valid terminal-uncertain path.
    const deviceStream = itx.streams.get(`/devices/${DEVICE_ID}`);
    const elsewhereDeviceRequest = await deviceStream.waitForEvent({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/notification/requested"],
      predicate: (event) =>
        (event.payload as { approvalRequestEventOffset?: number }).approvalRequestEventOffset ===
        elsewhereApproval.offset,
      timeoutMs: 15_000,
    });
    const attemptStarted = await deviceStream.waitForEvent({
      afterOffset: elsewhereDeviceRequest.offset,
      eventTypes: ["events.iterate.com/device/notification-attempt-started"],
      predicate: (event) => event.payload?.requestOffset === elsewhereDeviceRequest.offset,
      timeoutMs: 15_000,
    });
    await deviceStream.waitForEvent({
      afterOffset: attemptStarted.offset,
      eventTypes: ["events.iterate.com/device/notification-settled"],
      predicate: (event) => event.payload?.requestOffset === attemptStarted.payload?.requestOffset,
      // The product deadline is 15s; leave only a small propagation margin
      // for its already-durable terminal event to reach this ITX reader.
      timeoutMs: 20_000,
    });
    const settlements = await deviceStream.getEvents({
      eventTypes: ["events.iterate.com/device/notification-settled"],
    });
    expect(settlements).toHaveLength(2);
    const sendOutcome = (settlements.at(-1)!.payload as any).outcome;
    expect(["rejected-by-expo", "uncertain"]).toContain(sendOutcome.kind);
    if (sendOutcome.kind === "uncertain") {
      expect(sendOutcome).toMatchObject({ phase: "expo-send", reason: expect.any(String) });
    }
    const sendStatus = sendOutcome.kind === "uncertain" ? "Delivery uncertain" : "Send failed";
    await page.getByText(sendStatus).waitFor();
    // Both lanes journaled side by side — the comparison this spec exists for.
    await page.getByText("Skipped — already on screen").waitFor();

    // ── Approval rows EXPAND instead of navigating — and with the
    // standalone Approvals screen retired, the expansion is also where an
    // open batch gets DECIDED. Tapping the sent push's row unfolds the held
    // request still awaiting its decision, with Reject / Approve right
    // there.
    const deviceRow = page.getByTestId(/^notification-row-/).filter({ hasText: sendStatus });
    await deviceRow.click();
    await page.getByText("Awaiting decision").waitFor();
    await page.getByText("egress-echo?elsewhere=1").waitFor();

    // Reject it from the expansion with a typed reason (the web build's
    // window.prompt stands in for the native reason sheet). The outcome
    // badge is the success signal: the decision refetches the batch, the
    // actions retire, and the historical record takes their place —
    // verdict, the human's reason, and the #2372 thread-context line.
    const reason = "not while the spec is watching";
    await rejectFromExpansion(page, deviceRow, reason);
    await page.getByText(`Rejected because: ${reason}`).waitFor();
    // The thread-context LINE, by its link role: the chat list mounted-but-
    // hidden behind this screen now wears the same live title on its row, so
    // a bare text locator would find that copy too.
    await page.getByRole("link", { name: /Sending the launch webhook/ }).waitFor();

    // ── The orphan lane's payoff: the batch that predates enrollment
    // expands into the SAME detail and decide actions as a journaled row.
    // Reject it right there; the decided row lingers with its outcome for
    // this session (it must not vanish under the deciding finger) — the
    // Rejected status and reason record ARE the acknowledgment. Next visit
    // it's gone: an orphan has no device history to keep a row alive.
    const orphanRow = page.getByTestId(/^needs-approval-row-/);
    await orphanRow.click();
    await page.getByText("Awaiting decision").waitFor();
    await page.getByText("egress-echo?orphan=1").waitFor();
    await rejectFromExpansion(page, orphanRow, "orphans get decided here too");
    await page.getByText("Rejected because: orphans get decided here too").waitFor();

    // The chat deep-link lives INSIDE the expansion now — its "Open thread"
    // lands in the thread that caused the push, where tapping the real push
    // would have gone. Scoped to the device row: the lingering rejected
    // orphan's expansion carries its own thread link now.
    await deviceRow.getByRole("link", { name: "Open thread" }).click();
    // The heading, specifically: expo-router keeps the Notifications screen
    // mounted-but-hidden behind the chat, and its thread-context line also
    // carries this text — a bare text locator finds that hidden copy. The
    // header wears the thread's agent-set TITLE now, not the raw path
    // (chat-titles.spec.ts covers that surface on its own).
    await page.getByRole("heading", { name: "Sending the launch webhook" }).waitFor();
    expect(decodeURIComponent(page.url())).toContain("/agents/elsewhere-thread");
  } finally {
    await echo.close();
  }
});

/** Type into the chat composer and send through RN-web's controlled input. */
async function sendChatMessage(page: Page, message: string) {
  await page.getByPlaceholder("Message").click();
  await page.keyboard.insertText(message);
  await page.getByRole("button", { name: "Send" }).click();
}

/**
 * Wait for a batch-card button while the burst coalesces at the egress door —
 * same as specs/mobile/approvals.spec.ts's helper of the same name: the
 * already-started script run's activity spinner covers the wait the whole way.
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
 * Press a row expansion's Reject and answer the reason prompt — the retried
 * press + outcome-badge success signal of approvals.spec.ts's decideBatch,
 * for the notification surface: RN-web's Pressable occasionally drops a
 * synthesized press outright, and a decision must not silently not-happen.
 * The armed dialog handler is removed after every attempt so a stale one
 * cannot answer a later prompt. Scoped to the row: an earlier rejection's
 * badge elsewhere on the screen must not vouch for this one.
 */
async function rejectFromExpansion(page: Page, row: Locator, reason: string) {
  const button = row.getByRole("button", { name: "Reject" });
  for (let attempt = 0; attempt < 3; attempt++) {
    const handler = (dialog: import("@playwright/test").Dialog) =>
      void Promise.resolve(dialog.accept(reason)).catch(() => {});
    page.once("dialog", handler);
    try {
      await button.click().catch(() => {});
      await row.getByTestId("approval-decision-badge").filter({ hasText: "Rejected" }).waitFor();
      return;
    } catch {
      // Press lost or decision not landed — re-arm and press again. The
      // door honors the FIRST decision, so a duplicate press is harmless.
    } finally {
      page.off("dialog", handler);
    }
  }
  throw new Error("The Reject decision never showed a Rejected badge after 3 presses.");
}

/** Same helper as specs/mobile/approvals.spec.ts. */
async function resolveOsBaseUrl(): Promise<string> {
  const configured = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}

/** Same fixture as specs/mobile/approvals.spec.ts. */
function startEgressEcho() {
  return withTunnel({
    path: "/egress-echo",
    async fetch(request) {
      const body = await request.text();
      return Response.json({ body });
    },
  });
}
