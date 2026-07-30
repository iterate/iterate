import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { request as requestHttps } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createCaptunTunnel, type CaptunTunnel } from "captun";
import { LocalDevicePeerServer } from "../src/device/local-device-peer-server.ts";
import { LocalDevicePeer } from "../src/device/local-device-peer.ts";
import {
  ITERATE_KIT_PCM_SUBPROTOCOL,
  projectBearerSubprotocol,
  type ProviderVoiceEvent,
} from "../src/voice/device-pcm-proxy.ts";
import { connectGrokRealtimeVoice } from "../src/voice/grok-realtime-voice.ts";
import { createFixedPcmFrames } from "../src/voice/voice-e2e-audio.ts";

const executeFile = promisify(execFile);
const sampleRateHz = 16_000;
const frameBytes = 640;
const frameDurationMs = 20;
const responseTimeoutMs = 30_000;
const defaultPhrase =
  "Please reply by saying: Iterate voice path works.";

const usage = `Usage:
  doppler run --project voice --config dev_jonas -- pnpm voice:e2e

Required environment:
  CAPTUN_TOKEN
  XAI_API_KEY

Optional environment:
  CAPTUN_GATEWAY                 (default: https://tunnels.iterate.com)
  CAPTUN_TUNNEL_NAME
  ITERATE_KIT_VOICE_PHRASE
  ITERATE_KIT_VOICE_PCM_FILE    raw mono PCM16LE at 16 kHz
  ITERATE_KIT_SAY               (default: /usr/bin/say)
  ITERATE_KIT_FFMPEG            (default: /opt/homebrew/bin/ffmpeg)`;

export async function runVoiceE2e(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const captunToken = requireSecret(environment.CAPTUN_TOKEN, "CAPTUN_TOKEN");
  const xaiApiKey = requireSecret(environment.XAI_API_KEY, "XAI_API_KEY");
  const projectId = `prj_voice_e2e_${randomBytes(8).toString("hex")}`;
  const projectToken = `itxk_voice_e2e_${randomBytes(24).toString("base64url")}`;
  const peer = new LocalDevicePeer({
    mountPath: ["kit", "m5sticks3"],
    projectId,
    projectSecret: projectToken,
  });
  const providerResponseDone = Promise.withResolvers<void>();
  const providerFailure = Promise.withResolvers<never>();
  let failureRecorded = false;
  let responseCreated = false;

  const recordFailure = (error: Error) => {
    if (failureRecorded) return;
    failureRecorded = true;
    providerFailure.reject(error);
  };
  void providerFailure.promise.catch(() => {});

  const observeProviderEvent = (event: ProviderVoiceEvent) => {
    console.log(
      `would_post_to_stream event=${event.type} frame=${event.raw}`,
    );
    if (event.type === "error") {
      recordFailure(
        new Error(`Grok returned an error event: ${event.raw}`),
      );
    } else if (event.type === "response.created") {
      responseCreated = true;
    } else if (event.type === "response.done") {
      providerResponseDone.resolve();
    }
  };

  const server = new LocalDevicePeerServer(peer, {
    connectVoiceProvider: () =>
      connectGrokRealtimeVoice({
        apiKey: xaiApiKey,
        instructions:
          "This is an end-to-end voice transport test. Reply in one very short sentence.",
        sampleRateHz,
      }),
    onVoiceFailure: (reason) =>
      recordFailure(new Error(`PCM proxy failure: ${reason}`)),
    onVoiceProviderEvent: observeProviderEvent,
    pcmFrameBytes: frameBytes,
  });
  let tunnel: CaptunTunnel | undefined;
  let deviceSocket: WebSocket | undefined;

  try {
    tunnel = await createCaptunTunnel({
      fetch: (request) => server.fetch(request),
      gateway:
        environment.CAPTUN_GATEWAY ?? "https://tunnels.iterate.com",
      name: environment.CAPTUN_TUNNEL_NAME,
      token: captunToken,
    });
    console.log(`tunnel_ready url=${tunnel.url}`);

    const pcmUrl = new URL("/pcm", tunnel.url);
    pcmUrl.protocol = "wss:";
    pcmUrl.searchParams.set("projectId", projectId);
    const rejectedStatus = await probeRejectedBearer(
      pcmUrl,
      projectId,
      "deliberately-wrong-token",
    );
    if (rejectedStatus !== 401) {
      throw new Error(
        `Expected the public PCM endpoint to reject an invalid bearer with 401, received ${rejectedStatus}.`,
      );
    }
    console.log(
      "bearer_validation_passed invalid_status=401 provider_egress=skipped",
    );

    deviceSocket = await openDevicePcmSocket(pcmUrl, projectToken);
    console.log(
      `pcm_connected protocol=${deviceSocket.protocol} frame_bytes=${frameBytes} sample_rate_hz=${sampleRateHz}`,
    );

    const downlinkFrames: Uint8Array[] = [];
    const firstDownlink = Promise.withResolvers<void>();
    deviceSocket.binaryType = "arraybuffer";
    deviceSocket.addEventListener("message", (event) => {
      const bytes = deviceMessageBytes(event.data);
      if (!bytes) {
        recordFailure(
          new Error("The device PCM socket received a non-binary message."),
        );
        return;
      }
      if (bytes.byteLength !== frameBytes) {
        recordFailure(
          new Error(
            `The device PCM socket received ${bytes.byteLength} bytes instead of ${frameBytes}.`,
          ),
        );
        return;
      }
      downlinkFrames.push(bytes);
      firstDownlink.resolve();
    });
    deviceSocket.addEventListener(
      "error",
      () =>
        recordFailure(new Error("The public device PCM socket failed.")),
      { once: true },
    );
    deviceSocket.addEventListener(
      "close",
      (event) => {
        if (event.code !== 1000 && event.code !== 1001) {
          recordFailure(
            new Error(
              `The public device PCM socket closed with code ${event.code}: ${event.reason}`,
            ),
          );
        }
      },
      { once: true },
    );

    const input = await loadVoiceInput(environment);
    const silenceFrames = 75;
    const uplinkFrames = createFixedPcmFrames(
      input.pcm,
      frameBytes,
      silenceFrames,
    );
    try {
      console.log(
        `pcm_uplink_start source=${input.source} audio_bytes=${input.pcm.byteLength} frames=${uplinkFrames.length} trailing_silence_ms=${silenceFrames * frameDurationMs}`,
      );
      await sendAtRealtimeRate(deviceSocket, uplinkFrames);
    } finally {
      await input.cleanup();
    }
    console.log("pcm_uplink_complete");

    await withTimeout(
      Promise.race([
        Promise.all([
          firstDownlink.promise,
          providerResponseDone.promise,
        ]),
        providerFailure.promise,
      ]),
      responseTimeoutMs,
      "Timed out waiting for a complete Grok audio response.",
    );
    await delay(100);
    if (!responseCreated) {
      throw new Error(
        "Grok returned audio without a response.created lifecycle event.",
      );
    }
    const downlinkBytes = downlinkFrames.reduce(
      (total, frame) => total + frame.byteLength,
      0,
    );
    console.log(
      `voice_e2e_passed bearer_validation=true provider=grok uplink_frames=${uplinkFrames.length} downlink_frames=${downlinkFrames.length} downlink_bytes=${downlinkBytes}`,
    );
  } finally {
    deviceSocket?.close(1000, "Voice e2e complete.");
    tunnel?.[Symbol.dispose]();
    server[Symbol.dispose]();
    peer[Symbol.dispose]();
  }
}

