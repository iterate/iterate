# Blind Relayed Fetch over a Cap'n Web Peer

**Status:** minimal proof-of-concept plus Worker-shaped prototype  
**Local proof tested:** Node.js v22.16.0 on 2026-07-02  
**Goal:** let a Cloudflare Worker issue HTTPS requests whose final network egress is a Node machine's IP address, while that Node machine acts only as a blind TCP relay and does not receive the HTTP request or response in plaintext.

This document is a standalone implementation bundle. It contains the problem statement, research findings, architecture, runnable local proof, Cloudflare Worker-shaped prototype, and all source files required to reproduce the work.

## 1. Problem statement

A Worker currently calls `fetch()` directly. The desired behavior is a fetch-like entry point:

```ts
const response = await relayedFetch(request);
```

Internally, `relayedFetch()` should use a Cap'n Web/Captun-style peer stub representing a Node process that already opened an inbound WebSocket/RPC connection to the Worker. The Node process should provide the egress IP, but should not be handed a `Request` object, should not call `fetch()`, and should not see plaintext headers, cookies, bearer tokens, request bodies, response headers, or response bodies for HTTPS targets.

The correct abstraction is therefore not a remote fetcher. It is a blind dialer:

```ts
interface BlindRelay {
  dial(request: { host: string; port: number }): Promise<{
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }>;
}
```

The Worker owns the HTTP request, performs TLS, validates the target certificate, writes an HTTP/1.1 request inside the TLS session, and parses the HTTP response. The Node relay only opens a TCP socket and pipes opaque bytes.

## 2. Key conclusion

For this privacy property, **do not use Captun's normal `fetch(request)` capability**. Captun's public README describes its normal mode as a Node client exposing a local fetcher over WebSocket RPC, with the Worker calling `fetch(request)` on that stub. That means the Node process receives web-standard `Request` and `Response` objects and can inspect plaintext traffic.

The minimal privacy-preserving design is:

```text
Worker relayedFetch(request)
  -> Cap'n Web RPC: relay.dial({ host, port: 443 })
  -> Worker-side TLS over returned byte streams
  -> Worker-side HTTP/1.1 over TLS
  -> Node relay forwards opaque TCP bytes to target
  -> target sees the Node relay's public IP
```

The relay still sees metadata: the hostname it was asked to dial, the port, connection timing, byte counts, and usually TLS ClientHello/SNI metadata. It can also drop, delay, or corrupt bytes. With normal HTTPS certificate verification enabled in the Worker, it cannot silently read or modify HTTP contents without breaking TLS.

## 3. What this bundle proves

The runnable local proof creates a real HTTPS server, sends a POST request through a blind TCP relay, and verifies three facts:

1. The HTTPS target receives the secret path, header, and body.
2. The relay's first observed outbound bytes are a TLS ClientHello, not an HTTP request.
3. A plaintext leak check against the relay's byte preview passes.

The local proof uses Node's native `tls.connect({ socket })` API to stand in for Worker-side TLS. The Worker-shaped prototype uses the same design with Cloudflare Workers `nodejs_compat`, `node:tls`, and `node:stream` APIs. Cloudflare's docs confirm Workers support `node:tls` `connect`/`TLSSocket` and Node streams with `nodejs_compat`, but they do not explicitly document every `tls.connect()` option such as wrapping an arbitrary supplied Duplex. Treat the Worker adapter here as the smallest candidate implementation to test against the current Workers runtime. If that specific `socket` option is not supported in the deployed runtime, the same `BlindRelay` interface remains correct; replace the Worker TLS adapter with an audited userland/WASM TLS stack.

## 4. Architecture

### 4.1 Sequence

```text
Node relay process                                      Cloudflare Worker Durable Object
------------------                                      --------------------------------
newWebSocketRpcSession(wss://.../connect, relay)  --->  stores BlindRelay stub
                                                        receives /egress?url=https://api.example.com/path
                                                        builds Request
                                                        calls relay.dial({host:"api.example.com", port:443})
net.connect("api.example.com", 443)                <---  receives dial RPC
returns ReadableStream/WritableStream              --->  wraps streams as Duplex
                                                        tls.connect({ socket: duplex, servername })
opaque TLS bytes flow both ways                     <-->  writes HTTP/1.1 inside TLS
api.example.com sees relay IP                            returns Response to caller
```

