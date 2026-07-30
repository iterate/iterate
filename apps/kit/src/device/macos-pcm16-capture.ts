import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  readMacOsAvFoundationProcessingProvenance,
  resolveMacOsAvFoundationInputIdentity,
} from "./macos-avfoundation-provenance.ts";

export interface MacOsPcm16CaptureOptions {
  ffmpegExecutable?: string;
  input?: string;
  inputIdentity?: MacOsCaptureInputIdentity;
  resolveInputIdentity?: MacOsCaptureInputIdentityResolver;
  outputDirectory?: string;
  processing?: MacOsCaptureProcessingProvenance;
  verifyProcessing?: MacOsCaptureProcessingVerifier;
  sampleRateHz?: number;
}

export interface MacOsCaptureInputIdentity {
  avFoundationSpecifier: string;
  displayName: string;
  stableId: string;
  verification:
    | "caller-asserted-coreaudio-uid"
    | "host-resolved-coreaudio-uid"
    | "unverified-index";
}

export type MacOsMicrophoneMode = "standard" | "wide-spectrum" | "voice-isolation" | "unknown";

export interface MacOsCaptureProcessingProvenance {
  activeMicrophoneMode: MacOsMicrophoneMode;
  preferredMicrophoneMode: MacOsMicrophoneMode;
  verification: "host-resolved-avfoundation-microphone-mode" | "unverified";
}

export type MacOsCaptureInputIdentityResolver = (
  claim: Readonly<MacOsCaptureInputIdentity>,
) => Promise<MacOsCaptureInputIdentity>;

export type MacOsCaptureProcessingVerifier = (
  claim: Readonly<MacOsCaptureProcessingProvenance>,
) => Promise<MacOsCaptureProcessingProvenance>;

export interface MacOsCaptureProvenance {
  input: MacOsCaptureInputIdentity;
  processing: MacOsCaptureProcessingProvenance;
  recorder: {
    arguments: string[];
    executable: string;
    version: string;
  };
}

export interface Pcm16ArtifactInspection {
  artifactPath: string;
  capturedByteLength: number;
  capturedSampleCount: number;
  sampleRateHz: number;
}

export interface CompletedPcm16Capture extends Pcm16ArtifactInspection {
  captureProvenance: MacOsCaptureProvenance;
}

interface ProcessTermination {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const defaultFfmpegExecutable = "/opt/homebrew/bin/ffmpeg";
const defaultInput = ":0";
const defaultSampleRateHz = 48_000;
const startupEvidenceMs = 50;
const startupTimeoutMs = 5_000;
const shutdownTimeoutMs = 5_000;
const forcedShutdownTimeoutMs = 2_000;
const ffmpegVersionTimeoutMs = 2_000;
const maximumDiagnosticBytes = 32 * 1_024;
const execFileAsync = promisify(execFile);
const unknownProcessingProvenance: MacOsCaptureProcessingProvenance = Object.freeze({
  activeMicrophoneMode: "unknown",
  preferredMicrophoneMode: "unknown",
  verification: "unverified",
});

/**
 * Owns one bounded macOS microphone capture used as an acoustic oracle.
 *
 * Firmware queue metrics prove only that software handed bytes to a playback
 * API. The nearby Mac microphone closes the final gap: the test passes only
 * when those bytes became a continuous pressure wave. This recorder writes raw
 * mono PCM16LE so a ten-minute run consumes predictable disk (96 kB/s) without
 * retaining audio in the harness heap. The artifact intentionally survives the
 * run for spectrograms and postmortems.
 *
 * `start()` waits for actual file growth before returning; otherwise an
 * AVFoundation permission dialog or a wrong input index could let the device
 * finish before recording had begun. `stop()` is idempotent and sends SIGINT
 * so ffmpeg drains already-captured samples before the artifact is inspected.
 * Completion returns metadata, never decoded audio; the bounded artifact
 * analyzer owns disk reads after capture.
 */
export class MacOsPcm16Capture {
  readonly artifactPath: string;
  readonly captureProvenance: MacOsCaptureProvenance;
  readonly sampleRateHz: number;
  readonly #child: ChildProcess;
  readonly #termination: Promise<ProcessTermination>;
  #diagnostics = "";
  #launchFailure: Error | undefined;
  #stopPromise: Promise<CompletedPcm16Capture> | undefined;
  #terminated: ProcessTermination | undefined;

