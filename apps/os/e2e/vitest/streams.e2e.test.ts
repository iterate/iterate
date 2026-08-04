// Public-seam stream behavior that is independent of subscription policy.
// Durable event sending, callback connections, cursor changes, retries, and
// cross-stream appends live together in stream-connections-and-subscriptions.e2e.test.ts.

import { expect, test } from "vitest";
import type { Stream } from "../../src/itx-api.generated.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

const RUN_SUFFIX = crypto.randomUUID().slice(0, 8);
const EVENT_TYPE = "events.iterate.test/streams/basic";

test("a project stream appends and reads events through the public capability", async () => {
  const marker = crypto.randomUUID();
  const streamPath = `/e2e/streams/basic/${marker}`;

  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`streams-${RUN_SUFFIX}-${marker}`).create({});
  const { projectId } = await project.__describe();
  using stream = project.streams.get(streamPath);

  const [appended] = await stream.append({ type: EVENT_TYPE, payload: { marker } });
  expect(appended).toMatchObject({
    offset: expect.any(Number),
    payload: { marker },
    type: EVENT_TYPE,
  });
  expect(await stream.getEvents({ afterOffset: appended!.offset - 1 })).toEqual(
    expect.arrayContaining([expect.objectContaining({ offset: appended!.offset })]),
  );
  expect(coreState(await stream.runtimeState())).toMatchObject({
    path: streamPath,
    projectId,
  });
});

test("readEvents pages a bounded window and getEvents filters by type", async () => {
  const marker = crypto.randomUUID();
  const selectedType = `${EVENT_TYPE}/selected`;
  const otherType = `${EVENT_TYPE}/other`;

  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`stream-reads-${RUN_SUFFIX}-${marker}`).create({});
  using stream = project.streams.get(`/e2e/streams/reads/${marker}`);

  const appended = await stream.append(
    ...Array.from({ length: 505 }, (_, index) => ({
      type: index % 2 === 0 ? selectedType : otherType,
      payload: { index, marker },
    })),
  );
  const afterOffset = appended[0]!.offset - 1;
  const beforeOffset = appended.at(-1)!.offset + 1;

  using pager = stream.readEvents({ afterOffset, beforeOffset });
  const firstPage = await pager.next();
  const secondPage = await pager.next();
  expect(firstPage).toHaveLength(500);
  expect(secondPage).toHaveLength(5);
  expect([...firstPage, ...secondPage].map((event) => event.offset)).toEqual(
    appended.map((event) => event.offset),
  );
  expect(await pager.next()).toEqual([]);

  const selected = await stream.getEvents({
    afterOffset,
    beforeOffset,
    eventTypes: [selectedType],
    limit: 300,
  });
  expect(selected).toHaveLength(253);
  expect(selected.every((event) => event.type === selectedType)).toBe(true);
  await expect(stream.getEvents({ limit: 501 })).rejects.toThrow("getEvents limit");
});

test("memory-only ephemeral events preserve offsets while normal reads omit them", async () => {
  const marker = crypto.randomUUID();
  const ephemeralType = `${EVENT_TYPE}/ephemeral`;

  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`stream-ephemeral-${RUN_SUFFIX}-${marker}`).create({});
  using stream = project.streams.get(`/e2e/streams/ephemeral/${marker}`);

  const [before] = await stream.append({
    type: EVENT_TYPE,
    payload: { marker, position: "before" },
  });
  const [ephemeral] = await stream.append({
    type: ephemeralType,
    ephemeral: true,
    payload: { marker },
  });
  const [after] = await stream.append({ type: EVENT_TYPE, payload: { marker, position: "after" } });

  expect(ephemeral).toMatchObject({ ephemeral: true, offset: before!.offset + 1 });
  expect(after!).toMatchObject({ offset: ephemeral!.offset + 1 });
  await expect(stream.getEvent({ offset: ephemeral!.offset })).resolves.toEqual(ephemeral);

  const window = { afterOffset: before!.offset - 1, beforeOffset: after!.offset + 1 };
  expect((await stream.getEvents(window)).map((event) => event.offset)).toEqual([
    before!.offset,
    after!.offset,
  ]);
  expect(
    (await stream.getEvents({ ...window, includeEphemeral: true })).map((event) => event.offset),
  ).toEqual([before!.offset, ephemeral!.offset, after!.offset]);
  const firstPage = await stream.getEventPage({
    ...window,
    includeEphemeral: true,
    limit: 2,
  });
  const secondPage = await stream.getEventPage({
    afterOffset: firstPage.events.at(-1)!.offset,
    beforeOffset: window.beforeOffset,
    includeEphemeral: true,
    limit: 2,
  });
  expect(firstPage.events.map((event) => event.offset)).toEqual([
    before!.offset,
    ephemeral!.offset,
  ]);
  expect(secondPage.events.map((event) => event.offset)).toEqual([after!.offset]);
  expect(firstPage).toMatchObject({ streamMaxOffset: after!.offset });
  expect(secondPage).toMatchObject({ streamMaxOffset: after!.offset });
  await expect(
    stream.append({
      type: "events.iterate.com/stream/paused",
      ephemeral: true,
      payload: { reason: "control facts must be durable" },
    }),
  ).rejects.toThrow(/cannot be ephemeral/);
});

