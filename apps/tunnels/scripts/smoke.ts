// Exercise the actual repo CLI and deployed gateway with an isolated local HTTP/WebSocket server.
// Explicit opt-in: `pnpm --dir apps/tunnels smoke`. No deploy, fixed tunnel name or shared app state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { tunnelsEnvs } from "../../../envs.ts";

const name = `smoke-${randomUUID().slice(0, 12)}`;
const publicUrl = `https://${name}.${tunnelsEnvs.prd.hostname}`;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      method: request.method,
      path: request.url,
      body: Buffer.concat(chunks).toString(),
      marker: request.headers["x-tunnel-smoke"],
    }),
  );
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) =>
  socket.on("message", (data, binary) => socket.send(data, { binary })),
);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Fixture has no TCP address");

const child = spawn("pnpm", ["tunnel", String(address.port), "--name", name], {
  cwd: fileURLToPath(new URL("../../..", import.meta.url)),
  stdio: ["ignore", "pipe", "pipe"],
  // One process group allows the watchdog to stop pnpm, tsx and Captun together.
  detached: true,
});
let output = "";
const stopped = once(child, "exit");
let socket: WebSocket | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Tunnel startup timed out:\n${output}`)),
      30_000,
    );
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-12_000);
      if (output.includes("Ready") && output.includes(publicUrl)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Tunnel exited (${code}):\n${output}`));
    });
  });

  const response = await fetch(`${publicUrl}/callback?probe=1`, {
    method: "POST",
    headers: { "x-tunnel-smoke": name, "content-type": "text/plain" },
    body: "HTTP through Captun",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    method: "POST",
    path: "/callback?probe=1",
    body: "HTTP through Captun",
    marker: name,
  });

  socket = new WebSocket(publicUrl.replace("https:", "wss:") + "/socket");
  await once(socket, "open", { signal: AbortSignal.timeout(15_000) });
  const reply = once(socket, "message", { signal: AbortSignal.timeout(15_000) });
  socket.send("WebSocket through Captun");
  const [message, binary] = await reply;
  assert.equal(message.toString(), "WebSocket through Captun");
  assert.equal(binary, false);
  const binaryReply = once(socket, "message", { signal: AbortSignal.timeout(15_000) });
  socket.send(Buffer.from([0, 1, 127, 255]));
  const [bytes, isBinary] = await binaryReply;
  assert.deepEqual(Buffer.from(bytes), Buffer.from([0, 1, 127, 255]));
  assert.equal(isBinary, true);
  console.log(
    `PASS: ${publicUrl} forwards HTTP bodies/headers and text/binary WebSocket messages.`,
  );
} finally {
  socket?.terminate();
  for (const client of sockets.clients) client.terminate();
  sockets.close();
  server.closeAllConnections();
  server.close();
  if (child.pid && child.exitCode === null && !child.signalCode) {
    const pid = child.pid;
    process.kill(-pid, "SIGTERM");
    const timeout = setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) process.kill(-pid, "SIGKILL");
    }, 5_000);
    try {
      await stopped;
    } finally {
      clearTimeout(timeout);
    }
  }
}
