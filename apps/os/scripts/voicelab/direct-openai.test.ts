import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  instructionsFingerprint,
  readSessionSnapshot,
  runTurn,
  sessionConfigFingerprint,
} from "./direct-openai.ts";

const temporaryPaths: string[] = [];
afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
  }
});

function writeSnapshot(value: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "direct-openai-test-"));
  const snapshotPath = path.join(directory, "snapshot.json");
  temporaryPaths.push(directory);
  fs.writeFileSync(snapshotPath, JSON.stringify(value));
  return snapshotPath;
}

describe("direct OpenAI session snapshots", () => {
  it("accepts the uplink and latency-board formats and preserves their model", () => {
    const session = {
      type: "realtime",
      object: "realtime.session",
      id: "sess_captured",
      expires_at: 123,
      model: "gpt-realtime-2.1",
      instructions: "reply with banana",
    };
    const uplink = readSessionSnapshot(writeSnapshot({ effectiveSessionUpdated: [{ session }] }));
    const board = readSessionSnapshot(writeSnapshot({ effectiveSessions: [session] }));

    expect(uplink).toMatchObject({ model: "gpt-realtime-2.1" });
    expect(board).toMatchObject({ model: "gpt-realtime-2.1" });
    expect(uplink.session).not.toHaveProperty("id");
    expect(board.session).not.toHaveProperty("expires_at");
  });

  it("does not let response metadata or instructions perturb the configuration hash", () => {
    const first = {
      model: "gpt-realtime-2.1",
      object: "realtime.session",
      id: "sess_first",
      expires_at: 1,
      instructions: "say banana",
      audio: { output: { voice: "marin" } },
    };
    const second = {
      ...first,
      object: "different",
      id: "sess_second",
      expires_at: 2,
      instructions: "say plantain",
    };

    expect(sessionConfigFingerprint(first)).toBe(sessionConfigFingerprint(second));
    expect(instructionsFingerprint(first)).not.toBe(instructionsFingerprint(second));
  });
});

class SocketWithoutOutput extends EventEmitter {
  bufferedAmount = 0;
  send() {}
}

describe("direct OpenAI response validation", () => {
  it("fails a response.done that has no output audio", async () => {
    const socket = new SocketWithoutOutput();
    const pacer = { sendSourcePcm: async () => Buffer.alloc(480) };
    const turn = runTurn(socket as never, pacer as never, Buffer.alloc(640, 1), 0, null);

    socket.emit(
      "message",
      JSON.stringify({ type: "response.created", response: { id: "response_1" } }),
    );
    socket.emit(
      "message",
      JSON.stringify({ type: "response.done", response: { id: "response_1" } }),
    );

    await expect(turn).rejects.toThrow("completed without non-quiet output audio");
  });

  it("keeps sending zero PCM until a delayed response and both transcripts complete", async () => {
    const socket = new SocketWithoutOutput();
    const sent: Buffer[] = [];
    const pacer = {
      sendSourcePcm: async (pcm: Buffer) => {
        sent.push(pcm);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return pcm;
      },
    };
    const fixture = Buffer.alloc(640, 1);
    const responsePcm = Buffer.alloc(480);
    for (let offset = 0; offset < responsePcm.length; offset += 2) {
      responsePcm.writeInt16LE(1_000, offset);
    }
    const turn = runTurn(socket as never, pacer as never, fixture, 0, null);

    socket.emit(
      "message",
      JSON.stringify({ type: "response.created", response: { id: "response_1" } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.emit(
      "message",
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Please say banana.",
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "response.output_audio.delta",
        response_id: "response_1",
        delta: "",
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "response.output_audio.delta",
        response_id: "response_1",
        delta: responsePcm.toString("base64"),
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "response.output_audio_transcript.done",
        response_id: "response_1",
        transcript: "banana",
      }),
    );
    socket.emit(
      "message",
      JSON.stringify({ type: "response.done", response: { id: "response_1" } }),
    );

    await expect(turn).resolves.toMatchObject({
      firstAudioReceivedMs: expect.any(Number),
      outputDeltas: 1,
    });
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.slice(1).some((pcm) => pcm.every((sample) => sample === 0))).toBe(true);
  });
});
