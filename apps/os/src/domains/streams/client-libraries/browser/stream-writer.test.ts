import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireWriterRole,
  findNewerStreamDatabaseWriterLock,
  processorSchemaVersionKey,
  parseProcessorSchemaVersionKey,
  streamDatabaseWriterLockName,
  hasNewerSharedProcessorSchema,
} from "./stream-writer.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("acquireWriterRole", () => {
  it("does not release a granted lock until registered writer setup work settles", async () => {
    let lockCallbackFinished = false;
    const request = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        callback: () => Promise<void>,
      ): Promise<void> => {
        await callback();
        lockCallbackFinished = true;
      },
    );
    vi.stubGlobal("navigator", { locks: { request } });

    const role = acquireWriterRole({ lockName: "test-writer" });
    await role.whenWriter;
    const setup = deferred();
    role.holdUntil(setup.promise);

    role.release();
    await Promise.resolve();
    expect(lockCallbackFinished).toBe(false);

    setup.resolve(undefined);
    await vi.waitFor(() => expect(lockCallbackFinished).toBe(true));
  });
});

describe("processorSchemaVersionKey", () => {
  it("is deterministic regardless of processor order", () => {
    const forward = processorSchemaVersionKey([
      { slug: "browser-raw-events", schemaVersion: 2 },
      { slug: "browser-feed", schemaVersion: 6 },
    ]);
    const reversed = processorSchemaVersionKey([
      { slug: "browser-feed", schemaVersion: 6 },
      { slug: "browser-raw-events", schemaVersion: 2 },
    ]);
    expect(forward).toBe("browser-feed@6|browser-raw-events@2");
    expect(reversed).toBe(forward);
  });
});

describe("parseProcessorSchemaVersionKey", () => {
  it("round-trips a built key", () => {
    const schemaKey = processorSchemaVersionKey([
      { slug: "browser-feed", schemaVersion: 6 },
      { slug: "browser-raw-events", schemaVersion: 2 },
    ]);
    expect(parseProcessorSchemaVersionKey(schemaKey)).toEqual(
      new Map([
        ["browser-feed", 6],
        ["browser-raw-events", 2],
      ]),
    );
  });

  it("skips malformed entries instead of corrupting the comparison", () => {
    expect(parseProcessorSchemaVersionKey("browser-feed@6|garbage|@3|no-version@x")).toEqual(
      new Map([["browser-feed", 6]]),
    );
  });
});

describe("hasNewerSharedProcessorSchema", () => {
  const schemaKeyV5 = "browser-feed@5|browser-raw-events@2";
  const schemaKeyV6 = "browser-feed@6|browser-raw-events@2";

  it("detects a newer version of a shared processor", () => {
    expect(hasNewerSharedProcessorSchema(schemaKeyV6, schemaKeyV5)).toBe(true);
  });

  it("does not report an older schema as newer", () => {
    expect(hasNewerSharedProcessorSchema(schemaKeyV5, schemaKeyV6)).toBe(false);
  });

  it("does not report an identical key as newer", () => {
    expect(hasNewerSharedProcessorSchema(schemaKeyV6, schemaKeyV6)).toBe(false);
  });

  it("does not order keys when one shared processor is newer and another is older", () => {
    const mixedSchemaKeyA = "browser-feed@6|browser-raw-events@1";
    const mixedSchemaKeyB = "browser-feed@5|browser-raw-events@2";
    expect(hasNewerSharedProcessorSchema(mixedSchemaKeyA, mixedSchemaKeyB)).toBe(false);
    expect(hasNewerSharedProcessorSchema(mixedSchemaKeyB, mixedSchemaKeyA)).toBe(false);
  });

  it("does not order keys with no shared processors", () => {
    expect(hasNewerSharedProcessorSchema("other-processor@9", schemaKeyV5)).toBe(false);
  });

  it("ignores an added processor but detects a shared processor version increase", () => {
    const withExtraSameVersions = "browser-feed@5|browser-raw-events@2|new-processor@1";
    const withExtraAndBump = "browser-feed@6|browser-raw-events@2|new-processor@1";
    expect(hasNewerSharedProcessorSchema(withExtraSameVersions, schemaKeyV5)).toBe(false);
    expect(hasNewerSharedProcessorSchema(withExtraAndBump, schemaKeyV5)).toBe(true);
  });
});

describe("findNewerStreamDatabaseWriterLock", () => {
  const stream = { projectId: "prj_1", streamPath: "/agents/demo" };
  const oldSchemaKey = "browser-feed@5|browser-raw-events@2";
  const newSchemaKey = "browser-feed@6|browser-raw-events@2";
  const lockName = (processorSchemaVersionKey: string) =>
    streamDatabaseWriterLockName({ ...stream, processorSchemaVersionKey });

  it("finds a live newer-deploy writer from the stale tab's point of view", async () => {
    await expect(
      findNewerStreamDatabaseWriterLock({
        ...stream,
        processorSchemaVersionKey: oldSchemaKey,
        queryLocks: async () => ({
          held: [
            { name: lockName(oldSchemaKey), mode: "exclusive" },
            { name: lockName(newSchemaKey), mode: "exclusive" },
          ],
        }),
      }),
    ).resolves.toBe(lockName(newSchemaKey));
  });

  it("the fresh tab does not resign to the stale tab's lock", async () => {
    await expect(
      findNewerStreamDatabaseWriterLock({
        ...stream,
        processorSchemaVersionKey: newSchemaKey,
        queryLocks: async () => ({
          held: [
            { name: lockName(oldSchemaKey), mode: "exclusive" },
            { name: lockName(newSchemaKey), mode: "exclusive" },
          ],
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores our own lock and other streams' locks", async () => {
    await expect(
      findNewerStreamDatabaseWriterLock({
        ...stream,
        processorSchemaVersionKey: oldSchemaKey,
        queryLocks: async () => ({
          held: [
            { name: lockName(oldSchemaKey), mode: "exclusive" },
            {
              name: streamDatabaseWriterLockName({
                projectId: "prj_1",
                streamPath: "/agents/another",
                processorSchemaVersionKey: newSchemaKey,
              }),
              mode: "exclusive",
            },
            { name: "some-unrelated-lock", mode: "exclusive" },
          ],
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores shared holders — a resigned tab's death watch must not read as a live writer", async () => {
    await expect(
      findNewerStreamDatabaseWriterLock({
        ...stream,
        processorSchemaVersionKey: oldSchemaKey,
        queryLocks: async () => ({
          held: [{ name: lockName(newSchemaKey), mode: "shared" }],
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("answers undefined when the query fails (no evidence ⇒ keep today's rebuild behavior)", async () => {
    await expect(
      findNewerStreamDatabaseWriterLock({
        ...stream,
        processorSchemaVersionKey: oldSchemaKey,
        queryLocks: async () => {
          throw new Error("locks API unavailable");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
