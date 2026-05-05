import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("withHibernatingWebSockets", () => {
  it("accepts a hibernation WebSocket, restores lifecycle, tags, and attachment metadata", async () => {
    const roomName = `ws-room-${crypto.randomUUID()}`;
    await initializeHibernatingWebSocketRoom(roomName);

    const { socket, message: connected } = await connectWebSocketAndReadFirstJson(
      `/hibernating-websocket-rooms/${encodeURIComponent(roomName)}/__websocket?_pk=client-a&role=reader&tag=blue`,
    );

    expect(connected).toEqual({
      type: "connected",
      id: "client-a",
      tags: ["client-a", "blue", "role:reader", "connection:client-a"],
      originalUrl: "https://durable-object.local/__websocket?_pk=client-a&role=reader&tag=blue",
      attachment: { label: "attachment:client-a" },
    });

    socket.send("attachment");
    await expect(readJsonMessage(socket)).resolves.toEqual({
      type: "attachment",
      attachment: { label: "attachment:client-a" },
    });

    await expect(
      fetchJson(`/hibernating-websocket-rooms/${encodeURIComponent(roomName)}/connections/blue`),
    ).resolves.toEqual(["client-a"]);

    await expect(
      fetchJson(`/hibernating-websocket-rooms/${encodeURIComponent(roomName)}/state`),
    ).resolves.toMatchObject({
      connected: 1,
      messages: 1,
      wakeRuns: 1,
      lastConnectionId: "client-a",
      lastAttachment: { label: "attachment:client-a" },
    });

    socket.close(1000, "test complete");
  });

  it("broadcasts to tagged connections and can exclude connection ids", async () => {
    const roomName = `ws-broadcast-${crypto.randomUUID()}`;
    await initializeHibernatingWebSocketRoom(roomName);

    const { socket: reader } = await connectWebSocketAndReadFirstJson(
      `/hibernating-websocket-rooms/${encodeURIComponent(roomName)}/__websocket?_pk=reader&role=reader`,
    );
    const { socket: writer } = await connectWebSocketAndReadFirstJson(
      `/hibernating-websocket-rooms/${encodeURIComponent(roomName)}/__websocket?_pk=writer&role=writer`,
    );

    const readerBroadcast = readJsonMessage(reader);
    await postJson(`/hibernating-websocket-rooms/${encodeURIComponent(roomName)}/broadcast`, {
      text: "readers only",
      tag: "role:reader",
    });
    await expect(readerBroadcast).resolves.toMatchObject({
      type: "rpc-broadcast",
      text: "readers only",
    });

    const writerBroadcast = readJsonMessage(writer);
    const readerUnexpectedBroadcast = readJsonMessage(reader, 150);
    reader.send(
      JSON.stringify({
        type: "broadcast",
        text: "writer sees this",
        tag: "role:writer",
        exceptSelf: true,
      }),
    );
    await expect(writerBroadcast).resolves.toEqual({
      type: "broadcast",
      from: "reader",
      text: "writer sees this",
    });
    await expect(readerUnexpectedBroadcast).rejects.toThrow("Timed out waiting for message");

    reader.close(1000, "test complete");
    writer.close(1000, "test complete");
  });

  it("rejects non-WebSocket requests to the fixed route", async () => {
    const roomName = `ws-non-upgrade-${crypto.randomUUID()}`;
    await initializeHibernatingWebSocketRoom(roomName);

    const response = await SELF.fetch(
      `https://example.com/hibernating-websocket-rooms/${encodeURIComponent(roomName)}/__websocket`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Expected WebSocket upgrade.",
    });
  });
});

async function initializeHibernatingWebSocketRoom(roomName: string) {
  await postJson(`/hibernating-websocket-rooms/${encodeURIComponent(roomName)}/initialize`, {
    ownerUserId: "user-websocket",
  });
}

async function connectWebSocketAndReadFirstJson(path: string) {
  const response = (await SELF.fetch(`https://example.com${path}`, {
    headers: { Upgrade: "websocket" },
  })) as Response & {
    webSocket?: (WebSocket & { accept: (options?: { allowHalfOpen?: boolean }) => void }) | null;
  };

  expect(response.status).toBe(101);
  expect(response.webSocket).toBeTruthy();

  const socket = response.webSocket as WebSocket;
  const message = readJsonMessage(socket);
  response.webSocket?.accept();
  return { socket, message: await message };
}

async function postJson(path: string, body: unknown) {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  expect(response.status).toBe(200);
  return await response.json();
}

async function fetchJson(path: string) {
  const response = await SELF.fetch(`https://example.com${path}`);
  expect(response.status).toBe(200);
  return await response.json();
}

function readJsonMessage(socket: WebSocket, timeoutMs = 1_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", handleMessage);
      reject(new Error("Timed out waiting for message"));
    }, timeoutMs);

    const handleMessage = (event: MessageEvent) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(event.data)));
    };

    socket.addEventListener("message", handleMessage, { once: true });
  });
}
