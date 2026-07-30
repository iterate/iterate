import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RpcSession, type RpcStub, type RpcTransport } from "@iterate-com/capnweb";
import { beforeAll, expect, test } from "vitest";
import { encodeDeviceConfiguration, type DeviceConfiguration } from "../firmware/config-image.ts";
import type { M5StickS3 } from "./m5sticks3-contract.ts";
import type { StackChan, StackChanMetrics } from "./stackchan-contract.ts";

interface StackChanSimulator extends StackChan {
  __test: {
    renderUrlHash(): Promise<number>;
    servoYawDegrees(): Promise<number>;
    servoPitchDegrees(): Promise<number>;
    servoSpeed(): Promise<number>;
    ledIndex(): Promise<number>;
    photoReleaseCount(): Promise<number>;
  };
}

interface M5StickS3Simulator extends M5StickS3 {
  __test: {
    renderUrlHash(): Promise<number>;
    audioMode(): Promise<number>;
    notePlaybackStarted(): Promise<number>;
    pressButton(): Promise<number>;
    releaseButton(): Promise<number>;
    submitCapture(): Promise<number>;
    completeCapture(): Promise<number>;
    captureFramesDropped(): Promise<number>;
    captureStartCount(): Promise<number>;
    captureStopCount(): Promise<number>;
    playbackStopCount(): Promise<number>;
    playbackFlushCount(): Promise<number>;
    interruptionCount(): Promise<number>;
    closeProfile(): Promise<number>;
  };
  servos: {
    move(input: { yawDegrees: number; pitchDegrees: number; speed: number }): Promise<boolean>;
  };
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const buildDirectory = resolve(packageDirectory, ".build/host");
const simulatorExecutable = resolve(buildDirectory, "iterate-stackchan-simulator");
const m5sticks3SimulatorExecutable = resolve(buildDirectory, "iterate-m5sticks3-simulator");
const resourceProfileExecutable = resolve(buildDirectory, "iterate-stackchan-resource-profile");
const configurationDecoderExecutable = resolve(
  buildDirectory,
  "iterate-kit-configuration-decoder-fixture",
);

class SimulatorTransport implements RpcTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #label: string;
  readonly #messages: string[] = [];
  readonly #waiters: Array<{
    resolve: (message: string) => void;
    reject: (error: Error) => void;
  }> = [];
  #failure?: Error;
  #closing = false;

  constructor(executable = simulatorExecutable, label = "StackChan") {
    this.#label = label;
    this.#child = spawn(executable, [], {
      cwd: packageDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      if (process.env.ITERATE_KIT_TRACE) console.error(`simulator -> TypeScript ${line}`);
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.#messages.push(line);
    });
    let standardError = "";
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      standardError += chunk;
    });
    this.#child.once("error", (error) => this.#rejectAll(error));
    this.#child.once("close", (code, signal) => {
      if (this.#failure || this.#closing) return;
      this.#rejectAll(
        new Error(
          `${this.#label} simulator exited early (code=${code}, signal=${signal})` +
            (standardError ? `: ${standardError.trim()}` : ""),
        ),
      );
    });
  }

  send(message: string): Promise<void> {
    if (process.env.ITERATE_KIT_TRACE) console.error(`TypeScript -> simulator ${message}`);
    return this.sendBatch([message]);
  }

  sendBatch(messages: readonly string[]): Promise<void> {
    if (messages.length === 0) return Promise.resolve();
    return new Promise((resolveSend, rejectSend) => {
      this.#child.stdin.write(`${messages.join("\n")}\n`, (error) => {
        if (error) rejectSend(error);
        else resolveSend();
      });
    });
  }

  receive(): Promise<string> {
    const message = this.#messages.shift();
    if (message) return Promise.resolve(message);
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolveMessage, rejectMessage) => {
      this.#waiters.push({ resolve: resolveMessage, reject: rejectMessage });
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#child.exitCode !== null) return;
    this.#child.stdin.end();
    await new Promise<void>((resolveClose) => {
      const killTimer = setTimeout(() => this.#child.kill(), 1_000);
      this.#child.once("close", () => {
        clearTimeout(killTimer);
        resolveClose();
      });
    });
  }

  #rejectAll(error: Error) {
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

