import { describe, expect, test } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { StreamProcessorRunner } from "iterate/processors";
import { MemoryStream } from "iterate/processors/testing";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import type { Stream } from "../../itx-api.generated.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { WorkspaceProcessorContract } from "./workspace-processor-contract.ts";
import { WorkspaceProcessor } from "./workspace-processor-implementation.ts";

const neverStream = new Proxy({} as Stream, {
  get(_target, property) {
    throw new Error(`Unexpected stream access: ${String(property)}`);
  },
});

const WORKSPACE_PATH = "/workspaces/example";

/** REAL runner drive with hand-built frames (offsets preserved verbatim);
 * the never-stream proves the fold makes no stream calls of its own. */
function subject() {
  const processor = new WorkspaceProcessor({
    path: WORKSPACE_PATH,
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

function event(offset: number, type: string, payload: Record<string, unknown>): StreamEvent {
  return {
    createdAt: new Date(offset).toISOString(),
    offset,
    path: WORKSPACE_PATH,
    payload,
    type,
  };
}

const configMount = { policy: "commit-to-main", repoPath: "/repos/config" } as const;
const iterateMount = { policy: "read-only", repoPath: "/repos/iterate" } as const;

describe("WorkspaceProcessor fold", () => {
  test("created folds the birth certificate and its config", async () => {
    const driver = subject();
    await driver.deliver({
      events: [
        event(1, "events.iterate.com/workspace/created", {
          config: { mounts: { "/": configMount, "/iterate": iterateMount } },
        }),
      ],
      streamMaxOffset: 1,
    });

    await expect(driver.snapshot()).resolves.toMatchObject({
      state: {
        birthCertificate: { config: { mounts: { "/": configMount, "/iterate": iterateMount } } },
        config: { mounts: { "/": configMount, "/iterate": iterateMount } },
      },
    });
  });

  test("a configured patch deep-merges per mount: partial edit, add, and null-unmount", async () => {
    const driver = subject();
    await driver.deliver({
      events: [
        event(1, "events.iterate.com/workspace/created", {
          config: { mounts: { "/": configMount, "/iterate": iterateMount } },
        }),
        event(2, "events.iterate.com/workspace/configured", {
          config: {
            mounts: {
              // Partial value: only the policy flips, repoPath is retained.
              "/iterate": { policy: "commit-to-main" },
              // Unknown key: adds a mount.
              "/docs": { policy: "read-only", repoPath: "/repos/docs" },
              // null: unmounts.
              "/": null,
            },
          },
        }),
      ],
      streamMaxOffset: 2,
    });

    await expect(driver.snapshot()).resolves.toMatchObject({
      offset: 2,
      state: {
        birthCertificate: { config: { mounts: { "/": configMount, "/iterate": iterateMount } } },
        config: {
          mounts: {
            "/docs": { policy: "read-only", repoPath: "/repos/docs" },
            "/iterate": { policy: "commit-to-main", repoPath: "/repos/iterate" },
          },
        },
      },
    });
  });
});

// The workspace DO's registry wiring, minus the uninstantiable DurableObject
// shell: REAL registry + REAL runner over an in-memory journal, with the reads
// and facade built exactly as the DO builds them — pins configure()'s
// read-your-writes path (catchUp + runner-backed reads).
describe("registry + runner drive (the workspace DO's wiring)", () => {
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

  test("create-then-configure is read-your-writes through catchUp + runner-backed reads", async () => {
    const stream = new MemoryStream(WORKSPACE_PATH);
    const registry = createStreamProcessorRegistry(fakeDurableObjectState(), {
      stream,
      path: WORKSPACE_PATH,
      projectId: "prj_example",
      version: "v-test",
    });
    const workspaceProcessor = registry.register(
      new WorkspaceProcessor({ stream, path: WORKSPACE_PATH, projectId: "prj_example" }),
    );
    const reads = registry.reads(workspaceProcessor);
    const facade = new StreamProcessorRpcTarget(reads, {
      catchUpBeforeSnapshot: () => registry.catchUp(WorkspaceProcessorContract.slug),
    });

    await stream.append({
      type: "events.iterate.com/workspace/created",
      payload: { config: { mounts: { "/": configMount } } },
    });
    await expect(facade.snapshot()).resolves.toMatchObject({
      offset: 1,
      state: { config: { mounts: { "/": configMount } } },
    });

    await stream.append({
      type: "events.iterate.com/workspace/configured",
      payload: { config: { mounts: { "/iterate": iterateMount } } },
    });
    await expect(facade.snapshot()).resolves.toMatchObject({
      offset: 2,
      state: { config: { mounts: { "/": configMount, "/iterate": iterateMount } } },
    });
    await expect(reads.waitUntilEvent({ offset: 2, timeoutMs: 1_000 })).resolves.toBeUndefined();
  });
});

describe("fold safety (thermo regressions)", () => {
  test("a SECOND created event is skipped — the first certificate wins, the fold never wedges", async () => {
    const driver = subject();
    await driver.deliver({
      events: [
        event(1, "events.iterate.com/workspace/created", {
          config: { mounts: { "/": configMount } },
        }),
        // Raw append under a different idempotency key: schema-valid, must
        // fold as a no-op rather than throwing the cursor into a wedge.
        event(2, "events.iterate.com/workspace/created", {
          config: { mounts: { "/other": iterateMount } },
        }),
      ],
      streamMaxOffset: 2,
    });
    await expect(driver.snapshot()).resolves.toMatchObject({
      offset: 2,
      state: {
        birthCertificate: { config: { mounts: { "/": configMount } } },
        config: { mounts: { "/": configMount } },
      },
    });
  });

  test("a patch adding an INCOMPLETE mount folds without wedging — the entry is dropped", async () => {
    const driver = subject();
    await driver.deliver({
      events: [
        event(1, "events.iterate.com/workspace/created", {
          config: { mounts: { "/": configMount } },
        }),
        // Schema-valid (partial values are legal patch entries) but there is
        // no existing "/new" mount to merge into — a raw append can commit
        // this, and the fold must skip the entry, not throw.
        event(2, "events.iterate.com/workspace/configured", {
          config: { mounts: { "/new": { policy: "read-only" } } },
        }),
        // The fold keeps advancing past it.
        event(3, "events.iterate.com/workspace/configured", {
          config: { mounts: { "/docs": { policy: "read-only", repoPath: "/repos/docs" } } },
        }),
      ],
      streamMaxOffset: 3,
    });
    await expect(driver.snapshot()).resolves.toMatchObject({
      offset: 3,
      state: {
        config: {
          mounts: {
            "/": configMount,
            "/docs": { policy: "read-only", repoPath: "/repos/docs" },
          },
        },
      },
    });
  });

  test("a NON-CANONICAL raw event fails the contract parse and is skipped, not folded", async () => {
    const driver = subject();
    await driver.deliver({
      events: [
        event(1, "events.iterate.com/workspace/created", {
          config: { mounts: { "/": configMount } },
        }),
        // Aliasing spelling ("/docs/" vs "/docs") and a codec-unsafe repoPath:
        // both fail the payload schema, so the runner records a parse failure
        // and the fold never sees the event.
        event(2, "events.iterate.com/workspace/configured", {
          config: { mounts: { "/docs/": { policy: "read-only", repoPath: "/repos/docs" } } },
        }),
        event(3, "events.iterate.com/workspace/configured", {
          config: { mounts: { "/evil": { policy: "read-only", repoPath: "/repos/b?alias=1" } } },
        }),
      ],
      streamMaxOffset: 3,
    });
    await expect(driver.snapshot()).resolves.toMatchObject({
      offset: 3,
      state: { config: { mounts: { "/": configMount } } },
    });
  });
});
