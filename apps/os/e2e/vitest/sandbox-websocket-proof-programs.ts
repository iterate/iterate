import { WEBSOCKET_ECHO_PROTOCOL } from "./itx-capability-fixtures.ts";

export const CODEX_VERSION = "0.144.4";
export const WS_VERSION = "8.21.0";
export const GLOBAL_WEBSOCKET_MESSAGE = "global-websocket-echo";
export const WS_TEXT_MESSAGE = "ws-text-echo";
export const WS_BINARY_HEX = "000102ff";

/** Ordinary built-in client: no proxy, custom CA, headers, or Iterate code. */
export function globalWebSocketProbeScript(url: string): string {
  return `
const messages = [];
let closeObserved = null;
const socket = new WebSocket(${JSON.stringify(url)});
const result = await new Promise((resolve) => {
  const timeout = setTimeout(() => resolve({ error: "timeout", messages }), 30_000);
  socket.addEventListener("open", () =>
    socket.send(${JSON.stringify(GLOBAL_WEBSOCKET_MESSAGE)}),
  );
  socket.addEventListener("message", (event) => {
    messages.push(String(event.data));
    if (messages.includes(${JSON.stringify(GLOBAL_WEBSOCKET_MESSAGE)})) {
      socket.close(1000, "global-proof-complete");
      setTimeout(() => {
        clearTimeout(timeout);
        resolve({ closeObserved, messages, nodeVersion: process.version });
      }, 2_000);
    }
  });
  socket.addEventListener("close", (event) => {
    closeObserved = { code: event.code, reason: event.reason };
  });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    resolve({ error: "websocket error", messages });
  });
});

console.log(JSON.stringify(result));
process.exit(0);
`.trim();
}

/** Released `ws` client covering auth, protocol, text, binary, and close. */
export function wsProbeScript(url: string, includeAuthorization = true): string {
  return `
import WebSocket from "/tmp/websocket-proof/node_modules/ws/index.js";

const messages = [];
let binaryHex = null;
let exchangeComplete = false;
const socket = new WebSocket(
  ${JSON.stringify(url)},
  ${JSON.stringify(WEBSOCKET_ECHO_PROTOCOL)},
  ${
    includeAuthorization
      ? '{ headers: { Authorization: `Bearer ${process.env.CODEX_API_KEY ?? ""}` } }'
      : "undefined"
  },
);
const result = await new Promise((resolve) => {
  const finish = (value) => {
    clearTimeout(timeout);
    resolve(value);
  };
  const timeout = setTimeout(() => {
    socket.terminate();
    finish({ error: "timeout", messages, binaryHex });
  }, 30_000);
  socket.on("open", () => {
    socket.send(${JSON.stringify(WS_TEXT_MESSAGE)});
    socket.send(Buffer.from(${JSON.stringify(WS_BINARY_HEX)}, "hex"));
  });
  socket.on("message", (data, isBinary) => {
    if (isBinary) binaryHex = Buffer.from(data).toString("hex");
    else messages.push(data.toString());
    if (!exchangeComplete && messages.includes(${JSON.stringify(WS_TEXT_MESSAGE)}) && binaryHex) {
      exchangeComplete = true;
      socket.close(4001, "ws-proof-complete");
    }
  });
  socket.on("close", (code, reason) =>
    finish({
      binaryHex,
      closeObserved: { code, reason: reason.toString() },
      messages,
      nodeVersion: process.version,
      protocol: socket.protocol,
    }),
  );
  socket.on("error", (error) => finish({ error: String(error) }));
});

console.log(JSON.stringify(result));
process.exit(0);
`.trim();
}
