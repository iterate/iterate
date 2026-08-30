// Hermes ships no web streams. capnweb transports a ReadableStream argument
// as many flow-controlled frames — the lane big attachments ride
// (lib/composer-attachments.ts chunkedUploadStream) — and it needs the
// classes to exist globally. First import in app/_layout.tsx.

if (typeof globalThis.ReadableStream === "undefined") {
  const streams = require("web-streams-polyfill") as typeof import("web-streams-polyfill");
  globalThis.ReadableStream = streams.ReadableStream as unknown as typeof globalThis.ReadableStream;
  globalThis.WritableStream = streams.WritableStream as unknown as typeof globalThis.WritableStream;
  globalThis.TransformStream =
    streams.TransformStream as unknown as typeof globalThis.TransformStream;
}

export {};
