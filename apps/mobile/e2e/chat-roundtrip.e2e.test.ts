// Live chat round-trip through the app's own client modules, from Node.
//
// This drives the EXACT seam the phone uses — dialItx (itx-core.ts) over a
// real capnweb WebSocket with a bearer token, the /agents/mobile/<ts> new-chat
// convention, a live stream subscription like the thread screen's, and the
// chat reducer — against whatever deployment the ambient environment points
// at. Run it like the other e2e lanes:
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

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { newWebSocketRpcSession } from "capnweb";
import { mintForgedAccessToken } from "../../../scripts/auth/forge-token.ts";
import type { StreamEvent, StreamEventBatch, UnauthenticatedOs } from "../../os/src/types.ts";
import {
  ASSISTANT_MESSAGE_TYPE,
  mergeEventsByOffset,
  newMobileAgentPath,
  reduceChatEvents,
} from "../src/lib/chat.ts";
import { base64ToUint8Array } from "../src/lib/encoding.ts";
import { reduceFeed } from "../src/lib/feed.ts";
import { dialItx } from "../src/lib/itx-core.ts";

test("phone client seam: new mobile chat gets a live agent reply", async () => {
  const baseUrl = resolveBaseUrl();

  // A throwaway project, created the same way the other e2e lanes do (the
  // admin handle may create projects; there is no projects.remove yet).
  const admin = newWebSocketRpcSession<UnauthenticatedOs>(wsUrl(baseUrl));
  const adminSession = await admin.authenticate({
    type: "admin-secret",
    secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET"),
  });
  const slug = `mobile-e2e-${Date.now().toString(36)}`;
  const created = await adminSession.projects.create({ slug });
  const { projectId } = await created.__describe();

  // The phone lane: bearer token over the app's own dial.
  const token = await mintForgedAccessToken({
    forgePrivateJwk: requireEnv("AUTH_FORGE_PRIVATE_JWK"),
    issuer: requireEnv("APP_CONFIG_ITERATE_AUTH__ISSUER"),
    audience: process.env.APP_CONFIG_ITERATE_AUTH__RESOURCE?.trim() || portlessOrigin(baseUrl),
    email: "mobile-e2e@nustom.com",
    admin: true,
  });
  const session = await dialItx(baseUrl, async () => token);
  const project = await session.projects.get(projectId);

  // Live subscription first — the thread screen's lane — so we observe the
  // whole conversation as server pushes, not just the final read.
  const agentPath = newMobileAgentPath(new Date());
  const stream = project.streams.get(agentPath);
  let pushed: StreamEvent[] = [];
  const subscription = await stream.subscribe({
    replayAfterOffset: 0,
    processEventBatch: (batch: StreamEventBatch) => {
      pushed = mergeEventsByOffset(pushed, batch.events);
    },
  });
  expect(await subscription.ping()).toBe(true);

  // Sending the first message IS chat creation (lazy agent seeding).
  const agent = project.agents.get(agentPath);
  const sent = await agent.sendMessage(
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

  subscription.unsubscribe();
});

/** 1x1 transparent PNG. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * Deployed targets set APP_CONFIG_BASE_URL in Doppler; a local dev server
 * runs on a random port and publishes itself to the discovery file instead
 * (apps/os/scripts/lib/dev-server-info.ts).
 */
function resolveBaseUrl(): string {
  const fromEnv = process.env.APP_CONFIG_BASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const discoveryFile = resolve(import.meta.dirname, "../../os/.dev-server/dev-server.json");
  if (existsSync(discoveryFile)) {
    const info = JSON.parse(readFileSync(discoveryFile, "utf8")) as { baseUrl?: string };
    if (info.baseUrl) return info.baseUrl;
  }
  throw new Error(
    "No target deployment: set APP_CONFIG_BASE_URL (doppler config for a deployed env) " +
      "or start the local dev server (`pnpm dev start --detach`).",
  );
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required — run under a Doppler config for the target deployment, e.g. ` +
        `doppler run --config dev -- pnpm --dir apps/mobile test:e2e`,
    );
  }
  return value;
}

function wsUrl(baseUrl: string): string {
  const url = new URL("/api", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * The RFC 8707 resource for an OS deployment — port-stripped loopback for
 * local dev, matching the auth worker's audience list. Mirrors osResource()
 * in src/lib/auth.ts (which is welded to expo imports).
 */
function portlessOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return `http://${url.hostname}`;
  }
  return url.origin;
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
