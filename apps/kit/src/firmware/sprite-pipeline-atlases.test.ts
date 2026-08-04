import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pipelineDirectory = resolve(packageDirectory, "tools/sprite-pipeline");

describe("sprite pipeline atlases", () => {
  // Timeout: a pure-stdlib Python rebuild of four characters, each built twice
  // by the pipeline's internal determinism verification; measured ~55s locally.
  test(
    "committed firmware atlases match a rebuild from tracked sources",
    { timeout: 240_000 },
    () => {
      /*
       * `publish --check` reassembles every characters/<id> avatar from its
       * tracked avatar.json + source PNGs, builds each atlas twice (the
       * pipeline's own determinism gate), and byte-compares the would-be
       * installed .c/.h pairs plus the generated catalogue against
       * firmware/components/avatar. Drift between tracked sources and the
       * committed atlases fails here rather than on a device.
       */
      const result = spawnSync("python3", ["avatar_pipeline.py", "publish", "--check"], {
        cwd: pipelineDirectory,
        encoding: "utf8",
      });
      expect(
        result.error,
        "python3 is required; the avatar atlas rebuild gate cannot run without it",
      ).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("match a clean rebuild from sources");
    },
  );
});
