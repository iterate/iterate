// Hermes ships no web streams. capnweb transports a ReadableStream argument
// as many flow-controlled frames — how attachments over 512KB upload
// (lib/composer-attachments.ts chunkedUploadStream) — and it needs the
// classes to exist globally. First import in app/_layout.tsx.
//
// The type assertions here are safe because web-streams-polyfill implements
// the same WHATWG Streams spec that lib.dom's global declarations describe;
// TypeScript just can't unify a package's classes with built-in globals, so
// each assignment (and the require, which only names the package's own
// published types) goes through an assertion. Behaviorally the classes are
// interchangeable — that is the polyfill's entire contract.

if (typeof globalThis.ReadableStream === "undefined") {
  const streams = require("web-streams-polyfill") as typeof import("web-streams-polyfill");
  globalThis.ReadableStream = streams.ReadableStream as unknown as typeof globalThis.ReadableStream;
  globalThis.WritableStream = streams.WritableStream as unknown as typeof globalThis.WritableStream;
  globalThis.TransformStream =
    streams.TransformStream as unknown as typeof globalThis.TransformStream;
}

export {};
