// The phone approver, end to end in a browser: a script run's concurrent
// burst parks at the egress door as ONE approval batch, and the human decides
// it from the mobile app — Approve all behind the Face ID stand-in (the web
// build gates authenticated key reads behind `confirm()`), or Reject with a
// typed reason that lands verbatim in the script's 403 body so the calling
// agent can retry differently.
//
// Web-platform approximations, deliberate and dev-only: secure storage is
// localStorage with confirm()-gated reads (apps/mobile/src/lib/secure-store.ts),
// and push notifications don't exist — the spec navigates to the Approvals
// screen the way a human following a badge would.

import { expect, type Page } from "@playwright/test";
import { spinnerWaiter } from "middlewright";
import { connectItxReady } from "iterate/node";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { withTunnel } from "../../apps/os/e2e/test-support/tunnel.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { resolveAdminSecret } from "../test-support/forged-session.ts";
import { test } from "../test-support/test.ts";

test("approve a burst with one confirm; reject with a reason the script reads", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const echo = await startEgressEcho();
  try {
    // ── Sign up through the REAL flow: server picker → OAuth popup → email
    // OTP (fixed dev code) → org+project onboarding → back in the app.
    const projectSlug = `mobile-approvals-${Date.now().toString(36)}`;
    await page.goto("/");
    const serverInput = page.getByPlaceholder("https://os.iterate.com");
    await serverInput.fill(osBaseUrl);
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Sign in" }).click();
    const popup = await popupPromise;
    await popup.getByTestId("email-login-button").click();
    await signUpWithEmailOtp(popup, {
      email: uniqueSignupEmail("mobile-approvals"),
      projectSlug,
      testInfo,
    });
    // The phone client requests the `project` scope, so the popup continues
    // through project selection (the new project arrives pre-selected) and
    // the OAuth consent screen before redirecting back into the app.
    await popup.getByRole("button", { name: "Continue" }).click({ timeout: 30_000 });
    await popup.getByRole("button", { name: "Allow access" }).click({ timeout: 30_000 });

    // The popup redirects back into the app and closes itself; the app lands
    // on the project picker. Opening the project auto-enrolls this browser's
    // approval key — no manual enroll step anywhere below. The first project
    // list rides a COLD itx WebSocket to the deployment (session dial +
    // directory read observed at ~20-30s against preview slots), beyond the
    // spinner-waiter's budget — a product-latency problem worth fixing at the
    // source, not something more spinner UI can paper over.
    await page.getByText(projectSlug).click({ timeout: 60_000 });
    await page.getByText("New chat").waitFor();
    const projectId = new URL(page.url()).pathname.split("/")[2]!;

    // ── The agent side, from Node: a hold rule on the echo host, then a
    // 3-fetch Promise.all burst that parks as ONE batch at the egress door.
    using itx = await connectItxReady({
      auth: { type: "admin-secret", secret: await resolveAdminSecret() },
      baseUrl: osBaseUrl,
      projectId,
    });
    const echoHost = new URL(echo.url).hostname;
    const [rulesConfigured] = await itx.streams.get("/").append({
      type: "events.iterate.com/project/egress-rules-configured",
      payload: {
        rules: [
          {
            ruleKey: "spec-needs-a-human",
            description: "The mobile approvals spec holds these for a human",
            match: { hosts: [echoHost] },
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
    // Outwait the egress gate's ~5s rules cache before the first burst.
    await new Promise((resolve) => setTimeout(resolve, 6_000));

    const burst = (marker: string) =>
      itx.capabilityHost.runScript(
        `async () => {
          const responses = await Promise.all(
            Array.from({ length: 3 }, (_, index) =>
              fetch(${JSON.stringify(echo.url)} + "?${marker}=" + index, {
                method: "POST",
                body: "${marker} " + index,
              }),
            ),
          );
          return await Promise.all(
            responses.map(async (response) => ({
              status: response.status,
              body: await response.json(),
            })),
          );
        }`,
      );

    // ── Approve lane: one card for the whole burst, one confirm (the Face ID
    // stand-in), every request released.
    const approving = burst("approve-me");
    await page.goto(`/project/${projectId}/approvals?slug=${projectSlug}`);
    // Same shape as the reject lane below: the burst is still coalescing at
    // the egress door, the screen is honestly at rest (no spinner to wait
    // on), so hold the spinner-waiter off while the batch card appears.
    await spinnerWaiter.settings.run({ disabled: true }, () =>
      page.getByRole("button", { name: "Approve all 3 (Face ID)" }).waitFor({ timeout: 30_000 }),
    );
    acceptNextDialog(page);
    await page.getByRole("button", { name: "Approve all 3 (Face ID)" }).click();
    await page.getByText("Approved").first().waitFor();
    const approved = (await approving) as {
      result: Array<{ status: number; body: { body: string } }>;
    };
    expect(approved.result.map((entry) => entry.status)).toEqual([200, 200, 200]);

    // ── Reject lane: Reject all prompts for WHY, and the reason lands
    // verbatim in each rejected fetch's 403 body — the agent's cue to retry
    // differently.
    const rejecting = burst("reject-me");
    const reason = "wrong recipient — use the staging address";
    // Nothing on screen hints that a new batch is inbound (the second burst is
    // still coalescing at the egress door), so the spinner-waiter's
    // no-spinner fast-fail doesn't apply — wait for the card plainly.
    await spinnerWaiter.settings.run({ disabled: true }, () =>
      page.getByRole("button", { name: "Reject all" }).waitFor({ timeout: 30_000 }),
    );
    answerNextDialog(page, reason);
    await page.getByRole("button", { name: "Reject all" }).click();
    await page.getByText(`Rejected because: ${reason}`).waitFor();
    const rejected = (await rejecting) as {
      result: Array<{ status: number; body: { deniedBy?: string; reason?: string } }>;
    };
    expect(rejected.result.map((entry) => entry.status)).toEqual([403, 403, 403]);
    expect(rejected.result[0]!.body).toMatchObject({ deniedBy: "human", reason });
  } finally {
    await echo.close();
  }
});

/** Accept the next native dialog — the web build's Face ID stand-in. */
function acceptNextDialog(page: Page) {
  page.once("dialog", (dialog) => void dialog.accept());
}

/** Answer the next native prompt with `text` — the typed rejection reason. */
function answerNextDialog(page: Page, text: string) {
  page.once("dialog", (dialog) => void dialog.accept(text));
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
      return Response.json({ body: await request.text() });
    },
  });
}
