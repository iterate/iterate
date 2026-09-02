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
// The files are attached over admin itx — the same addFiles call the
// composer makes — and every turn they open is answered by the fixture's
// scripted model, so nothing here waits on a real LLM.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { test } from "../test-support/test.ts";

test("multiple photos share a mosaic row; a lone tall one sits on its blurred backdrop", async ({
  page,
  helpers,
}) => {
  await using fixture = await helpers.createMobileFixture("mobile-chat-photos");

  const agent = await fixture.createAgent();
  agent.responses.set(async () => "ok");
  await page.goto(agent.mobileUrl);

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
    // Long enough to wrap: a caption must not stretch the bubble wider than
    // its photo. The <attachment> parts are what the composer sends
    // (lib/composer-attachments.ts): dimensions the mosaic needs, metadata
    // the caption must hide.
    message: [
      "Here are their instructions, and a caption long enough that it has to wrap onto several lines inside the bubble",
      '<attachment filename="phone-screenshot.png" width="390" height="844" />',
      '<attachment filename="swim-email.png" width="720" height="480" />',
    ].join("\n"),
  });

  // The mosaic only kicks in at two photos — this one is alone.
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

  // One justified row at the SAME height (390×844 next to 720×480 share
  // ~142pt), together filling the 280pt bubble — not stacked. The poll rides
  // out the reflow after the images report their dimensions.
  const screenshot = page.getByLabel("phone-screenshot.png");
  const landscape = page.getByLabel("swim-email.png");
  await expect.poll(async () => (await screenshot.boundingBox())?.width).toBeLessThan(100);
  const screenshotBox = (await screenshot.boundingBox())!;
  const landscapeBox = (await landscape.boundingBox())!;
  expect(Math.round(screenshotBox.height)).toBe(Math.round(landscapeBox.height));
  expect(Math.abs(screenshotBox.y - landscapeBox.y)).toBeLessThan(1);
  expect(landscapeBox.x).toBeGreaterThan(screenshotBox.x + screenshotBox.width - 1);
  expect(Math.round(screenshotBox.width + landscapeBox.width)).toBeGreaterThanOrEqual(276);

  // The caption sits under the mosaic, never wider than it — and the
  // <attachment .../> metadata lines are stripped from what a human sees.
  const caption = page.getByText("Here are their instructions,");
  await caption.waitFor();
  expect(await caption.textContent()).not.toContain("<attachment");
  const captionBox = (await caption.boundingBox())!;
  expect(captionBox.y).toBeGreaterThan(landscapeBox.y);
  expect(captionBox.width).toBeLessThanOrEqual(281);

  // The lone screenshot: 606pt tall at bubble width, so it is capped at 340
  // and no longer fills its frame — the case the blurred backdrop exists
  // for, drawn as a cover-scaled copy of the photo behind the fitted one.
  const solo = page.getByLabel("phone-screenshot-solo.png");
  await solo.getByTestId("photo-backdrop").waitFor();
  expect(await solo.boundingBox()).toMatchObject({ height: 340, width: 280 });

  // The video draws as a playable tile with the placeholder face (a browser
  // can't thumbnail the deliberately-bogus bytes); the wav is genuine, so
  // play really flips to pause.
  const wav = tinyWav();
  const mediaMessage = await agent.addFiles({
    files: [
      { contentType: "audio/wav", data: wav, filename: "voice-note.wav" },
      { contentType: "video/mp4", data: new Uint8Array([0, 0, 0, 0]), filename: "clip.mp4" },
    ],
    message: '<attachment filename="clip.mp4" width="640" height="360" />',
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
  // raw XML — the <user-location .../> part disappears from the caption.
  await agent.message(
    'Meet here\n<user-location latitude="51.5074" longitude="-0.1278" accuracy-meters="15" captured-at="2026-08-30T16:05:04.166Z" />',
  );
  await page.getByLabel(/Open location 51\.50740, -0\.12780 in maps/).waitFor();
  const locationCaption = page.getByText("Meet here");
  await locationCaption.waitFor();
  expect(await locationCaption.textContent()).not.toContain("<user-location");
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