### 4.2 Visibility model

| Data                   |                                            Worker sees |                                   Node relay sees | HTTPS target sees |
| ---------------------- | -----------------------------------------------------: | ------------------------------------------------: | ----------------: |
| Full URL, path, query  |                                                    Yes | Host requested for `dial`; path hidden inside TLS |               Yes |
| Request headers/body   |                                                    Yes |                                     No, for HTTPS |               Yes |
| Response headers/body  |                                                    Yes |                                     No, for HTTPS |               Yes |
| Target host and port   |                                                    Yes |                                               Yes |               Yes |
| Timing and byte counts |                                                    Yes |                                               Yes |               Yes |
| Egress source IP       | Cloudflare sees relay connection; target sees relay IP |                                Its own IP is used |     Node relay IP |
| Plain HTTP traffic     |                                   Not implemented here |       Would be visible if implemented without TLS |               Yes |

## 5. Research notes

### 5.1 Captun's normal fetcher is not opaque

Captun is a small self-hosted alternative to ngrok/Cloudflare Tunnel, with a public side hosted on Workers and a Node side connected by WebSocket RPC. Its README describes the Node client as exposing its local fetcher, while the Worker calls `fetch(request)` through a tunnel handle. That is ideal for convenient remote fetch, but it is the wrong primitive when the relay must not see plaintext.

Relevant first-party sources:

- Captun README: https://github.com/iterate/captun/blob/main/README.md
- Captun Worker example/source pattern: https://github.com/iterate/captun

### 5.2 Cap'n Web is the right RPC substrate for a dial capability

Cap'n Web is a JavaScript-native object-capability RPC system. Its README describes JSON-based RPC over HTTP, WebSocket, and `postMessage`, bidirectional calls, pass-by-reference objects via `RpcTarget`, and stream support. That makes it a good fit for exposing a `BlindRelay` object instead of a `Fetcher` object.

Relevant first-party sources:

- Cap'n Web README: https://github.com/cloudflare/capnweb/blob/main/README.md
- Cap'n Web npm package/types: https://www.npmjs.com/package/capnweb

### 5.3 Cloudflare Workers APIs involved

Workers provide WebSocket handling and Durable Objects, which are appropriate for storing the currently connected relay peer. Workers also provide outbound TCP sockets via `cloudflare:sockets.connect()`, but that API is not directly useful for a reverse WebSocket relay because the TCP socket it creates egresses from Cloudflare, not from the home/Node relay. The TCP socket `startTls()` method is documented as only applying to sockets created with `secureTransport: "starttls"`; it is not a general TLS wrapper for arbitrary WebSocket/RPC byte streams.

As of the referenced Cloudflare docs, Workers Node.js compatibility includes `node:tls` with `connect`/`TLSSocket` and `node:stream`; this bundle's Worker candidate adapter tries to use those APIs to run TLS over a Duplex built from Cap'n Web-returned Web Streams.

Relevant first-party sources:

- Workers TCP sockets: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
- Workers WebSockets: https://developers.cloudflare.com/workers/runtime-apis/websockets/
- Workers Durable Objects WebSocket patterns: https://developers.cloudflare.com/durable-objects/examples/websocket-server/
- Workers Node.js compatibility overview: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Workers `node:tls`: https://developers.cloudflare.com/workers/runtime-apis/nodejs/tls/
- Workers Node streams: https://developers.cloudflare.com/workers/runtime-apis/nodejs/streams/
- Workers Web Crypto: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

### 5.4 Node APIs involved

The relay uses Node's `node:net` module to create a stream-based TCP client. The local proof uses Node's `node:tls` to wrap a Duplex representing the blind relay stream. This demonstrates the protocol property independent of Cloudflare deployment details.

Relevant first-party sources:

- Node `net`: https://nodejs.org/api/net.html
- Node `tls`: https://nodejs.org/api/tls.html
- Node streams: https://nodejs.org/api/stream.html

## 6. Limitations and production requirements

