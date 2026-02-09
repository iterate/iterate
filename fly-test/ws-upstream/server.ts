import fs from "node:fs";

const PORT = Number(process.env.UPSTREAM_WS_PORT ?? "19090");
const LOG_PATH = process.env.UPSTREAM_WS_LOG_PATH ?? "/tmp/ws-upstream.log";
let sessionCounter = 0;

type WsData = { sessionId: string };

function appendLog(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  process.stdout.write(`${line}\n`);
  fs.appendFileSync(LOG_PATH, `${line}\n`);
}

function nextSessionId(): string {
  sessionCounter += 1;
  return `upstream-${sessionCounter}`;
}

function summarizeMessage(message: string | Buffer | Uint8Array): string {
  if (typeof message === "string") return message.replaceAll("\n", "\\n").slice(0, 180);
  return `[bytes=${new Uint8Array(message).byteLength}]`;
}

fs.mkdirSync("/tmp", { recursive: true });
fs.appendFileSync(LOG_PATH, "");
appendLog(`BOOT pid=${process.pid} port=${PORT}`);

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch(request: Request, server: Bun.Server<WsData>) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/ws") {
      const sessionId = nextSessionId();
      if (server.upgrade(request, { data: { sessionId } })) return;
      return new Response("websocket upgrade failed\n", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
  websocket: {
    open(ws: Bun.ServerWebSocket<WsData>): void {
      appendLog(`OPEN id=${ws.data.sessionId}`);
      ws.send("server-secret: welcome from ws-upstream");
    },
    message(ws: Bun.ServerWebSocket<WsData>, message: string | Buffer | Uint8Array): void {
      appendLog(`IN id=${ws.data.sessionId} msg="${summarizeMessage(message)}"`);
      const text =
        typeof message === "string" ? message : `[bytes=${new Uint8Array(message).byteLength}]`;
      ws.send(`server-secret: upstream received -> ${text}`);
    },
    close(ws: Bun.ServerWebSocket<WsData>, code: number, reason: string): void {
      appendLog(`CLOSE id=${ws.data.sessionId} code=${code} reason="${reason || ""}"`);
    },
  },
});

appendLog(`LISTEN port=${PORT}`);
