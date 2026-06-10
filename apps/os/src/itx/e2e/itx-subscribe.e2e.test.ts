// itx stream subscriptions over Cap'n Web: the browser/Node reactivity seam.
// A callback crosses the session, the Stream DO pushes batches through the
// stateless worker, and the disposer tears the subscription down. This is
// the primitive the dashboard's live stream views are built on.

import { expect, test } from "vitest";
import { connectItx, type ItxClient } from "../client.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const PROJECT_SLUG = `itx-sub-e2e-${RUN_SUFFIX}`;
const STREAM_PATH = "/itx-e2e/subscribe";
const EVENT_TYPE = "events.iterate.test/itx/subscribe-e2e";

test("subscribe replays history, tails live appends, and unsubscribes", async () => {
  using itx = connectGlobal();
  const project = (await itx.projects.create({ slug: PROJECT_SLUG })) as { id: string };
  using projectItx = await itx.projects.get(project.id);

  const stream = projectItx.streams.get(STREAM_PATH);
  const before = `before-${RUN_SUFFIX}`;
  await stream.append({ type: EVENT_TYPE, payload: { marker: before } });

  // The callback lives in THIS Node process; batches are pushed to it.
  const seen: { marker: string; offset: number }[] = [];
  const subscription = await stream.subscribe(
    (batch) => {
      for (const event of batch.events) {
        seen.push({
          marker: (event.payload as { marker?: string }).marker ?? "",
          offset: event.offset,
        });
      }
    },
    { afterOffset: "start" },
  );

  const during = `during-${RUN_SUFFIX}`;
  await stream.append({ type: EVENT_TYPE, payload: { marker: during } });

  await waitFor(
    () => seen.some((e) => e.marker === before) && seen.some((e) => e.marker === during),
    `replay + live markers; saw ${JSON.stringify(seen)}`,
  );

  // Offsets are strictly ordered and dedupe-able — what the multiplexer
  // relies on to merge history reads with replayed batches.
  const offsets = seen.map((e) => e.offset);
  expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);

  await subscription.unsubscribe();
  const countAtUnsubscribe = seen.length;
  await stream.append({ type: EVENT_TYPE, payload: { marker: `after-${RUN_SUFFIX}` } });
  // No delivery should arrive after unsubscribe; give a misbehaving
  // subscription a moment to prove us wrong.
  await new Promise((resolve) => setTimeout(resolve, 750));
  expect(seen.length).toBe(countAtUnsubscribe);
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function connectGlobal(): ItxClient {
  return connectItx({ baseUrl: baseUrl(), token: adminApiSecret() });
}

function adminApiSecret() {
  const secret =
    process.env.OS_E2E_ADMIN_API_SECRET?.trim() ||
    process.env.OS_ADMIN_API_SECRET?.trim() ||
    process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() ||
    "";
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required for itx e2e tests.");
  return secret;
}

function baseUrl() {
  const url =
    process.env.OS_ITX_E2E_BASE_URL?.trim().replace(/\/+$/, "") ||
    process.env.APP_CONFIG_BASE_URL?.trim().replace(/\/+$/, "") ||
    "";
  if (!url) throw new Error("APP_CONFIG_BASE_URL (or OS_ITX_E2E_BASE_URL) is required.");
  return url;
}