1. **Worker TLS adapter must be verified in the deployed Workers runtime.** The local proof demonstrates the cleanest adapter with Node `tls.connect({ socket })`. Cloudflare documents `node:tls` support but not every option combination. The fallback architecture is a userland/WASM TLS adapter behind the same `relayedFetch()` interface.
2. **HTTP/2 is not implemented.** This prototype forces HTTP/1.1 with ALPN `http/1.1`.
3. **Streaming HTTP responses are not fully implemented.** The prototype collects the response before returning it. That is fine for a minimal proof; production should stream decrypted response bytes through a `ReadableStream`.
4. **Chunked transfer decoding is not implemented in the local parser.** The local HTTPS test server sends `Content-Length`. Production should implement chunked decoding or use a mature HTTP parser.
5. **The relay sees metadata.** It sees the dialed host/port, connection timing, byte counts, and normally TLS ClientHello/SNI. ECH is a separate target/client capability problem.
6. **The relay can deny service.** A blind relay can always drop, delay, or corrupt bytes. TLS authentication prevents silent content inspection/modification when certificate verification is enabled.
7. **Use allow-lists.** A general-purpose relay is risky. Restrict target hosts and ports in both Worker and relay policy.
8. **Do not support plaintext HTTP for this privacy goal.** Plain HTTP would expose the entire request and response to the relay.
9. **Pin and audit dependencies.** Cap'n Web and any TLS/HTTP parser dependency become part of the security boundary.

## 7. Minimal runnable local reproduction

### 7.1 Setup

Create a directory and copy the source files from section 9 into the listed paths. Then run:

```bash
npm install
npm run test:local
```

The test uses `openssl` to create a one-day self-signed certificate for a local HTTPS target. No public network is required.

### 7.2 Expected output shape

The exact TLS bytes vary on every run. The important parts are that the target receives the secrets and the relay plaintext leak check says `PASS`.

```text
target response status: 200
target response body:
{
  "ok": true,
  "method": "POST",
  "url": "/secret?token=worker-only",
  "authorization": "Bearer not-visible-to-relay",
  "workerSecretHeader": "also-hidden-from-relay",
  "body": "payload hidden inside TLS"
}
relay observation:
{
  "host": "localhost",
  "port": 9443,
  "bytesWorkerToTarget": 748,
  "bytesTargetToWorker": 2313,
  "firstWorkerToTargetHex": "16 03 01 01 79 01 00 01 75 03 03 77 dc de de c1 eb 1c d0 bd 8a 88 3a f8 0d c4 fc b6 bf ca f8 4f 06 2a 82 17 4a 3c 8d f2 bd cd ab 20 33 91 11 f7 c5 87 f9 3b b7 e9 e7 be ba c4 c2 4a 1f b2 41 35",
  "firstWorkerToTargetAscii": "....y...u..w..........:........O.*..J<..... 3......;.......J..A5}#..q.b..]Pz.v......./.+.0.,...'",
  "firstTargetToWorkerHex": "16 03 03 00 7a 02 00 00 76 03 03 a2 8c b4 d3 05 66 ad ca 5d 65 6c 9f e3 5a c8 ac e5 95 68 9c e1 c1 da 82 6e 4f 62 2c c6 ca 45 30 20 33 91 11 f7 c5 87 f9 3b b7 e9 e7 be ba c4 c2 4a 1f b2 41 35"
}
relay plaintext leak check: PASS
```

## 8. Worker prototype deployment shape

The Worker prototype source is intentionally small:

- `prototype/worker.ts` owns the public Worker entry point and Durable Object.
- `prototype/node-relay-agent.ts` runs on the home/egress Node machine and exposes a `BlindRelay` RPC target.
- `prototype/worker-node-tls-relayed-fetch.ts` provides the fetch-shaped API: `relayedFetch(input, init, relay)`.
- `prototype/web-stream-duplex.ts` adapts Cap'n Web Web Streams into a Node-style Duplex for `node:tls`.
- `prototype/types.ts` defines the RPC interface.

Typical deployment flow:

