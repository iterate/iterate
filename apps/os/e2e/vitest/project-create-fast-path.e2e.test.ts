import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test(
  "fast-path create is self-driving: nobody waits, the saga still lands project/ready",
  { retry: 0 },
  async ({ expect }) => {
    using session = withItxSession({
      auth: { type: "admin-secret", secret: adminSecret() },
    });
    const slug = `create-fast-path-${crypto.randomUUID().slice(0, 8)}`;

    // The dashboard form's exact shape: identity() pipelined through the
    // non-blocking create — one round trip, resolving pre-birth.
    using project = session.projects.get(slug).create({}, { readiness: "exists" });
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

test("core create returns at the existing durable birth barrier", { retry: 0 }, async () => {
  using session = withItxSession({
    auth: { type: "admin-secret", secret: adminSecret() },
  });
  const slug = `create-core-${crypto.randomUUID().slice(0, 8)}`;

  using project = await session.projects.get(slug).create({}, { readiness: "core" });
  const [projectState, capabilityHostState, schedulerState, repoState, emailState] =
    await Promise.all([
      project.processor.getRuntimeState(),
      project.capabilityHost.processor.getRuntimeState(),
      project.scheduler.processor.getRuntimeState(),
      project.repo.processor.getRuntimeState(),
      project.email.processor.getRuntimeState(),
    ]);

  expect(projectState.snapshot.state.birthCertificate).not.toBeNull();
  expect(capabilityHostState.snapshot.state).toMatchObject({ birthCertificate: expect.anything() });
  expect(schedulerState.snapshot.state.birthCertificate).not.toBeNull();
  // Core owns the config-repo processor's request batch, not the asynchronous
  // Artifacts seed or its terminal repos/created certificate.
  expect(repoState.snapshot.state.createRequest).not.toBeNull();
  expect(emailState.snapshot.state).toMatchObject({ birthCertificate: expect.anything() });

  await project.waitUntilReady();
  const probeApp = `core-probe-${crypto.randomUUID().slice(0, 8)}`;
  const workerResponse = await project.worker.fetch(
    new Request("https://example.com/probe", {
      headers: { "x-iterate-app": probeApp },
    }),
  );
  expect(workerResponse).toMatchObject({ status: 404 });
  expect(await workerResponse.text()).toContain(`unknown app: ${probeApp}`);
});

test("invalid or legacy readiness options fail before registering a project", async () => {
  using session = withItxSession({
    auth: { type: "admin-secret", secret: adminSecret() },
  });
  const legacySlug = `create-legacy-${crypto.randomUUID().slice(0, 8)}`;
  const invalidSlug = `create-invalid-${crypto.randomUUID().slice(0, 8)}`;

  await expect(
    session.projects.get(legacySlug).create({}, { waitUntilReady: false } as never),
  ).rejects.toThrow(/Unknown project create option "waitUntilReady"/);
  await expect(
    session.projects.get(invalidSlug).create({}, { readiness: "sometimes" } as never),
  ).rejects.toThrow(/Unknown project create readiness "sometimes"/);

  const projects = await session.projects.list();
  expect(projects.some(({ slug }) => slug === legacySlug || slug === invalidSlug)).toBe(false);
});