function requireSecret(value: string | undefined, name: string) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(
      `Missing ${name}. Run this command through the appropriate Doppler config.`,
    );
  }
  return normalized;
}

async function loadVoiceInput(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const suppliedPcmPath = environment.ITERATE_KIT_VOICE_PCM_FILE;
  if (suppliedPcmPath) {
    return {
      cleanup: async () => {},
      pcm: new Uint8Array(await readFile(suppliedPcmPath)),
      source: "file",
    };
  }

  const directory = await mkdtemp(join(tmpdir(), "iterate-kit-voice-e2e-"));
  const aiffPath = join(directory, "prompt.aiff");
  const pcmPath = join(directory, "prompt.pcm");
  try {
    await executeFile(environment.ITERATE_KIT_SAY ?? "/usr/bin/say", [
      "-o",
      aiffPath,
      environment.ITERATE_KIT_VOICE_PHRASE ?? defaultPhrase,
    ]);
    await executeFile(
      environment.ITERATE_KIT_FFMPEG ?? "/opt/homebrew/bin/ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        aiffPath,
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ac",
        "1",
        "-ar",
        String(sampleRateHz),
        pcmPath,
      ],
    );
    return {
      cleanup: () => rm(directory, { force: true, recursive: true }),
      pcm: new Uint8Array(await readFile(pcmPath)),
      source: "macos-say",
    };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

async function sendAtRealtimeRate(
  socket: WebSocket,
  frames: readonly Uint8Array[],
) {
  const startedAt = performance.now();
  for (let index = 0; index < frames.length; index += 1) {
    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error(
        `The PCM socket stopped before uplink frame ${index}.`,
      );
    }
    socket.send(frames[index]);
    const nextDeadline = startedAt + (index + 1) * frameDurationMs;
    await delay(Math.max(0, nextDeadline - performance.now()));
  }
}

function openDevicePcmSocket(url: URL, projectToken: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, [
      ITERATE_KIT_PCM_SUBPROTOCOL,
      projectBearerSubprotocol(projectToken),
    ]);
    const timeout = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error("Timed out opening the public PCM WebSocket."));
    }, 15_000);
    const opened = () => {
      cleanup();
      if (socket.protocol !== ITERATE_KIT_PCM_SUBPROTOCOL) {
        socket.close(4002, "Unexpected PCM protocol.");
        reject(
          new Error(
            `The server selected unexpected protocol ${socket.protocol}.`,
          ),
        );
        return;
      }
      resolve(socket);
    };
    const failed = () => {
      cleanup();
      reject(new Error("The public PCM WebSocket handshake failed."));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
    };
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
  });
}

function probeRejectedBearer(
  url: URL,
  projectId: string,
  bearerToken: string,
) {
  const httpsUrl = new URL(url);
  httpsUrl.protocol = "https:";
  httpsUrl.searchParams.delete("projectId");
  return new Promise<number>((resolve, reject) => {
    const request = requestHttps(httpsUrl, {
      headers: {
        connection: "Upgrade",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-protocol": ITERATE_KIT_PCM_SUBPROTOCOL,
        "sec-websocket-version": "13",
        upgrade: "websocket",
        "x-iterate-project-id": projectId,
        authorization: `Bearer ${bearerToken}`,
      },
    });
    request.setTimeout(15_000, () => {
      request.destroy(
        new Error("Timed out probing public bearer validation."),
      );
    });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(
        new Error(
          "The public PCM endpoint accepted an invalid bearer token.",
        ),
      );
    });
    request.once("error", reject);
    request.end();
  });
}

function deviceMessageBytes(data: unknown) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
  }
  return undefined;
}

function withTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  message: string,
) {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

if (process.argv.includes("--help")) {
  console.log(usage);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runVoiceE2e(process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