```bash
npm install
npx wrangler secret put RELAY_TOKEN
npx wrangler deploy -c prototype/wrangler.toml

# On the Node relay machine:
export RELAY_GATEWAY_URL="wss://YOUR_WORKER_HOST/__relay/connect?token=YOUR_SECRET"
npx tsx prototype/node-relay-agent.ts

# From a client:
curl "https://YOUR_WORKER_HOST/egress?url=https://example.com/"
```

For production, replace the demo `/egress?url=...` route with a narrower application route so callers cannot turn the relay into an open proxy.

## 9. Source files

### `package.json`

```json
{
  "name": "blind-relay-relayed-fetch-poc",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Minimal proof of concept for HTTPS relayed fetch through a blind Node TCP relay.",
  "scripts": {
    "test:local": "node src/local-proof/run.mjs"
  },
  "dependencies": {
    "capnweb": "^0.8.0",
    "node-forge": "^1.3.1"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "wrangler": "^4.0.0"
  }
}
```

### `src/local-proof/duplex-from-web.mjs`

```js
import { Duplex } from "node:stream";

export class WebStreamDuplex extends Duplex {
  #reader;
  #writer;
  #reading = false;
  #destroyed = false;

  constructor({ readable, writable }) {
    super({ allowHalfOpen: false });
    this.#reader = readable.getReader();
    this.#writer = writable.getWriter();
  }

  async _read() {
    if (this.#reading || this.#destroyed) return;
    this.#reading = true;

    try {
      while (!this.#destroyed) {
        const { value, done } = await this.#reader.read();
        if (done) {
          this.push(null);
          return;
        }

        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (!this.push(chunk)) return;
      }
    } catch (error) {
      this.destroy(error);
    } finally {
      this.#reading = false;
    }
  }

  _write(chunk, _encoding, callback) {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.#writer.write(bytes).then(() => callback(), callback);
  }

  _final(callback) {
    this.#writer.close().then(
      () => callback(),
      (error) => {
        if (error && error.code === "ERR_INVALID_STATE") callback();
        else callback(error);
      },
    );
  }

  _destroy(error, callback) {
    this.#destroyed = true;
    Promise.allSettled([
      this.#reader.cancel(error).catch(() => {}),
      this.#writer.abort(error).catch(() => {}),
    ]).finally(() => callback(error));
  }
}
```

### `src/local-proof/blind-relay.mjs`

```js
import net from "node:net";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";

function toHexPreview(bytes, max = 64) {
  return Array.from(bytes.slice(0, max), (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function toAsciiPreview(bytes, max = 96) {
  return Buffer.from(bytes.slice(0, max))
    .toString("latin1")
    .replace(/[^\x20-\x7e]/g, ".");
}

export class CountingBlindRelay {
  observations = [];

  async dial({ host, port }) {
    if (typeof host !== "string" || host.length === 0) {
      throw new Error("host must be a non-empty string");
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("port must be an integer from 1 to 65535");
    }

    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    await once(socket, "connect");

    const observation = {
      host,
      port,
      bytesWorkerToTarget: 0,
      bytesTargetToWorker: 0,
      firstWorkerToTargetHex: "",
      firstWorkerToTargetAscii: "",
      firstTargetToWorkerHex: "",
    };
    this.observations.push(observation);

    const socketReadable = Readable.toWeb(socket);
    const socketWritable = Writable.toWeb(socket);

    const observeOutbound = new TransformStream({
      transform(chunk, controller) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        observation.bytesWorkerToTarget += bytes.byteLength;
        if (!observation.firstWorkerToTargetHex) {
          observation.firstWorkerToTargetHex = toHexPreview(bytes);
          observation.firstWorkerToTargetAscii = toAsciiPreview(bytes);
        }
        controller.enqueue(bytes);
      },
    });

    const observeInbound = new TransformStream({
      transform(chunk, controller) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        observation.bytesTargetToWorker += bytes.byteLength;
        if (!observation.firstTargetToWorkerHex) {
          observation.firstTargetToWorkerHex = toHexPreview(bytes);
        }
        controller.enqueue(bytes);
      },
    });

    observeOutbound.readable.pipeTo(socketWritable).catch(() => socket.destroy());

    return {
      readable: socketReadable.pipeThrough(observeInbound),
      writable: observeOutbound.writable,
    };
  }
}
```

