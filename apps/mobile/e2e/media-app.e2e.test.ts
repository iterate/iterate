// Live proof of the userland MediaApp: a fresh project's seeded config
// worker fans /media events into the packaged app, and both query doors
// answer — the worker RPC directly, and the itx.media capability the app
// mounts on project/worker-updated. Events are appended directly (no AI
// calls) so this exercises the processor/index machinery, not the vision
// pipeline (media.e2e.test.ts owns that).
//
//   doppler run --config dev -- pnpm --dir apps/mobile test:e2e   # local dev (pnpm dev must be running)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { connectItx } from "iterate/node";
import { mediaWorkerRef } from "iterate/starter-apps/media/ref";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import { MEDIA_CAPTURED_EVENT_TYPE, mediaFilePath } from "../src/lib/media.ts";
import { portlessOrigin, requireEnv, resolveBaseUrl } from "./e2e-helpers.ts";

test("the seeded MediaApp answers search over appended /media events, via worker RPC and itx.media", async () => {
  const baseUrl = resolveBaseUrl();

  using adminSession = connectItx({
    baseUrl,
    auth: { type: "admin-secret", secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET") },
  });
  const slug = `mobile-media-app-e2e-${Date.now().toString(36)}`;
  const created = await adminSession.projects.get(slug).create({});
  const { projectId } = await created.__describe();

  const token = await mintForgedAccessToken({
    forgePrivateJwk: requireEnv("AUTH_FORGE_ES256_PRIVATE_JWK"),
    issuer: requireEnv("APP_CONFIG_ITERATE_AUTH__ISSUER"),
    audience: process.env.APP_CONFIG_ITERATE_AUTH__RESOURCE?.trim() || portlessOrigin(baseUrl),
    email: "mobile-media-app-e2e@nustom.com",
    admin: true,
  });
  using project = connectItx({ baseUrl, auth: { type: "bearer", token }, projectId });

  // Store real bytes (search hits mint signed URLs) and append the captured
  // event the pipeline would have produced.
  const png = readFileSync(resolve(import.meta.dirname, "fixtures/ticket.png"));
  const stableKey = "e2e-media-app-fixture";
  const path = mediaFilePath(stableKey, "ticket.png");
  await project.files.get(path).put({ data: new Uint8Array(png), contentType: "image/png" });
  await project.streams.get("/media").append({
    type: MEDIA_CAPTURED_EVENT_TYPE,
    idempotencyKey: `media-captured-${stableKey}`,
    payload: {
      stableKey,
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
      processedBy: "e2e-fixture",
    },
  });

  // Door 1: the worker RPC — search catches up on the stream itself, so
  // this needs no fan-in to have happened yet.
  using worker = project.workers.get(mediaWorkerRef) as any;
  const hits = await worker.search({ q: "florence seat" });
  expect(hits).toMatchObject([
    { stableKey, tags: ["screenshot", "logistics"], url: expect.stringMatching(/^https?:\/\//) },
  ]);
  expect(await worker.get(stableKey)).toMatchObject({ filename: "ticket.png" });
  expect(await worker.search({ q: "florence", tags: ["receipt"] })).toEqual([]);

  // Door 2: the itx.media mount contract. The glue provides this on
  // project/worker-updated (unit-tested in the starter-app), but that
  // delivery can lag a fresh project by minutes in local dev — so this
  // performs the SAME provide the glue makes and asserts the mounted dotted
  // surface answers. Deterministic; the timing question is tracked in the
  // task file.
  await project.capabilityHost.runScript(
    `async (itx) => {
      return await itx.capabilityHosts.get("/").provideCapability({
        type: "itx-call",
        path: ["media"],
        expression: ["workers", ["get", ${JSON.stringify(mediaWorkerRef)}]],
        flattenNestedPaths: true,
        instructions: "e2e mount",
      });
    }`,
  );
  const mounted = await (project as any).media.search({ q: "florence" });
  expect(mounted).toMatchObject([{ stableKey }]);
});
