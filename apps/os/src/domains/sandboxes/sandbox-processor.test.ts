// The sandbox processor's executable spec, on the generic step harness from
// iterate/processors/testing: the REAL StreamProcessorRunner over the shared
// MemoryStream. The processor is a PURE reducer (no side-effect lanes, no
// clock), so scenarios are ordered appends — the contract's `consumes`
// vocabulary through the typed step, and the unconsumed audit facts the
// Durable Object also appends (`*-requested`, `workspace-restored`) through
// raw `h.stream.append` function steps, exactly as they ride the production
// stream.

import { describe, expect, it } from "vitest";
import type { ConsumedInput } from "iterate/processors";
import { makeMemoryProgressStore, makeProcessorHarness } from "iterate/processors/testing";
import { SandboxProcessorContract } from "./sandbox-processor-contract.ts";
import { SandboxProcessor } from "./sandbox-processor-implementation.ts";

const CREATED = {
  type: "events.iterate.com/sandbox/created",
  payload: { config: { instanceType: "basic" } },
} satisfies ConsumedInput<SandboxProcessorContract>;

function makeSandboxHarness() {
  return makeProcessorHarness<SandboxProcessorContract>({
    createProcessor: (deps) => new SandboxProcessor(deps),
    path: "/sandboxes/test",
  });
}

describe("SandboxProcessor", () => {
  it("reduces a pet's whole life: created → running → stopped → running → destroyed", async () => {
    const h = makeSandboxHarness();
    // create-requested lands on the /sandboxes catalogue stream, not here —
    // the pet's own stream starts with the completion.
    await h.play(["append", CREATED]);
    expect(h.state()).toMatchObject({
      birthCertificate: { config: { instanceType: "basic" } },
      running: false,
      status: "created",
      lastBackupId: null,
    });

    await h.play(["append", { type: "events.iterate.com/sandbox/started", payload: {} }]);
    expect(h.state()).toMatchObject({ running: true, status: "running" });

    await h.play([
      "append",
      { type: "events.iterate.com/sandbox/backup-created", payload: { backupId: "bkp-1" } },
      { type: "events.iterate.com/sandbox/stopped", payload: {} },
    ]);
    expect(h.state()).toMatchObject({ running: false, status: "stopped", lastBackupId: "bkp-1" });

    // The rest of the life in one batch, raw-appended because it mixes
    // consumed completions with the unconsumed audit facts the Durable Object
    // also puts on this stream.
    await h.play(() =>
      h.stream.append(
        // An implicit wake: started without a start-requested.
        { type: "events.iterate.com/sandbox/started", payload: {} },
        { type: "events.iterate.com/sandbox/workspace-restored", payload: { backupId: "bkp-1" } },
        // Killing the Durable Object does not change the container lifecycle.
        { type: "events.iterate.com/sandbox/kill-requested", payload: {} },
        { type: "events.iterate.com/sandbox/destroy-requested", payload: {} },
        { type: "events.iterate.com/sandbox/destroyed", payload: {} },
      ),
    );
    expect(h.state()).toMatchObject({ running: false, status: "destroyed" });
  });

  it("ignores a second sandbox birth certificate during reduction", async () => {
    const h = makeSandboxHarness();
    await h.play(["append", CREATED, CREATED]);
    expect(h.state().birthCertificate).toEqual(CREATED.payload);
  });

  it("destroyed is terminal — a late-delivered stopped cannot resurrect the status", async () => {
    const h = makeSandboxHarness();
    await h.play([
      "append",
      { type: "events.iterate.com/sandbox/created", payload: { config: { instanceType: "lite" } } },
      { type: "events.iterate.com/sandbox/destroyed", payload: {} },
      // The SDK delivers a stop that happened while the Durable Object was
      // hibernated on the NEXT wake — after the destroy already landed.
      { type: "events.iterate.com/sandbox/stopped", payload: {} },
    ]);
    expect(h.state()).toMatchObject({ running: false, status: "destroyed" });
  });

  it("reduces the configured env map: later configs merge over earlier, null unsets", async () => {
    const h = makeSandboxHarness();
    await h.play([
      "append",
      {
        type: "events.iterate.com/sandbox/configured",
        payload: { env: { GH_TOKEN: 'getSecret("/secrets/gh")', FOO: "bar" } },
      },
      {
        type: "events.iterate.com/sandbox/configured",
        payload: { env: { OPENAI_API_KEY: 'getSecret("/secrets/openai")', FOO: "baz" } },
      },
    ]);
    expect(h.state().env).toEqual({
      GH_TOKEN: 'getSecret("/secrets/gh")',
      OPENAI_API_KEY: 'getSecret("/secrets/openai")',
      FOO: "baz",
    });

    // null is the stream-safe spelling of setEnvVars' undefined: unset.
    await h.play([
      "append",
      { type: "events.iterate.com/sandbox/configured", payload: { env: { GH_TOKEN: null } } },
    ]);
    expect(h.state().env).toEqual({
      OPENAI_API_KEY: 'getSecret("/secrets/openai")',
      FOO: "baz",
    });
  });

  it("ignores events outside its catalog", async () => {
    const h = makeSandboxHarness();
    await h.play(() =>
      h.stream.append({ type: "events.iterate.com/agent/turn-started", payload: {} }),
    );
    expect(h.state()).toMatchObject({
      birthCertificate: null,
      lastBackupId: null,
      running: false,
      status: null,
    });
  });

  it("a full replay (fresh cursor over the same stream) reduces to the identical projection", async () => {
    const h = makeSandboxHarness();
    await h.play(
      ["append", CREATED, { type: "events.iterate.com/sandbox/started", payload: {} }],
      [
        "append",
        {
          type: "events.iterate.com/sandbox/configured",
          payload: { env: { GH_TOKEN: 'getSecret("/secrets/gh")' } },
        },
        { type: "events.iterate.com/sandbox/backup-created", payload: { backupId: "bkp-1" } },
        { type: "events.iterate.com/sandbox/stopped", payload: {} },
      ],
    );

    const replay = makeProcessorHarness<SandboxProcessorContract>({
      createProcessor: (deps) => new SandboxProcessor(deps),
      substrate: { clock: h.clock, stream: h.stream, progress: makeMemoryProgressStore() },
    });
    await replay.settle(); // reduces the whole stream from offset zero
    expect(replay.state()).toEqual(h.state());
    expect(replay.state()).toMatchObject({ status: "stopped", lastBackupId: "bkp-1" });
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

  it("builds the collection's idempotency-keyed catalogue claim", () => {
    // Mirrors SandboxCollectionRpcTarget.create: the create-requested append
    // to the /sandboxes catalogue stream IS the atomic name claim.
    expect(
      SandboxProcessorContract.buildEvent({
        type: "events.iterate.com/sandbox/create-requested",
        idempotencyKey: "sandbox/create-requested:/sandboxes/main",
        payload: {
          path: "/sandboxes/main",
          instanceType: "basic",
          sleepAfter: "10m",
          env: { GH_TOKEN: 'getSecret("/secrets/gh")' },
        },
      }),
    ).toMatchObject({
      idempotencyKey: "sandbox/create-requested:/sandboxes/main",
      payload: { path: "/sandboxes/main", instanceType: "basic" },
    });
  });
});
