import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isDurableObjectViewMessage } from "./with-durable-object-views.ts";

describe("withDurableObjectViews", () => {
  it("sends the default view when no view query param is provided", async () => {
    const roomName = `view-room-${crypto.randomUUID()}`;
    await postJson(`/durable-object-view-rooms/${encodeURIComponent(roomName)}/initialize`, {
      ownerUserId: "user-default-view",
    });

    const socket = await connectWebSocket(
      `/durable-objects/durable-object-view-rooms/by-name/${encodeURIComponent(roomName)}/__websocket`,
    );

    const initial = await readDurableObjectViewMessage(socket);
    expect(initial).toMatchObject({
      kind: "durable-object-view",
      view: "default",
      value: {
        count: 0,
        ownerUserId: "user-default-view",
      },
    });

    socket.close(1000, "test complete");
  });

  it("sends the requested view on connect and after a server-side mutation", async () => {
    const roomName = `view-room-${crypto.randomUUID()}`;
    await postJson(`/durable-object-view-rooms/${encodeURIComponent(roomName)}/initialize`, {
      ownerUserId: "user-view",
    });

    const socket = await connectWebSocket(
      `/durable-objects/durable-object-view-rooms/by-name/${encodeURIComponent(roomName)}/__websocket?view=counter`,
    );

    const initial = await readDurableObjectViewMessage(socket);
    expect(initial).toMatchObject({
      kind: "durable-object-view",
      view: "counter",
      value: {
        count: 0,
        ownerUserId: "user-view",
      },
    });
    expect(initial.revision).toEqual(expect.any(String));

    const incrementedMessage = readDurableObjectViewMessage(socket);
    await postJson(`/durable-object-view-rooms/${encodeURIComponent(roomName)}/increment`, {});

    const incremented = await incrementedMessage;
    expect(incremented).toMatchObject({
      kind: "durable-object-view",
      view: "counter",
      value: {
        count: 1,
        ownerUserId: "user-view",
      },
    });

    socket.close(1000, "test complete");
  });
});

async function connectWebSocket(path: string) {
  const response = (await SELF.fetch(`https://example.com${path}`, {
    headers: { Upgrade: "websocket" },
  })) as Response & {
    webSocket?: (WebSocket & { accept: (options?: { allowHalfOpen?: boolean }) => void }) | null;
  };

  expect(response.status).toBe(101);
  expect(response.webSocket).toBeTruthy();

  response.webSocket?.accept();
  return response.webSocket as WebSocket;
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

function readDurableObjectViewMessage(socket: WebSocket): Promise<{
  kind: "durable-object-view";
  view: string;
  revision: string;
  value: unknown;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", handleMessage);
      reject(new Error("Timed out waiting for Durable Object view message"));
    }, 1_000);

    const handleMessage = (event: MessageEvent) => {
      clearTimeout(timeout);
      const value = JSON.parse(String(event.data)) as unknown;
      if (!isDurableObjectViewMessage(value)) {
        reject(new Error("Received non-view message"));
        return;
      }

      resolve(value);
    };

    socket.addEventListener("message", handleMessage, { once: true });
  });
}
