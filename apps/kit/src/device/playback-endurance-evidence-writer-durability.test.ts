import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const durabilityTrace = vi.hoisted(() => ({
  descriptorPaths: new Map<number, string>(),
  fsyncPaths: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: ((...arguments_: unknown[]) => {
      const descriptor = arguments_[0] as number;
      durabilityTrace.fsyncPaths.push(
        durabilityTrace.descriptorPaths.get(descriptor) ?? `unknown:${descriptor}`,
      );
      return Reflect.apply(actual.fsyncSync, actual, arguments_);
    }) as typeof actual.fsyncSync,
    openSync: ((...arguments_: unknown[]) => {
      const descriptor = Reflect.apply(actual.openSync, actual, arguments_) as number;
      durabilityTrace.descriptorPaths.set(descriptor, String(arguments_[0]));
      return descriptor;
    }) as typeof actual.openSync,
  };
});

import { PlaybackEnduranceJsonlEvidenceWriter } from "./playback-endurance-evidence-writer.ts";
import type { PlaybackEnduranceRunManifest } from "./playback-endurance-ladder.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  durabilityTrace.descriptorPaths.clear();
  durabilityTrace.fsyncPaths.length = 0;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("persists raw callbacks before publishing their judged manifest", async () => {
  /*
   * A manifest is the commit record for one physical stage. If it reaches
   * disk before raw callbacks, host failure can leave apparently complete
   * acceptance evidence with its diagnostic history missing. This spies only
   * on barrier order while still executing real writes and real fsync calls.
   */
  const root = await mkdtemp(join(tmpdir(), "iterate-endurance-durability-test-"));
  temporaryDirectories.push(root);
  const writer = PlaybackEnduranceJsonlEvidenceWriter.open(root);
  try {
    writer.append({
      hostReceivedAtMonotonicMs: 0,
      report: {
        deviceBootId: "boot-001",
        deviceProducedAtMonotonicMs: 0,
        deviceSequence: 0,
        values: {},
      },
      runId: "run-001",
      schemaVersion: 1,
    });
    writer.appendManifest({
      durationMs: 60_000,
      ladderIndex: 0,
      schemaVersion: 1,
    } as PlaybackEnduranceRunManifest);
  } finally {
    writer[Symbol.dispose]();
  }

  expect(durabilityTrace.fsyncPaths.map((path) => basename(path))).toEqual([
    "raw-metrics.jsonl",
    "manifests.jsonl",
  ]);
});
