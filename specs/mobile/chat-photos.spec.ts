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
    // edge — the exact gap this layout exists to remove. The <img> parts are
    // what the composer sends (the html attachment vocabulary): the
    // user-message-describer facet derives them into typed attachments, which
    // is where the mosaic gets its exact dimensions and the caption its
    // cleaned text.
    message: [
      "Here are their instructions, and a caption long enough that it has to wrap onto several lines inside the bubble",
      '<img alt="phone-screenshot.png" width="390" height="844">',
      '<img alt="swim-email.png" width="720" height="480">',
    ].join("\n"),
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
  // The mosaic only lays out once the describer facet's derived dimensions
  // land — its first build is server-side work with no loading UI for
  // spinner-waiter, hence the manual timeout.
  await expect
    .poll(async () => (await screenshot.boundingBox())?.width, { timeout: 120_000 }) // timeout: describer facet cold build, invisible to spinner-waiter
    .toBeLessThan(100);
  const screenshotBox = (await screenshot.boundingBox())!;
  const landscapeBox = (await landscape.boundingBox())!;
  expect(Math.round(screenshotBox.height)).toBe(Math.round(landscapeBox.height));
  expect(Math.abs(screenshotBox.y - landscapeBox.y)).toBeLessThan(1);
  expect(landscapeBox.x).toBeGreaterThan(screenshotBox.x + screenshotBox.width - 1);
  expect(Math.round(screenshotBox.width + landscapeBox.width)).toBeGreaterThanOrEqual(276);

  // The caption sits under the mosaic, never wider than it — and the derived
  // re-emission cleans the <img> part lines out of what a human sees (by the
  // time the mosaic above laid out, the described fact has already landed).
  const caption = page.getByText("Here are their instructions,");
  await caption.waitFor();
  expect(await caption.textContent()).not.toContain("<img");
  const captionBox = (await caption.boundingBox())!;
  expect(captionBox.y).toBeGreaterThan(landscapeBox.y);
  expect(captionBox.width).toBeLessThanOrEqual(281);

  // The lone screenshot: 606pt tall at bubble width, so it is capped at 340
  // and no longer fills its frame — the case the blurred backdrop exists
  // for, drawn as a cover-scaled copy of the photo behind the fitted one.
  const solo = page.getByLabel("phone-screenshot-solo.png");
  await solo.getByTestId("photo-backdrop").waitFor();
  expect(await solo.boundingBox()).toMatchObject({ height: 340, width: 280 });

  // Audio + video attachments in one message: the video (dimensions known
  // from its derived <video> part) draws as a playable tile — here with the
  // placeholder face, since a browser build can't extract a thumbnail from
  // the deliberately-bogus bytes — and the audio draws the play/waveform
  // row. Real playback: the wav is genuine, so play flips to pause.
  const wav = tinyWav();
  const mediaMessage = await agent.addFiles({
    files: [
      { contentType: "audio/wav", data: wav, filename: "voice-note.wav" },
      { contentType: "video/mp4", data: new Uint8Array([0, 0, 0, 0]), filename: "clip.mp4" },
    ],
    message: '<video data-filename="clip.mp4" width="640" height="360"></video>',
  });

  // The file plane honors byte ranges — without this, iOS AVPlayer (expo-audio
  // playback, expo-video, thumbnail extraction) can't stream or even report a
  // duration from these urls. Assert the real serving path, not the parser.
  const audioUrl = mediaMessage.files.find((file) => file.filename === "voice-note.wav")!.url;
  const ranged = await fetch(audioUrl, { headers: { range: "bytes=0-99" } });
  expect(ranged).toMatchObject({ status: 206 });
  expect(Object.fromEntries(ranged.headers)).toMatchObject({
    "accept-ranges": "bytes",
    "content-range": `bytes 0-99/${wav.byteLength}`,
  });
  expect(await ranged.arrayBuffer()).toMatchObject({ byteLength: 100 });

  await page.getByLabel("Play video clip.mp4").waitFor();
  await page.getByLabel("Seek audio").waitFor();
  await page.getByLabel("Play audio").click();
  await page.getByLabel("Pause audio").waitFor();

  // Tapping a photo opens the in-app viewer instantly on the cached image —
  // not a browser page re-downloading it.
  await landscape.click();
  const fullScreen = page.getByLabel("Full screen media");
  await fullScreen.waitFor();
  await fullScreen.click();
  await page.getByLabel("Close image").click();

  // A shared location renders as a tappable map card (OSM tiles + pin), not
  // raw markup — the geo anchor part disappears from the caption once the
  // described fact lands. The map card only exists in the DERIVED render, so
  // waiting for it also proves the caption swap. Manual timeout: derivation
  // is server-side work with no loading UI for spinner-waiter.
  await agent.message(
    'Meet here\n<a href="geo:51.5074,-0.1278" data-accuracy-m="15" data-captured-at="2026-08-30T16:05:04.166Z">Shared location</a>',
  );
  await page.getByLabel(/Open location 51\.50740, -0\.12780 in maps/).waitFor({ timeout: 60_000 }); // timeout: describer derivation, invisible to spinner-waiter
  const locationCaption = page.getByText("Meet here");
  await locationCaption.waitFor();
  expect(await locationCaption.textContent()).not.toContain("geo:");
});

/** A real WAV: 8kHz mono 16-bit, 3s of a 440Hz tone — long enough that the
 * player is still visibly PLAYING when the spec looks for the pause state
 * (a 0.2s clip finished before the assertion could see it). */
function tinyWav(): Uint8Array {
  const sampleRate = 8000;
  const sampleCount = Math.floor(sampleRate * 3);
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + sampleCount * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(sampleCount * 2, 40);
  for (let i = 0; i < sampleCount; i++) {
    buffer.writeInt16LE(
      Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 8000),
      44 + i * 2,
    );
  }
  return new Uint8Array(buffer);
}

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
