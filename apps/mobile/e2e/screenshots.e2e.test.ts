// Live proof of the screenshot capture pipeline: the exact bytes-then-script
// sequence the Screenshots screen performs (see
// app/project/[projectId]/screenshots.tsx) against a real project — upload to
// itx.files, then one capabilityHost.runScript doing toMarkdown → tag →
// append. Also the repo's first live proof that IMAGE input to
// itx.ai.toMarkdown works (the cf-ai-to-markdown example only exercises
// CSV/HTML and is e2eProven: false).
//
//   doppler run --config dev -- pnpm --dir apps/mobile test:e2e   # local dev (pnpm dev must be running)

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { connectItx } from "iterate/node";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import {
  buildCaptureScript,
  SCREENSHOT_CAPTURED_EVENT_TYPE,
  screenshotFilePath,
} from "../src/lib/screenshots.ts";
import { portlessOrigin, requireEnv, resolveBaseUrl } from "./e2e-helpers.ts";

// 64x64 solid red PNG — small enough to inline, big enough for Cloudflare's
// image pipeline to describe.
const RED_SQUARE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwMqpfz0TMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj13zk8EPp8weQAAAAABJRU5ErkJggg==";

test("screenshot capture: bytes → toMarkdown description → tags → captured event, idempotently", async () => {
  const baseUrl = resolveBaseUrl();

  using adminSession = connectItx({
    baseUrl,
    auth: { type: "admin-secret", secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET") },
  });
  const slug = `mobile-screenshots-e2e-${Date.now().toString(36)}`;
  const created = await adminSession.projects.get(slug).create({});
  const { projectId } = await created.__describe();

  const token = await mintForgedAccessToken({
    forgePrivateJwk: requireEnv("AUTH_FORGE_ES256_PRIVATE_JWK"),
    issuer: requireEnv("APP_CONFIG_ITERATE_AUTH__ISSUER"),
    audience: process.env.APP_CONFIG_ITERATE_AUTH__RESOURCE?.trim() || portlessOrigin(baseUrl),
    email: "mobile-screenshots-e2e@nustom.com",
    admin: true,
  });
  using project = connectItx({ baseUrl, auth: { type: "bearer", token }, projectId });

  // The screen's exact sequence: hash → put bytes → runScript.
  const bytes = Buffer.from(RED_SQUARE_BASE64, "base64");
  const stableKey = createHash("sha256").update(RED_SQUARE_BASE64).digest("hex");
  const filename = "screenshot-e2e.png";
  await project.files
    .get(screenshotFilePath(stableKey, filename))
    .put({ data: new Uint8Array(bytes), contentType: "image/png" });

  const script = buildCaptureScript({
    stableKey,
    filename,
    contentType: "image/png",
    width: 64,
    height: 64,
  });
  const execution = await project.capabilityHost.runScript(script);
  const event: any = execution.result;

  expect(event).toMatchObject({
    type: SCREENSHOT_CAPTURED_EVENT_TYPE,
    offset: expect.any(Number),
    payload: {
      stableKey,
      filename,
      contentType: "image/png",
      taggedBy: expect.stringContaining("@cf/"),
    },
  });
  // The vision model wrote SOMETHING about the image, and the tagger
  // returned at least one tag ("untagged" would still satisfy this — the
  // pipeline surviving end-to-end is what's under test, not model quality).
  expect(event.payload.markdown).toEqual(expect.any(String));
  expect(event.payload.markdown.length).toBeGreaterThan(0);
  expect(event.payload.tags.length).toBeGreaterThan(0);

  // Re-running the same capture (retry, re-pick) must return the SAME event.
  const rerun = await project.capabilityHost.runScript(script);
  expect(rerun.result).toMatchObject({ offset: event.offset });

  // And the list read the screen performs sees exactly one capture.
  const events = await project.streams
    .get("/screenshots")
    .getEvents({ eventTypes: [SCREENSHOT_CAPTURED_EVENT_TYPE] });
  expect(events).toHaveLength(1);
});
