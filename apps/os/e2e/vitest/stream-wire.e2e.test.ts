// Wire-level guarantees of the stream delivery lanes (streams README, R2):
// during warm delivery, frames flow stream→subscriber ONLY. An ephemeral
// subscription's batch results are disposed unpulled by the stream, so the
// subscriber side originates ZERO frames while batches flow — no acks, no
// resolves, nothing. This is what keeps append→delivered latency flat under
// load (voice rides this lane) and it is exactly the property a ReadableStream
// transport could never have (its per-chunk acks ARE its flow control).
//
// These tests resurrect the "delivers event batches without
// subscriber-originated return traffic" guard that lived in the old
// packages/streams example app and died in the #1525 move. They record the
// subscriber session's decoded WebSocket frames via the client's
// onWebSocketMessage tap and assert directions, not payload internals — the
// contract is directional silence, not a specific protocol encoding.

import { expect, test } from "vitest";
import { appendEvents } from "../test-support/append-events.ts";
import { adminSecret, withItxSession, type ItxWebSocketMessage } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const EVENT_TYPE = "events.iterate.test/wire/probe";

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("ephemeral live delivery originates zero subscriber-side frames", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/wire/one-way-${marker}`;

  // Publisher: its own session, so its append traffic can never be mistaken
  // for subscriber-originated frames on the tapped session below.
  using publisherSession = withItxSession();
  using publisherItx = publisherSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = publisherItx.projects.create({
    slug: `wire-${RUN_SUFFIX}-${marker.slice(0, 8)}`,
  });
  const { projectId } = await project.__describe();

  // Subscriber: a separate session with every decoded ws frame recorded.
  const frames: ItxWebSocketMessage[] = [];
  using subscriberProject = withItxSession({
    auth: { type: "admin-secret", secret: adminSecret() },
    projectId,
    onWebSocketMessage: (message) => frames.push(message),
  });

  const receivedOffsets: number[] = [];
  const handle = await subscriberProject.streams.get(streamPath).subscribe({
    replayAfterOffset: 0,
    processEventBatch: (batch) => {
      receivedOffsets.push(...batch.events.map((event) => event.offset));
    },
  });

  // Let the subscribe handshake and the immediate first batch fully settle,
  // then draw the line: everything after this point is live delivery.
  await waitFor(() => receivedOffsets.length > 0, 15_000, "initial replay batch");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const liveDeliveryStartsAt = frames.length;

  const appended = await appendEvents(
    project.streams.get(streamPath),
    { type: EVENT_TYPE, payload: { n: 1 } },
    { type: EVENT_TYPE, payload: { n: 2 } },
    { type: EVENT_TYPE, payload: { n: 3 } },
  );
  const lastOffset = appended.at(-1)!.offset;
  await waitFor(() => receivedOffsets.includes(lastOffset), 15_000, "live batch delivery");

  const liveFrames = frames.slice(liveDeliveryStartsAt);
  const outbound = liveFrames.filter(([, direction]) => direction === "out");
  const inbound = liveFrames.filter(([, direction]) => direction === "in");

  // The load-bearing assertion: batches arrived (inbound frames exist) while
  // the subscriber sent NOTHING back. Delivery is fire-and-forget push; the
  // stream disposes each batch result unpulled, so no resolve/ack ever needs
  // to travel subscriber→stream.
  expect(inbound.length).toBeGreaterThan(0);
  expect(outbound).toEqual([]);

  handle.unsubscribe();
});

test("warm ephemeral delivery latency: measure and bound append→delivered", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/wire/latency-${marker}`;
  const SAMPLES = 20;

  using publisherSession = withItxSession();
  using publisherItx = publisherSession.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = publisherItx.projects.create({
    slug: `wire-lat-${RUN_SUFFIX}-${marker.slice(0, 8)}`,
  });
  const { projectId } = await project.__describe();

  using subscriberProject = withItxSession({
    auth: { type: "admin-secret", secret: adminSecret() },
    projectId,
  });

  const arrivedAt = new Map<number, number>();
  const handle = await subscriberProject.streams.get(streamPath).subscribe({
    processEventBatch: (batch) => {
      const now = performance.now();
      for (const event of batch.events) {
        if (!arrivedAt.has(event.offset)) arrivedAt.set(event.offset, now);
      }
    },
  });
  // Warm the whole path (stream DO resident, connection pump primed) before sampling.
  await project.streams.get(streamPath).append({ type: EVENT_TYPE, payload: { warmup: true } });
  await waitFor(() => arrivedAt.size > 0, 15_000, "warmup delivery");

  const deltas: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const sentAt = performance.now();
    const [event] = await appendEvents(project.streams.get(streamPath), {
      type: EVENT_TYPE,
      payload: { sample },
    });
    const offset = event!.offset;
    await waitFor(() => arrivedAt.has(offset), 15_000, `delivery of sample ${sample}`);
    deltas.push(arrivedAt.get(offset)! - sentAt);
  }
  handle.unsubscribe();

  const sorted = [...deltas].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  // Report for the PR/regression tracking; the number includes one client→
  // server append round trip plus the push leg, so it measures the whole
  // user-observable path, not just the in-DO fan-out.
  console.log(
    `stream wire latency (append call → batch delivered, ${SAMPLES} samples): p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
  );
  // Loose CI bound: the in-DO fan-out budget is single-digit ms (asserted by
  // design; see streams README), but from a test runner this path crosses the
  // network twice. Catch regressions to seconds-scale, not ms jitter.
  expect(p50).toBeLessThan(1_000);
});