### `src/local-proof/relayed-fetch-node.mjs`

```js
import tls from "node:tls";
import { once } from "node:events";
import { WebStreamDuplex } from "./duplex-from-web.mjs";

function normalizeHeaders(request, bodyBytes) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);

  headers.set("host", url.host);
  headers.set("connection", "close");

  if (bodyBytes && bodyBytes.byteLength > 0 && !headers.has("content-length")) {
    headers.set("content-length", String(bodyBytes.byteLength));
  }

  return headers;
}

function encodeHttp1Request(request, bodyBytes) {
  const url = new URL(request.url);
  const path = `${url.pathname || "/"}${url.search}`;
  const headers = normalizeHeaders(request, bodyBytes);
  const lines = [`${request.method} ${path} HTTP/1.1`];

  for (const [name, value] of headers) {
    lines.push(`${name}: ${value}`);
  }

  const head = Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "utf8");
  return bodyBytes && bodyBytes.byteLength > 0
    ? Buffer.concat([head, Buffer.from(bodyBytes)])
    : head;
}

function parseHttp1Response(buffer) {
  const split = buffer.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("malformed HTTP response: missing header terminator");

  const headerText = buffer.subarray(0, split).toString("latin1");
  const body = buffer.subarray(split + 4);
  const [statusLine, ...headerLines] = headerText.split("\r\n");
  const match = /^HTTP\/1\.\d\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!match) throw new Error(`malformed HTTP status line: ${statusLine}`);

  const headers = new Headers();
  for (const line of headerLines) {
    const index = line.indexOf(":");
    if (index > 0) {
      headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
  }

  return new Response(body, {
    status: Number(match[1]),
    statusText: match[2] || "",
    headers,
  });
}

export async function relayedFetch(input, init = {}, relay, tlsOptions = {}) {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);

  if (url.protocol !== "https:") {
    throw new Error(`this proof-of-concept only implements https:, got ${url.protocol}`);
  }

  const bodyBytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  const port = url.port ? Number(url.port) : 443;
  const dialed = await relay.dial({ host: url.hostname, port });
  const tunneledDuplex = new WebStreamDuplex(dialed);

  const tlsSocket = tls.connect({
    socket: tunneledDuplex,
    servername: url.hostname,
    ALPNProtocols: ["http/1.1"],
    ...tlsOptions,
  });

  await once(tlsSocket, "secureConnect");

  const chunks = [];
  tlsSocket.on("data", (chunk) => chunks.push(chunk));
  tlsSocket.write(encodeHttp1Request(request, bodyBytes));
  tlsSocket.end();

  await once(tlsSocket, "close");
  return parseHttp1Response(Buffer.concat(chunks));
}
```

### `src/local-proof/run.mjs`

