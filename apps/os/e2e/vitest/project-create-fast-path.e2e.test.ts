import { test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// Quarantined by tasks/quarantined-preview-e2e-retry-flakes.md.
test.skip(
  "fast-path create is self-driving: nobody waits, the saga still lands project/ready",
  { retry: 0 },
  async ({ expect }) => {
    using session = withItxSession({
      auth: { type: "admin-secret", secret: adminSecret() },
    });
    const slug = `create-fast-path-${crypto.randomUUID().slice(0, 8)}`;

    // The dashboard form's exact shape: identity() pipelined through the
    // non-blocking create — one round trip, resolving pre-birth.
    using project = session.projects.get(slug).create({}, { waitUntilReady: false });
    const identity = await project.identity();
    expect(identity).toMatchObject({ slug });

    // Observer-effect-free probe: waitForEvent talks only to the stream
    // spine, never a processor, so `project/ready` arriving proves create's
    // own post-response nudge (not this test) drove the bootstrap saga.
    // Deliberately NOT project.waitUntilReady(), whose snapshot() would heal
    // a dead saga and mask a broken nudge.
    const ready = await project.streams.get("/").waitForEvent({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/project/ready"],
      timeoutMs: 60_000,
    });
    expect(ready).toMatchObject({ type: "events.iterate.com/project/ready" });
  },
);
