/**
 * Agent Response Time Test
 *
 * Measures end-to-end latency of the agent webchat flow:
 *   1. Create a machine (local-docker or daytona)
 *   2. Wait for it to be ready
 *   3. Send a hello-world message, measure time to response
 *   4. Send a second message, measure time to response
 *   5. Archive the machine
 *
 * Env vars:
 *   AGENT_RESPONSE_TIME_TEST=1         — gate: skip unless set
 *   MACHINE_TYPE=daytona|local-docker   — which provider to use (default: daytona)
 *
 * For prod/stg (where test OTP doesn't work), provide auth cookies + project path:
 *   AUTH_COOKIE="better-auth.session_token=xxx"  — session cookie from browser
 *   PROJECT_PATH="/orgs/my-org/projects/my-proj" — existing project path
 *
 * Run:
 *   AGENT_RESPONSE_TIME_TEST=1 pnpm spec -- spec/agent-response-time.spec.ts
 *   AGENT_RESPONSE_TIME_TEST=1 MACHINE_TYPE=local-docker pnpm spec -- spec/agent-response-time.spec.ts
 *   AGENT_RESPONSE_TIME_TEST=1 APP_URL=https://os.iterate.com AUTH_COOKIE="better-auth.session_token=xxx" PROJECT_PATH="/orgs/nustom/projects/my-proj" pnpm spec -- spec/agent-response-time.spec.ts
 */

import { expect } from "@playwright/test";
import { createOrganization, createProject, login, sidebarButton, test } from "./test-helpers.ts";

const MACHINE_TYPE = process.env.MACHINE_TYPE ?? "daytona";
const MACHINE_READY_TIMEOUT = MACHINE_TYPE === "daytona" ? 180_000 : 120_000;
const AGENT_RESPONSE_TIMEOUT = 180_000;

/** Prod mode: skip login/org/project creation, use provided cookies + project path */
const AUTH_COOKIE = process.env.AUTH_COOKIE;
const PROJECT_PATH = process.env.PROJECT_PATH;
const USE_EXISTING_SESSION = !!(AUTH_COOKIE && PROJECT_PATH);

/** Human-readable ms → "12.3s" */
function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// Disable all artifacts — we don't need traces/videos/screenshots for a benchmark
test.use({ trace: "off", video: "off", screenshot: "off" });

