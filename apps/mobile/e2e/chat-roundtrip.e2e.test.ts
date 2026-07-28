// Live chat round-trip through the app's own client modules, from Node.
//
// This drives the shared iterate client over a real capnweb WebSocket with a
// bearer token, the /agents/mobile/<ts> new-chat convention, a live stream
// connection like the thread screen's, and the chat reducer — against
// whatever deployment the ambient environment points at.
//
//   doppler run --config dev -- pnpm --dir apps/mobile test:e2e   # local dev (pnpm dev must be running)
//   doppler run --config preview_3 -- pnpm --dir apps/mobile test:e2e
//
// Credentials: the interactive PKCE browser flow is inherently on-device, so
// the bearer here is a forge-minted access token (same trust path as
// `pnpm auth:mint`; the deployment's baked JWKS carries the forge public key).
// Minted with admin=true — project-claims policy is the auth worker's job and
// is exercised by the real sign-in on the phone; this lane proves transport,
// event shapes, live push, and reducer.

import { expect, test } from "vitest";
import { type RpcStub } from "capnweb";
import { connectItx, type Agent, type StreamEvent, type StreamEventBatch } from "iterate/node";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import {
  ASSISTANT_MESSAGE_TYPE,
  mergeEventsByOffset,
  newMobileAgentPath,
  reduceChatEvents,
} from "../src/lib/chat.ts";
import { base64ToUint8Array } from "../src/lib/encoding.ts";
import { reduceFeed } from "../src/lib/feed.ts";
import { portlessOrigin, requireEnv, resolveBaseUrl } from "./e2e-helpers.ts";

test("phone client seam: new mobile chat gets a live agent reply", async () => {
  const baseUrl = resolveBaseUrl();

  // A throwaway project, created the same way the other e2e lanes do (the
  // admin handle may create projects; there is no projects.remove yet).
  using adminSession = connectItx({
    baseUrl,
    auth: {
      type: "admin-secret",
      secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET"),
    },
  });
  const slug = `mobile-e2e-${Date.now().toString(36)}`;
  const created = await adminSession.projects.get(slug).create({});
  const { projectId } = await created.__describe();

  // The phone lane: bearer token over the app's own dial.
  const token = await mintForgedAccessToken({
    forgePrivateJwk: requireEnv("AUTH_FORGE_PRIVATE_JWK"),
    issuer: requireEnv("APP_CONFIG_ITERATE_AUTH__ISSUER"),
    audience: process.env.APP_CONFIG_ITERATE_AUTH__RESOURCE?.trim() || portlessOrigin(baseUrl),
    email: "mobile-e2e@nustom.com",
    admin: true,
  });
  using project = connectItx({ baseUrl, auth: { type: "bearer", token }, projectId });

  // Open the thread screen's live connection first so we observe the
  // whole conversation as server pushes, not just the final read.
  const agentPath = newMobileAgentPath(new Date());
  const stream = project.streams.get(agentPath);
  let pushed: StreamEvent[] = [];
  using connection = await stream.openConnection({
    replayAfterOffset: 0,
    processEventBatch: (batch: StreamEventBatch) => {
      pushed = mergeEventsByOffset(pushed, batch.events);
    },
  });
  expect(await connection.ping()).toBe(true);

  // Stream processor births are explicit: create() before the first
  // message, same as the dashboard's new-chat page and the app's own send
  // mutation (chat.tsx).
  const agent = project.agents.get(agentPath) as RpcStub<Agent>;
  await agent.create();
  const sent = await agent.message(
    "Reply with a short greeting. Do not run any code or take any other action.",
  );
  expect(sent).toMatchObject({ offset: expect.any(Number) });

  const reply = await agent.stream.waitForEvent({
    afterOffset: sent.offset,
    eventTypes: [ASSISTANT_MESSAGE_TYPE],
    timeoutMs: 120_000,
  });
  expect(reply).toMatchObject({ type: ASSISTANT_MESSAGE_TYPE });

  // What the chat screen would render from the full stream.
  const events = await agent.stream.getEvents({});
  const thread = reduceChatEvents(events);
  expect(thread).toMatchObject({
    working: false,
    messages: [
      { role: "user", text: expect.stringContaining("short greeting") },
      { role: "assistant", text: expect.any(String) },
    ],
  });
  expect(thread.messages[1]!.text.length).toBeGreaterThan(0);

  // The subscription saw the same conversation as live pushes.
  await waitFor(
    () => reduceChatEvents(pushed).messages.length >= 2,
    "live subscription to deliver both messages",
  );

  // Image attachment, exactly as the phone composer sends it: one addFiles
  // call with bytes over the same socket → one input event with a signed url.
  const { files } = await agent.addFiles({
    files: [{ contentType: "image/png", data: base64ToUint8Array(TINY_PNG), filename: "e2e.png" }],
    message: "What's in this image? Reply in one short sentence, no code.",
  });
  expect(files).toMatchObject([
    {
      contentType: "image/png",
      filename: "e2e.png",
      url: expect.stringMatching(/^https?:\/\//),
      size: expect.any(Number),
    },
  ]);

  // The signed URL serves the exact bytes back without auth.
  const served = await fetch(files[0]!.url);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toContain("image/png");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(base64ToUint8Array(TINY_PNG));

  // The feed reduction the phone renders picks the attachment up.
  const feed = reduceFeed(agentPath, await agent.stream.getEvents({}));
  const withFiles = feed.items.find(
    (item) => item.kind === "user" && (item.files?.length || 0) > 0,
  );
  expect(withFiles).toMatchObject({
    kind: "user",
    files: [{ filename: "e2e.png", contentType: "image/png" }],
  });

  connection.close();
});

/** 1x1 transparent PNG. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
