// The secret processor's executable spec, in two layers:
//
// 1. Step scenarios on the generic harness (makeProcessorHarness from
//    iterate/processors/testing): the REAL StreamProcessorRunner over the
//    shared MemoryStream with production idempotency semantics (a same-key
//    append with a different body is REJECTED). The home stream lives inside a
//    MemoryStreamNetwork so the ONE side effect — the secret/created catalog
//    copy onto the project root stream "/" — is observable.
// 2. The registry-level wiring suite (fake DurableObjectState, REAL registry +
//    runner, the facade built exactly as secret-durable-object.ts builds it),
//    kept on its inline registry harness.

import { describe, expect, it, test } from "vitest";
import { KEEPALIVE_ALARM_LEAD_MS, type ConsumedInput } from "iterate/processors";
import {
  makeMemoryProgressStore,
  makeProcessorHarness,
  MemoryStream,
  MemoryStreamNetwork,
  type HarnessSubstrate,
} from "iterate/processors/testing";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { SecretProcessorContract } from "./secret-processor-contract.ts";
import { SecretProcessor } from "./secret-processor-implementation.ts";

const SECRET_PATH = "/secrets/example";

const ENCRYPTED_MATERIAL = {
  algorithm: "AES-GCM-SHA256+SECRET-CELL-V1",
  ciphertext: "ciphertext",
  iv: "initialization-vector",
} as const;

const CREATED = {
  type: "events.iterate.com/secret/created",
  payload: {
    config: {
      egress: { urls: ["https://api.example.com"] },
      refresh: null,
    },
  },
} satisfies ConsumedInput<SecretProcessorContract>;

const GITHUB_REFRESH = {
  kind: "github-app-installation",
  apiBase: "https://api.github.com",
  appId: "312345",
  installationId: "45678901",
  privateKey: { platform: "integrations.github" },
} as const;

/** The generic harness over a MemoryStreamNetwork, so copies to the
 * project root stream "/" land somewhere observable. Pass another harness's
 * substrate for a replay incarnation over the SAME stream. */
function makeSecretHarness(substrate?: HarnessSubstrate) {
  if (substrate === undefined) {
    const clock = { now: 1_000_000 };
    const network = new MemoryStreamNetwork(() => clock.now);
    substrate = {
      clock,
      stream: network.get(SECRET_PATH),
      progress: makeMemoryProgressStore(SecretProcessorContract),
    };
  }
  const harness = makeProcessorHarness<SecretProcessorContract>({
    createProcessor: (deps) => new SecretProcessor(deps),
    substrate,
  });
  const network = harness.stream.network!;
  return { ...harness, network, catalog: () => network.eventsAt("/") };
}

describe("SecretProcessor birth", () => {
  it("secret/created reduces the whole birth policy and copies the catalog fact to the project root", async () => {
    const h = makeSecretHarness();
    await h.play([
      "append",
      {
        type: "events.iterate.com/secret/created",
        payload: {
          config: {
            egress: { urls: ["https://api.example.com"] },
            encryptedMaterial: ENCRYPTED_MATERIAL,
            refresh: null,
          },
        },
      },
    ]);

    expect(h.state()).toMatchObject({
      birthCertificate: {
        config: {
          egress: { urls: ["https://api.example.com"] },
          refresh: null,
          // Schema default: every pre-existing stream reduces as write-only.
          visibility: "write-only",
        },
      },
      egress: { urls: ["https://api.example.com"] },
      // Birth material commits at the created event's own offset — the
      // position AES-GCM authenticates.
      encryptedMaterial: { ...ENCRYPTED_MATERIAL, offset: 1 },
      refresh: null,
      updatedOffset: 1,
    });

    // The ONE side effect: the created event re-appended onto "/", keyed on
    // the consumed event's coordinates so a redelivered frame dedupes.
    expect(h.catalog()).toMatchObject([
      {
        type: "events.iterate.com/secret/created",
        idempotencyKey: `secret/catalog-created@/secrets/example:1@source-stream:${h.stream.streamId}`,
        payload: { config: { visibility: "write-only" } },
      },
    ]);
    // No home-stream appends of its own — the created event stands alone.
    expect(h.events()).toHaveLength(1);
  });

  it("the born project API key shape: readable visibility with an empty egress pin reduces verbatim", async () => {
    const h = makeSecretHarness();
    await h.play([
      "append",
      {
        type: "events.iterate.com/secret/created",
        payload: { config: { egress: { urls: [] }, refresh: null, visibility: "readable" } },
      },
    ]);

    expect(h.state().birthCertificate).toMatchObject({ config: { visibility: "readable" } });
    expect(h.state().encryptedMaterial).toBeNull();
    expect(h.catalog()).toHaveLength(1);
  });

  it("a second created event is a no-op: the first birth certificate wins", async () => {
    const h = makeSecretHarness();
    await h.play(["append", CREATED]);
    const before = h.state();
    // Conflicting births are rejected at the Secret DO's create door; a
    // duplicate that still reaches reduce must not wedge the frame, and must
    // not re-birth.
    await h.append(CREATED);
    expect(h.state()).toEqual(before);
  });
});