```js
import https from "node:https";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import fs from "node:fs/promises";
import { once } from "node:events";
import { CountingBlindRelay } from "./blind-relay.mjs";
import { relayedFetch } from "./relayed-fetch-node.mjs";

const tmpDir = new URL("./.tmp/", import.meta.url);
const keyPath = new URL("key.pem", tmpDir);
const certPath = new URL("cert.pem", tmpDir);

async function ensureSelfSignedCertificate() {
  mkdirSync(tmpDir, { recursive: true });

  if (existsSync(keyPath) && existsSync(certPath)) return;

  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath.pathname,
      "-out",
      certPath.pathname,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ],
    { stdio: "pipe" },
  );

  if (result.status !== 0) {
    throw new Error(`openssl failed: ${result.stderr.toString()}`);
  }
}

async function main() {
  await ensureSelfSignedCertificate();

  const key = await fs.readFile(keyPath);
  const cert = await fs.readFile(certPath);

  const server = https.createServer({ key, cert }, (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const responseObject = {
        ok: true,
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        workerSecretHeader: req.headers["x-worker-secret"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      const body = Buffer.from(JSON.stringify(responseObject, null, 2));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(body.byteLength),
        connection: "close",
      });
      res.end(body);
    });
  });

  server.listen(9443, "127.0.0.1");
  await once(server, "listening");

  const relay = new CountingBlindRelay();
  const request = new Request("https://localhost:9443/secret?token=worker-only", {
    method: "POST",
    headers: {
      authorization: "Bearer not-visible-to-relay",
      "x-worker-secret": "also-hidden-from-relay",
      "content-type": "text/plain",
    },
    body: "payload hidden inside TLS",
  });

  const response = await relayedFetch(request, {}, relay, {
    rejectUnauthorized: false,
  });

  const text = await response.text();
  const observation = relay.observations[0];

  const plaintextNeedles = [
    "POST /secret",
    "authorization",
    "Bearer not-visible-to-relay",
    "x-worker-secret",
    "payload hidden inside TLS",
  ];
  const relayPreview = `${observation.firstWorkerToTargetAscii}\n${observation.firstWorkerToTargetHex}`;
  const relayPreviewLeaksPlaintext = plaintextNeedles.some((needle) =>
    relayPreview.includes(needle),
  );

  console.log("target response status:", response.status);
  console.log("target response body:");
  console.log(text);
  console.log("relay observation:");
  console.log(JSON.stringify(observation, null, 2));
  console.log("relay plaintext leak check:", relayPreviewLeaksPlaintext ? "FAIL" : "PASS");

  server.close();

  if (response.status !== 200) throw new Error("unexpected response status");
  if (!text.includes("Bearer not-visible-to-relay"))
    throw new Error("target did not receive secret header");
  if (!text.includes("payload hidden inside TLS"))
    throw new Error("target did not receive secret body");
  if (relayPreviewLeaksPlaintext) throw new Error("relay preview leaked plaintext");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

### `prototype/types.ts`

```ts
import type { RpcStub } from "capnweb";

export type DialRequest = {
  host: string;
  port: number;
};

export type DialResult = {
  // Bytes read from the target TCP socket by the relay and delivered to the Worker.
  readable: ReadableStream<Uint8Array>;

  // Bytes written by the Worker and forwarded by the relay to the target TCP socket.
  writable: WritableStream<Uint8Array>;
};

export interface BlindRelay {
  ping(): Promise<{ ok: true; now: number }>;
  dial(request: DialRequest): Promise<DialResult>;
}

export type BlindRelayStub = RpcStub<BlindRelay>;
```

### `prototype/node-relay-agent.ts`

```ts
import net from "node:net";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import type { BlindRelay, DialRequest, DialResult } from "./types";

const DEFAULT_ALLOWED_PORTS = new Set([443]);

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function validateDialRequest(request: DialRequest): void {
  if (typeof request.host !== "string" || request.host.length === 0) {
    throw new Error("host must be a non-empty string");
  }

  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535) {
    throw new Error("port must be an integer from 1 to 65535");
  }

  if (!DEFAULT_ALLOWED_PORTS.has(request.port)) {
    throw new Error(`port ${request.port} is not allowed by this relay`);
  }

  // Minimal demo guardrail. Production deployments should use a strict allow-list
  // of known target hostnames rather than a regex.
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(request.host)) {
    throw new Error(`host ${request.host} is blocked by this relay`);
  }
}

class NodeBlindRelay extends RpcTarget implements BlindRelay {
  async ping() {
    return { ok: true as const, now: Date.now() };
  }

  async dial(request: DialRequest): Promise<DialResult> {
    validateDialRequest(request);

    const socket = net.connect({ host: request.host, port: request.port });
    socket.setNoDelay(true);

    await Promise.race([
      once(socket, "connect"),
      once(socket, "error").then(([error]) => Promise.reject(error)),
    ]);

    // Important: no TLS termination, no HTTP parsing, no fetch(). This process
    // only forwards opaque bytes between the Worker and the target TCP socket.
    return {
      readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
      writable: Writable.toWeb(socket) as WritableStream<Uint8Array>,
    };
  }
}

const gateway = mustGetEnv("RELAY_GATEWAY_URL");

// Example:
// RELAY_GATEWAY_URL="wss://worker.example.com/__relay/connect?token=..." \
//   node dist/prototype/node-relay-agent.js
newWebSocketRpcSession(gateway, new NodeBlindRelay(), {
  onSendError(error) {
    console.error("RPC send error", error);
  },
});

