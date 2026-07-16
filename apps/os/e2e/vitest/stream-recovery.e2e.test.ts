import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test("waitForEvent still finds a durable event after recovery replaces its live subscription", async () => {
  const marker = crypto.randomUUID();
  const path = `/recovery-wait-${marker}`;
  const eventType = "events.iterate.test/recovery-wait-target";
  using transport = withItxSession();
  using session = transport.authenticate({ type: "admin-secret", secret: adminSecret() });
  using stream = session.streams.get(path);
  using recovery = session.streamRecovery.get({ projectId: null, path });

  const [seed] = await stream.append({
    type: "events.iterate.test/recovery-wait-seed",
    payload: { marker },
  });
  const exported = await recovery.exportForRecovery({ limit: 500 });
  const pending = stream.waitForEvent({
    afterOffset: seed!.offset,
    eventTypes: [eventType],
    timeoutMs: 5_000,
  });
  void pending.catch(() => undefined);

  await waitForCondition(
    async () => {
      const state = await stream.runtimeState();
      return Object.values(state.runtime.connections).some(
        (connection) => connection.subscriber?.description === "waitForEvent",
      );
    },
    { description: "waitForEvent subscription to open" },
  );

  // Advance the live wait beyond the exported head. Recovery rewinds the
  // allocator, so the target below deliberately reuses an offset this waiter
  // already scanned in the replaced journal.
  const [replacedTail] = await stream.append({
    type: "events.iterate.test/recovery-wait-replaced-tail",
    payload: { marker },
  });
  await waitForCondition(
    async () => {
      const state = await stream.runtimeState();
      return Object.values(state.runtime.connections).some(
        (connection) =>
          connection.subscriber?.description === "waitForEvent" &&
          connection.cursor >= replacedTail!.offset,
      );
    },
    { description: "waitForEvent subscription to scan the replaced tail" },
  );

  await recovery.restoreFromRecovery({
    format: exported.format,
    version: exported.version,
    stream: exported.stream,
    events: exported.events,
    highestAssignedOffset: exported.throughOffset,
  });
  const [target] = await stream.append({ type: eventType, payload: { marker } });

  await expect(pending).resolves.toMatchObject({
    offset: target!.offset,
    payload: { marker },
    type: eventType,
  });
});

test("waitForEvent ignores a predicate result from the journal recovery replaced", async () => {
  const marker = crypto.randomUUID();
  const path = `/recovery-wait-predicate-${marker}`;
  const staleType = "events.iterate.test/recovery-wait-stale-predicate";
  const targetType = "events.iterate.test/recovery-wait-current-predicate";
  const predicateEntered = Promise.withResolvers<void>();
  const releasePredicate = Promise.withResolvers<void>();
  using transport = withItxSession();
  using session = transport.authenticate({ type: "admin-secret", secret: adminSecret() });
  using stream = session.streams.get(path);
  using recovery = session.streamRecovery.get({ projectId: null, path });

  const [seed] = await stream.append({
    type: "events.iterate.test/recovery-wait-predicate-seed",
    payload: { marker },
  });
  const exported = await recovery.exportForRecovery({ limit: 500 });
  const pending = stream.waitForEvent({
    afterOffset: seed!.offset,
    predicate: async (event) => {
      if (event.type === staleType) {
        predicateEntered.resolve();
        await releasePredicate.promise;
        return true;
      }
      return event.type === targetType;
    },
    timeoutMs: 5_000,
  });
  void pending.catch(() => undefined);

  await stream.append({ type: staleType, payload: { marker } });
  await predicateEntered.promise;

  await recovery.restoreFromRecovery({
    format: exported.format,
    version: exported.version,
    stream: exported.stream,
    events: exported.events,
    highestAssignedOffset: exported.throughOffset,
  });
  const [target] = await stream.append({ type: targetType, payload: { marker } });
  releasePredicate.resolve();

  await expect(pending).resolves.toMatchObject({
    offset: target!.offset,
    payload: { marker },
    type: targetType,
  });
});