test.describe("agent response time", () => {
  test.skip(
    process.env.AGENT_RESPONSE_TIME_TEST !== "1",
    "Set AGENT_RESPONSE_TIME_TEST=1 to run this test",
  );

  // This test is inherently slow — machine boot + LLM round-trips
  test.setTimeout(600_000);

  test("machine boot, hello world, second request, shutdown", async ({ page, baseURL }) => {
    const runId = Date.now();
    const machineName = `Perf Machine ${runId}`;

    // ── 1. Setup: login or inject cookies ──────────────────────────────

    if (USE_EXISTING_SESSION) {
      // Parse and inject cookies for prod/stg
      const url = new URL(baseURL!);
      const isSecure = url.protocol === "https:";
      const cookies = AUTH_COOKIE!.split(";").map((c) => {
        const [name, ...rest] = c.trim().split("=");
        return {
          name: name!,
          value: decodeURIComponent(rest.join("=")),
          domain: url.hostname,
          path: "/",
          secure: isSecure,
          httpOnly: true,
          sameSite: "Lax" as const,
        };
      });
      await page.context().addCookies(cookies);
      await page.goto(PROJECT_PATH!);
      // Wait for page to load with auth
      await page.waitForLoadState("networkidle");
    } else {
      const testEmail = `agent-perf-${runId}+test@nustom.com`;
      await login(page, testEmail);
      await createOrganization(page);
      await createProject(page);
    }

    // ── 2. Create machine ──────────────────────────────────────────────

    await sidebarButton(page, "Machines").click();
    await page.getByRole("link", { name: "Create Machine" }).click();

    if (MACHINE_TYPE !== "daytona") {
      // daytona is the default — only change if we need something else
      await page.getByRole("combobox").click();
      const optionName =
        MACHINE_TYPE === "local-docker" ? /Local Docker/i : new RegExp(MACHINE_TYPE, "i");
      await page.getByRole("option", { name: optionName }).click();
    }

    await page.getByPlaceholder("Machine name").fill(machineName);

    const machineCreateStart = performance.now();
    await page.getByRole("button", { name: "Create" }).click();

    // ── 3. Wait for machine ready ──────────────────────────────────────

    const machineRow = page.getByRole("link", { name: machineName });
    await machineRow.waitFor({ timeout: 30_000 });
    await machineRow.locator("text=Ready").waitFor({ timeout: MACHINE_READY_TIMEOUT });

    const machineReadyMs = performance.now() - machineCreateStart;

    // ── 4. Navigate to webchat ─────────────────────────────────────────

    await sidebarButton(page, "Home").click();
    await page
      .getByTestId("webchat-input")
      .and(page.locator(":not([disabled])"))
      .waitFor({ timeout: 30_000 });

    // Dismiss any lingering toasts
    await page
      .locator("[data-sonner-toast]")
      .first()
      .waitFor({ state: "hidden", timeout: 10_000 })
      .catch(() => {});

    // ── 5. First message: "hello world" ────────────────────────────────

    await page.getByRole("button", { name: "New Thread" }).click();

    const input = page.getByTestId("webchat-input");
    await input.fill("Reply with exactly: HELLO_WORLD_ACK");

    const firstMsgStart = performance.now();
    await page.getByTestId("webchat-send").click();

    // Wait for the user message to appear
    await page
      .getByTestId("webchat-message-user")
      .filter({ hasText: "HELLO_WORLD_ACK" })
      .waitFor({ timeout: 15_000 });

    // Wait for assistant response with non-empty text
    await page.getByTestId("webchat-message-assistant").first().waitFor({
      timeout: AGENT_RESPONSE_TIMEOUT,
    });
    await expect
      .poll(
        async () => {
          const text = await page.getByTestId("webchat-message-assistant").last().innerText();
          return text.trim().length;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    const firstResponseMs = performance.now() - firstMsgStart;

    // ── 6. Second message ──────────────────────────────────────────────

    await input.fill("Reply with exactly: SECOND_ACK");

    const secondMsgStart = performance.now();
    await page.getByTestId("webchat-send").click();

    await page
      .getByTestId("webchat-message-user")
      .filter({ hasText: "SECOND_ACK" })
      .waitFor({ timeout: 15_000 });

    // Wait for a second assistant message
    await expect
      .poll(async () => page.getByTestId("webchat-message-assistant").count(), {
        timeout: AGENT_RESPONSE_TIMEOUT,
      })
      .toBeGreaterThan(1);

    const secondResponseMs = performance.now() - secondMsgStart;

    // ── 7. Report timings (before archive so data is captured even on cleanup failure) ──

    const report = {
      machineType: MACHINE_TYPE,
      machineReadyMs: Math.round(machineReadyMs),
      firstResponseMs: Math.round(firstResponseMs),
      secondResponseMs: Math.round(secondResponseMs),
    };

    console.log("\n┌─── Agent Response Time Results ───┐");
    console.log(`│ Machine type:      ${MACHINE_TYPE}`);
    console.log(`│ Machine ready:     ${fmtMs(machineReadyMs)}`);
    console.log(`│ First response:    ${fmtMs(firstResponseMs)}`);
    console.log(`│ Second response:   ${fmtMs(secondResponseMs)}`);
    console.log("└───────────────────────────────────┘");
    console.log(`AGENT_PERF_JSON=${JSON.stringify(report)}`);

    // ── 8. Archive the machine (best-effort cleanup) ───────────────────

    try {
      await sidebarButton(page, "Machines").click();

      // Archive is inside a ⋯ dropdown menu on the machine row
      const machineCard = page.locator("[class*=rounded-lg]", { hasText: machineName });
      const moreButton = machineCard
        .getByRole("button")
        .filter({ has: page.locator("svg") })
        .last();
      await moreButton.click({ timeout: 5_000 });
      await page.getByRole("menuitem", { name: "Archive" }).click({ timeout: 3_000 });
    } catch {
      // Archive is best-effort — don't fail the test over cleanup
    }

    // Soft assertions — we want timings even if these fail
    expect(firstResponseMs, "First response should complete within timeout").toBeLessThan(
      AGENT_RESPONSE_TIMEOUT,
    );
    expect(secondResponseMs, "Second response should complete within timeout").toBeLessThan(
      AGENT_RESPONSE_TIMEOUT,
    );
  });
});
