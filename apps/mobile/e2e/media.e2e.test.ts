// Live proof of the media capture pipeline: the exact bytes-then-script
// sequence the Media screen performs (see app/project/[projectId]/media.tsx)
// against a real project — upload to itx.files, then one
// capabilityHost.runScript doing toMarkdown → vision transcript+tags →
// append. Also the repo's live proof that IMAGE input to itx.ai.toMarkdown
// works (the cf-ai-to-markdown example only exercises CSV/HTML and is
// e2eProven: false). The fixture (e2e/fixtures/ticket.png) renders "Train to
// Florence / Seat 21A", so the transcript assertion is a real full-text OCR
// check, not just shape.
//
//   doppler run --config dev -- pnpm --dir apps/mobile test:e2e   # local dev (pnpm dev must be running)

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { connectItx } from "iterate/node";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import {
  buildProcessScript,
  MEDIA_CAPTURED_EVENT_TYPE,
  MEDIA_EVENT_TYPES,
  MEDIA_PROCESSED_EVENT_TYPE,
  mediaFilePath,
} from "../src/lib/media.ts";
import { portlessOrigin, requireEnv, resolveBaseUrl } from "./e2e-helpers.ts";

test("media capture: bytes → description → transcript+tags → captured event, idempotently; re-analyze overlays", async () => {
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

  // The screen's exact sequence: hash → put bytes → runScript.
  const png = readFileSync(resolve(import.meta.dirname, "fixtures/ticket.png"));
  const base64 = png.toString("base64");
  const stableKey = createHash("sha256").update(base64).digest("hex");
  const filename = "media-e2e-ticket.png";
  await project.files
    .get(mediaFilePath(stableKey, filename))
    .put({ data: new Uint8Array(png), contentType: "image/png" });

  const captureScript = buildProcessScript({
    stableKey,
    filename,
    contentType: "image/png",
    width: 280,
    height: 110,
    source: "picker",
    capturedAt: null,
    isScreenshot: null,
    mode: "capture",
  });
  const execution = await project.capabilityHost.runScript(captureScript);
  const event: any = execution.result;

  expect(event).toMatchObject({
    type: MEDIA_CAPTURED_EVENT_TYPE,
    offset: expect.any(Number),
    payload: {
      stableKey,
      filename,
      contentType: "image/png",
      processedBy: expect.stringContaining("@cf/"),
    },
  });
  // The vision models actually read the image: the description says
  // SOMETHING, and the transcript contains the rendered ticket text.
  expect(event.payload.markdown.length).toBeGreaterThan(0);
  expect(event.payload.transcript.toLowerCase()).toContain("florence");
  expect(Array.isArray(event.payload.tags)).toBe(true);

  // Re-running the same capture (retry, re-pick) must return the SAME event.
  const rerun = await project.capabilityHost.runScript(captureScript);
  expect(rerun.result).toMatchObject({ offset: event.offset });

  // Re-analyze appends a processed event the list derivation overlays.
  const reprocess = await project.capabilityHost.runScript(
    buildProcessScript({
      stableKey,
      filename,
      contentType: "image/png",
      width: 280,
      height: 110,
      source: "picker",
      capturedAt: null,
      isScreenshot: null,
      mode: { reprocessNonce: "e2e-1" },
    }),
  );
  expect(reprocess.result).toMatchObject({ type: MEDIA_PROCESSED_EVENT_TYPE });

  // The list read the screen performs sees one capture + one reprocess.
  const events = await project.streams.get("/media").getEvents({ eventTypes: MEDIA_EVENT_TYPES });
  expect(events.map((entry: any) => entry.type)).toEqual([
    MEDIA_CAPTURED_EVENT_TYPE,
    MEDIA_PROCESSED_EVENT_TYPE,
  ]);
});
