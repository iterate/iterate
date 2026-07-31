import { WebSocketPair, createWebSocketResponse } from "captun";
import { Socket } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import {
  LocalFetchWebSocketServer,
  type LocalFetchWebSocketBridgeMetrics,
} from "./local-fetch-websocket-server.ts";

const servers: LocalFetchWebSocketServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

  test("admits eight PCM payloads and rejects the ninth by media bytes, not frame overhead", async () => {
    /*
     * The first one-minute Stick run reached a `ws.bufferedAmount` of 5,152
     * bytes: eight 640-byte payloads plus eight four-byte server headers. The
     * realtime allowance is 5,120 payload bytes. Eight frames must therefore
     * be observable as exactly-full while the ninth is rejected before send;
     * comparing the wire aggregate directly makes the policy depend on a
     * WebSocket library's framing representation.
     *
     * Queueing before the Workers-style endpoint is accepted deterministically
     * recreates one bounded provider burst without relying on kernel timing.
     */
    /*
     * A WebSocket close handshake is ordered behind data already accepted by
     * the kernel. After a freshness violation that can replay seconds of old
     * speech just as the network becomes healthy again. The reset must happen
     * on the concrete TCP socket: `WebSocket.terminate()` only calls
     * `destroy()`, whose API does not promise an RST or discard semantics.
     *
     * Spy on the real loopback Socket method without replacing it. That keeps
     * this an integration contract for the exact Node primitive and also makes
     * the client observe the abnormal transport loss a device will see.
     */
    const hardReset = vi.spyOn(Socket.prototype, "resetAndDestroy");
    const closed = Promise.withResolvers<LocalFetchWebSocketBridgeMetrics>();
    const frame = new Uint8Array(640);
    const server = await LocalFetchWebSocketServer.listen({
      fetch() {
        const pair = new WebSocketPair();
        pair[0].accept();
        for (let frameIndex = 0; frameIndex < 9; frameIndex += 1) {
          pair[0].send(frame);
        }
        return createWebSocketResponse(pair[1], {
          protocol: "iterate.kit.pcm.v1",
        });
      },
      host: "127.0.0.1",
      maximumBufferedBytes: 8 * frame.byteLength,
      onBridgeClosed: closed.resolve,
    });
    servers.push(server);

    const socket = new WebSocket(`${server.webSocketOrigin}/pcm`, ["iterate.kit.pcm.v1"]);
    socket.on("error", () => {});
    const deviceClose = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    await onceOpen(socket);

    await expect(closed.promise).resolves.toMatchObject({
      closeCode: 4013,
      closeReason: "LAN bridge backpressure.",
      deviceSocketCloseDisposition: "tcpReset",
      deviceSocketMaximumPayloadBytesInFlight: 8 * frame.byteLength,
      deviceSocketPayloadBytesInFlightAtClose: 8 * frame.byteLength,
      maximumBufferedBytes: 8 * frame.byteLength,
      workerToDeviceBytes: 8 * frame.byteLength,
      workerToDeviceMessages: 8,
    });
    const metrics = await closed.promise;
    /*
     * Loopback may hand bytes to the kernel synchronously and report zero
     * `bufferedAmount`; the payload ledger remains deterministic regardless of
     * that platform timing. The physical artifact retains the complementary
     * 5,152-byte wire observation.
     */
    expect(metrics.deviceSocketMaximumBufferedBytes).toBeGreaterThanOrEqual(0);
    expect(metrics.deviceSocketMaximumSendCallbacksInFlight).toBe(8);
    expect(hardReset).toHaveBeenCalledOnce();
    await expect(deviceClose).resolves.toEqual({ code: 1006, reason: "" });
  });

  test("admits fresh audio on a replacement generation after hard reset", async () => {
    /*
     * Resetting stale TCP bytes is only half the recovery contract. The next
     * connection must start with a zero media ledger and accept current audio;
     * otherwise a bounded failure merely becomes a stuck conversation. Use
     * the real LAN bridge twice: generation one fills the eight-frame
     * allowance and is reset, while generation two receives a distinct fresh
     * marker through the same server immediately afterwards.
     */
    const frame = new Uint8Array(640);
    const freshFrame = new Uint8Array(640).fill(0xa5);
    let generation = 0;
    const closed: LocalFetchWebSocketBridgeMetrics[] = [];
    const server = await LocalFetchWebSocketServer.listen({
      fetch() {
        generation += 1;
        const pair = new WebSocketPair();
        pair[0].accept();
        if (generation === 1) {
          for (let frameIndex = 0; frameIndex < 9; frameIndex += 1) {
            pair[0].send(frame);
          }
        } else {
          pair[0].send(freshFrame);
        }
        return createWebSocketResponse(pair[1], {
          protocol: "iterate.kit.pcm.v1",
        });
      },
      host: "127.0.0.1",
      maximumBufferedBytes: 8 * frame.byteLength,
      onBridgeClosed: (metrics) => closed.push(metrics),
    });
    servers.push(server);

    const staleSocket = new WebSocket(`${server.webSocketOrigin}/pcm`, ["iterate.kit.pcm.v1"]);
    staleSocket.on("error", () => {});
    const staleClose = new Promise<number>((resolve) => {
      staleSocket.once("close", (code) => resolve(code));
    });
    await onceOpen(staleSocket);
    await expect(staleClose).resolves.toBe(1006);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      closeCode: 4013,
      deviceSocketCloseDisposition: "tcpReset",
    });

    const freshSocket = new WebSocket(`${server.webSocketOrigin}/pcm`, ["iterate.kit.pcm.v1"]);
    freshSocket.binaryType = "arraybuffer";
    freshSocket.on("error", () => {});
    const freshMessage = onceMessage(freshSocket);
    await onceOpen(freshSocket);
    expect(new Uint8Array(await freshMessage)).toEqual(freshFrame);
    freshSocket.close(1000, "replacement complete");
  });

  test("reports bounded bridge evidence when a device socket closes", async () => {
    /*
     * A physical playback failure can otherwise be explained equally well by
     * host event-loop pacing, a full host TCP writer, firmware receive
     * starvation, or an undersized hardware reserve. Merely logging close code
     * 4013 proves none of those. This test requires the real bridge seam to
     * retain only fixed-size aggregates and report them at close, so an
     * endurance artifact can discriminate the layers without recording every
     * high-rate PCM frame or perturbing the run with per-frame console output.
     */
    const closed = Promise.withResolvers<LocalFetchWebSocketBridgeMetrics>();
    const server = await LocalFetchWebSocketServer.listen({
      fetch() {
        const pair = new WebSocketPair();
        pair[0].accept();
        pair[0].addEventListener("message", (event) => {
          pair[0].send(event.data);
        });
        return createWebSocketResponse(pair[1], {
          protocol: "iterate.kit.pcm.v1",
        });
      },
      host: "127.0.0.1",
      onBridgeClosed: closed.resolve,
    });
    servers.push(server);

    const socket = new WebSocket(`${server.webSocketOrigin}/pcm`, ["iterate.kit.pcm.v1"]);
    socket.binaryType = "arraybuffer";
    await onceOpen(socket);
    const echoed = onceMessage(socket);
    socket.send(Uint8Array.of(1, 2, 3, 4));
    expect(new Uint8Array(await echoed)).toEqual(Uint8Array.of(1, 2, 3, 4));
    socket.close(1000, "test complete");

    await expect(closed.promise).resolves.toMatchObject({
      closeCode: 1000,
      closeReason: "test complete",
      deviceToWorkerBytes: 4,
      deviceToWorkerMessages: 1,
      endpoint: "/pcm",
      maximumBufferedBytes: 8 * 640,
      protocol: "iterate.kit.pcm.v1",
      workerToDeviceBytes: 4,
      workerToDeviceMessages: 1,
    });
    const metrics = await closed.promise;
    expect(metrics.deviceSocketMaximumBufferedBytes).toBeGreaterThanOrEqual(0);
    /*
     * `ws.bufferedAmount` includes WebSocket headers, whereas the realtime
     * product budget is expressed in 640-byte PCM payloads. The one-minute
     * physical run stopped at 5,152 bytes: exactly eight payloads plus eight
     * four-byte server-frame headers. If the bridge reports only the wire
     * aggregate, a future diagnosis can mistake a full 160 ms media backlog
     * for a 32-byte accounting defect. Require both ledgers and the age of the
     * oldest unfinished send while this tiny echo has a known four-byte truth.
     */
    expect(metrics.deviceSocketMaximumPayloadBytesInFlight).toBe(4);
    expect(metrics.deviceSocketPayloadBytesInFlightAtClose).toBe(0);
    expect(metrics.deviceSocketOldestSendCallbackAgeMsAtClose).toBe(0);
    expect(metrics.deviceSocketMaximumSendCallbacksInFlight).toBe(1);
    expect(metrics.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("retains a bounded secret-free chronology for control RPC diagnosis", async () => {
    /*
     * A one-second physical getDiagnostics stall can occur before the request
     * reaches the device, while firmware handles it, after the response reaches
     * the host, or while Cap'n Web settles the promise. Aggregate byte counts
     * cannot distinguish those layers. Retain only the final protocol
     * envelopes so a failed run can correlate push/pull/resolve/release.
     *
     * Raw Cap'n Web messages are forbidden here: authentication and arbitrary
     * method arguments can contain project secrets. This deliberately puts a
     * sentinel in both directions and requires the terminal metrics to expose
     * command metadata without preserving either argument value.
     */
    const closed = Promise.withResolvers<LocalFetchWebSocketBridgeMetrics>();
    const deviceMessageReceived = Promise.withResolvers<void>();
    const hostSecret = "host-secret-must-not-be-retained";
    const deviceSecret = "device-secret-must-not-be-retained";
    const hostPush = `["push",["pipeline",0,["getDiagnostics"],[{"secret":"${hostSecret}"}]]]`;
    const deviceResolution = `["resolve",41,{"secret":"${deviceSecret}"}]`;
    const server = await LocalFetchWebSocketServer.listen({
      fetch() {
        const pair = new WebSocketPair();
        pair[0].accept();
        pair[0].addEventListener(
          "message",
          () => {
            deviceMessageReceived.resolve();
            pair[0].send(hostPush);
          },
          { once: true },
        );
        return createWebSocketResponse(pair[1]);
      },
      host: "127.0.0.1",
      onBridgeClosed: closed.resolve,
    });
    servers.push(server);

    const socket = new WebSocket(`${server.webSocketOrigin}/api`);
    await onceOpen(socket);
    const pushed = onceTextMessage(socket);
    socket.send(deviceResolution);
    await deviceMessageReceived.promise;
    expect(await pushed).toBe(hostPush);
    socket.close(1000, "chronology captured");

    const metrics = await closed.promise;
    expect(metrics.controlMessageTrace).toEqual([
      {
        command: "resolve",
        direction: "deviceToWorker",
        elapsedMs: expect.any(Number),
        id: 41,
        method: "",
        payloadBytes: Buffer.byteLength(deviceResolution),
      },
      {
        command: "push",
        direction: "workerToDevice",
        elapsedMs: expect.any(Number),
        id: null,
        method: "getDiagnostics",
        payloadBytes: Buffer.byteLength(hostPush),
      },
    ]);
    expect(metrics.controlMessageTrace).toHaveLength(2);
    expect(JSON.stringify(metrics.controlMessageTrace)).not.toContain(hostSecret);
    expect(JSON.stringify(metrics.controlMessageTrace)).not.toContain(deviceSecret);
  });

  test("evicts old control chronology instead of growing with endurance duration", async () => {
    /*
     * A diagnostic that retains every RPC would eventually become the memory
     * pressure it is meant to investigate. Exercise the real bridge rather
     * than only a helper: after seventy device envelopes, the terminal record
     * must contain the newest sixty-four and no hidden per-message history.
     */
    const closed = Promise.withResolvers<LocalFetchWebSocketBridgeMetrics>();
    const allMessagesReceived = Promise.withResolvers<void>();
    const server = await LocalFetchWebSocketServer.listen({
      fetch() {
        const pair = new WebSocketPair();
        pair[0].accept();
        let received = 0;
        pair[0].addEventListener("message", () => {
          received += 1;
          if (received === 70) allMessagesReceived.resolve();
        });
        return createWebSocketResponse(pair[1]);
      },
      host: "127.0.0.1",
      onBridgeClosed: closed.resolve,
    });
    servers.push(server);

    const socket = new WebSocket(`${server.webSocketOrigin}/api`);
    await onceOpen(socket);
    for (let id = 0; id < 70; id += 1) socket.send(JSON.stringify(["resolve", id, null]));
    await allMessagesReceived.promise;
    socket.close(1000, "bounded chronology captured");

    const metrics = await closed.promise;
    expect(metrics.controlMessageTrace).toHaveLength(64);
    expect(metrics.controlMessageTrace.at(0)).toMatchObject({ command: "resolve", id: 6 });
    expect(metrics.controlMessageTrace.at(-1)).toMatchObject({ command: "resolve", id: 69 });
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

function onceTextMessage(socket: WebSocket) {
  return new Promise<string>((resolve, reject) => {
    socket.once("message", (data, isBinary) => {
      if (!isBinary) {
        resolve(data.toString("utf8"));
        return;
      }
      reject(new Error("Expected a text WebSocket message."));
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
