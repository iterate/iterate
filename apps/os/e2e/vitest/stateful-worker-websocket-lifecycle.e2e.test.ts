import { expect, test } from "vitest";
import WebSocket, { type RawData } from "ws";
import type { StatefulDynamicWorkerRef } from "../../src/domains/workers/schemas.ts";
import { adminSecret, buildUrl, deployedBaseUrl, withItxSession } from "./test-helpers.ts";

/*
 * A stateful dynamic worker is a facet behind a stable outer Durable Object.
 * The facet owns the application's WebSocket, but capability calls arrive at
 * the outer object. Cloudflare may evict an idle outer object after 70–140
 * seconds even while its child facet still has a standard WebSocket. If the
 * next capability call recreates the same facet from a new outer incarnation,
 * workerd retires the old facet and silently cuts off the live socket.
 *
 * Waiting beyond that documented eviction window is slow but essential: an
 * immediate RPC call exercises only the warm-object happy path and did not
 * reproduce the production Stick reset. This deployed-only regression keeps
 * the public socket idle long enough to force the lifecycle boundary, invokes
 * a normal read-only capability, then proves the same facet generation and
 * socket are still alive.
 */
const OUTER_DURABLE_OBJECT_EVICTION_WAIT_MS = 150_000;

test.skipIf(deployedBaseUrl() === null)(
  "a stateful worker WebSocket survives a capability call after its outer DO eviction window",
  { retry: 0, timeout: 360_000 },
  async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const slug = `stateful-ws-life-${marker}`;
    const workerRef = {
      className: "SocketLifecycleDurableObject",
      durableWorkerKey: `socket-lifecycle-${marker}`,
      path: "/",
      source: {
        createWorker: {
          entryPoint: "worker.ts",
          files: { repoPath: "/repos/config", type: "repo" },
        },
      },
      type: "stateful",
    } satisfies StatefulDynamicWorkerRef;

    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects.get(slug).create({});
    await project.repo.commitFiles({
      changes: [
        {
          path: "worker.ts",
          content: `
            import {
              IterateDurableObject,
              IterateWorkerEntrypoint,
              type StatefulDynamicWorkerRef,
            } from "iterate/sdk";

            const workerRef = ${JSON.stringify(workerRef)} satisfies StatefulDynamicWorkerRef;

            export class SocketLifecycleDurableObject extends IterateDurableObject {
              #generation = crypto.randomUUID();

              generation() {
                return this.#generation;
              }

              fetch(request: Request): Response {
                if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
                  return new Response("WebSocket required", { status: 426 });
                }
                const [client, server] = Object.values(new WebSocketPair());
                server.binaryType = "arraybuffer";
                server.accept();
                server.addEventListener("message", (event) => {
                  if (typeof event.data === "string") {
                    server.send(this.#generation + ":" + event.data);
                  } else {
                    server.send(event.data);
                  }
                });
                return new Response(null, { status: 101, webSocket: client });
              }
            }

            export default class LifecycleRouter extends IterateWorkerEntrypoint {
              fetch(request: Request): Promise<Response> {
                return this.fetchDynamicWorker(request, workerRef);
              }
            }
          `,
        },
      ],
      message: "Add stateful WebSocket lifecycle regression fixture",
    });

    const socket = await openProjectSocket(slug);
    try {
      const before = await withDeadline(
        roundTrip(socket, "before-outer-eviction"),
        "initial WebSocket echo",
      );
      const generation = before.slice(0, before.indexOf(":"));
      expect(generation).toMatch(/^[0-9a-f-]{36}$/);

      const pcmFrame = Buffer.alloc(640);
      for (let index = 0; index < pcmFrame.length; index += 1) pcmFrame[index] = index & 0xff;
      expect(
        await withDeadline(roundTripBinary(socket, pcmFrame), "initial binary WebSocket echo"),
      ).toEqual(pcmFrame);

      await new Promise((resolve) => setTimeout(resolve, OUTER_DURABLE_OBJECT_EVICTION_WAIT_MS));

      using worker = project.workers.get(workerRef) as unknown as {
        [Symbol.dispose](): void;
        generation(): Promise<string>;
      };
      expect(await withDeadline(worker.generation(), "capability call after eviction window")).toBe(
        generation,
      );
      expect(
        await withDeadline(
          roundTrip(socket, "after-capability-call"),
          "WebSocket echo after capability call",
        ),
      ).toBe(`${generation}:after-capability-call`);

      // Voice PCM uses binary frames, so a surviving text echo alone would
      // miss conversions or corruption introduced by the relay. The 640-byte
      // payload matches one 20 ms mono S16LE frame at the Stick's 16 kHz wire
      // format and deliberately includes every byte value.
      expect(
        await withDeadline(
          roundTripBinary(socket, pcmFrame),
          "binary WebSocket echo after capability call",
        ),
      ).toEqual(pcmFrame);
    } finally {
      socket.close(1000, "test complete");
    }
  },
);

async function openProjectSocket(slug: string): Promise<WebSocket> {
  const base = new URL(buildUrl({ path: "/" }));
  const local = base.hostname === "localhost" || base.hostname.endsWith(".localhost");
  const configuredProjectBases = process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES?.trim();
  const previewMatch = /^os\.(iterate-preview-\d+)\.com$/.exec(base.hostname);
  const projectBase = configuredProjectBases
    ? String((JSON.parse(configuredProjectBases) as string[])[0])
    : previewMatch
      ? `${previewMatch[1]}.app`
      : base.hostname;
  const appHost = `lifecycle--${slug}`;
  const deadline = Date.now() + 120_000;

  for (;;) {
    const socket = local
      ? new WebSocket(`ws://${base.host}/`, {
          handshakeTimeout: 20_000,
          headers: { host: `${appHost}.localhost${base.port ? `:${base.port}` : ""}` },
        })
      : new WebSocket(`wss://${appHost}.${projectBase}/`, { handshakeTimeout: 20_000 });
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        socket.once("open", () => resolve(socket));
        socket.once("unexpected-response", (_request, response) => {
          response.resume();
          reject(new Error(`upgrade rejected: ${response.statusCode}`));
        });
        socket.once("error", reject);
      });
    } catch (error) {
      socket.terminate();
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("503") || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

function roundTrip(socket: WebSocket, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData) => {
      cleanup();
      resolve(String(data));
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`socket closed before echo (${code}: ${reason.toString()})`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);
    socket.send(payload);
  });
}

function roundTripBinary(socket: WebSocket, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData, isBinary: boolean) => {
      cleanup();
      if (!isBinary) {
        const textPayload = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        reject(
          new Error(
            `binary WebSocket echo arrived as a text frame: ${JSON.stringify(textPayload.slice(0, 160))}`,
          ),
        );
        return;
      }
      if (Buffer.isBuffer(data)) {
        resolve(data);
      } else if (Array.isArray(data)) {
        resolve(Buffer.concat(data));
      } else {
        resolve(Buffer.from(data));
      }
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`socket closed before binary echo (${code}: ${reason.toString()})`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);
    socket.send(payload);
  });
}

async function withDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after 30 seconds`)),
          30_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
