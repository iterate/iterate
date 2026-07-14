import { WEBSOCKET_ECHO_PROTOCOL } from "./itx-capability-fixtures.ts";

export const CODEX_VERSION = "0.144.4";
export const WS_VERSION = "8.21.0";
export const GLOBAL_WEBSOCKET_MESSAGE = "global-websocket-echo";
export const WS_TEXT_MESSAGE = "ws-text-echo";
export const WS_BINARY_HEX = "000102ff";

/**
 * An ordinary zero-configuration WebSocket program: no proxy agent, custom CA,
 * headers, or Iterate-specific code. It proves bare WSS egress, a server-first
 * frame, and a client frame through container intercept.
 */
export function globalWebSocketProbeScript(url: string): string {
  return `
const result = await new Promise((resolve) => {
  const messages = [];
  let closeObserved = null;
  let opened = false;
  let settled = false;
  const socket = new WebSocket(${JSON.stringify(url)});
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve(value);
  };
  const timeout = setTimeout(() => {
    socket.close();
    finish({ ok: false, stage: "timeout", messages, opened });
  }, 30_000);
  socket.addEventListener("open", () => {
    opened = true;
    socket.send(${JSON.stringify(GLOBAL_WEBSOCKET_MESSAGE)});
  });
  socket.addEventListener("message", (event) => {
    messages.push(String(event.data));
    if (messages.includes(${JSON.stringify(GLOBAL_WEBSOCKET_MESSAGE)})) {
      socket.close(1000, "global-proof-complete");
      setTimeout(() =>
        finish({
          closeAttempted: true,
          closeObserved,
          duplexOk: true,
          messages,
          nodeVersion: process.version,
          opened,
          protocol: socket.protocol,
          stage: "messages",
        }),
      2_000);
    }
  });
  socket.addEventListener("close", (event) => {
    closeObserved = { code: event.code, reason: event.reason };
  });
  socket.addEventListener("error", () =>
    finish({ ok: false, stage: "error", messages, opened }),
  );
});

console.log(JSON.stringify(result));
process.exit(0);
`.trim();
}

/**
 * The unmodified npm `ws` client with its normal API. This covers request
 * headers (the Codex-shaped bearer token), subprotocol negotiation, text and
 * binary frames, server-first delivery, and an exact reciprocal close after
 * receiving both echoes.
 */
export function wsProbeScript(url: string, includeAuthorization = true): string {
  return `
import WebSocket from "/tmp/websocket-proof/node_modules/ws/index.js";

const result = await new Promise((resolve) => {
  const messages = [];
  let binaryHex = null;
  let closeObserved = null;
  let exchangeComplete = false;
  let settled = false;
  const socket = new WebSocket(
    ${JSON.stringify(url)},
    ${JSON.stringify(WEBSOCKET_ECHO_PROTOCOL)},
    ${
      includeAuthorization
        ? '{ headers: { Authorization: `Bearer ${process.env.CODEX_API_KEY ?? ""}` } }'
        : "undefined"
    },
  );
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve(value);
  };
  const timeout = setTimeout(() => {
    socket.terminate();
    finish({ ok: false, stage: "timeout", messages, binaryHex });
  }, 30_000);
  socket.on("open", () => {
    socket.send(${JSON.stringify(WS_TEXT_MESSAGE)});
    socket.send(Buffer.from(${JSON.stringify(WS_BINARY_HEX)}, "hex"));
  });
  socket.on("message", (data, isBinary) => {
    if (isBinary) binaryHex = Buffer.from(data).toString("hex");
    else messages.push(data.toString());
    if (
      !exchangeComplete &&
      messages.includes(${JSON.stringify(WS_TEXT_MESSAGE)}) &&
      binaryHex !== null
    ) {
      exchangeComplete = true;
      socket.close(4001, "ws-proof-complete");
    }
  });
  socket.on("close", (code, reason) => {
    closeObserved = { code, reason: reason.toString() };
    finish({
      binaryHex,
      closeAttempted: exchangeComplete,
      closeObserved,
      messages,
      nodeVersion: process.version,
      ok: exchangeComplete,
      protocol: socket.protocol,
      stage: exchangeComplete ? "close" : "early-close",
    });
  });
  socket.on("error", (error) =>
    finish({ ok: false, stage: "error", error: String(error) }),
  );
});

console.log(JSON.stringify(result));
process.exit(0);
`.trim();
}
