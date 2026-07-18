import { describe, expect, it } from "vitest";
import {
  findSupersedingMirrorWriterLock,
  mirrorLockVersionVector,
  parseLockVersionVector,
  streamMirrorWriterLockName,
  vectorSupersedes,
} from "./stream-leader.ts";

describe("mirrorLockVersionVector", () => {
  it("is deterministic regardless of member order", () => {
    const forward = mirrorLockVersionVector([
      { slug: "browser-raw-events", schemaVersion: 2 },
      { slug: "browser-feed", schemaVersion: 6 },
    ]);
    const reversed = mirrorLockVersionVector([
      { slug: "browser-feed", schemaVersion: 6 },
      { slug: "browser-raw-events", schemaVersion: 2 },
    ]);
    expect(forward).toBe("browser-feed@6|browser-raw-events@2");
    expect(reversed).toBe(forward);
  });
});

describe("parseLockVersionVector", () => {
  it("round-trips a built vector", () => {
    const vector = mirrorLockVersionVector([
      { slug: "browser-feed", schemaVersion: 6 },
      { slug: "browser-raw-events", schemaVersion: 2 },
    ]);
    expect(parseLockVersionVector(vector)).toEqual(
      new Map([
        ["browser-feed", 6],
        ["browser-raw-events", 2],
      ]),
    );
  });

  it("skips malformed entries instead of poisoning the comparison", () => {
    expect(parseLockVersionVector("browser-feed@6|garbage|@3|no-version@x")).toEqual(
      new Map([["browser-feed", 6]]),
    );
  });
});

describe("vectorSupersedes", () => {
  const v5 = "browser-feed@5|browser-raw-events@2";
  const v6 = "browser-feed@6|browser-raw-events@2";

  it("a bumped shared member supersedes (the deploy-boundary case)", () => {
    expect(vectorSupersedes(v6, v5)).toBe(true);
  });

  it("never supersedes in the other direction (the stale tab must lose)", () => {
    expect(vectorSupersedes(v5, v6)).toBe(false);
  });

  it("an identical vector never supersedes", () => {
    expect(vectorSupersedes(v6, v6)).toBe(false);
  });

  it("mixed vectors (one member ahead, one behind) supersede in neither direction", () => {
    const mixedA = "browser-feed@6|browser-raw-events@1";
    const mixedB = "browser-feed@5|browser-raw-events@2";
    expect(vectorSupersedes(mixedA, mixedB)).toBe(false);
    expect(vectorSupersedes(mixedB, mixedA)).toBe(false);
  });

  it("disjoint member sets are incomparable", () => {
    expect(vectorSupersedes("other-member@9", v5)).toBe(false);
  });

  it("an added member alone does not supersede; an added member plus a shared bump does", () => {
    const withExtraSameVersions = "browser-feed@5|browser-raw-events@2|new-member@1";
    const withExtraAndBump = "browser-feed@6|browser-raw-events@2|new-member@1";
    expect(vectorSupersedes(withExtraSameVersions, v5)).toBe(false);
    expect(vectorSupersedes(withExtraAndBump, v5)).toBe(true);
  });
});

describe("findSupersedingMirrorWriterLock", () => {
  const stream = { projectId: "prj_1", streamPath: "/agents/onboarding" };
  const oldVector = "browser-feed@5|browser-raw-events@2";
  const newVector = "browser-feed@6|browser-raw-events@2";
  const lockName = (versionVector: string) =>
    streamMirrorWriterLockName({ ...stream, versionVector });

  it("finds a live newer-deploy writer from the stale tab's point of view", async () => {
    await expect(
      findSupersedingMirrorWriterLock({
        ...stream,
        versionVector: oldVector,
        queryLocks: async () => ({
          held: [
            { name: lockName(oldVector), mode: "exclusive" },
            { name: lockName(newVector), mode: "exclusive" },
          ],
        }),
      }),
    ).resolves.toBe(lockName(newVector));
  });

  it("the fresh tab does not resign to the stale tab's lock", async () => {
    await expect(
      findSupersedingMirrorWriterLock({
        ...stream,
        versionVector: newVector,
        queryLocks: async () => ({
          held: [
            { name: lockName(oldVector), mode: "exclusive" },
            { name: lockName(newVector), mode: "exclusive" },
          ],
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores our own lock and other streams' locks", async () => {
    await expect(
      findSupersedingMirrorWriterLock({
        ...stream,
        versionVector: oldVector,
        queryLocks: async () => ({
          held: [
            { name: lockName(oldVector), mode: "exclusive" },
            {
              name: streamMirrorWriterLockName({
                projectId: "prj_1",
                streamPath: "/agents/another",
                versionVector: newVector,
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
      findSupersedingMirrorWriterLock({
        ...stream,
        versionVector: oldVector,
        queryLocks: async () => ({
          held: [{ name: lockName(newVector), mode: "shared" }],
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("answers undefined when the query fails (no evidence ⇒ keep today's rebuild behavior)", async () => {
    await expect(
      findSupersedingMirrorWriterLock({
        ...stream,
        versionVector: oldVector,
        queryLocks: async () => {
          throw new Error("locks API unavailable");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