  private constructor(
    child: ChildProcess,
    artifactPath: string,
    sampleRateHz: number,
    captureProvenance: MacOsCaptureProvenance,
  ) {
    this.#child = child;
    this.artifactPath = artifactPath;
    this.sampleRateHz = sampleRateHz;
    this.captureProvenance = captureProvenance;
    this.#termination = new Promise<ProcessTermination>((resolve, reject) => {
      child.once("error", (error) => {
        this.#launchFailure = error;
        reject(error);
      });
      child.once("exit", (code, signal) => {
        const termination = { code, signal };
        this.#terminated = termination;
        resolve(termination);
      });
    });
    /*
     * ffmpeg runs at error log level, but a broken audio device can still
     * repeat diagnostics. Retain enough context to explain failure without
     * converting a long endurance run into an unbounded Node string.
     */
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (this.#diagnostics.length >= maximumDiagnosticBytes) return;
      this.#diagnostics += String(chunk).slice(
        0,
        maximumDiagnosticBytes - this.#diagnostics.length,
      );
    });
    /*
     * Start failures are observed explicitly by the readiness loop and by
     * stop(). Attach a rejection observer immediately so a missing executable
     * cannot become an unrelated unhandled-rejection warning.
     */
    void this.#termination.catch(() => {});
  }

  static async start(options: MacOsPcm16CaptureOptions = {}): Promise<MacOsPcm16Capture> {
    if (process.platform !== "darwin") {
      throw new Error("The physical acoustic recorder requires macOS AVFoundation.");
    }
    const sampleRateHz = options.sampleRateHz ?? defaultSampleRateHz;
    if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz <= 0) {
      throw new Error("The acoustic capture sample rate must be a positive integer.");
    }
    const ffmpegExecutable = options.ffmpegExecutable ?? defaultFfmpegExecutable;
    const ffmpegVersion = await readFfmpegVersion(ffmpegExecutable);
    const input = await resolveCaptureInput(options, ffmpegExecutable);
    const outputRoot = options.outputDirectory ?? tmpdir();
    await mkdir(outputRoot, { recursive: true });
    const directory = await mkdtemp(join(outputRoot, "iterate-kit-acoustic-"));
    const artifactPath = join(directory, "microphone.pcm16le");
    const ffmpegArguments = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "avfoundation",
      "-i",
      input.avFoundationSpecifier,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(sampleRateHz),
      "-acodec",
      "pcm_s16le",
      "-f",
      "s16le",
      artifactPath,
    ];
    const child = spawn(ffmpegExecutable, ffmpegArguments, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const capture = new MacOsPcm16Capture(child, artifactPath, sampleRateHz, {
      input,
      processing: unknownProcessingProvenance,
      recorder: {
        arguments: [...ffmpegArguments],
        executable: ffmpegExecutable,
        version: ffmpegVersion,
      },
    });
    try {
      await capture.#waitUntilRecording();
      /*
       * Query active mode only after ffmpeg has opened the microphone.
       * AVFoundation documents that active mode may differ from the user's
       * preferred mode when the active route does not support it; a pre-open
       * query could therefore bless the requested setting rather than the
       * capture chain that produced this artifact.
       */
      capture.captureProvenance.processing = await resolveCaptureProcessing(options);
      return capture;
    } catch (error) {
      if (!capture.#terminated) {
        await capture.#terminateFailedStartup();
      }
      throw error;
    }
  }

  stop() {
    this.#stopPromise ??= this.#finish();
    return this.#stopPromise;
  }

  async #waitUntilRecording() {
    const minimumBytes = (this.sampleRateHz * 2 * startupEvidenceMs) / 1_000;
    const deadline = performance.now() + startupTimeoutMs;
    while (performance.now() < deadline) {
      if (this.#launchFailure) {
        throw new Error(`Unable to start acoustic capture: ${this.#launchFailure.message}`);
      }
      if (this.#terminated) {
        throw new Error(this.#unexpectedTermination(this.#terminated));
      }
      try {
        const status = await stat(this.artifactPath);
        if (status.size >= minimumBytes) return;
      } catch {
        /*
         * ffmpeg creates the artifact after AVFoundation opens. Absence during
         * this bounded readiness window is expected; process termination and
         * the deadline distinguish a real failure from ordinary startup.
         */
      }
      await delay(25);
    }
    const forced = await this.#terminateFailedStartup();
    throw new Error(
      `Acoustic capture produced no samples within ${startupTimeoutMs} ms.` +
        (forced ? " The recorder required SIGKILL during startup cleanup." : "") +
        this.#diagnosticSuffix(),
    );
  }

  async #terminateFailedStartup() {
    if (this.#terminated) return false;
    this.#child.kill("SIGINT");
    try {
      await waitWithTimeout(
        this.#termination,
        shutdownTimeoutMs,
        "Timed out stopping the unready acoustic recorder.",
      );
      return false;
    } catch {
      /*
       * start() has not returned an owner that the caller can stop. Cleanup is
       * therefore our responsibility before rejecting; merely signalling and
       * throwing can leak a wedged ffmpeg process plus the microphone device.
       */
      this.#child.kill("SIGKILL");
      await waitWithTimeout(
        this.#termination,
        forcedShutdownTimeoutMs,
        "The unready acoustic recorder remained alive after SIGKILL.",
      );
      return true;
    }
  }

  async #finish(): Promise<CompletedPcm16Capture> {
    if (this.#launchFailure) {
      throw new Error(`Unable to start acoustic capture: ${this.#launchFailure.message}`);
    }
    if (!this.#terminated) this.#child.kill("SIGINT");
    let termination: ProcessTermination;
    try {
      termination = await waitWithTimeout(
        this.#termination,
        shutdownTimeoutMs,
        "Timed out stopping the acoustic recorder.",
      );
    } catch (error) {
      /*
       * An endurance CLI must not return while ffmpeg still owns the
       * microphone or artifact descriptor. Graceful SIGINT gets a fixed drain
       * budget; exceeding it is a failed run, followed by a separately bounded
       * SIGKILL solely to restore a known host state.
       */
      this.#child.kill("SIGKILL");
      await waitWithTimeout(
        this.#termination,
        forcedShutdownTimeoutMs,
        "The acoustic recorder remained alive after SIGKILL.",
      );
      const cause = error instanceof Error ? ` ${error.message}` : "";
      throw new Error(
        `The acoustic recorder was forcibly terminated with SIGKILL; ` +
          `the run is invalid and its partial artifact remains at ${this.artifactPath}.${cause}`,
      );
    }
    /*
     * ffmpeg commonly reports 255 when SIGINT requests a clean recording stop.
     * Accept that documented process convention, but keep every other exit
     * observable: a partially written file is not sufficient physical proof.
     */
    if (termination.code !== 0 && termination.code !== 255 && termination.signal !== "SIGINT") {
      throw new Error(this.#unexpectedTermination(termination));
    }
    return {
      ...(await inspectPcm16Artifact(this.artifactPath, this.sampleRateHz)),
      captureProvenance: structuredClone(this.captureProvenance),
    };
  }

  #unexpectedTermination(termination: ProcessTermination) {
    return (
      `The acoustic recorder stopped unexpectedly ` +
      `(code=${String(termination.code)} signal=${String(termination.signal)}).` +
      this.#diagnosticSuffix()
    );
  }

  #diagnosticSuffix() {
    const diagnostics = this.#diagnostics.trim();
    return diagnostics ? ` ffmpeg: ${diagnostics}` : "";
  }
}

