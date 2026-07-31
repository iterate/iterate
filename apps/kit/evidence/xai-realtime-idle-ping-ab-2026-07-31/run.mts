import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const ARM_LIMIT_MS = 45_000;
const MODEL = "grok-voice-think-fast-2.0";
const RESULT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "result.json");

type JsonObject = Record<string, unknown>;

interface ArmResult {
  arm: "baseline" | "pong";
  close: {
    atUtc: string;
    code: number;
    elapsedMs: number;
    reason: string;
    initiatedByExperiment: boolean;
  };
  events: Array<{
    atUtc: string;
    elapsedMs: number;
    payload?: JsonObject;
    type: string;
  }>;
  firstPing?: JsonObject;
  openedAtUtc: string;
  pingsReceived: number;
  pongsSent: number;
}

function utcNow() {
  return new Date().toISOString();
}

function elapsedSince(startedAt: number) {
  return Math.round(performance.now() - startedAt);
}

function parseJsonObject(data: WebSocket.RawData): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(data.toString());
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

async function mintClientSecret(apiKey: string) {
  const response = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Client-secret mint failed with HTTP ${response.status}.`);
  }
  const body: unknown = await response.json();
  if (
    body === null ||
    typeof body !== "object" ||
    !("value" in body) ||
    typeof body.value !== "string" ||
    body.value.length === 0
  ) {
    throw new Error("Client-secret mint returned an unexpected payload.");
  }
  return body.value;
}

async function runArm(
  arm: ArmResult["arm"],
  apiKey: string,
  incomingPingTimestampField?: "ping_timestamp" | "timestamp",
): Promise<ArmResult> {
  const clientSecret = await mintClientSecret(apiKey);
  const startedAt = performance.now();
  const openedAtUtc = utcNow();
  const events: ArmResult["events"] = [];
  let pingsReceived = 0;
  let pongsSent = 0;
  let firstPing: JsonObject | undefined;
  let initiatedByExperiment = false;

  const socket = new WebSocket(`wss://api.x.ai/v1/realtime?model=${MODEL}`, [
    `xai-client-secret.${clientSecret}`,
  ]);

  const close = await new Promise<ArmResult["close"]>((resolveClose, rejectClose) => {
    const armTimer = setTimeout(() => {
      initiatedByExperiment = true;
      socket.close(1000, "experiment arm complete");
    }, ARM_LIMIT_MS);
    const terminationTimer = setTimeout(() => {
      initiatedByExperiment = true;
      socket.terminate();
    }, ARM_LIMIT_MS + 2_000);

    socket.once("open", () => {
      events.push({ atUtc: utcNow(), elapsedMs: elapsedSince(startedAt), type: "open" });
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            audio: {
              input: {
                format: { rate: 16_000, type: "audio/pcm" },
                transcription: { model: "grok-transcribe" },
                transport: "binary",
              },
              output: {
                format: { rate: 16_000, type: "audio/pcm" },
                transport: "binary",
              },
            },
            instructions: "Idle keepalive experiment. Do not initiate a response.",
            turn_detection: { type: null },
            voice: "eve",
          },
        }),
      );
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        events.push({ atUtc: utcNow(), elapsedMs: elapsedSince(startedAt), type: "binary" });
        return;
      }
      const payload = parseJsonObject(data);
      const type = typeof payload?.type === "string" ? payload.type : "unparseable-text";
      const event: ArmResult["events"][number] = {
        atUtc: utcNow(),
        elapsedMs: elapsedSince(startedAt),
        type,
      };
      if (type === "ping" && payload) {
        event.payload = payload;
        firstPing ??= payload;
        pingsReceived += 1;
        if (arm === "pong") {
          if (!incomingPingTimestampField) {
            rejectClose(new Error("The pong arm has no baseline-validated timestamp field."));
            socket.terminate();
            return;
          }
          const timestamp = payload[incomingPingTimestampField];
          if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
            rejectClose(
              new Error(
                `Live ping omitted numeric ${incomingPingTimestampField}; refusing to guess a pong.`,
              ),
            );
            socket.terminate();
            return;
          }
          // Both official xAI clients use ping_timestamp in the reply. The
          // Android client maps the live ping's `timestamp` field to this
          // differently named pong field.
          socket.send(JSON.stringify({ type: "pong", ping_timestamp: timestamp }));
          pongsSent += 1;
        }
      }
      events.push(event);
    });

    socket.once("error", (error) => {
      events.push({
        atUtc: utcNow(),
        elapsedMs: elapsedSince(startedAt),
        payload: { message: error.message },
        type: "socket.error",
      });
    });

    socket.once("close", (code, reason) => {
      clearTimeout(armTimer);
      clearTimeout(terminationTimer);
      resolveClose({
        atUtc: utcNow(),
        code,
        elapsedMs: elapsedSince(startedAt),
        reason: reason.toString(),
        initiatedByExperiment,
      });
    });
  });

  return {
    arm,
    close,
    events,
    firstPing,
    openedAtUtc,
    pingsReceived,
    pongsSent,
  };
}

const apiKey = process.env.XAI_API_KEY;
if (!apiKey) throw new Error("XAI_API_KEY must be injected by Doppler.");

const baseline = await runArm("baseline", apiKey);
const firstPing = baseline.firstPing;
const incomingPingTimestampField =
  typeof firstPing?.ping_timestamp === "number"
    ? "ping_timestamp"
    : typeof firstPing?.timestamp === "number"
      ? "timestamp"
      : undefined;
if (!incomingPingTimestampField) {
  throw new Error(
    `Baseline ping did not match either official xAI client shape: ${JSON.stringify(firstPing)}.`,
  );
}
const pong = await runArm("pong", apiKey, incomingPingTimestampField);
const result = {
  arms: [baseline, pong],
  completedAtUtc: utcNow(),
  constraints: {
    armLimitMs: ARM_LIMIT_MS,
    incomingPingTimestampField,
    identicalSessionUpdate: true,
    separateEphemeralClientSecretPerArm: true,
  },
  model: MODEL,
  schemaVersion: 1,
};

await mkdir(dirname(RESULT_PATH), { recursive: true });
await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
console.log(
  JSON.stringify({
    baseline: baseline.close,
    baselinePings: baseline.pingsReceived,
    pong: pong.close,
    pongPings: pong.pingsReceived,
    pongsSent: pong.pongsSent,
    resultPath: RESULT_PATH,
  }),
);
