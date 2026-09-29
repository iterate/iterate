import { expect, test } from "vitest";
import { platformFailureOf } from "./platform-failures.ts";

test.for([
  { message: "WebSocket connection failed.", failure: "socket-lost" },
  {
    message:
      "Error: WebSocket connection failed.\n    at WebSocket.<anonymous> (file:///w/node_modules/@iterate-com/capnweb/dist/index.js:3021:40)",
    failure: "socket-lost",
  },
  {
    message:
      "until(the one answer): timed out after 20000ms (365 polls, 334 threw, the slowest 66ms) — last error: WebSocket connection failed.",
    failure: "socket-lost",
  },
  { message: "Network connection lost.", failure: "transport-cut" },
  { message: "Error: Network connection lost.", failure: "transport-cut" },
  { message: "TypeError: fetch failed", failure: "connection-reset" },
  {
    message:
      "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
    failure: "object-shut-down",
  },
  {
    message:
      "The control plane failed accessibleTo: Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
    failure: "object-shut-down",
  },
] as const)("$failure: $message", ({ message, failure }) => {
  expect(platformFailureOf(message)).toBe(failure);
});

test.for([
  "Peer closed WebSocket: 3000 the session ended",
  "WebSocket connection failed: closed 1006 before it opened (Received network error or non-101 status code.)",
  "Test timed out in 60000ms.",
  "internal error; reference = gqi35m81degninvamjsup6vs",
  "expected 'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.' to contain 'the commit was refused'",
  'MCP tools/call answered 500: {"error":"boom"}',
])("not the platform's: %s", (message) => {
  expect(platformFailureOf(message)).toBeUndefined();
});