/**
 * Validates capture completion without loading the recording.
 *
 * This function intentionally returns only file metadata. Reading 57.6 MB for
 * a ten-minute 48 kHz capture here would defeat the streaming analyzer by
 * creating both a whole-file Buffer and a whole-file Int16Array first.
 */
export async function inspectPcm16Artifact(
  artifactPath: string,
  sampleRateHz: number,
): Promise<Pcm16ArtifactInspection> {
  if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error("The acoustic capture sample rate must be a positive integer.");
  }
  const artifactStatus = await stat(artifactPath);
  if (artifactStatus.size === 0) {
    throw new Error("The acoustic recorder stopped without capturing samples.");
  }
  if (artifactStatus.size % 2 !== 0) {
    throw new Error("The acoustic artifact must contain whole PCM16 samples.");
  }
  return {
    artifactPath,
    capturedByteLength: artifactStatus.size,
    capturedSampleCount: artifactStatus.size / 2,
    sampleRateHz,
  };
}

async function resolveCaptureInput(
  options: MacOsPcm16CaptureOptions,
  ffmpegExecutable: string,
): Promise<MacOsCaptureInputIdentity> {
  const claim = options.inputIdentity ?? {
    avFoundationSpecifier: options.input ?? defaultInput,
    displayName: "unresolved AVFoundation input",
    stableId: `unverified-avfoundation:${options.input ?? defaultInput}`,
    verification: "unverified-index" as const,
  };
  assertCaptureInputIdentity(claim);
  if (options.input && options.input !== claim.avFoundationSpecifier) {
    throw new Error("The acoustic capture input disagrees with its claimed identity.");
  }
  if (
    !options.resolveInputIdentity &&
    options.inputIdentity?.verification === "host-resolved-coreaudio-uid"
  ) {
    throw new Error("Host-resolved acoustic input identity requires an input identity resolver.");
  }
  const resolver =
    options.resolveInputIdentity ??
    ((inputClaim: Readonly<MacOsCaptureInputIdentity>) =>
      resolveMacOsAvFoundationInputIdentity({
        claim: inputClaim,
        ffmpegExecutable,
      }));
  const resolved = await resolver(structuredClone(claim));
  assertCaptureInputIdentity(resolved);
  if (resolved.verification !== "host-resolved-coreaudio-uid") {
    throw new Error("The acoustic input resolver did not return host-resolved CoreAudio identity.");
  }
  if (resolved.avFoundationSpecifier !== claim.avFoundationSpecifier) {
    throw new Error("The resolved acoustic input does not match the requested AVFoundation input.");
  }
  if (
    claim.verification === "caller-asserted-coreaudio-uid" &&
    resolved.stableId !== claim.stableId
  ) {
    throw new Error("The host-resolved acoustic input does not match the expected stable ID.");
  }
  return structuredClone(resolved);
}

