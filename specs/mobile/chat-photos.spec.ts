// Photo attachments in a chat thread, through the real phone-sized web build.
//
// The shape under test is Telegram's: a photo reaches the bubble's edges at
// its own aspect ratio, and a photo too tall to show whole is capped and
// fitted onto a blurred copy of itself rather than letterboxed in black. Two
// fixtures cover both halves — a phone screenshot (far taller than the cap)
// and a landscape image (shorter than it).
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

test("photos fill their bubble, and a tall one sits on its own blurred backdrop", async ({
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
    message: "Here are their instructions",
  });

  // 390×844 fixture: 606pt tall at bubble width, so it is capped at 340 and no
  // longer fills its frame — the case the blurred backdrop exists for, drawn
  // as a cover-scaled copy of the photo behind the fitted one. Waiting on the
  // backdrop also waits out the frame's own loading state: until the image
  // reports its dimensions every photo holds a plain 4:3 box.
  const screenshot = page.getByLabel("phone-screenshot.png");
  await screenshot.getByTestId("photo-backdrop").waitFor();
  expect(await screenshot.boundingBox()).toMatchObject({ height: 340, width: 280 });

  // 720×480 fixture: 187pt tall at bubble width, comfortably under the cap, so
  // it fills its frame and needs nothing behind it.
  const landscape = page.getByLabel("swim-email.png");
  await expect.poll(async () => (await landscape.boundingBox())?.height).toBe(187);
  expect(await landscape.getByTestId("photo-backdrop").count()).toBe(0);

  // The caption sits under its photos, the way every chat app stacks them.
  const caption = page.getByText("Here are their instructions");
  await caption.waitFor();
  expect((await caption.boundingBox())!.y).toBeGreaterThan((await landscape.boundingBox())!.y);
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
