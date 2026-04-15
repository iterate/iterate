import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { useMockHttpServer, ws } from "@iterate-com/mock-http-proxy";
import { describe, expect, test } from "vitest";
import {
  type Event,
  type EventInput,
  StreamPath,
  StreamSocketErrorFrame,
  StreamSocketEventFrame,
  type StreamSocketEventFrame as StreamSocketEventFrameValue,
} from "@iterate-com/events-contract";
import { collectAsyncIterableUntilIdle, createEvents2AppFixture } from "../helpers.ts";

const rawEventsBaseUrl = process.env.EVENTS_BASE_URL?.trim().replace(/\/+$/, "") ?? null;
const describeLocalExternalSubscriberWebsocket =
  rawEventsBaseUrl && isLocalhostBaseUrl(rawEventsBaseUrl) ? describe.sequential : describe.skip;
const app =
  rawEventsBaseUrl == null ? null : createEvents2AppFixture({ baseURL: rawEventsBaseUrl });
const testTimeoutMs = 30_000;
const pollIntervalMs = 100;
const historyIdleTimeoutMs = 250;

describeLocalExternalSubscriberWebsocket("events external subscriber websocket e2e", () => {
  test(
    "websocket subscriber receives framed events and can append back into the same stream",
    async () => {
      const path = uniqueStreamPath();
      const sourceType =
        `https://events.iterate.com/events/example/ws-source/${randomUUID()}` as Event["type"];
      const peerType =
        `https://events.iterate.com/events/example/ws-peer/${randomUUID()}` as Event["type"];
      const outboundFrames: StreamSocketEventFrameValue[] = [];
      let peerAppendSent = false;

      await using peer = await useMockHttpServer();
      const socket = ws.link("/after-event-handler");
      peer.use(
        socket.addEventListener("connection", ({ client }) => {
          client.addEventListener("message", (event) => {
            const raw = String(event.data);
            const parsed = StreamSocketEventFrame.safeParse(JSON.parse(raw));
            if (!parsed.success) {
              return;
            }

            outboundFrames.push(parsed.data);
            if (parsed.data.event.type !== sourceType || peerAppendSent) {
              return;
            }

            peerAppendSent = true;
            client.send(
              JSON.stringify({
                type: "append",
                event: {
                  type: peerType,
                  payload: {
                    echoedType: parsed.data.event.type,
                    seenOffset: parsed.data.event.offset,
                  },
                },
              }),
            );
          });
        }),
      );

      await configureWebsocketSubscriber({
        callbackUrl: websocketCallbackUrl(peer.url, path),
        path,
        slug: "processor:ping-pong",
      });

      await append(path, {
        type: sourceType,
        payload: { message: "hello from e2e" },
      });

      const sourceFrame = await waitForOutboundFrame(
        outboundFrames,
        (frame) => frame.event.type === sourceType,
      );
      const peerEvent = await waitForEvent(path, (event) => event.type === peerType);

      expect(sourceFrame).toMatchObject({
        type: "event",
        event: {
          streamPath: path,
          type: sourceType,
          payload: { message: "hello from e2e" },
        },
      });
      expect(peerEvent).toMatchObject({
        streamPath: path,
        type: peerType,
        payload: {
          echoedType: sourceType,
          seenOffset: sourceFrame.event.offset,
        },
      });
    },
    testTimeoutMs,
  );

  test(
    "websocket subscribers ignore jsonataTransform and still receive canonical framed events",
    async () => {
      const path = uniqueStreamPath();
      const sourceType =
        `https://events.iterate.com/events/example/ws-canonical/${randomUUID()}` as Event["type"];
      const outboundFrames: StreamSocketEventFrameValue[] = [];
      const peerErrors: string[] = [];

      await using peer = await useMockHttpServer();
      const socket = ws.link("/after-event-handler");
      peer.use(
        socket.addEventListener("connection", ({ client }) => {
          client.addEventListener("message", (event) => {
            const raw = String(event.data);
            const eventFrame = StreamSocketEventFrame.safeParse(JSON.parse(raw));
            if (eventFrame.success) {
              outboundFrames.push(eventFrame.data);
              return;
            }

            const errorFrame = StreamSocketErrorFrame.safeParse(JSON.parse(raw));
            if (errorFrame.success) {
              peerErrors.push(errorFrame.data.message);
            }
          });
        }),
      );

      await configureWebsocketSubscriber({
        callbackUrl: websocketCallbackUrl(peer.url, path),
        path,
        slug: "processor:canonical",
        jsonataTransform: '{"kind":"transformed","copied":payload.message}',
      });

      await append(path, {
        type: sourceType,
        payload: { message: "keep me canonical" },
      });

      const sourceFrame = await waitForOutboundFrame(
        outboundFrames,
        (frame) => frame.event.type === sourceType,
      );

      expect(sourceFrame).toMatchObject({
        type: "event",
        event: {
          streamPath: path,
          type: sourceType,
          payload: { message: "keep me canonical" },
        },
      });
      expect(sourceFrame.event).not.toMatchObject({
        kind: "transformed",
      });
      expect(peerErrors).toEqual([]);
      expect(await collectStreamEvents(path)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            streamPath: path,
            type: sourceType,
            payload: { message: "keep me canonical" },
          }),
        ]),
      );
    },
    testTimeoutMs,
  );
});

function requireAppFixture() {
  if (app == null) {
    throw new Error("EVENTS_BASE_URL is required for websocket subscriber e2e.");
  }

  return app;
}

async function configureWebsocketSubscriber(args: {
  callbackUrl: string;
  path: StreamPath;
  slug: string;
  jsonataTransform?: string;
}) {
  await append(args.path, {
    type: "https://events.iterate.com/events/stream/subscription/configured",
    payload: {
      slug: args.slug,
      type: "websocket",
      callbackUrl: args.callbackUrl,
      ...(args.jsonataTransform == null ? {} : { jsonataTransform: args.jsonataTransform }),
    },
  });
}

async function append(path: StreamPath, event: EventInput) {
  await requireAppFixture().append({
    streamPath: path,
    event,
  });
}

async function collectStreamEvents(path: StreamPath) {
  return (await collectAsyncIterableUntilIdle({
    iterable: await requireAppFixture().client.stream({
      path,
      beforeOffset: "end",
    }),
    idleMs: historyIdleTimeoutMs,
  })) as Event[];
}

async function waitForEvent(path: StreamPath, predicate: (event: Event) => boolean) {
  const deadline = Date.now() + testTimeoutMs;

  while (Date.now() < deadline) {
    const events = await collectStreamEvents(path);
    const match = events.find(predicate);
    if (match) {
      return match;
    }

    await delay(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for matching event in ${path}`);
}

async function waitForOutboundFrame(
  frames: StreamSocketEventFrameValue[],
  predicate: (frame: StreamSocketEventFrameValue) => boolean,
) {
  const deadline = Date.now() + testTimeoutMs;

  while (Date.now() < deadline) {
    const match = frames.find(predicate);
    if (match) {
      return match;
    }

    await delay(pollIntervalMs);
  }

  throw new Error("Timed out waiting for outbound websocket frame");
}

function uniqueStreamPath() {
  return StreamPath.parse(`/e2e/${randomUUID().slice(0, 8)}/ws-subscriber`);
}

function websocketCallbackUrl(baseUrl: string, path: StreamPath) {
  const url = new URL("/after-event-handler", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("streamPath", path);
  return url.toString();
}

function isLocalhostBaseUrl(baseUrl: string) {
  const host = new URL(baseUrl).hostname;
  return host === "127.0.0.1" || host === "localhost";
}
