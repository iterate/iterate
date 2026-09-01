// The phone approver, end to end in a browser — and entirely INSIDE the
// conversation: a plain chat message ("Run the approve-me burst") reaches an
// agent on an intercepted/* model, served by this spec's response handler
// pairing each command with a codemode script. The script runs a burst
// deterministically, the requests park at the egress approval gate as ONE
// batch, and the approval dialog appears in-thread where the human is already
// looking. Approve all behind the Face ID stand-in (the web build gates
// authenticated key reads behind `confirm()`), then a second burst rejected
// with a typed reason the script's 403 body carries back into the thread.
//
// Every wait is a UI wait: the working row spans the request debounce
// (turnPending), the live activity card spins from script start through the
// parked-at-the-door window to the decision, and each script narrates its
// outcomes into the feed — so the spinner-waiter budgets the whole flow. The
// journal is only READ, never awaited: the headline assertion is that the
// entire conversation opened exactly two LLM requests, both on
// intercepted/typed — a model no real provider can serve, only the handler in
// this process.
//
// Web-platform approximations, deliberate and dev-only: secure storage is
// localStorage with confirm()-gated reads (apps/mobile/src/lib/secure-store.ts),
// and pushes don't exist on web — the spec enrolls this browser's device
// identity server-side so each batch's notification journals a row for the
// final act: the Notifications view (the approvals surface, now that the
// standalone screen is retired), where each row expands into the batch's
// history wearing the thread's status at the time.

import { expect, type Page } from "@playwright/test";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { test } from "../test-support/test.ts";
import { withApprovalDeliveryDiagnostic } from "./approval-delivery-diagnostics.ts";

// The browser's device identity, fixed BEFORE the app boots (the web build's
// secure store is localStorage), so the server-side enrollment below and the
// Notifications view read the same device stream.
const DEVICE_ID = "spec-web-approver";

