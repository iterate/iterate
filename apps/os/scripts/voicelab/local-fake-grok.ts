// A deterministic, entirely local Grok-realtime-compatible endpoint.
//
// Unlike fake-grok.ts this does not publish through captun. It binds only to
// loopback, sends no credentials, and makes no outbound request. Its purpose
// is the literal no-provider proof: the local OS worker dials this process,
// receives a session, hears synthetic microphone PCM, and returns speaker PCM
// through the same bridge and Cap'n Web stream a device uses.
import { Buffer } from "node:buffer";
import { createServer } from "node:http";

import WebSocket, { WebSocketServer, type RawData } from "ws";

const SAMPLE_RATE = 16_000;
const ANSWER_SECONDS = 1;
export const LOCAL_FAKE_SPEAKER_BYTES = SAMPLE_RATE * 2 * ANSWER_SECONDS;
const ANSWER_TRANSCRIPT = "The local voice provider heard the microphone.";
const SILENT_FRAMES_TO_END_SPEECH = 12;

export interface LocalFakeGrokSession {
  id: number;
  openedAt: number;
  closedAt: number | null;
  received: string[];
  micBytes: number;
  speechStarts: number;
  speechStops: number;
  answers: number;
  speakerBytes: number;
}

export interface LocalFakeGrok {
  /** Loopback-only HTTP URL accepted by the guest worker's WebSocket fetch. */
  url: string;
  sessions: LocalFakeGrokSession[];
  close(): Promise<void>;
}

/** A 440 Hz PCM16 tone: deterministic speaker bytes without a speech service. */
function tone(bytes: number): Buffer {
  const samples = Math.floor(bytes / 2);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) {
    const phase = (2 * Math.PI * 440 * index) / SAMPLE_RATE;
    pcm.writeInt16LE(Math.round(Math.sin(phase) * 8000), index * 2);
  }
  return pcm;
}

function hasSpeech(pcm: Buffer): boolean {
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    if (Math.abs(pcm.readInt16LE(offset)) >= 64) return true;
  }
  return false;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Start a provider that is reachable only from this machine. */
export async function startLocalFakeGrok(): Promise<LocalFakeGrok> {
  const sessions: LocalFakeGrokSession[] = [];
  const sockets = new Set<WebSocket>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ localFakeGrok: true, sessions: sessions.length }));
  });
  const webSockets = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit("connection", webSocket, request);
    });
  });

  webSockets.on("connection", (socket) => {
    sockets.add(socket);
    const session: LocalFakeGrokSession = {
      answers: 0,
      closedAt: null,
      id: sessions.length + 1,
      micBytes: 0,
      openedAt: Date.now(),
      received: [],
      speakerBytes: 0,
      speechStarts: 0,
      speechStops: 0,
    };
    sessions.push(session);

    let answering = false;
    let speaking = false;
    let silentFrames = 0;
    let responseSequence = 0;

    const emit = (event: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
    };
    const answer = () => {
      if (answering || socket.readyState !== WebSocket.OPEN) return;
      answering = true;
      session.answers++;
      const responseId = `local_response_${session.id}_${++responseSequence}`;
      emit({ response: { id: responseId }, type: "response.created" });
      emit({ delta: ANSWER_TRANSCRIPT, type: "response.output_audio_transcript.delta" });

      const pcm = tone(LOCAL_FAKE_SPEAKER_BYTES);
      for (let offset = 0; offset < pcm.length; offset += 6_400) {
        const chunk = pcm.subarray(offset, Math.min(offset + 6_400, pcm.length));
        socket.send(chunk, { binary: true });
        session.speakerBytes += chunk.length;
      }

      emit({ transcript: ANSWER_TRANSCRIPT, type: "response.output_audio_transcript.done" });
      emit({
        response: { id: responseId, output: [], status: "completed" },
        type: "response.done",
      });
      answering = false;
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const pcm = rawDataToBuffer(data);
        session.micBytes += pcm.length;
        if (hasSpeech(pcm)) {
          silentFrames = 0;
          if (!speaking) {
            speaking = true;
            session.speechStarts++;
            emit({ audio_start_ms: 0, type: "input_audio_buffer.speech_started" });
          }
        } else if (speaking) {
          silentFrames += Math.max(1, Math.floor(pcm.length / 640));
          if (silentFrames >= SILENT_FRAMES_TO_END_SPEECH) {
            speaking = false;
            silentFrames = 0;
            session.speechStops++;
            const itemId = `local_item_${session.id}_${session.speechStops}`;
            emit({ audio_end_ms: 0, item_id: itemId, type: "input_audio_buffer.speech_stopped" });
            emit({
              item_id: itemId,
              transcript: "deterministic local microphone utterance",
              type: "conversation.item.input_audio_transcription.completed",
            });
            answer();
          }
        }
        return;
      }

      let event: unknown;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      const type =
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        typeof event.type === "string"
          ? event.type
          : "unknown";
      session.received.push(type);
      if (type === "session.update") {
        emit({ session: { id: `local_session_${session.id}` }, type: "session.updated" });
      } else if (type === "input_audio_buffer.commit") {
        emit({ item_id: `local_item_${session.id}`, type: "input_audio_buffer.committed" });
      } else if (type === "response.create") {
        answer();
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      session.closedAt = Date.now();
    });

    // A short delay is intentional: it proves the bridge listens from socket
    // acceptance onward while keeping the test fast and deterministic.
    setTimeout(() => {
      emit({ session: { id: `local_session_${session.id}` }, type: "session.created" });
    }, 25);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("local fake Grok did not bind a TCP port");
  }

  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        webSockets.close(() => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      });
    },
    sessions,
    url: `http://127.0.0.1:${address.port}/v1/realtime`,
  };
}

export const LOCAL_FAKE_ANSWER_TRANSCRIPT = ANSWER_TRANSCRIPT;
