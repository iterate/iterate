import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { connectGrokRealtimeVoice } from "../../src/voice/grok-realtime-voice.ts";

const outputPath = resolve(dirname(fileURLToPath(import.meta.url)), "result.json");
const apiKey = process.env.XAI_API_KEY;
if (!apiKey) throw new Error("XAI_API_KEY must be injected by Doppler.");

const socket = await connectGrokRealtimeVoice({
  apiKey,
  instructions: "Repeat the requested sentence exactly and add nothing else.",
  sampleRateHz: 16_000,
  turnDetection: "manual",
});

const binaryMessages: Array<{ byteLength: number; receivedAtMonotonicMs: number }> = [];
const providerEvents: Array<{ raw: string; receivedAtMonotonicMs: number; type: string }> = [];
const startedAt = performance.now();

const completed = new Promise<void>((resolveCompleted, rejectCompleted) => {
  const timeout = setTimeout(() => {
    rejectCompleted(new Error("Timed out waiting for the packet-shape response."));
  }, 30_000);

  socket.addEventListener("message", (event) => {
    const receivedAtMonotonicMs = performance.now() - startedAt;
    if (typeof event.data === "string") {
      let type = "unparseable-text";
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          "type" in parsed &&
          typeof parsed.type === "string"
        ) {
          type = parsed.type;
        }
      } catch {
        // The raw value below is the durable evidence for malformed text.
      }
      providerEvents.push({ raw: event.data, receivedAtMonotonicMs, type });
      if (type === "response.done") {
        clearTimeout(timeout);
        resolveCompleted();
      } else if (type === "error") {
        clearTimeout(timeout);
        rejectCompleted(new Error(`Grok returned ${event.data}`));
      }
      return;
    }

    const byteLength =
      event.data instanceof ArrayBuffer
        ? event.data.byteLength
        : ArrayBuffer.isView(event.data)
          ? event.data.byteLength
          : event.data instanceof Blob
            ? event.data.size
            : -1;
    binaryMessages.push({ byteLength, receivedAtMonotonicMs });
  });
  socket.addEventListener(
    "close",
    (event) => {
      clearTimeout(timeout);
      rejectCompleted(new Error(`Grok closed before response.done: ${event.code} ${event.reason}`));
    },
    { once: true },
  );
  socket.addEventListener(
    "error",
    () => {
      clearTimeout(timeout);
      rejectCompleted(new Error("Grok WebSocket errored before response.done."));
    },
    { once: true },
  );
});

socket.send(
  JSON.stringify({
    item: {
      content: [
        {
          text: "Say exactly: Why don't scientists trust atoms? Because they make up everything!",
          type: "input_text",
        },
      ],
      role: "user",
      type: "message",
    },
    type: "conversation.item.create",
  }),
);
socket.send(JSON.stringify({ type: "response.create" }));

try {
  await completed;
} finally {
  socket.close(1000, "packet-shape probe complete");
}

const result = {
  binaryMessages,
  completedAtUtc: new Date().toISOString(),
  maximumBinaryMessageBytes: Math.max(0, ...binaryMessages.map(({ byteLength }) => byteLength)),
  oddBinaryMessageCount: binaryMessages.filter(({ byteLength }) => byteLength % 2 !== 0).length,
  providerEventTypes: providerEvents.map(({ type }) => type),
  schemaVersion: 1,
  totalBinaryBytes: binaryMessages.reduce((total, { byteLength }) => total + byteLength, 0),
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result));
