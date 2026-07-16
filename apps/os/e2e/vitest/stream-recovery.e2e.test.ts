import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

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