test("approve and reject script bursts from inside the chat thread", async ({ page, helpers }) => {
  await page.addInitScript((deviceId) => {
    localStorage.setItem("iterate.secure-store.iterate.mobileDeviceId.v1", deviceId);
  }, DEVICE_ID);

  // The egress echo the bursts fetch. withTunnel (captun) keeps it reachable
  // from deployed preview workers too. (Reimplemented rather than imported
  // from apps/os/e2e: that module drags in Workers-global typings this
  // tsconfig doesn't have.)
  await using echo = await withTunnel(async function (request) {
    const body = await request.text();
    return Response.json({ body });
  });

  await using fixture = await helpers.createMobileFixture("mobile-approvals");
  const { itx } = fixture;

  // ── Admin-side policy, the one non-user step: a hold rule on the echo
  // host so the bursts park for a human.
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
  // Enroll this browser's device identity server-side (the web build has no
  // push channel of its own) so every batch's notification opens a row on
  // the device stream — what the Notifications view reads below. The
  // in-thread dialogs claim both batches, so the rows settle suppressed and
  // the undeliverable token is never dialed.
  await itx.devices.get(DEVICE_ID).enroll({
    appVersion: "spec",
    expoPushToken: `ExponentPushToken[${DEVICE_ID}-never-deliverable]`,
    label: "Spec web approver",
    notificationsStatus: "granted",
    platform: "ios",
  });

  // ── Into the conversation: everything below happens in ONE chat thread.
  await page.getByText("New chat").click();
  await page.getByPlaceholder("Message").waitFor();
  const agentPath = decodeURIComponent(new URL(page.url()).searchParams.get("path")!);
  const agent = await fixture.createAgent({ path: agentPath });

  agent.responses.setOnce(async () => {
    return agent.responses.codemodify(`
      async (itx) => {
        await itx.agent.append({ type: "events.iterate.com/agent/summary-updated", payload: { title: "Refund sweep", activity: "Emailing 3 customers about order refunds" } });

        const responses = await Promise.all([
          fetch(${JSON.stringify(echo.url)} + "?approve-me=0", { method: "POST", body: "approve-me 0" }),
          fetch(${JSON.stringify(echo.url)} + "?approve-me=1", { method: "POST", body: "approve-me 1" }),
          fetch(${JSON.stringify(echo.url)} + "?approve-me=2", { method: "POST", body: "approve-me 2" }),
        ])

        const outcomes = await Promise.all(responses.map(async (r) => ({ status: r.status, json: await r.json() })));

        await itx.chat.sendMessage("approve-me outcomes: " + JSON.stringify(outcomes));
      }
    `);
  });

  await sendChatMessage(page, "Run the approve-me burst");
  await waitForBatchCardButton({
    agentPaths: [agentPath],
    deviceId: DEVICE_ID,
    itx,
    name: "Approve all 3 (Face ID)",
    page,
  });
  await decideBatch(page, "Approve all 3 (Face ID)", "approved", (dialog) => dialog.accept());
  await page.getByText(/approve-me outcomes:/).waitFor();

  const reason = "wrong recipient — use the staging address";

  agent.responses.setOnce(async () => {
    return agent.responses.codemodify(`
      async (itx) => {
        await itx.agent.append({ type: "events.iterate.com/agent/summary-updated", payload: { title: "Invoice chase", activity: "Preparing payment reminders" } });
        await itx.agent.append({ type: "events.iterate.com/agent/summary-updated", payload: { activity: "Requesting payment for 3 overdue invoices" } });

        const responses = await Promise.all([
          fetch(${JSON.stringify(echo.url)} + "?reject-me=0", { method: "POST", body: "reject-me 0" }),
          fetch(${JSON.stringify(echo.url)} + "?reject-me=1", { method: "POST", body: "reject-me 1" }),
          fetch(${JSON.stringify(echo.url)} + "?reject-me=2", { method: "POST", body: "reject-me 2" }),
        ])

        const outcomes = await Promise.all(responses.map(async (r) => ({ status: r.status, json: await r.json() })));

        await itx.chat.sendMessage("reject-me outcomes: " + JSON.stringify(outcomes));
      }
    `);
  });

  await sendChatMessage(page, "Run the reject-me burst");

  await waitForBatchCardButton({
    agentPaths: [agentPath],
    deviceId: DEVICE_ID,
    itx,
    name: "Reject all",
    page,
  });
  await decideBatch(page, "Reject all", "rejected", (dialog) => dialog.accept(reason));
  await page.getByText(/reject-me outcomes:/).waitFor();

  // ── Asserted from the journal (a read, not a wait — both narrations are
  // already on screen): the approved burst got 200s, the rejected one 403s
  // whose bodies carry the human's reason verbatim (the cue an agent would
  // read to retry differently).
  const outcomeMessages = (
    await itx.streams.get(agentPath).getEvents({
      eventTypes: ["events.iterate.com/agents/web-message-sent"],
    })
  )
    .map((event) => (event.payload as { message: string }).message)
    .filter((message) => message.includes(" outcomes: "));
  const outcomes = Object.fromEntries(
    outcomeMessages.map((message) => {
      const [marker, json] = message.split(" outcomes: ");
      return [
        marker,
        JSON.parse(json!) as Array<{ status: number; json: Record<string, unknown> }>,
      ];
    }),
  );
  expect(outcomes["approve-me"]!.map((entry) => entry.status)).toEqual([200, 200, 200]);
  expect(outcomes["reject-me"]!.map((entry) => entry.status)).toEqual([403, 403, 403]);
  expect(outcomes["reject-me"]![0]!.json).toMatchObject({ deniedBy: "human", reason });

  // ── The run's approvals read IN CONTEXT: each settled "ran code" card
  // wears a status icon while collapsed (a check on the card whose burst
  // was approved, an x on the card whose burst was rejected — located by
  // their accessible labels, the stable handle now the marks are Feather
  // icons), and its code step expands into Script | Approvals
  // tabs — the Approvals tab rendering the batch through the same shared
  // body as the Notifications expansion, decision badge and policy
  // included.
  const approvedCard = page
    .getByTestId(/^activity-card-/)
    .filter({ has: page.getByLabel("approved", { exact: true }) });
  const rejectedCard = page
    .getByTestId(/^activity-card-/)
    .filter({ has: page.getByLabel("rejected", { exact: true }) });
  await approvedCard.waitFor();
  await rejectedCard.waitFor();
  await approvedCard.click();
  await approvedCard.getByRole("button", { name: "Approvals" }).click();
  await approvedCard.getByText("Approved", { exact: true }).waitFor();
  await approvedCard.getByText("The mobile approvals spec holds these for a human").waitFor();
  // Collapse it back so the thread reads clean for the next act.
  await approvedCard.getByLabel("approved", { exact: true }).click();

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
 * Wait for a batch-card button while the turn runs and the burst coalesces at
 * the egress door — the working row and the live "running code…" activity
 * cover the whole wait with real spinners. The diagnostic wrapper adds the
 * durable event chain to a timeout, so a failure names the missing
 * transition instead of just the button.
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
 * survives the card folding up when the run settles). Retried because RN-web's
 * Pressable occasionally drops a synthesized press outright — no handler call
 * at all — and a decision must not silently not-happen. `answerDialog` re-arms
 * per attempt: each press summons a fresh Face ID confirm / reason prompt; the
 * handler is removed after every attempt so a stale one cannot answer the
 * NEXT lane's dialog with the wrong response.
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
    .getAttribute("data-testid");
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