function assertCaptureInputIdentity(input: MacOsCaptureInputIdentity) {
  if (!input.avFoundationSpecifier.trim()) {
    throw new Error("The acoustic capture AVFoundation input specifier is required.");
  }
  if (!input.displayName.trim()) {
    throw new Error("The acoustic capture input display name is required.");
  }
  if (!input.stableId.trim()) {
    throw new Error("The acoustic capture stable input ID is required.");
  }
  if (
    input.verification !== "caller-asserted-coreaudio-uid" &&
    input.verification !== "host-resolved-coreaudio-uid" &&
    input.verification !== "unverified-index"
  ) {
    throw new Error("The acoustic capture input verification method is invalid.");
  }
}

async function resolveCaptureProcessing(
  options: MacOsPcm16CaptureOptions,
): Promise<MacOsCaptureProcessingProvenance> {
  const claim = options.processing ?? unknownProcessingProvenance;
  assertCaptureProcessingProvenance(claim);
  if (
    !options.verifyProcessing &&
    options.processing?.verification === "host-resolved-avfoundation-microphone-mode"
  ) {
    throw new Error("Host-resolved acoustic microphone mode requires a processing verifier.");
  }
  const verifier = options.verifyProcessing ?? (() => readMacOsAvFoundationProcessingProvenance());
  const resolved = await verifier(structuredClone(claim));
  assertCaptureProcessingProvenance(resolved);
  if (resolved.verification !== "host-resolved-avfoundation-microphone-mode") {
    throw new Error(
      "The acoustic processing verifier did not return a host-resolved AVFoundation " +
        "microphone mode.",
    );
  }
  return structuredClone(resolved);
}

function assertCaptureProcessingProvenance(provenance: MacOsCaptureProcessingProvenance) {
  for (const [name, value] of Object.entries(provenance)) {
    if (!String(value).trim()) {
      throw new Error(`The acoustic capture processing field ${name} is required.`);
    }
  }
  if (
    provenance.verification !== "host-resolved-avfoundation-microphone-mode" &&
    provenance.verification !== "unverified"
  ) {
    throw new Error("The acoustic capture processing verification method is invalid.");
  }
  for (const mode of [provenance.activeMicrophoneMode, provenance.preferredMicrophoneMode]) {
    if (
      mode !== "standard" &&
      mode !== "wide-spectrum" &&
      mode !== "voice-isolation" &&
      mode !== "unknown"
    ) {
      throw new Error("The acoustic capture microphone mode is invalid.");
    }
  }
}

async function readFfmpegVersion(executable: string) {
  if (!executable.trim()) {
    throw new Error("The acoustic recorder executable path is required.");
  }
  try {
    const { stdout } = await execFileAsync(executable, ["-version"], {
      encoding: "utf8",
      maxBuffer: 8 * 1_024,
      timeout: ffmpegVersionTimeoutMs,
    });
    const version = stdout.split(/\r?\n/, 1)[0]?.trim();
    if (!version) throw new Error("version output was empty");
    return version;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to identify the acoustic recorder: ${detail}`);
  }
}

/**
 * Decodes an on-disk PCM16LE artifact without assuming the host byte order.
 *
 * Keep this small-buffer utility for focused protocol tests and postmortem
 * snippets. Endurance code must use the streaming artifact analyzer instead.
 */
export function decodePcm16Le(encoded: Uint8Array) {
  if (encoded.byteLength % 2 !== 0) {
    throw new Error("The acoustic artifact must contain whole PCM16 samples.");
  }
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const samples = new Int16Array(encoded.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
}

function waitWithTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
