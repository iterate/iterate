// The Media screen through the real phone-sized web build, in two lanes:
//
// 1. Deterministic (CI-able): real signup, then a captured event SEEDED over
//    the admin API — no AI calls — proving list rendering, search filtering,
//    and the full-screen viewer chrome.
// 2. The live capture pipeline (opt-in): file-input capture through the real
//    toMarkdown + vision calls. AI-dependent, so never deterministic — a
//    permanent opt-in and an eval candidate rather than a CI test.
//
//   MOBILE_MEDIA_SPECS=1 pnpm spec --project=mobile -g "media"

import { resolve } from "node:path";
import { connectItx } from "iterate/node";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { test } from "../test-support/test.ts";

test("renders, searches, and views seeded media", async ({ page }, testInfo) => {
  test.skip(
    !process.env.APP_CONFIG_ADMIN_API_SECRET,
    "structural: seeding needs the deployment's admin API secret in the environment",
  );
  const osBaseUrl = await resolveOsBaseUrl();
  const projectSlug = `mobile-media-${Date.now().toString(36)}`;

  await signUpToProject(page, testInfo, osBaseUrl, projectSlug);
  const projectId = new URL(page.url()).pathname.split("/")[2];

  // Seed one captured item the way the pipeline would have written it — no
  // AI involved, so assertions are exact.
  using project = connectItx({
    baseUrl: osBaseUrl,
    auth: { type: "admin-secret", secret: process.env.APP_CONFIG_ADMIN_API_SECRET! },
    projectId,
  });
  // Vocabulary inlined from apps/mobile/src/lib/media.ts (Playwright's
  // transformer cannot load that module from here).
  const stableKey = "spec-seeded-ticket";
  const path = `/media/${stableKey}-ticket.png`;
  const { readFileSync } = await import("node:fs");
  const png = readFileSync(
    resolve(import.meta.dirname, "../../apps/mobile/e2e/fixtures/ticket.png"),
  );
  await project.files.get(path).put({ data: new Uint8Array(png), contentType: "image/png" });
  await project.streams.get("/media").append({
    type: "events.iterate.com/media/captured",
    idempotencyKey: `media-captured-${stableKey}`,
    payload: {
      stableKey,
      title: "Trenitalia ticket to Florence",
      path,
      filename: "ticket.png",
      contentType: "image/png",
      width: 280,
      height: 110,
      source: "library-sync",
      capturedAt: "2026-08-10T09:00:00.000Z",
      isScreenshot: true,
      markdown: "A train ticket to Florence.",
      transcript: "Train to Florence Seat 21A",
      tags: ["screenshot", "logistics"],
      processedBy: "spec-fixture",
    },
  });

  await page.getByLabel("Open project menu").filter({ visible: true }).click();
  await page.getByRole("button", { name: "/media" }).click();

  // The seeded row, its tags, and search over description + transcript.
  await page.getByText("A train ticket to Florence.").waitFor();
  // "logistics" renders as both a filter chip and the row tag.
  await page.getByText("logistics", { exact: true }).nth(1).waitFor();
  await page.getByPlaceholder("Search descriptions and text…").fill("seat 21a");
  await page.getByText("A train ticket to Florence.").waitFor();
  await page.getByPlaceholder("Search descriptions and text…").fill("zzz-no-match");
  await page.getByText("No results").waitFor();
  await page.getByPlaceholder("Search descriptions and text…").fill("");

  // Viewer: thumbnail → full screen; tap toggles chrome; See more expands.
  await page.getByLabel("View full screen").first().click();
  await page.getByLabel("Full screen media").click();
  await page.getByRole("button", { name: "See more" }).click();
  await page.getByText("See less").waitFor();
  await page.getByLabel("Close image").click();

  // The Auto-collect row opens a confirm dialog — nothing syncs on tap.
  await page.getByText("Auto-collect screenshots").click();
  await page.getByText("Nothing happens until you confirm here.").waitFor();
  await page.getByText("1 week", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Turn on" }).waitFor();

  // Delete-all lives behind its own inline confirm, then the wiped
  // tombstone clears the list live.
  await page.getByText("Delete all media…").click();
  await page.getByText(/cannot be undone/).waitFor();
  await page.getByRole("button", { name: "Yes, delete everything" }).click();
  await page.getByText("Nothing here yet").waitFor();
});

test("captures through the live vision pipeline", async ({ page }, testInfo) => {
  test.skip(
    process.env.MOBILE_MEDIA_SPECS !== "1",
    "parked: AI-dependent (real toMarkdown + vision calls), so never CI-deterministic — likely becomes an eval; run with MOBILE_MEDIA_SPECS=1 — revisit by 2026-08-24",
  );
  // Test BUDGET (not an action timeout): two real vision-model calls ride
  // this test and routinely take over a minute together.
  test.setTimeout(240_000);
  const osBaseUrl = await resolveOsBaseUrl();
  const projectSlug = `mobile-media-ai-${Date.now().toString(36)}`;

  await signUpToProject(page, testInfo, osBaseUrl, projectSlug);
  await page.getByLabel("Open project menu").filter({ visible: true }).click();
  await page.getByRole("button", { name: "/media" }).click();
  await page.getByText("Nothing here yet").waitFor();

  // Capture through the picker's web fallback (an <input type=file>). The
  // pending card's spinner keeps the spinner waiter extending the wait
  // while the vision pipeline runs — no explicit timeouts.
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "+ Add" }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(
    resolve(import.meta.dirname, "../../apps/mobile/e2e/fixtures/ticket.png"),
  );
  await page.getByText("Analyzing…").waitFor();
  await page
    .getByText(/Florence/)
    .first()
    .waitFor();
});

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
    email: uniqueSignupEmail("mobile-media"),
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
