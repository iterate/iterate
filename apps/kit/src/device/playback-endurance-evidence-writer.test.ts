import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PlaybackEnduranceJsonlEvidenceWriter } from "./playback-endurance-evidence-writer.ts";
import type { PlaybackEnduranceRunManifest } from "./playback-endurance-ladder.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("playback endurance JSONL evidence writer", () => {
  test("durably separates raw callback records from judged stage manifests", async () => {
    /*
     * Raw callbacks must survive a later analyzer or policy failure, while
     * manifests should remain one self-contained record per completed stage.
     * Separate append-only files preserve both timelines without retaining a
     * ten-minute callback history solely in the Node heap.
     */
    const root = await mkdtemp(join(tmpdir(), "iterate-endurance-writer-test-"));
    temporaryDirectories.push(root);
    const writer = PlaybackEnduranceJsonlEvidenceWriter.open(root);
    writer.append({
      hostReceivedAtMonotonicMs: 10,
      report: {
        deviceBootId: "boot-001",
        deviceProducedAtMonotonicMs: 20,
        deviceSequence: 3,
        values: { free_internal_heap_bytes: 200_000 },
      },
      runId: "run-001",
      schemaVersion: 1,
    });
    writer.appendManifest({
      durationMs: 60_000,
      ladderIndex: 0,
      schemaVersion: 1,
    } as PlaybackEnduranceRunManifest);
    writer[Symbol.dispose]();

    expect(
      (await readFile(writer.rawMetricsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        hostReceivedAtMonotonicMs: 10,
        report: {
          deviceBootId: "boot-001",
          deviceProducedAtMonotonicMs: 20,
          deviceSequence: 3,
          values: { free_internal_heap_bytes: 200_000 },
        },
        runId: "run-001",
        schemaVersion: 1,
      },
    ]);
    expect(
      (await readFile(writer.manifestsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        durationMs: 60_000,
        ladderIndex: 0,
        schemaVersion: 1,
      },
    ]);
  });

  test("fails closed after disposal instead of silently dropping late evidence", async () => {
    /*
     * A callback can race teardown. Treating a closed descriptor as a no-op
     * would make the retained file appear complete, so late writes are an
     * explicit harness failure.
     */
    const root = await mkdtemp(join(tmpdir(), "iterate-endurance-writer-test-"));
    temporaryDirectories.push(root);
    const writer = PlaybackEnduranceJsonlEvidenceWriter.open(root);
    writer[Symbol.dispose]();

    expect(() =>
      writer.append({
        hostReceivedAtMonotonicMs: 0,
        report: {
          deviceBootId: "boot-001",
          deviceProducedAtMonotonicMs: 0,
          deviceSequence: 0,
          values: {},
        },
        runId: "late",
        schemaVersion: 1,
      }),
    ).toThrow("evidence writer is closed");
  });
});
