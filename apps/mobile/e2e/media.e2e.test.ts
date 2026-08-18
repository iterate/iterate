// Live proof of the media capture pipeline: the exact bytes-then-append
// sequence the Media screen performs (see app/project/[projectId]/media.tsx)
// against a real project — upload to itx.files, then ONE durable
// media/uploaded append — followed by the SERVER-side analysis reaction (the
// seeded MediaApp processor drives toMarkdown → vision transcript+tags and
// settles with a media/processed event). Also the repo's live proof that
// IMAGE input to itx.ai.toMarkdown works (the cf-ai-to-markdown example only
// exercises CSV/HTML and is e2eProven: false). The fixture
// (e2e/fixtures/ticket.png) renders "Train to Florence / Seat 21A", so the
// transcript assertion is a real full-text OCR check, not just shape.
//
//   doppler run --config dev -- pnpm --dir apps/mobile test:e2e   # local dev (pnpm dev must be running)

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { connectItx } from "iterate/node";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import {
  buildReanalyzeEvent,
  buildUploadedEvent,
  MEDIA_PROCESSED_EVENT_TYPE,
  MEDIA_UPLOADED_EVENT_TYPE,
  mediaFilePath,
} from "../src/lib/media.ts";
import { portlessOrigin, requireEnv, resolveBaseUrl } from "./e2e-helpers.ts";

test("media upload: bytes → uploaded event → server-side analysis settles a processed event; re-analyze overlays", async () => {
  const baseUrl = resolveBaseUrl();

  using adminSession = connectItx({
    baseUrl,
    auth: { type: "admin-secret", secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET") },
  });
  const slug = `mobile-media-e2e-${Date.now().toString(36)}`;
  const created = await adminSession.projects.get(slug).create({});
  const { projectId } = await created.__describe();

  const token = await mintForgedAccessToken({
    forgePrivateJwk: requireEnv("AUTH_FORGE_ES256_PRIVATE_JWK"),
    issuer: requireEnv("APP_CONFIG_ITERATE_AUTH__ISSUER"),
    audience: process.env.APP_CONFIG_ITERATE_AUTH__RESOURCE?.trim() || portlessOrigin(baseUrl),
    email: "mobile-media-e2e@nustom.com",
    admin: true,
  });
  using project = connectItx({ baseUrl, auth: { type: "bearer", token }, projectId });

  // The screen's exact sequence: hash → put bytes → append uploaded.
  const png = readFileSync(resolve(import.meta.dirname, "fixtures/ticket.png"));
  const base64 = png.toString("base64");
  const stableKey = createHash("sha256").update(base64).digest("hex");
  const filename = "media-e2e-ticket.png";
  await project.files
    .get(mediaFilePath(stableKey, filename))
    .put({ data: new Uint8Array(png), contentType: "image/png" });

  const stream = project.streams.get("/media");
  const uploadedInput = buildUploadedEvent({
    stableKey,
    wipeGeneration: 0,
    filename,
    contentType: "image/png",
    width: 280,
    height: 110,
    source: "picker",
    capturedAt: null,
    isScreenshot: null,
  });
  const [uploaded] = await stream.append(uploadedInput);
  expect(uploaded).toMatchObject({
    type: MEDIA_UPLOADED_EVENT_TYPE,
    offset: expect.any(Number),
  });

  // Re-appending the same upload (retry, re-pick) dedupes to the SAME event.
  const [rerun] = await stream.append(uploadedInput);
  expect(rerun).toMatchObject({ offset: uploaded!.offset });

  // The seeded MediaApp processor reacts server-side: no socket held open,
  // no client involvement — the settlement just arrives on the stream.
  const processed: any = await stream.waitForEvent({
    afterOffset: uploaded!.offset,
    eventTypes: [MEDIA_PROCESSED_EVENT_TYPE],
    predicate: (event: any) => event.payload.stableKey === stableKey,
    timeoutMs: 120_000,
  });
  expect(processed.payload).toMatchObject({
    stableKey,
    error: null,
    requestOffset: uploaded!.offset,
    processedBy: expect.stringContaining("@cf/"),
  });
  // The vision models actually read the image: the description says
  // SOMETHING, and the transcript contains the rendered ticket text.
  expect(processed.payload.markdown.length).toBeGreaterThan(0);
  expect(processed.payload.transcript.toLowerCase()).toContain("florence");
  expect(Array.isArray(processed.payload.tags)).toBe(true);

  // Re-analyze is a durable request the same server pipeline answers.
  await stream.append(buildReanalyzeEvent(stableKey, "e2e-1"));
  const reprocessed: any = await stream.waitForEvent({
    afterOffset: processed.offset,
    eventTypes: [MEDIA_PROCESSED_EVENT_TYPE],
    predicate: (event: any) => event.payload.stableKey === stableKey,
    timeoutMs: 120_000,
  });
  expect(reprocessed.payload).toMatchObject({ stableKey, error: null });
});
