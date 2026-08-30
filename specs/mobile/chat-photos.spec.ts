// Photo attachments in a chat thread, through the real phone-sized web build.
//
// The shape under test is Telegram's, in both halves:
//
// - A message with SEVERAL photos lays them out as a mosaic — photos share a
//   justified row at one common height (lib/mosaic-layout.ts) instead of
//   stacking full-width on top of each other.
// - A lone photo reaches the bubble's edges at its own aspect ratio, and one
//   too tall to show whole is capped and fitted onto a blurred copy of
//   itself rather than letterboxed in black.
//
// ZERO model turns: the files are attached over admin itx, the same
// addFiles call the composer makes, so nothing here waits on an LLM.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { connectItxReady } from "iterate/node";
import { localOsDevServer } from "../../apps/os/scripts/dev.ts";
import { signUpWithEmailOtp, uniqueSignupEmail } from "../test-support/email-otp-signup.ts";
import { resolveAdminSecret } from "../test-support/forged-session.ts";
import { test } from "../test-support/test.ts";

test("multiple photos share a mosaic row; a lone tall one sits on its blurred backdrop", async ({
  page,
}, testInfo) => {
  const osBaseUrl = await resolveOsBaseUrl();
  const projectSlug = `mobile-chat-photos-${Date.now().toString(36)}`;

  await signUpToProject(page, testInfo, osBaseUrl, projectSlug);
  const projectId = new URL(page.url()).pathname.split("/")[2]!;

  await page.getByText("New chat").click();
  const pathHeading = page.getByRole("heading", { name: /^mobile\// });
  await pathHeading.waitFor();
  const agentPath = `/agents/${await pathHeading.textContent()}`;

  using itx = await connectItxReady({
    auth: { type: "admin-secret", secret: await resolveAdminSecret() },
    baseUrl: osBaseUrl,
    projectId,
  });
  using agent = itx.agents.get(agentPath);
  await agent.create();
  // One addFiles call carrying both attachments plus a caption — exactly what
  // the composer sends when you pick photos and type something.
  await agent.addFiles({
    files: ["phone-screenshot.png", "swim-email.png"].map((filename) => ({
      contentType: "image/png",
      data: new Uint8Array(
        readFileSync(resolve(import.meta.dirname, "../../apps/mobile/e2e/fixtures", filename)),
      ),
      filename,
    })),
    // Long enough to wrap: a caption must not be able to stretch the bubble
    // wider than its photo, which would put bubble fill along the photo's
    // edge — the exact gap this layout exists to remove.
    message:
      "Here are their instructions, and a caption long enough that it has to wrap onto several lines inside the bubble",
  });

  // A second message with the tall screenshot ALONE — the mosaic only kicks
  // in at two photos, so this one exercises the single-photo frame rules.
  await agent.addFiles({
    files: [
      {
        contentType: "image/png",
        data: new Uint8Array(
          readFileSync(
            resolve(import.meta.dirname, "../../apps/mobile/e2e/fixtures", "phone-screenshot.png"),
          ),
        ),
        filename: "phone-screenshot-solo.png",
      },
    ],
  });

  // The two-photo message: one justified row, both photos at the SAME height
  // (390×844 next to 720×480 → aspects 0.46 and 1.5 share ~142pt), together
  // filling the 280pt bubble width — not stacked. Until the images report
  // their dimensions each mosaic tile shows its Loading state, which the
  // spinner waiter holds on; the poll then only rides out the one reflow.
  const screenshot = page.getByLabel("phone-screenshot.png");
  const landscape = page.getByLabel("swim-email.png");
  await expect.poll(async () => (await screenshot.boundingBox())?.width).toBeLessThan(100);
  const screenshotBox = (await screenshot.boundingBox())!;
  const landscapeBox = (await landscape.boundingBox())!;
  expect(Math.round(screenshotBox.height)).toBe(Math.round(landscapeBox.height));
  expect(Math.abs(screenshotBox.y - landscapeBox.y)).toBeLessThan(1);
  expect(landscapeBox.x).toBeGreaterThan(screenshotBox.x + screenshotBox.width - 1);
  expect(Math.round(screenshotBox.width + landscapeBox.width)).toBeGreaterThanOrEqual(276);

  // The caption sits under the mosaic, never wider than it.
  const caption = page.getByText("Here are their instructions,");
  await caption.waitFor();
  const captionBox = (await caption.boundingBox())!;
  expect(captionBox.y).toBeGreaterThan(landscapeBox.y);
  expect(captionBox.width).toBeLessThanOrEqual(281);

  // The lone screenshot: 606pt tall at bubble width, so it is capped at 340
  // and no longer fills its frame — the case the blurred backdrop exists
  // for, drawn as a cover-scaled copy of the photo behind the fitted one.
  const solo = page.getByLabel("phone-screenshot-solo.png");
  await solo.getByTestId("photo-backdrop").waitFor();
  expect(await solo.boundingBox()).toMatchObject({ height: 340, width: 280 });
});

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
    email: uniqueSignupEmail("mobile-chat-photos"),
    projectSlug,
    testInfo,
  });
  // Project selection auto-continues for test identities (project-access.tsx)
  // — consent is the next interactive page.
  await popup.getByRole("button", { name: "Allow access" }).click();
  await page.getByText("New chat").waitFor();
  // Video-mode demos start at the interesting part, not the OAuth ceremony.
  page.videoMode?.setStartTime();
}

async function resolveOsBaseUrl(): Promise<string> {
  const configured = process.env.APP_CONFIG_BASE_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const target = await localOsDevServer.resolveTarget();
  return target.baseUrl;
}
