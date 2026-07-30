import { test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test(
  "fast-path create is self-driving: nobody waits, the saga still lands project/created",
  { retry: 0 },
  async ({ expect }) => {
    using session = withItxSession({
      auth: { type: "admin-secret", secret: adminSecret() },
    });
    const slug = `create-fast-path-${crypto.randomUUID().slice(0, 8)}`;

    // The dashboard form's exact shape: identity() pipelined through the
    // non-blocking create — one round trip, resolving pre-birth.
    using project = session.projects.get(slug).create({}, { waitUntilCreated: false });
    const identity = await project.identity();
    expect(identity).toMatchObject({ slug });

    // Observer-effect-free probe: waitForEvent talks only to the stream
    // spine, never a processor, so terminal `project/created` arriving proves create's
    // own post-response nudge (not this test) drove the bootstrap saga.
    // Deliberately NOT project.waitUntilCreated(), whose snapshot() would heal
    // a dead saga and mask a broken nudge.
    const created = await project.streams.get("/").waitForEvent({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/project/created"],
      timeoutMs: 60_000,
    });
    expect(created).toMatchObject({ type: "events.iterate.com/project/created" });
  },
);
