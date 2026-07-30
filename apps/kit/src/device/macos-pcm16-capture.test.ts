import { chmod, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decodePcm16Le, inspectPcm16Artifact, MacOsPcm16Capture } from "./macos-pcm16-capture.ts";

describe("macOS PCM16 microphone capture", () => {
  test("completes a ten-minute capture as artifact metadata rather than decoded PCM", async () => {
    /*
     * Capture completion is on the critical path of the ten-minute proof.
     * Returning `samples` here would force Buffer + Int16Array materialization
     * before the bounded analyzer ever sees the artifact. A sparse file keeps
     * this test fast while preserving the production byte count: 57.6 MB at
     * 48 kHz mono PCM16.
     */
    const directory = await mkdtemp(join(tmpdir(), "iterate-kit-capture-inspection-"));
    const artifactPath = join(directory, "microphone.pcm16le");
    const artifact = await open(artifactPath, "w");
    try {
      await artifact.truncate(57_600_000);
    } finally {
      await artifact.close();
    }

    try {
      const completed = await inspectPcm16Artifact(artifactPath, 48_000);
      expect(completed).toEqual({
        artifactPath,
        capturedByteLength: 57_600_000,
        capturedSampleCount: 28_800_000,
        sampleRateHz: 48_000,
      });
      expect("samples" in completed).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("decodes the artifact using the wire byte order rather than host endianness", () => {
    /*
     * The acoustic artifact is an independent physical oracle and may be
     * inspected on a machine with different native byte order. Reinterpreting
     * Buffer storage as Int16Array would make that oracle host-dependent, so
     * retain an explicit little-endian boundary just like the device protocol.
     */
    expect([...decodePcm16Le(Uint8Array.of(0x00, 0x80, 0xff, 0xff, 0x34, 0x12))]).toEqual([
      -32_768, -1, 0x1234,
    ]);
  });

  test("rejects a truncated sample instead of silently dropping acoustic evidence", () => {
    expect(() => decodePcm16Le(Uint8Array.of(0x01))).toThrow("whole PCM16 samples");
  });

  test.runIf(process.platform === "darwin")(
    "records stable microphone identity and forcibly terminates a wedged recorder",
    async () => {
      /*
       * AVFoundation's ':0' index can change whenever the USB hub is replugged,
       * and ffmpeg can wedge while draining. Acceptance therefore needs both
       * the resolved CoreAudio identity and a hard shutdown bound; retaining a
       * path while leaking the recorder process is not a completed proof.
       */
      const directory = await mkdtemp(join(tmpdir(), "iterate-kit-capture-process-"));
      const executable = join(directory, "fake-ffmpeg.mjs");
      await writeFile(
        executable,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv[2] === "-version") {
  console.log("ffmpeg version fake-endurance-1");
  process.exit(0);
}
writeFileSync(process.argv.at(-1), Buffer.alloc(9600));
process.on("SIGINT", () => {});
setInterval(() => {}, 1000);
`,
      );
      await chmod(executable, 0o700);

      try {
        const capture = await MacOsPcm16Capture.start({
          ffmpegExecutable: executable,
          inputIdentity: {
            avFoundationSpecifier: ":3",
            displayName: "MacBook Pro Microphone",
            stableId: "AppleUSBAudioEngine:mic-001",
            verification: "caller-asserted-coreaudio-uid",
          },
          outputDirectory: directory,
          processing: {
            activeMicrophoneMode: "wide-spectrum",
            preferredMicrophoneMode: "wide-spectrum",
            verification: "unverified",
          },
          resolveInputIdentity: async (claim) => ({
            ...claim,
            verification: "host-resolved-coreaudio-uid",
          }),
          verifyProcessing: async (claim) => ({
            ...claim,
            verification: "host-resolved-avfoundation-microphone-mode",
          }),
        });

        expect(capture.captureProvenance).toMatchObject({
          input: {
            avFoundationSpecifier: ":3",
            stableId: "AppleUSBAudioEngine:mic-001",
            verification: "host-resolved-coreaudio-uid",
          },
          processing: {
            activeMicrophoneMode: "wide-spectrum",
            preferredMicrophoneMode: "wide-spectrum",
            verification: "host-resolved-avfoundation-microphone-mode",
          },
          recorder: {
            executable,
            version: "ffmpeg version fake-endurance-1",
          },
        });
        const stoppedAt = performance.now();
        await expect(capture.stop()).rejects.toThrow("forcibly terminated with SIGKILL");
        expect(performance.now() - stoppedAt).toBeLessThan(7_000);
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
    10_000,
  );

  test.runIf(process.platform === "darwin")(
    "rejects a claimed stable input with no stable identifier",
    async () => {
      await expect(
        MacOsPcm16Capture.start({
          inputIdentity: {
            avFoundationSpecifier: ":0",
            displayName: "Unnamed microphone",
            stableId: "",
            verification: "caller-asserted-coreaudio-uid",
          },
        }),
      ).rejects.toThrow("stable input ID");
    },
  );

  test.runIf(process.platform === "darwin")(
    "does not let caller labels impersonate host verification",
    async () => {
      /*
       * Provenance enums cross a trust boundary. Merely spelling a value
       * "host-resolved" must not bless caller JSON; only successful execution
       * of the corresponding resolver/verifier seam may produce that label.
       */
      await expect(
        MacOsPcm16Capture.start({
          inputIdentity: {
            avFoundationSpecifier: ":0",
            displayName: "Claimed microphone",
            stableId: "claimed-uid",
            verification: "host-resolved-coreaudio-uid",
          },
        }),
      ).rejects.toThrow("requires an input identity resolver");

      await expect(
        MacOsPcm16Capture.start({
          processing: {
            activeMicrophoneMode: "wide-spectrum",
            preferredMicrophoneMode: "wide-spectrum",
            verification: "host-resolved-avfoundation-microphone-mode",
          },
        }),
      ).rejects.toThrow("requires a processing verifier");
    },
  );

  test.runIf(process.platform === "darwin")(
    "kills a recorder that wedges before startup can return an owner",
    async () => {
      /*
       * A readiness timeout happens inside start(), before the caller receives
       * a capture object and therefore before it can call stop(). The startup
       * path must own the same bounded SIGINT→SIGKILL escalation or one bad
       * microphone open can leak ffmpeg across every later endurance stage.
       */
      const directory = await mkdtemp(join(tmpdir(), "iterate-kit-capture-startup-"));
      const executable = join(directory, "fake-ffmpeg.mjs");
      const pidPath = join(directory, "capture.pid");
      await writeFile(
        executable,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv[2] === "-version") {
  console.log("ffmpeg version fake-startup-wedge-1");
  process.exit(0);
}
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGINT", () => {});
setInterval(() => {}, 1000);
`,
      );
      await chmod(executable, 0o700);

      try {
        const startedAt = performance.now();
        await expect(
          MacOsPcm16Capture.start({
            ffmpegExecutable: executable,
            inputIdentity: {
              avFoundationSpecifier: ":3",
              displayName: "MacBook Pro Microphone",
              stableId: "AppleUSBAudioEngine:mic-001",
              verification: "caller-asserted-coreaudio-uid",
            },
            outputDirectory: directory,
            resolveInputIdentity: async (claim) => ({
              ...claim,
              verification: "host-resolved-coreaudio-uid",
            }),
          }),
        ).rejects.toThrow("required SIGKILL during startup cleanup");
        expect(performance.now() - startedAt).toBeLessThan(12_000);

        const childPid = Number(await readFile(pidPath, "utf8"));
        expect(Number.isSafeInteger(childPid)).toBe(true);
        expect(() => process.kill(childPid, 0)).toThrow();
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
    13_000,
  );
});
