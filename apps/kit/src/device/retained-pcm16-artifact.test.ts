import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { inspectRetainedPcm16Artifact } from "./retained-pcm16-artifact.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("retained PCM16 artifact inspection", () => {
  test("recomputes exact file identity through one bounded descriptor", async () => {
    /*
     * A transport adapter's reported source hash is not proof that it retained
     * the bytes it claims to have offered. The acceptance process must reopen
     * the artifact and derive its facts independently, while keeping memory
     * use constant as stages grow from one to ten minutes.
     */
    const directory = await mkdtemp(join(tmpdir(), "iterate-retained-pcm16-"));
    temporaryDirectories.push(directory);
    const artifactPath = join(directory, "source.pcm16le");
    await writeFile(artifactPath, Uint8Array.of(1, 2, 3, 4));

    await expect(
      inspectRetainedPcm16Artifact({
        artifactPath,
        readChunkBytes: 2,
      }),
    ).resolves.toEqual({
      byteLength: 4,
      maximumBufferedAudioBytes: 2,
      sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
    });
  });
});
