// The live-state channel over the real deployment transport.
// `.liveState.subscribe` pushes a full snapshot then minimal diffs; this
// exercises both cases the primitive supports — a Durable-Object-backed node
// (`itx.liveState`, whose demo counter is shared across watchers) and a
// stateless one (`itx.liveDemo.ticker`, driven by a timer in the request
// isolate with no DO).
import { expect, test } from "vitest";
import { applyPatch, type LiveUpdate } from "iterate/sdk/capnweb";
import type { ProjectLiveState } from "../../src/domains/projects/project-live-state.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);

test("itx.liveState pushes a snapshot then a minimal diff; the DO-backed counter is shared", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`live-state-${RUN_SUFFIX}-${marker}`).create({});
  await project.__describe();

  const track = trackLiveState<ProjectLiveState>();
  using subscription = await project.liveState.subscribe(track.onUpdate);

  // The subscribe-time frame is a full snapshot: current state IS the first paint.
  await waitForCondition(() => track.state() !== undefined, {
    description: "the initial live snapshot",
  });
  expect(track.state()!.liveDemo).toMatchObject({ count: expect.any(Number) });
  const before = track.state()!.liveDemo.count;

  // Bumping the DO-backed counter arrives as a PATCH (not a re-snapshot) and only
  // moves the liveDemo slice — the processor's `reduced` slice is untouched.
  await project.liveDemo.increment();
  await waitForCondition(() => (track.state()?.liveDemo.count ?? before) > before, {
    description: "a patch reflecting the incremented counter",
    timeoutMs: 30_000,
  });
  expect(track.patchCount()).toBeGreaterThan(0);
  expect(track.state()!.liveDemo).toMatchObject({ count: before + 1 });

  // ping() reports liveness — the lever the dashboard watchdog uses — and it
  // flips false ONCE UNSUBSCRIBED, over the real wire: a ping that kept
  // answering true for a closed subscription would leave every watchdog
  // believing a dead channel was live. (This assertion carried over from the
  // deleted processor-reactivity e2e.)
  expect(await subscription.ping()).toBe(true);
  await subscription.unsubscribe();
  expect(await subscription.ping()).toBe(false);

  // …and a closed subscription no longer delivers: the counter moves, the
  // tracked state does not.
  const closedAt = track.state()!.liveDemo.count;
  await project.liveDemo.increment();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(track.state()!.liveDemo).toMatchObject({ count: closedAt });
});

test("itx.liveDemo.ticker (stateless, no Durable Object) advances over time", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`live-ticker-${RUN_SUFFIX}-${marker}`).create({});
  await project.__describe();

  const track = trackLiveState<{ tick: number; startedAt: number }>();
  using subscription = await project.liveDemo.ticker.subscribe(track.onUpdate);

  await waitForCondition(() => (track.state()?.tick ?? 0) >= 2, {
    description: () => `the stateless ticker to reach tick >= 2 (at ${track.state()?.tick ?? 0})`,
    timeoutMs: 15_000,
  });
  expect(track.patchCount()).toBeGreaterThan(0); // it advanced via diffs, not re-snapshots
  expect(await subscription.ping()).toBe(true);
});

test("itx.liveState indexes stream activity as a peer slice", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`live-index-${RUN_SUFFIX}-${marker}`).create({});
  await project.__describe();

  const track = trackLiveState<ProjectLiveState>();
  using subscription = await project.liveState.subscribe(track.onUpdate);
  await waitForCondition(() => track.state() !== undefined, {
    description: "the initial snapshot",
  });

  // Appending to a new stream flows through processEventBatch → the streams
  // index (a peer slice of itx.liveState, nothing to do with the processor fold).
  const streamPath = `/e2e/live-index/${marker}`;
  await project.streams.get(streamPath).append({
    type: "events.iterate.test/live-index",
    payload: { marker },
  });
  await waitForCondition(() => track.state()?.streamsIndex?.[streamPath] !== undefined, {
    description: () =>
      `the new stream in the index (have ${Object.keys(track.state()?.streamsIndex ?? {}).length})`,
    timeoutMs: 30_000,
  });
  expect(track.state()!.streamsIndex[streamPath]).toMatchObject({
    path: streamPath,
    eventCount: expect.any(Number),
    lastActivityAt: expect.any(String),
  });
  expect(await subscription.ping()).toBe(true);
});

