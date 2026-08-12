// Live proof of the userland NotesApp: the composer's exact append lands on
// a fresh project's /notes stream, the app's analysis OBLIGATION settles
// with a real model call (title/tags overlaid — this is the one lane that
// exercises itx.ai.run from inside a processor attempt, not a script), and
// both query doors answer — the worker RPC directly, and the itx.notes
// capability the glue mounts on project/worker-updated. Delete tombstones
// drop the note from search.
//
//   doppler run --config dev -- pnpm --dir apps/mobile test:e2e   # local dev (pnpm dev must be running)

import { expect, test } from "vitest";
import { connectItx } from "iterate/node";
import { notesWorkerRef } from "iterate/starter-apps/notes/ref";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import {
  buildCapturedEvent,
  buildDeletedEvent,
  NOTE_ANALYSIS_SETTLED_EVENT_TYPE,
  NOTES_STREAM_PATH,
} from "../src/lib/notes.ts";
import { portlessOrigin, requireEnv, resolveBaseUrl } from "./e2e-helpers.ts";

test(
  "the seeded NotesApp analyzes a captured note and answers search, via worker RPC and itx.notes",
  { timeout: 180_000 },
  async () => {
    const baseUrl = resolveBaseUrl();

    using adminSession = connectItx({
      baseUrl,
      auth: { type: "admin-secret", secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET") },
    });
    const slug = `mobile-notes-e2e-${Date.now().toString(36)}`;
    const created = await adminSession.projects.get(slug).create({});
    const { projectId } = await created.__describe();

    const token = await mintForgedAccessToken({
      forgePrivateJwk: requireEnv("AUTH_FORGE_ES256_PRIVATE_JWK"),
      issuer: requireEnv("APP_CONFIG_ITERATE_AUTH__ISSUER"),
      audience: process.env.APP_CONFIG_ITERATE_AUTH__RESOURCE?.trim() || portlessOrigin(baseUrl),
      email: "mobile-notes-e2e@nustom.com",
      admin: true,
    });
    using project = connectItx({ baseUrl, auth: { type: "bearer", token }, projectId });

    // The composer's exact append (components/note-composer.tsx) — no AI in
    // the capture path; the title arrives later as an obligation settlement.
    const noteKey = `e2e-${Date.now().toString(36)}`;
    const stream = project.streams.get(NOTES_STREAM_PATH);
    await stream.append(
      buildCapturedEvent({
        noteKey,
        text: "Standing desk height: 76cm was exactly right at the office",
        attachments: [],
        capturedOnDeviceAt: new Date().toISOString(),
      }),
    );

    // Door 1: the worker RPC. search() catches the processor up on the stream
    // itself, so the note is visible immediately — title pending or settled.
    using worker = project.workers.get(notesWorkerRef) as any;
    const immediate = await worker.search({ q: "standing desk" });
    expect(immediate).toMatchObject([{ noteKey }]);

    // The catch-up above started the analysis obligation; its settlement is a
    // durable stream fact. Poll for it (one real small-model call).
    const settled = await pollUntil(async () => {
      const events = await stream.getEvents({
        afterOffset: 0,
        eventTypes: [NOTE_ANALYSIS_SETTLED_EVENT_TYPE],
      });
      return events.find((event: any) => event.payload.noteKey === noteKey) || null;
    });
    expect(settled).toMatchObject({
      payload: {
        noteKey,
        result: { status: "succeeded", processedBy: expect.stringContaining("@cf/") },
      },
    });
    const analyzed = await worker.get(noteKey);
    expect(analyzed.title).not.toBe("");

    // Door 2: the itx.notes mount contract — same provide the glue makes on
    // project/worker-updated (which can lag a fresh project in local dev),
    // then the mounted dotted surface answers like an agent would call it.
    const viaItx = await project.capabilityHost.runScript(
      `async (itx) => {
      await itx.capabilityHosts.get("/").provideCapability({
        type: "itx-call",
        path: ["notes"],
        expression: ["workers", ["get", ${JSON.stringify(notesWorkerRef)}]],
        flattenNestedPaths: true,
        instructions: "e2e mount",
      });
      return await itx.notes.search({ q: "standing desk" });
    }`,
    );
    expect(viaItx.result).toMatchObject([{ noteKey, title: analyzed.title }]);

    // Long-press delete on the phone = this tombstone; the fold drops the note.
    await stream.append(buildDeletedEvent(noteKey));
    expect(await worker.search({ q: "standing desk" })).toEqual([]);
  },
);

async function pollUntil<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 120_000;
  while (true) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
