import { describe, expect, it } from "vitest";
import { MemoryStream, driveProcessor } from "iterate/processors/testing";
import { SandboxProcessorContract } from "./sandbox-processor-contract.ts";
import { SandboxProcessor } from "./sandbox-processor-implementation.ts";

function event(type: string, payload: Record<string, unknown> = {}) {
  return { type, payload };
}

/** REAL runner drive over an in-memory journal: append facts, deliver, read
 * the runner's committed fold — the pure-fold tests below never reach for
 * anything beyond that. */
function sandboxHarness() {
  const stream = new MemoryStream("/sandboxes/test");
  const processor = new SandboxProcessor({
    stream,
    path: "/sandboxes/test",
    projectId: null,
  });
  return { stream, driver: driveProcessor(processor, stream) };
}

describe("SandboxProcessor", () => {
  it("throws when a second sandbox birth certificate is reduced", async () => {
    const { stream, driver } = sandboxHarness();
    await stream.append(
      event("events.iterate.com/sandbox/created", { config: { instanceType: "basic" } }),
      event("events.iterate.com/sandbox/created", { config: { instanceType: "basic" } }),
    );

    await expect(driver.deliver()).rejects.toThrow("more than one sandbox/created event");
  });

  it("folds a pet's whole life: created → running → stopped → running → destroyed", async () => {
    const { stream, driver } = sandboxHarness();
    // create-requested lands on the /sandboxes catalogue stream, not here —
    // the pet's own stream starts with the completion.
    await stream.append(
      event("events.iterate.com/sandbox/created", { config: { instanceType: "basic" } }),
    );
    await driver.deliver();
    await expect(driver.snapshot()).resolves.toMatchObject({
      state: {
        birthCertificate: { config: { instanceType: "basic" } },
        status: "created",
        lastBackupId: null,
      },
    });

    await stream.append(
      event("events.iterate.com/sandbox/started"),
      event("events.iterate.com/sandbox/backup-created", { backupId: "bkp-1" }),
      event("events.iterate.com/sandbox/stopped"),
    );
    await driver.deliver();
    await expect(driver.snapshot()).resolves.toMatchObject({
      state: { status: "stopped", lastBackupId: "bkp-1" },
    });

    await stream.append(
      // An implicit wake: started without a start-requested.
      event("events.iterate.com/sandbox/started"),
      event("events.iterate.com/sandbox/workspace-restored", { backupId: "bkp-1" }),
      event("events.iterate.com/sandbox/destroy-requested"),
      event("events.iterate.com/sandbox/destroyed"),
    );
    await driver.deliver();
    await expect(driver.snapshot()).resolves.toMatchObject({
      state: { status: "destroyed" },
    });
  });

  it("destroyed is terminal — a late-delivered stopped cannot resurrect the status", async () => {
    const { stream, driver } = sandboxHarness();
    await stream.append(
      event("events.iterate.com/sandbox/created", { config: { instanceType: "lite" } }),
      event("events.iterate.com/sandbox/destroyed"),
      // The SDK delivers a stop that happened while the Durable Object was
      // hibernated on the NEXT wake — after the destroy already landed.
      event("events.iterate.com/sandbox/stopped"),
    );
    await driver.deliver();
    await expect(driver.snapshot()).resolves.toMatchObject({
      state: { status: "destroyed" },
    });
  });

  it("folds the configured env map (later configs merge over earlier)", async () => {
    const { stream, driver } = sandboxHarness();
    await stream.append(
      event("events.iterate.com/sandbox/configured", {
        env: { GH_TOKEN: 'getSecret({ path: "/secrets/gh" })', FOO: "bar" },
      }),
      event("events.iterate.com/sandbox/configured", {
        env: { OPENAI_API_KEY: 'getSecret({ path: "/secrets/openai" })', FOO: "baz" },
      }),
    );
    await driver.deliver();
    const snap = await driver.snapshot();
    expect(snap.state.env).toEqual({
      GH_TOKEN: 'getSecret({ path: "/secrets/gh" })',
      OPENAI_API_KEY: 'getSecret({ path: "/secrets/openai" })',
      FOO: "baz",
    });
  });

  it("ignores events outside its catalog", async () => {
    const { stream, driver } = sandboxHarness();
    await stream.append(event("events.iterate.com/agent/turn-started"));
    await driver.deliver();
    await expect(driver.snapshot()).resolves.toMatchObject({
      state: { birthCertificate: null, lastBackupId: null, status: null },
    });
  });
});

describe("SandboxProcessorContract.buildEvent", () => {
  it("validates lifecycle payloads against the catalog", () => {
    expect(
      SandboxProcessorContract.buildEvent({
        type: "events.iterate.com/sandbox/backup-created",
        payload: { backupId: "bkp-1" },
      }),
    ).toMatchObject({ payload: { backupId: "bkp-1" } });

    expect(() =>
      SandboxProcessorContract.buildEvent({
        type: "events.iterate.com/sandbox/backup-created",
        // @ts-expect-error — the wrong payload shape must fail at runtime too
        payload: { wrong: true },
      }),
    ).toThrow();
  });
});