console.log(`blind relay connected to ${gateway}`);
await new Promise(() => {});
```

### `prototype/web-stream-duplex.ts`

```ts
import { Duplex } from "node:stream";

export class WebStreamDuplex extends Duplex {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reading = false;
  private dead = false;

  constructor(streams: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  }) {
    super({ allowHalfOpen: false });
    this.reader = streams.readable.getReader();
    this.writer = streams.writable.getWriter();
  }

  async _read() {
    if (this.reading || this.dead) return;
    this.reading = true;

    try {
      while (!this.dead) {
        const { value, done } = await this.reader.read();
        if (done) {
          this.push(null);
          return;
        }

        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (!this.push(chunk)) return;
      }
    } catch (error) {
      this.destroy(error as Error);
    } finally {
      this.reading = false;
    }
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.writer.write(bytes).then(() => callback(), callback);
  }

  _final(callback: (error?: Error | null) => void) {
    this.writer.close().then(
      () => callback(),
      (error: Error & { code?: string }) => {
        if (error?.code === "ERR_INVALID_STATE") callback();
        else callback(error);
      },
    );
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.dead = true;
    Promise.allSettled([
      this.reader.cancel(error).catch(() => {}),
      this.writer.abort(error).catch(() => {}),
    ]).finally(() => callback(error));
  }
}
```

### `prototype/worker-node-tls-relayed-fetch.ts`

```ts
import tls from "node:tls";
import { once } from "node:events";
import { WebStreamDuplex } from "./web-stream-duplex";
import type { BlindRelayStub } from "./types";

type TlsOptions = {
  rejectUnauthorized?: boolean;
  ca?: string | string[];
};

function normalizeHeaders(request: Request, bodyBytes?: Uint8Array): Headers {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);

  headers.set("host", url.host);
  headers.set("connection", "close");

  if (bodyBytes && bodyBytes.byteLength > 0 && !headers.has("content-length")) {
    headers.set("content-length", String(bodyBytes.byteLength));
  }

  return headers;
}