test("recovery rejects incompatible core events before replacing the live stream", async () => {
  const path = `/recovery-strict-${crypto.randomUUID()}`;
  using transport = withItxSession();
  using session = transport.authenticate({ type: "admin-secret", secret: adminSecret() });
  using stream = session.streams.get(path);
  using recovery = session.streamRecovery.get({ projectId: null, path });

  const [marker] = await stream.append({
    type: "events.iterate.test/recovery-marker",
    payload: { retained: true },
  });
  const exported = await recovery.exportForRecovery({ limit: 500 });
  const incompatibleEvents = exported.events.map((event) =>
    event.type === "events.iterate.com/stream/woken" ? { ...event, payload: {} } : event,
  );

  await expect(
    recovery.restoreFromRecovery({
      format: exported.format,
      version: exported.version,
      stream: exported.stream,
      events: incompatibleEvents,
      highestAssignedOffset: exported.throughOffset,
    }),
  ).rejects.toThrow(/recovery event at offset .*stream\/woken.*incompatible/);

  const surviving = await stream.getEvents({ afterOffset: 0, limit: 500 });
  expect(surviving.some((event) => event.offset === marker?.offset)).toBe(true);
  await expect(
    stream.append({ type: "events.iterate.test/recovery-still-live", payload: {} }),
  ).resolves.toHaveLength(1);
});

test("recovery streams byte-bounded pages through one acknowledged export", async () => {
  const path = `/recovery-streamed-${crypto.randomUUID()}`;
  using transport = withItxSession();
  using session = transport.authenticate({ type: "admin-secret", secret: adminSecret() });
  using stream = session.streams.get(path);
  using recovery = session.streamRecovery.get({ projectId: null, path });

  const [firstLarge, secondLarge] = await stream.append(
    { type: "events.iterate.test/recovery-large", payload: { value: "a".repeat(600_000) } },
    { type: "events.iterate.test/recovery-large", payload: { value: "b".repeat(600_000) } },
  );
  const firstPage = await recovery.exportForRecovery({ limit: 500 });
  expect(firstPage).toMatchObject({ complete: false });
  expect(firstPage.events.some((event) => event.offset === firstLarge?.offset)).toBe(true);
  expect(firstPage.events.some((event) => event.offset === secondLarge?.offset)).toBe(false);

  const pages: (typeof firstPage)[] = [];
  const sink = new (class extends RpcTarget {
    async write(page: typeof firstPage) {
      pages.push(page);
    }
  })();
  const summary = await recovery.exportToRecovery({ sink, limit: 500 });

  expect(pages.length).toBeGreaterThan(1);
  expect(pages.at(-1)?.complete).toBe(true);
  expect(pages.flatMap((page) => page.events).map((event) => event.offset)).toContain(
    secondLarge?.offset,
  );
  expect(summary).toMatchObject({
    complete: true,
    exportedEventCount: pages.reduce((count, page) => count + page.events.length, 0),
    lastExportedOffset: pages.at(-1)?.events.at(-1)?.offset,
    pageCount: pages.length,
    throughOffset: pages[0]?.throughOffset,
  });

  const sessionPages: (typeof firstPage)[] = [];
  const sessionSink = new (class extends RpcTarget {
    async write(page: typeof firstPage) {
      sessionPages.push(page);
    }
  })();
  const firstSession = await recovery.exportToRecovery({ sink: sessionSink, maxPages: 1 });
  expect(firstSession).toMatchObject({ complete: false, pageCount: 1 });
  const secondSession = await recovery.exportToRecovery({
    sink: sessionSink,
    afterOffset: firstSession.lastExportedOffset,
    maxPages: 1,
    throughOffset: firstSession.throughOffset,
  });
  expect(secondSession).toMatchObject({ complete: true, pageCount: 1 });
  expect(sessionPages).toHaveLength(2);
});