// Stream liveState rides the hibernatable liveState socket
// (domains/live-state-socket.ts): the worker relay seeds itself from the
// socket's first frame and then receives `{"type":"state"}` frames — no
// retained subscription pins the Stream DO. Same public LiveStateRpc
// contract; this proves updates flow end-to-end through the socket-fed
// relay engine.
test("stream.liveState pushes updates through the state socket without a DO-side subscription", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`stream-live-${RUN_SUFFIX}-${marker}`).create({});
  const streamPath = `/e2e/stream-live/${marker}`;
  using stream = project.streams.get(streamPath);
  const [first] = await stream.append({
    type: "events.iterate.test/live/tick",
    payload: { round: 1 },
  });

  const track = trackLiveState<{ coreProcessorState: { maxOffset: number } }>();
  using subscription = await stream.liveState.subscribe(track.onUpdate);

  await waitForCondition(() => track.state() !== undefined, {
    description: "the initial stream runtime snapshot",
  });
  expect(track.state()!.coreProcessorState.maxOffset).toBeGreaterThanOrEqual(first!.offset);

  const [second] = await stream.append({
    type: "events.iterate.test/live/tick",
    payload: { round: 2 },
  });
  await waitForCondition(
    () => (track.state()?.coreProcessorState.maxOffset ?? 0) >= second!.offset,
    {
      description: "a state-socket-fed update reflecting the new append",
      timeoutMs: 30_000,
    },
  );
  expect(await subscription.ping()).toBe(true);
});

// Secret liveState rides the socket lane too — as a KEYED facet lane on the
// secret STREAM Durable Object (the secret processor is facet-hosted; see
// facetProcessorLiveStateRelay and the stream DO's facet lanes): pushed
// DESCRIPTION updates — never material — flow without a DO-side retained
// subscription.
test("secret.liveState pushes description updates through the liveState socket", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`secret-live-${RUN_SUFFIX}-${marker}`).create({});
  using secret = project.secrets.get(`/secrets/live/${marker}`);
  await secret.create({ egress: { urls: ["https://one.example"] }, material: "material-1" });

  const track = trackLiveState<{ hasMaterial: boolean; egress: { urls: string[] } }>();
  using subscription = await secret.liveState.subscribe(track.onUpdate);
  await waitForCondition(() => track.state() !== undefined, {
    description: "the initial secret description snapshot",
  });
  expect(track.state()).toMatchObject({ hasMaterial: true, egress: { urls: expect.any(Array) } });
  expect(JSON.stringify(track.state())).not.toContain("material-1");

  await secret.update({ egress: { urls: ["https://two.example"] }, material: "material-2" });
  await waitForCondition(
    () => track.state()?.egress.urls.includes("https://two.example") === true,
    {
      description: "a pushed description update reflecting the new egress pin",
      timeoutMs: 30_000,
    },
  );
  expect(JSON.stringify(track.state())).not.toContain("material-2");
  expect(await subscription.ping()).toBe(true);
});

// The project/secret DO fetch lanes also serve user-influenced egress
// traffic, where a user script controls arbitrary headers. The lane header
// CLAIMS a request for the liveState lane outright — it must never continue
// to the egress lanes, so an internal-looking request cannot alias into a
// real outbound fetch. (The header is deliberately a plain marker, not a
// signed token: a script that composes a WebSocket upgrade with it watches
// its own project's liveState, which itx already serves it.)
test("a user egress request wearing the liveState lane header is claimed by the lane, never egressed", async () => {
  const marker = crypto.randomUUID().slice(0, 8);
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`lane-gate-${RUN_SUFFIX}-${marker}`).create({});
  await project.__describe();

  const claimed = await project.egress.fetch(
    new Request("https://live-state.internal/", {
      headers: { "x-iterate-live-state": "watch" },
    }),
  );
  expect(claimed).toMatchObject({ status: 400 });
  expect(await claimed.json()).toMatchObject({
    error: expect.stringContaining("WebSocket upgrades"),
  });
});

function trackLiveState<State>(): {
  onUpdate: (update: LiveUpdate<State>) => void;
  state: () => State | undefined;
  patchCount: () => number;
} {
  let state: State | undefined;
  let patches = 0;
  return {
    onUpdate: (update) => {
      if (update.type === "snapshot") state = update.state;
      else {
        patches += 1;
        state = applyPatch(state as State, update.patch);
      }
    },
    state: () => state,
    patchCount: () => patches,
  };
}