describe("SecretProcessor material decisions", () => {
  it("an update with material records the committed offset; the next material-less update destroys it", async () => {
    const h = makeSecretHarness();
    await h.play([
      "append",
      CREATED,
      {
        type: "events.iterate.com/secret/updated",
        payload: {
          egress: { urls: ["https://api.example.com"] },
          encryptedMaterial: ENCRYPTED_MATERIAL,
        },
      },
    ]);
    expect(h.state()).toMatchObject({
      encryptedMaterial: { ...ENCRYPTED_MATERIAL, offset: 2 },
      updatedOffset: 2,
    });

    // An update is a COMPLETE material decision: this refresh-only update
    // clears the retained value on purpose.
    await h.play([
      "append",
      { type: "events.iterate.com/secret/updated", payload: { refresh: null } },
    ]);
    expect(h.state()).toMatchObject({
      encryptedMaterial: null,
      refresh: null,
      updatedOffset: 3,
    });
  });

  it("refresh: present replaces (null clears), omitted leaves the strategy in force", async () => {
    const h = makeSecretHarness();
    await h.play([
      "append",
      CREATED,
      {
        type: "events.iterate.com/secret/updated",
        payload: { encryptedMaterial: ENCRYPTED_MATERIAL, refresh: GITHUB_REFRESH },
      },
      // refresh omitted: the strategy stays; the replacement material commits
      // at this new offset (the revision fence the DO checks moves with it).
      {
        type: "events.iterate.com/secret/updated",
        payload: { encryptedMaterial: ENCRYPTED_MATERIAL },
      },
    ]);
    expect(h.state()).toMatchObject({
      refresh: { kind: "github-app-installation", installationId: "45678901" },
      encryptedMaterial: { ...ENCRYPTED_MATERIAL, offset: 3 },
      updatedOffset: 3,
    });

    await h.play([
      "append",
      { type: "events.iterate.com/secret/updated", payload: { refresh: null } },
    ]);
    expect(h.state().refresh).toBeNull();
  });

  it("egress: omitted leaves the pin, present replaces it", async () => {
    const h = makeSecretHarness();
    await h.play([
      "append",
      CREATED,
      {
        type: "events.iterate.com/secret/updated",
        payload: { encryptedMaterial: ENCRYPTED_MATERIAL },
      },
    ]);
    expect(h.state().egress).toEqual({ urls: ["https://api.example.com"] });

    await h.play([
      "append",
      {
        type: "events.iterate.com/secret/updated",
        payload: { egress: { urls: ["https://slack.com", "https://files.slack.com"] } },
      },
    ]);
    expect(h.state().egress).toEqual({ urls: ["https://slack.com", "https://files.slack.com"] });
    // …and the egress-only update destroyed the material (complete decision).
    expect(h.state().encryptedMaterial).toBeNull();
  });
});

describe("SecretProcessor audit", () => {
  it("secret/used mirrors the NEWEST fact exactly; a bare used fact clears stale attribution", async () => {
    const h = makeSecretHarness();
    await h.play([
      "append",
      CREATED,
      {
        type: "events.iterate.com/secret/used",
        payload: {
          usedAt: "2026-07-08T14:31:09.412Z",
          usedBy: "prj_b9f2c81d4e6a4f0a9c3d7e5b1a8f2c4d",
          url: "https://slack.com/api/chat.postMessage",
        },
      },
    ]);
    expect(h.state().audit).toEqual({
      usedCount: 1,
      lastUsedAt: "2026-07-08T14:31:09.412Z",
      lastUsedBy: "prj_b9f2c81d4e6a4f0a9c3d7e5b1a8f2c4d",
      lastUsedUrl: "https://slack.com/api/chat.postMessage",
    });

    // A used fact without usedBy/url CLEARS the previous attribution rather
    // than showing it next to a fresh timestamp (exact-equality assertion).
    await h.play([
      "append",
      {
        type: "events.iterate.com/secret/used",
        payload: { usedAt: "2026-07-08T15:00:00.000Z" },
      },
    ]);
    expect(h.state().audit).toEqual({ usedCount: 2, lastUsedAt: "2026-07-08T15:00:00.000Z" });
  });
});

