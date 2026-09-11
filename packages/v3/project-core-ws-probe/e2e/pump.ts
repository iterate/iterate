import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { gunzipSync } from "node:zlib";

const base = process.env.WORKER_BASE_URL;
if (!base) throw new Error("set WORKER_BASE_URL to the deployed diagnostic Worker");

async function text(path: string) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "terminal-accepted");
}

async function raw(path: string, acceptEncoding: string) {
  const url = new URL(path, base);
  const client = url.protocol === "https:" ? https : http;
  return await new Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }>(
    (resolve, reject) => {
      const request = client.get(
        url.href,
        { headers: { "accept-encoding": acceptEncoding } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({ headers: response.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      request.on("error", reject);
      request.setTimeout(10_000, () => request.destroy(new Error("raw request timed out")));
    },
  );
}

for (let index = 0; index < 10; index++) await text("/http-terminal-accepted-reentrant-pipe");

const gzip = "H4sIAAAAAAAAEytJLcrNzEvM0U1MTk4tKElNAQCqUrN6EQAAAA==";
for (const path of ["/http-terminal-gzip-reentrant-raw", "/http-terminal-gzip-reentrant-pipe"]) {
  const identity = await raw(path, "identity");
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.equal(identity.headers["content-length"], undefined);
  assert.equal(identity.body.toString(), "terminal-accepted");

  const compressed = await raw(path, "gzip");
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(compressed.body).toString(), "terminal-accepted");
  assert.equal(compressed.body.length, 37);
  if (path.endsWith("raw")) {
    assert.equal(compressed.headers["content-length"], "37");
    assert.equal(Buffer.from(compressed.body).toString("base64"), gzip);
  } else assert.equal(compressed.headers["content-length"], undefined);
}

const slow = await fetch(new URL("/http-terminal-slow-reentrant-pipe", base), {
  signal: AbortSignal.timeout(10_000),
});
assert.equal(slow.status, 202);
assert.equal(await slow.text(), "terminal-accepted");

const delayed = await fetch(new URL("/http-terminal-slow-reentrant-pipe", base), {
  signal: AbortSignal.timeout(10_000),
});
const delayedReader = delayed.body?.getReader();
assert.ok(delayedReader);
const delayedFirst = await delayedReader.read();
assert.equal(new TextDecoder().decode(delayedFirst.value), "terminal-");
await new Promise((resolve) => setTimeout(resolve, 750));
const delayedSecond = await delayedReader.read();
assert.equal(new TextDecoder().decode(delayedSecond.value), "accepted");
assert.deepEqual(await delayedReader.read(), { done: true, value: undefined });

const controller = new AbortController();
const canceled = await fetch(new URL("/http-terminal-slow-reentrant-pipe", base), {
  signal: controller.signal,
});
const reader = canceled.body?.getReader();
assert.ok(reader);
const first = await reader.read();
assert.equal(new TextDecoder().decode(first.value), "terminal-");
controller.abort();
await assert.rejects(
  reader.read(),
  (error: unknown) => error instanceof DOMException && error.name === "AbortError",
);

const socketUrl = new URL("/reentrant-pipe-socket", base);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(socketUrl.href);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("socket open failed")), { once: true });
});
socket.send("probe");
const message = await new Promise<string>((resolve, reject) => {
  socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
  socket.addEventListener("error", () => reject(new Error("socket message failed")), {
    once: true,
  });
});
assert.equal(message, "reentrant:probe");
socket.close(1000, "diagnostic complete");
await new Promise<void>((resolve, reject) => {
  socket.addEventListener(
    "close",
    (event) => {
      assert.equal(event.code, 1000);
      resolve();
    },
    { once: true },
  );
  socket.addEventListener("error", () => reject(new Error("socket close failed")), { once: true });
});

console.log(JSON.stringify({ complete: true }));
