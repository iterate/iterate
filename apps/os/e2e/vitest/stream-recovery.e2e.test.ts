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
