import { expect, test } from "vitest";
import {
  guestbookCreationEvents,
  guestbookStreamPath,
} from "../../config-repo-template/guestbook.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// The proof that a USERSPACE Durable Object is a first-class stream-spine
// subscriber: the seeded template's guestbook configures a durable WAKE
// subscription whose persisted expression names the app through the ordinary
// worker collection — ["workers", ["get", ref], "processor",
// "wakeStreamSubscriber"] — so the stream evaluates it, performs the wake
// handshake against GuestbookApp's registry, retains the returned sink
// ACROSS the worker-loader hop, and pushes frames into the userspace runner.
// Nothing else can produce the asserted outcome: this test never renders the
// app and the project worker has no guestbook lane, so the only path from
// "entries appended" to "milestone emitted" is spine-driven wake delivery
// into the user Durable Object.
test(
  "a userspace Durable Object hosts a stream processor behind a native wake subscription",
  { timeout: 240_000 },
  async () => {
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = itx.projects.create({
      slug: `guestbook-wake-${crypto.randomUUID().slice(0, 8)}`,
    });
    const projectId = await project.projectId;

    // The exact batch shape the seeded app's /sign handler appends: the
    // idempotency-keyed creation events (birth + wake subscription), then
    // five signatures — enough to cross the processor's first milestone.
    const stream = project.streams.get(guestbookStreamPath);
    await stream.append(
      ...guestbookCreationEvents(),
      ...[1, 2, 3, 4, 5].map((n) => ({
        type: "events.iterate.com/guestbook/entry-signed",
        payload: { message: `hello ${n}`, name: `visitor ${n}` },
        idempotencyKey: `guestbook/entry:${n}`,
      })),
    );

    // The milestone can only be appended by the guestbook processor folding
    // to head inside GuestbookApp — delivered there by the wake subscription.
    // Generous timeout: the first dial may cold-build the seeded worker.
    const milestone = await stream.waitForEvent({
      eventTypes: ["events.iterate.com/guestbook/milestone-reached"],
      timeoutMs: 210_000,
    });
    // Payload plus provenance: stamped by the userspace processor's own
    // append lane, on its own stream coordinates.
    expect(milestone).toMatchObject({
      payload: { count: 5 },
      source: {
        processor: {
          slug: "guestbook",
          stream: { path: guestbookStreamPath, projectId },
        },
      },
    });

    // The handshake journaled real presence: the stream's roster carries the
    // userspace contract announcement, exactly as it does for platform
    // processors. (The milestone already proves the handshake happened, so
    // this fact is committed by now.)
    const connects = await stream.getEvents({
      eventTypes: ["events.iterate.com/stream/subscriber-connected"],
    });
    const guestbookConnects = connects.filter(
      (event) => event.payload?.subscriptionKey === "app-guestbook#guestbook",
    );
    expect(guestbookConnects.length).toBeGreaterThan(0);
    const announcement = (
      guestbookConnects.at(-1)?.payload?.subscriber as
        | { processor?: { announcement?: { slug?: string; emits?: string[] } } }
        | undefined
    )?.processor?.announcement;
    expect(announcement?.slug).toBe("guestbook");
    expect(announcement?.emits).toContain("events.iterate.com/guestbook/milestone-reached");

    // First-class citizenship, round two: ask the STREAM for the processor's
    // runtime state — it forwards the read through the retained wake
    // connection into the userspace registry and answers with the fold.
    const runtime = await stream.getProcessorRuntimeState({
      subscriptionKey: "app-guestbook#guestbook",
    });
    const folded = runtime?.snapshot?.state as
      | { entries?: unknown[]; lastMilestone?: number }
      | undefined;
    expect(folded?.entries).toHaveLength(5);
  },
);