test("an idempotency key on an ephemeral event rejects the whole append batch", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects
    .get(`stream-ephemeral-idempotency-${RUN_SUFFIX}-${marker}`)
    .create({});
  using stream = project.streams.get(`/e2e/streams/ephemeral-idempotency/${marker}`);

  const [before] = await stream.append({
    type: EVENT_TYPE,
    payload: { marker, position: "before" },
  });
  await expect(
    stream.append(
      {
        type: `${EVENT_TYPE}/ephemeral`,
        ephemeral: true,
        idempotencyKey: `invalid-ephemeral-${marker}`,
        payload: { marker },
      },
      {
        type: EVENT_TYPE,
        payload: { marker, position: "must-not-commit" },
      },
    ),
  ).rejects.toThrow("ephemeral events cannot have an idempotencyKey");

  const [after] = await stream.append({
    type: EVENT_TYPE,
    payload: { marker, position: "after" },
  });
  expect(after!).toMatchObject({ offset: before!.offset + 1 });
});

test("ephemeral events are forgotten after the stream Durable Object restarts", async () => {
  const marker = crypto.randomUUID();
  const ephemeralType = `${EVENT_TYPE}/ephemeral-restart`;

  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects
    .get(`stream-ephemeral-restart-${RUN_SUFFIX}-${marker}`)
    .create({});
  using stream = project.streams.get(`/e2e/streams/ephemeral-restart/${marker}`);

  const [ephemeral] = await stream.append({
    type: ephemeralType,
    ephemeral: true,
    payload: { marker },
  });

  await stream.kill().catch(() => undefined);

  expect(
    await stream.getEvents({
      afterOffset: ephemeral!.offset - 1,
      beforeOffset: ephemeral!.offset + 1,
      includeEphemeral: true,
    }),
  ).toEqual([]);
  await expect(stream.getEvent({ offset: ephemeral!.offset })).resolves.toBeUndefined();

  const [afterRestart] = await stream.append({
    type: EVENT_TYPE,
    payload: { marker, position: "after-restart" },
  });
  expect(afterRestart!.offset).toBeGreaterThan(ephemeral!.offset);
});

test("a stream killed during a call reports the retryable stream-unavailable tag", async () => {
  const marker = crypto.randomUUID();

  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`stream-kill-${RUN_SUFFIX}-${marker}`).create({});
  using stream = project.streams.get(`/e2e/streams/kill/${marker}`);

  const pendingCall = stream
    .waitForEvent({ eventTypes: [`${EVENT_TYPE}/never`], timeoutMs: 60_000 })
    .then(() => undefined)
    .catch((error: unknown) => error);
  await waitForWaitForEventConnection(stream);
  await stream.kill().catch(() => undefined);

  const rejection = await pendingCall;
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain("stream-unavailable: ");
  expect((rejection as Error).message).toContain("kill requested");
});

async function waitForWaitForEventConnection(stream: Stream): Promise<void> {
  await waitForCondition(
    async () => {
      const value = (await stream.runtimeState()) as {
        runtime?: { connections?: Record<string, { openedBy?: { description?: string } }> };
      };
      return Object.values(value.runtime?.connections ?? {}).some(
        (connection) => connection.openedBy?.description === "waitForEvent",
      );
    },
    { description: "waitForEvent to enter the stream before kill", timeoutMs: 30_000 },
  );
}

function coreState(value: unknown): {
  eventCount: number;
  maxOffset: number;
  path: string;
  projectId: string | null;
} {
  return (value as { coreProcessorState: ReturnType<typeof coreState> }).coreProcessorState;
}
