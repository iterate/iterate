import { WebSocketPair, createWebSocketResponse } from "captun";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { LocalFetchWebSocketServer } from "./local-fetch-websocket-server.ts";

const servers: LocalFetchWebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("local fetch WebSocket server", () => {
  test("bridges a Workers-style socket directly onto a LAN TCP listener", async () => {
    /*
     * The physical harness previously had only Captun's message-by-message
     * Cap'n Web forwarding path. That path can preserve every byte while
     * delivering 20 ms PCM with 100+ ms gaps, so it cannot distinguish a
     * device playback defect from tunnel scheduling. This test protects the
     * direct runtime adapter: binary message boundaries and the selected PCM
     * subprotocol must survive without adding another application queue.
     */
    const received: Uint8Array[] = [];
    const server = await LocalFetchWebSocketServer.listen({
      fetch(request) {
        expect(new URL(request.url).pathname).toBe("/pcm");
        const pair = new WebSocketPair();
        pair[0].accept();
        pair[0].addEventListener("message", (event) => {
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          received.push(bytes.slice());
          pair[0].send(bytes);
        });
        return createWebSocketResponse(pair[1], {
          protocol: "iterate.kit.pcm.v1",
        });
      },
      host: "127.0.0.1",
    });
    servers.push(server);

    const socket = new WebSocket(`${server.webSocketOrigin}/pcm`, ["iterate.kit.pcm.v1"]);
    socket.binaryType = "arraybuffer";
    await onceOpen(socket);
    const echoed = onceMessage(socket);
    socket.send(Uint8Array.of(1, 2, 3, 4));

    expect(new Uint8Array(await echoed)).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(received).toEqual([Uint8Array.of(1, 2, 3, 4)]);
    expect(socket.protocol).toBe("iterate.kit.pcm.v1");
  });

  test("returns fetch rejections before accepting a WebSocket upgrade", async () => {
    /*
     * A direct harness must not bypass the same authentication and protocol
     * checks used by the tunnel/Worker-shaped path. Otherwise a smooth local
     * playback could prove a different system. Preserve the fetch response as
     * the HTTP upgrade rejection rather than accepting and closing later.
     */
    const server = await LocalFetchWebSocketServer.listen({
      fetch: () => new Response("invalid bearer", { status: 401 }),
      host: "127.0.0.1",
    });
    servers.push(server);

    const response = await rejectedUpgrade(new WebSocket(`${server.webSocketOrigin}/pcm`));
    expect(response.statusCode).toBe(401);
    expect(await readResponseBody(response)).toBe("invalid bearer");
  });
});

function onceOpen(socket: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function onceMessage(socket: WebSocket) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    socket.once("message", (data) => {
      if (data instanceof ArrayBuffer) {
        resolve(data);
        return;
      }
      reject(new Error(`Expected ArrayBuffer, received ${Object.prototype.toString.call(data)}.`));
    });
    socket.once("error", reject);
  });
}

function rejectedUpgrade(socket: WebSocket) {
  return new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => resolve(response));
    socket.once("open", () => reject(new Error("Rejected upgrade unexpectedly opened.")));
    socket.once("error", () => {
      /*
       * `ws` emits an error after `unexpected-response` unless the response is
       * consumed. The response event is the assertion surface; suppress that
       * secondary lifecycle notification so it cannot become an unhandled
       * test failure.
       */
    });
  });
}

async function readResponseBody(response: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
