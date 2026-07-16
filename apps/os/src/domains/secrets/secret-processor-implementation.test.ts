import { describe, expect, test } from "vitest";
import type { StreamEvent } from "iterate/stream-events";
import { StreamProcessorRunner } from "iterate/stream-processor-runner";
import { createStreamProcessorRegistry } from "iterate/stream-processor-registry";
import { MemoryStream } from "../streams/test-helpers.ts";
import type { Stream } from "../../itx-api.generated.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { SecretProcessorContract } from "./secret-processor-contract.ts";
import { SecretProcessor } from "./secret-processor-implementation.ts";

const neverStream = new Proxy({} as Stream, {
  get(_target, property) {
    throw new Error(`Unexpected stream access: ${String(property)}`);
  },
});

/** REAL runner drive with hand-built frames (offsets preserved verbatim);
 * the never-stream proves the fold makes no stream calls of its own. */
function subject() {
  const processor = new SecretProcessor({
    path: "/secrets/example",
    projectId: "prj_example",
    stream: neverStream,
  });
  const runner = new StreamProcessorRunner({ processor, stream: neverStream });
  return {
    async deliver(frame: { events: StreamEvent[]; streamMaxOffset: number }) {
      const opened = await runner.openDelivery();
      await opened.sink({
        ...frame,
        scannedAfterOffset: opened.checkpointOffset,
        scannedThroughOffset: frame.events.at(-1)?.offset ?? opened.checkpointOffset,
      });
    },
    snapshot: () => runner.snapshot(),
  };
}

function updated(offset: number, payload: Record<string, unknown>): StreamEvent {
  return {
    createdAt: new Date(offset).toISOString(),
    offset,
    path: "/secrets/example",
    payload,
    type: "events.iterate.com/secret/updated",
  };
}

const encryptedMaterial = {
  algorithm: "AES-GCM-SHA256+SECRET-CELL-V1",
  ciphertext: "ciphertext",
  iv: "initialization-vector",
} as const;

describe("SecretProcessor material decisions", () => {
  test("records the committed offset with material", async () => {
    const driver = subject();
    await driver.deliver({
      events: [
        updated(7, {
          egress: { urls: ["https://api.example.com"] },
          encryptedMaterial,
        }),
      ],
      streamMaxOffset: 7,
    });

    await expect(driver.snapshot()).resolves.toMatchObject({
      state: { encryptedMaterial: { ...encryptedMaterial, offset: 7 }, updatedOffset: 7 },
    });
  });

  test("every material-less update clears retained material", async () => {
    const driver = subject();
    await driver.deliver({
      events: [
        updated(1, {
          egress: { urls: ["https://api.example.com"] },
          encryptedMaterial,
        }),
        updated(2, {
          refresh: null,
        }),
      ],
      streamMaxOffset: 2,
    });

    await expect(driver.snapshot()).resolves.toMatchObject({
      offset: 2,
      state: { encryptedMaterial: null, refresh: null, updatedOffset: 2 },
    });
  });
});

// The secret DO's registry wiring (secret-durable-object.ts), minus the
// uninstantiable DurableObject shell: REAL registry + REAL runner + REAL
// SecretProcessor over an in-memory journal, with the reads and the
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
      payload: { egress: { urls: ["https://api.example.com"] }, encryptedMaterial },
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
