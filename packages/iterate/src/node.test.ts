// node.test.ts — `connectIterate`'s heartbeat, against a real WebSocket server on localhost: a
// connection whose far end stops answering pings is closed, so its owner learns it is dead.

import type { AddressInfo } from "node:net";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { connectIterate } from "./node.ts";

// A connection that stays open gets a dead-after far above any event-loop stall a loaded CI runner
// has; one that should close keeps 100 ms and is watched for longer than that.
test.for([
  { edge: "answers every ping", closes: false, deadAfterMs: 1_000, watchMs: 500 },
  {
    edge: "answers none (the network vanished without a close)",
    closes: true,
    deadAfterMs: 100,
    watchMs: 2_000,
  },
])("a connection whose edge $edge: closed = $closes", async ({ closes, deadAfterMs, watchMs }) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong: !closes });
  server.on("connection", (socket) => {
    newWebSocketRpcSession(socket as unknown as WebSocket, {
      authenticate: () => new Session(),
    });
  });
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    using connection = await connectIterate({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      auth: { type: "bearer", token: "t" },
      heartbeat: { intervalMs: 20, deadAfterMs },
    });
    const outcome = await Promise.race([
      connection.closed,
      new Promise((resolve) => setTimeout(() => resolve("open"), watchMs)),
    ]);
    expect(outcome).toEqual(
      closes ? { code: 1006, reason: "no answer to a WebSocket ping for 0.1 s" } : "open",
    );
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

class Session extends RpcTarget {}