class StackChanSimulatorFixture {
  readonly #transport = new SimulatorTransport();
  readonly stackchan: RpcStub<StackChanSimulator>;

  constructor() {
    this.stackchan = new RpcSession<StackChanSimulator>(this.#transport).getRemoteMain();
  }

  async [Symbol.asyncDispose]() {
    this.stackchan[Symbol.dispose]();
    await this.#transport.close();
  }
}

class M5StickS3SimulatorFixture {
  readonly #transport = new SimulatorTransport(m5sticks3SimulatorExecutable, "M5StickS3");
  readonly m5sticks3: RpcStub<M5StickS3Simulator>;

  constructor() {
    this.m5sticks3 = new RpcSession<M5StickS3Simulator>(this.#transport).getRemoteMain();
  }

  async [Symbol.asyncDispose]() {
    this.m5sticks3[Symbol.dispose]();
    await this.#transport.close();
  }
}

beforeAll(() => {
  mkdirSync(buildDirectory, { recursive: true });
  for (const args of [
    [
      "-S",
      resolve(packageDirectory, "firmware"),
      "-B",
      buildDirectory,
      "-DCMAKE_BUILD_TYPE=MinSizeRel",
    ],
    ["--build", buildDirectory, "--parallel"],
    ["--build", buildDirectory, "--target", "test"],
  ]) {
    const result = spawnSync("cmake", args, {
      cwd: packageDirectory,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`cmake ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
    }
  }
});

test("drains coalesced Cap'n Web frames from one transport read", async () => {
  const transport = new SimulatorTransport();
  try {
    await transport.sendBatch(['["push",["pipeline",0,["__test","servoSpeed"],[]]]', '["pull",1]']);
    await expect(
      Promise.race([
        transport.receive(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("coalesced pull frame was not drained")), 500),
        ),
      ]),
    ).resolves.toBe('["resolve",1,0]');
  } finally {
    await transport.close();
  }
});

test("the firmware decoder accepts the exact configuration image emitted by TypeScript", () => {
  const configuration: DeviceConfiguration = {
    schemaVersion: 1,
    wifi: {
      ssid: "studio",
      password: "correct horse battery staple",
    },
    iterate: {
      baseUrl: "https://os.iterate.com",
      projectId: "prj_voice_lab",
      projectApiKey: "itxk_secret",
    },
  };
  const decoded = spawnSync(configurationDecoderExecutable, [], {
    cwd: packageDirectory,
    encoding: "utf8",
    input: encodeDeviceConfiguration(configuration, 512),
  });

  expect(decoded.error).toBeUndefined();
  expect(decoded.status, decoded.stderr).toBe(0);
  expect(decoded.stdout.trim().split("\n")).toEqual([
    configuration.wifi.ssid,
    configuration.wifi.password,
    configuration.iterate.baseUrl,
    configuration.iterate.projectId,
    configuration.iterate.projectApiKey,
  ]);
});

test("the real embedded capability layer exposes the StackChan surface", async () => {
  await using fixture = new StackChanSimulatorFixture();
  const { stackchan } = fixture;
  const description = await stackchan.__describe();
  expect(description.instructions).not.toMatch(/microphone|speaker|AEC/i);
  expect(description.children).toMatchObject({
    subscribeToMetrics: expect.any(String),
    renderOnScreen: expect.any(String),
    servos: expect.any(String),
    leds: expect.any(String),
    takePhoto: expect.any(String),
  });

  await expect(
    stackchan.renderOnScreen({ url: "https://assets.iterate.com/test/face.png" }),
  ).resolves.toBe(true);
  await expect(
    stackchan.servos.move({ yawDegrees: -42, pitchDegrees: 31, speed: 640 }),
  ).resolves.toBe(true);
  await expect(stackchan.leds.set({ index: 7, red: 12, green: 34, blue: 56 })).resolves.toBe(true);
  await expect(stackchan.leds.fill({ red: 4, green: 5, blue: 6 })).resolves.toBe(true);

  await expect(stackchan.__test.renderUrlHash()).resolves.toBe(4_164_392_526);
  await expect(stackchan.__test.servoYawDegrees()).resolves.toBe(-42);
  await expect(stackchan.__test.servoPitchDegrees()).resolves.toBe(31);
  await expect(stackchan.__test.servoSpeed()).resolves.toBe(640);
  await expect(stackchan.__test.ledIndex()).resolves.toBe(7);
});

test("the M5StickS3 profile describes screen, metrics, and push-to-talk events", async () => {
  await using fixture = new M5StickS3SimulatorFixture();
  const { m5sticks3 } = fixture;
  const description = await m5sticks3.__describe();
  expect(description.children).toEqual({
    subscribeToMetrics: expect.any(String),
    renderOnScreen: expect.any(String),
    pushToTalk: {
      start: expect.any(String),
      stop: expect.any(String),
    },
  });

  await expect(
    m5sticks3.renderOnScreen({
      url: "https://assets.iterate.com/test/stick-face.png",
    }),
  ).resolves.toBe(true);
  await expect(m5sticks3.__test.renderUrlHash()).resolves.not.toBe(0);
  await expectRpcRejection(
    m5sticks3.servos.move({
      yawDegrees: 0,
      pitchDegrees: 0,
      speed: 100,
    }),
    "unknown device capability",
  );
});

test("the M5StickS3 button drives bounded push-to-talk without a mic queue", async () => {
  await using fixture = new M5StickS3SimulatorFixture();
  const { m5sticks3 } = fixture;

  await expect(m5sticks3.__test.audioMode()).resolves.toBe(0);
  await expect(m5sticks3.__test.notePlaybackStarted()).resolves.toBe(0);
  await expect(m5sticks3.__test.pressButton()).resolves.toBe(0);
  await expect(m5sticks3.__test.captureStartCount()).resolves.toBe(1);
  await expect(m5sticks3.__test.playbackStopCount()).resolves.toBe(1);
  await expect(m5sticks3.__test.playbackFlushCount()).resolves.toBe(1);
  await expect(m5sticks3.__test.interruptionCount()).resolves.toBe(1);

  await expect(m5sticks3.__test.submitCapture()).resolves.toBe(0);
  await expect(m5sticks3.__test.submitCapture()).resolves.toBe(-5);
  await expect(m5sticks3.__test.captureFramesDropped()).resolves.toBe(1);
  await expect(m5sticks3.__test.completeCapture()).resolves.toBe(0);
  await expect(m5sticks3.__test.submitCapture()).resolves.toBe(0);
  await expect(m5sticks3.__test.completeCapture()).resolves.toBe(0);
  await expect(m5sticks3.__test.releaseButton()).resolves.toBe(0);
});

test("remote push-to-talk calls enter the same deferred event processor", async () => {
  await using fixture = new M5StickS3SimulatorFixture();
  const { m5sticks3 } = fixture;

  await expect(m5sticks3.pushToTalk.start()).resolves.toBe(true);
  await expectEventually(async () => {
    expect(await m5sticks3.__test.captureStartCount()).toBe(1);
  });
  await expect(m5sticks3.pushToTalk.stop()).resolves.toBe(true);
  await expectEventually(async () => {
    expect(await m5sticks3.__test.captureStopCount()).toBe(1);
  });
});

test("closing the M5StickS3 profile stops capture exactly once", async () => {
  await using fixture = new M5StickS3SimulatorFixture();
  const { m5sticks3 } = fixture;

  await expect(m5sticks3.__test.pressButton()).resolves.toBe(0);
  await expect(m5sticks3.__test.captureStartCount()).resolves.toBe(1);
  await expect(m5sticks3.__test.closeProfile()).resolves.toBe(0);
  await expect(m5sticks3.__test.captureStopCount()).resolves.toBe(1);
  await expect(m5sticks3.__test.submitCapture()).resolves.toBe(-6);
  await expect(m5sticks3.__test.captureStopCount()).resolves.toBe(1);
});

test("takePhoto returns bounded JPEG bytes over Cap'n Web", async () => {
  await using fixture = new StackChanSimulatorFixture();
  const { stackchan } = fixture;
  const jpeg = await stackchan.takePhoto();
  expect(jpeg).toBeInstanceOf(Uint8Array);
  expect(jpeg.byteLength).toBeGreaterThan(16);
  expect(Array.from(jpeg.slice(0, 2))).toEqual([0xff, 0xd8]);
  expect(Array.from(jpeg.slice(-2))).toEqual([0xff, 0xd9]);
  await expectEventually(async () => {
    expect(await stackchan?.__test.photoReleaseCount()).toBe(1);
  });
});

test("subscribeToMetrics calls a remote callback from the C peer", async () => {
  await using fixture = new StackChanSimulatorFixture();
  const { stackchan } = fixture;
  const firstMetric = Promise.withResolvers<StackChanMetrics>();
  await stackchan.subscribeToMetrics((metrics) => firstMetric.resolve(metrics));

  const metrics = await Promise.race([
    firstMetric.promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("metrics callback did not arrive")), 2_000),
    ),
  ]);
  expect(metrics).toMatchObject({
    freeHeapBytes: 312_000,
    minimumFreeHeapBytes: 280_000,
    freeInternalHeapBytes: 220_000,
    minimumFreeInternalHeapBytes: 200_000,
    freePsramBytes: 7_500_000,
    taskStackHighWaterBytes: 4_096,
    cpuPermille: 73,
  });
  expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
});

test("invalid device arguments are per-call errors and leave the session healthy", async () => {
  await using fixture = new StackChanSimulatorFixture();
  const { stackchan } = fixture;
  await expectRpcRejection(
    stackchan.servos.move({ yawDegrees: 129, pitchDegrees: 20, speed: 500 }),
    "servo command is outside the configured limits",
  );
  await expectRpcRejection(
    stackchan.renderOnScreen({ url: "file:///tmp/not-allowed.png" }),
    "hardware rejected the arguments",
  );
  await expect(
    stackchan.servos.move({ yawDegrees: 10, pitchDegrees: 20, speed: 500 }),
  ).resolves.toBe(true);
});

test("a rejected metrics callback is stopped instead of retried forever", async () => {
  await using fixture = new StackChanSimulatorFixture();
  const { stackchan } = fixture;
  let deliveries = 0;
  await stackchan.subscribeToMetrics(() => {
    deliveries++;
    throw new Error("subscriber failed");
  });
  await expectEventually(() => {
    expect(deliveries).toBe(1);
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  expect(deliveries).toBe(1);
  await expect(stackchan.__test.servoSpeed()).resolves.toBe(0);
});

test("the bounded metrics subscriber table rejects overflow without killing RPC", async () => {
  await using fixture = new StackChanSimulatorFixture();
  const { stackchan } = fixture;
  await stackchan.subscribeToMetrics(() => {});
  await stackchan.subscribeToMetrics(() => {});
  await expect(stackchan.subscribeToMetrics(() => {})).rejects.toThrow(
    "metrics subscription limit reached",
  );
  await expect(stackchan.__test.servoSpeed()).resolves.toBe(0);
});

test("reports static working memory and host CPU cost", () => {
  const result = spawnSync(resourceProfileExecutable, [], {
    cwd: packageDirectory,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  const profile = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(profile).toMatchObject({
    libraryHeapPolicy: "no allocator dependency",
    iterations: 100_000,
  });
  expect(profile.stackchanProfileBytes).toBeTypeOf("number");
  expect(profile.m5sticks3ProfileBytes).toBeTypeOf("number");
  expect(profile.m5sticks3PlatformBytes).toBeTypeOf("number");
  expect(profile.m5sticks3CaptureFrameStorageBytes).toBeTypeOf("number");
  expect(profile.m5sticks3PlatformControlBytes).toBeTypeOf("number");
  expect(profile.m5sticks3DirectBackendHostAbiBytes).toBeTypeOf("number");
  expect(profile.m5sticks3DirectOutputHostAbiBytes).toBeTypeOf("number");
  expect(profile.m5sticks3StereoScratchBytes).toBeTypeOf("number");
  expect(profile.m5sticks3DirectOutputControlHostAbiBytes).toBeTypeOf("number");
  expect(profile.m5sticks3RealtimePolicyHostAbiBytes).toBeTypeOf("number");
  expect(profile.m5sticks3GenerationFenceMailboxHostAbiBytes).toBeTypeOf("number");
  expect(profile.m5sticks3LifecycleMailboxHostAbiBytes).toBeTypeOf("number");
  expect(profile.m5sticks3OwnerTimeoutCountersHostAbiBytes).toBeTypeOf("number");
  expect(profile.m5sticks3PrebufferDeadlineHostAbiBytes).toBeTypeOf("number");
  expect(profile.m5sticks3DirectDmaRuntimeBytes).toBeTypeOf("number");
  expect(profile.m5sticks3PcmLanePayloadBytes).toBeTypeOf("number");
  expect(profile.m5sticks3AudioTaskStackBytes).toBeTypeOf("number");
  expect(profile.m5sticks3EventStorageBytes).toBeTypeOf("number");
  expect(profile.metricSubscriptionBytes).toBeTypeOf("number");
  expect(profile.protocolWorkingSetBytes).toBeTypeOf("number");
  expect(profile.stackchanProfileWorkingSetBytes).toBeTypeOf("number");
  expect(profile.m5sticks3ControlPlaneWorkingSetBytes).toBeTypeOf("number");
  expect(profile.nanosecondsPerServoRpc).toBeTypeOf("number");
  expect(profile.hostPeakResidentBytes).toBeTypeOf("number");
  // Capture retains two mono frames. Playback retains one stereo expansion
  // scratch frame; the four physical stereo DMA frames are driver-owned.
  // Keeping those three budgets distinct prevents a future hidden FIFO from
  // being excused as a benign change in the platform adapter.
  expect(profile.m5sticks3CaptureFrameStorageBytes).toBe(2 * 640);
  expect(profile.m5sticks3StereoScratchBytes).toBe(2 * 640);
  expect(profile.m5sticks3DirectDmaRuntimeBytes).toBe(4 * 2 * 640);
  // Each direction has 32 20 ms mono frames (640 ms). This is payload only;
  // target map evidence accounts for slot metadata and ring control objects.
  expect(profile.m5sticks3PcmLanePayloadBytes).toBe(2 * 32 * 640);
  expect(profile.m5sticks3AudioTaskStackBytes).toBe(8_192);
  expect(profile.m5sticks3PlatformControlBytes).toBeLessThanOrEqual(128);
  expect(profile.m5sticks3PlatformBytes).toBe(
    (profile.m5sticks3CaptureFrameStorageBytes as number) +
      (profile.m5sticks3PlatformControlBytes as number),
  );
  expect(profile.m5sticks3DirectOutputHostAbiBytes).toBe(
    (profile.m5sticks3StereoScratchBytes as number) +
      (profile.m5sticks3DirectOutputControlHostAbiBytes as number),
  );
  expect(profile.m5sticks3DirectBackendHostAbiBytes).toBeGreaterThan(0);
  expect(profile.m5sticks3RealtimePolicyHostAbiBytes).toBeGreaterThan(0);
  expect(profile.m5sticks3GenerationFenceMailboxHostAbiBytes).toBeGreaterThan(0);
  expect(profile.m5sticks3LifecycleMailboxHostAbiBytes).toBeGreaterThan(0);
  expect(profile.m5sticks3OwnerTimeoutCountersHostAbiBytes).toBe(2 * Uint32Array.BYTES_PER_ELEMENT);
  expect(profile.m5sticks3PrebufferDeadlineHostAbiBytes).toBeGreaterThan(0);
  expect(profile.m5sticks3ControlPlaneWorkingSetBytes).toBe(
    (profile.protocolWorkingSetBytes as number) +
      (profile.m5sticks3ProfileBytes as number) +
      (profile.m5sticks3PlatformBytes as number) +
      (profile.m5sticks3EventStorageBytes as number),
  );
  expect(profile.stackchanProfileWorkingSetBytes).toBeLessThanOrEqual(6_000);
  // This ceiling covers only the explicitly summed control plane plus capture.
  // Audio-owner state, lane payload, DMA, and its task stack have separate
  // assertions above because combining unlike memory classes hides regressions.
  expect(profile.m5sticks3ControlPlaneWorkingSetBytes).toBeLessThanOrEqual(8_192);
});

async function expectEventually(assertion: () => void | Promise<void>) {
  let lastFailure: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastFailure = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  throw lastFailure;
}

async function expectRpcRejection(value: PromiseLike<unknown>, message: string) {
  let rejection: unknown;
  try {
    await value;
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain(message);
}