function encodeHttp1Request(request: Request, bodyBytes?: Uint8Array): Uint8Array {
  const url = new URL(request.url);
  const path = `${url.pathname || "/"}${url.search}`;
  const headers = normalizeHeaders(request, bodyBytes);
  const lines = [`${request.method} ${path} HTTP/1.1`];

  for (const [name, value] of headers) {
    lines.push(`${name}: ${value}`);
  }

  const head = new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`);
  if (!bodyBytes || bodyBytes.byteLength === 0) return head;

  const out = new Uint8Array(head.byteLength + bodyBytes.byteLength);
  out.set(head, 0);
  out.set(bodyBytes, head.byteLength);
  return out;
}

function parseHttp1Response(bytes: Uint8Array): Response {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const split = buffer.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("malformed HTTP response: missing header terminator");

  const headerText = buffer.subarray(0, split).toString("latin1");
  const body = buffer.subarray(split + 4);
  const [statusLine, ...headerLines] = headerText.split("\r\n");
  const match = /^HTTP\/1\.\d\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!match) throw new Error(`malformed HTTP status line: ${statusLine}`);

  const headers = new Headers();
  for (const line of headerLines) {
    const index = line.indexOf(":");
    if (index > 0) {
      headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
  }

  return new Response(body, {
    status: Number(match[1]),
    statusText: match[2] || "",
    headers,
  });
}

export async function relayedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  relay: BlindRelayStub,
  tlsOptions: TlsOptions = {},
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);

  if (url.protocol !== "https:") {
    return new Response("blind relayed fetch prototype only supports https:", { status: 400 });
  }

  const bodyBytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
  const port = url.port ? Number(url.port) : 443;
  const dialed = await relay.dial({ host: url.hostname, port });
  const tlsTransport = new WebStreamDuplex(dialed);

  // This is the smallest candidate Worker-side TLS adapter. It depends on
  // Cloudflare Workers nodejs_compat supporting node:tls with a supplied Duplex
  // socket. The local proof in this bundle tests the same technique in Node.
  const tlsSocket = tls.connect({
    socket: tlsTransport,
    servername: url.hostname,
    ALPNProtocols: ["http/1.1"],
    rejectUnauthorized: true,
    ...tlsOptions,
  });

  await once(tlsSocket, "secureConnect");

  const chunks: Buffer[] = [];
  tlsSocket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  tlsSocket.write(encodeHttp1Request(request, bodyBytes));
  tlsSocket.end();

  await once(tlsSocket, "close");
  return parseHttp1Response(Buffer.concat(chunks));
}
```

### `prototype/worker.ts`

```ts
import { DurableObject } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { relayedFetch } from "./worker-node-tls-relayed-fetch";
import type { BlindRelay, BlindRelayStub } from "./types";

export interface Env {
  HOME_RELAY: DurableObjectNamespace<HomeRelay>;
  RELAY_TOKEN: string;
}

function stripHopByHopHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
  ]) {
    out.delete(name);
  }
  return out;
}

export class HomeRelay extends DurableObject<Env> {
  private relay?: BlindRelayStub;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__relay/connect") {
      return this.acceptRelay(request, url);
    }

    if (url.pathname === "/__relay/status") {
      return Response.json({ connected: Boolean(this.relay) });
    }

    if (url.pathname === "/egress") {
      if (!this.relay) return new Response("relay is not connected", { status: 503 });

      const target = url.searchParams.get("url");
      if (!target) return new Response("missing ?url=https://...", { status: 400 });

      const targetUrl = new URL(target);
      if (targetUrl.protocol !== "https:") {
        return new Response("only https: targets are allowed", { status: 400 });
      }

      const init: RequestInit = {
        method: request.method,
        headers: stripHopByHopHeaders(request.headers),
      };

      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
      }

      return relayedFetch(new Request(targetUrl, init), {}, this.relay);
    }

    return new Response("not found", { status: 404 });
  }

  private acceptRelay(request: Request, url: URL): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected WebSocket upgrade", { status: 426 });
    }

    const token = url.searchParams.get("token") ?? request.headers.get("x-relay-token");
    if (token !== this.env.RELAY_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();

    this.relay?.[Symbol.dispose]?.();
    const relay = newWebSocketRpcSession<BlindRelay>(server);
    relay.onRpcBroken(() => {
      if (this.relay === relay) this.relay = undefined;
    });
    this.relay = relay;

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }
}

export default {
  fetch(request: Request, env: Env) {
    const id = env.HOME_RELAY.idFromName("default");
    return env.HOME_RELAY.get(id).fetch(request);
  },
} satisfies ExportedHandler<Env>;
```

### `prototype/wrangler.toml`

```toml
name = "blind-relay-relayed-fetch"
main = "prototype/worker.ts"
compatibility_date = "2026-07-02"
compatibility_flags = ["nodejs_compat"]

[vars]
# Set the real value as a secret in production:
#   npx wrangler secret put RELAY_TOKEN
RELAY_TOKEN = "dev-token-change-me"

[[durable_objects.bindings]]
name = "HOME_RELAY"
class_name = "HomeRelay"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["HomeRelay"]
```

## 10. Implementation checklist for production

- Replace `?url=` with explicit application destinations or a strict allow-list.
- Keep relay auth out of query strings if logs are sensitive; use a short-lived token or a signed connect URL.
- Set `rejectUnauthorized: true` and use the platform trust store or pinned CA material where appropriate.
- Add request and response size limits.
- Add timeouts for `dial`, TLS handshake, request write, first byte, and total response time.
- Support streaming responses rather than collecting all bytes.
- Implement chunked transfer decoding or use a mature HTTP/1 parser.
- Decide how to handle redirects; a redirect may change the target host and must go through policy again.
- Log only metadata you are comfortable retaining.
- Add tests with a real public HTTPS target after local verification.

## 11. Smallest proof summary

The smallest convincing proof is the local test in this bundle. It proves that a fetch-like function can perform a real HTTPS request through a Node process that only relays bytes. The Node relay sees TLS records, not plaintext HTTP. The Worker deployment then depends on using either the candidate Workers `node:tls` adapter shown here or a userland/WASM TLS adapter behind the same `BlindRelay` stream interface.
