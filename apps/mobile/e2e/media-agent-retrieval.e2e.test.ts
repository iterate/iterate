// Reconstructs the real dogfood thread that motivated agent-discoverable
// media (a captured swimming-lesson email screenshot the agent could not
// find): capture three fake screenshots — the lesson email plus two decoys —
// then retrieve through the SAME door an agent uses, the media-search
// catalogue example run via capabilityHost.runScript. Proves the whole
// chain: upload → server-side analysis (the seeded MediaApp processor) →
// OCR transcript → example discoverable in the catalogue → keyword search
// finds the right item with a usable answer.
//
//   doppler run --config dev -- pnpm --dir apps/mobile test:e2e   # local dev (pnpm dev must be running)

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mediaWorkerRef } from "iterate/starter-apps/media/ref";
import { interceptor } from "@iterate-com/test-support";
import { expect, test } from "vitest";
import { connectItx } from "iterate/node";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import { phoneRunnableExamples } from "../src/lib/examples.ts";
import { buildUploadedEvent, MEDIA_PROCESSED_EVENT_TYPE, mediaFilePath } from "../src/lib/media.ts";
import { portlessOrigin, requireEnv, resolveBaseUrl } from "./e2e-helpers.ts";

const FIXTURES = ["swim-email.png", "decoy-receipt.png", "decoy-code.png"];

test("an agent-style media-search run finds the swimming lesson among decoys", async () => {
  const baseUrl = resolveBaseUrl();

  using adminSession = connectItx({
    baseUrl,
    auth: { type: "admin-secret", secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET") },
  });
  const slug = `mobile-media-agent-e2e-${Date.now().toString(36)}`;
  const created = await interceptor.createProject(adminSession.projects.get(slug));
  const { projectId } = await created.__describe();

  const token = await mintForgedAccessToken({
    forgePrivateJwk: requireEnv("AUTH_FORGE_ES256_PRIVATE_JWK"),
    issuer: requireEnv("APP_CONFIG_ITERATE_AUTH__ISSUER"),
    audience: process.env.APP_CONFIG_ITERATE_AUTH__RESOURCE?.trim() || portlessOrigin(baseUrl),
    email: "mobile-media-agent-e2e@nustom.com",
    admin: true,
  });
  using project = connectItx({ baseUrl, auth: { type: "bearer", token }, projectId });
  await (project.workers.get(mediaWorkerRef) as any).configure({
    model: "intercepted/@cf/meta/llama-4-scout-17b-16e-instruct",
    markdownModel: "intercepted/cloudflare/to-markdown",
  });

  let analyzing = "";
  const transcripts: Record<string, string> = {
    "swim-email.png": "Swimming lesson Tuesday at 4:30",
    "decoy-receipt.png": "Coffee receipt: paid £4",
    "decoy-code.png": "Terminal: pnpm test passed",
  };
  using _ai = await interceptor.intercept(project, (call) => {
    if (call.source === "agent-turn") return interceptor.noOpAgent(call);
    const transcript = transcripts[analyzing];
    if (!transcript) throw new Error(`No scripted media response for ${analyzing}`);
    if (call.model === "intercepted/cloudflare/to-markdown") {
      return Response.json({ format: "markdown", data: transcript });
    }
    expect(call).toMatchObject({
      source: "ai-run",
      model: "intercepted/@cf/meta/llama-4-scout-17b-16e-instruct",
    });
    return Response.json({ response: JSON.stringify({ title: analyzing, transcript, tags: [] }) });
  });

  // Capture all three the way the Media screen does: bytes + one uploaded
  // event each; the seeded MediaApp processor analyzes server-side.
  const stream = project.streams.get("/media");
  const uploads: { stableKey: string; offset: number }[] = [];
  for (const filename of FIXTURES) {
    analyzing = filename;
    const png = readFileSync(resolve(import.meta.dirname, "fixtures", filename));
    const stableKey = createHash("sha256").update(png.toString("base64")).digest("hex");
    await project.files
      .get(mediaFilePath(stableKey, filename))
      .put({ data: new Uint8Array(png), contentType: "image/png" });
    const [uploaded] = await stream.append(
      buildUploadedEvent({
        wipeGeneration: 0,
        stableKey,
        filename,
        contentType: "image/png",
        width: 0,
        height: 0,
        source: "picker",
        capturedAt: null,
        isScreenshot: null,
      }),
    );
    uploads.push({ stableKey, offset: uploaded!.offset });
    // One scripted image at a time; selection is explicit, not a pretend vision model.
    await stream.waitForEvent({
      afterOffset: uploaded!.offset,
      eventTypes: [MEDIA_PROCESSED_EVENT_TYPE],
      predicate: (event: any) =>
        event.payload.stableKey === stableKey && event.payload.error === null,
      timeoutMs: 120_000,
    });
  }
  // Search needs the transcripts: wait for every item's analysis settlement.
  for (const upload of uploads) {
    const processed: any = await stream.waitForEvent({
      afterOffset: Math.min(...uploads.map((entry) => entry.offset)),
      eventTypes: [MEDIA_PROCESSED_EVENT_TYPE],
      predicate: (event: any) =>
        event.payload.stableKey === upload.stableKey && event.payload.error === null,
      timeoutMs: 120_000,
    });
    expect(processed.payload).toMatchObject({
      stableKey: upload.stableKey,
      processedBy: "intercepted/@cf/meta/llama-4-scout-17b-16e-instruct",
    });
  }

  // Retrieval through the agent door: the media-search catalogue example,
  // exactly as the Examples screen / an agent script would run it.
  const example = phoneRunnableExamples().find((candidate) => candidate.id === "media-search");
  expect(example).toBeDefined();
  const execution = await project.capabilityHost.runScript(
    `async (itx) => {\nconst vars = { query: "swimming" };\n${example!.code}\n}`,
  );
  const hits = execution.result as {
    filename: string;
    transcript: string;
    description: string;
    url: string;
  }[];

  // Exactly the lesson email — the receipt and terminal decoys must not match.
  expect(hits.map((hit) => hit.filename)).toEqual(["swim-email.png"]);
  // And the answer to "when is the swimming lesson?" is in the transcript.
  expect(hits[0].transcript.toLowerCase()).toMatch(/4:30|tuesday/);
  expect(hits[0].url).toMatch(/^https?:\/\//);
});