describe("SecretProcessor recovery", () => {
  it("a catalog outage holds the cursor; the successor incarnation re-runs the copy", async () => {
    const h = makeSecretHarness();
    // The project root stream is down: the blocked copy fails, so the
    // frame fails with the cursor HELD — the created event stays deliverable.
    h.network.get("/").failAppendsOfType = "events.iterate.com/secret/created";
    await expect(h.append(CREATED)).rejects.toThrow("injected append failure");
    expect(h.catalog()).toHaveLength(0);

    // The outage ends; the incarnation dies. The successor redelivers the
    // created event and the catalog fact lands — nothing was lost.
    h.network.get("/").failAppendsOfType = undefined;
    h.crash();
    await h.advanceTime(KEEPALIVE_ALARM_LEAD_MS + 1);
    expect(h.catalog()).toMatchObject([
      {
        idempotencyKey: `secret/catalog-created@/secrets/example:1@source-stream:${h.stream.streamId}`,
      },
    ]);
    expect(h.state().birthCertificate).not.toBeNull();
  });

  it("a full replay (fresh cursor over the same stream) reaches the same state and dedupes the copy", async () => {
    const h = makeSecretHarness();
    await h.play(
      ["append", CREATED],
      [
        "append",
        {
          type: "events.iterate.com/secret/updated",
          payload: { encryptedMaterial: ENCRYPTED_MATERIAL, refresh: GITHUB_REFRESH },
        },
      ],
      [
        "append",
        {
          type: "events.iterate.com/secret/used",
          payload: { usedAt: "2026-07-08T14:31:09.412Z", usedBy: "prj_example" },
        },
      ],
      // The clock is now well past the original appends: the replayed
      // copy must still produce a byte-identical body (it is built from
      // the consumed payload, never from now()), or the same-key append would
      // be REJECTED and wedge the replay.
      ["advanceTime", 60_000],
    );
    const headState = h.state();
    const committedOffsets = h.events().map((row) => row.offset);
    expect(h.catalog()).toHaveLength(1);

    const replay = makeSecretHarness({
      clock: h.clock,
      stream: h.stream,
      progress: makeMemoryProgressStore(SecretProcessorContract),
    });
    await replay.settle(); // replays every event; a wedge would throw here

    expect(replay.events().map((row) => row.offset)).toEqual(committedOffsets);
    expect(replay.state()).toEqual(headState);
    // The re-run copy deduped on its key instead of double-cataloging.
    expect(h.catalog()).toHaveLength(1);
  });
});

// The secret DO's registry wiring (secret-durable-object.ts), minus the
// uninstantiable DurableObject shell: REAL registry + REAL runner + REAL
// SecretProcessor over an in-memory stream, with the reads and the
// StreamProcessorRpcTarget built exactly as the DO builds them. Pins the
// cutover's load-bearing behavior: set-then-read is read-your-writes through
// `registry.catchUp` + the RUNNER's committed progress (the processor
// instance's internal checkpoint never advances under runner drive), and the
// facade's publicState projection still redacts the state that leaves.
describe("registry + runner drive (the secret DO's wiring)", () => {
  /** The slice of DurableObjectState the registry touches, in memory. */
  function fakeDurableObjectState(): DurableObjectState {
    const kv = new Map<string, unknown>();
    const alarm: { at: number | null } = { at: null };
    return {
      storage: {
        kv: {
          get: (key: string) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
          put: (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
          delete: (key: string) => kv.delete(key),
        },
        getAlarm: async () => alarm.at,
        setAlarm: async (at: number | Date) => {
          alarm.at = typeof at === "number" ? at : at.getTime();
        },
        deleteAlarm: async () => {
          alarm.at = null;
        },
      },
      waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined),
    } as unknown as DurableObjectState;
  }

  test("set-then-read is read-your-writes through catchUp + runner-backed reads", async () => {
    const stream = new MemoryStream("/secrets/example");
    const registry = createStreamProcessorRegistry(fakeDurableObjectState(), {
      stream,
      path: "/secrets/example",
      projectId: "prj_example",
      version: "v-test",
    });
    const secretProcessor = registry.register(
      new SecretProcessor({ stream, path: "/secrets/example", projectId: "prj_example" }),
    );
    const reads = registry.reads(secretProcessor);
    const facade = new StreamProcessorRpcTarget(reads, {
      catchUpBeforeSnapshot: () => registry.catchUp(SecretProcessorContract.slug),
      // The DO's describeSecretState redaction, reduced to the fact under
      // test: material must leave as hasMaterial, never as ciphertext.
      publicState: (state) => ({ hasMaterial: state.encryptedMaterial !== null }),
    });

    // The write: the DO's update() appends to the stream. NO push delivery
    // ever runs in this test, so the read below sees the write purely through
    // the pull-through (registry.catchUp) driving the RUNNER's cursors.
    await stream.append({
      type: "events.iterate.com/secret/updated",
      payload: {
        egress: { urls: ["https://api.example.com"] },
        encryptedMaterial: ENCRYPTED_MATERIAL,
      },
    });
    await expect(facade.snapshot()).resolves.toEqual({
      offset: 1,
      state: { hasMaterial: true },
    });

    // The next write is seen by the very next read — the DO's
    // update()-then-describe() loop (every material-less update destroys
    // retained material, so the projection flips back).
    await stream.append({ type: "events.iterate.com/secret/updated", payload: {} });
    await expect(facade.snapshot()).resolves.toEqual({
      offset: 2,
      state: { hasMaterial: false },
    });

    // The runner-backed offset-wait short-circuits on committed progress —
    // the third read of the StreamProcessorRpc contract, same provider.
    await expect(reads.waitUntilEvent({ offset: 2, timeoutMs: 1_000 })).resolves.toBeUndefined();
  });
});
