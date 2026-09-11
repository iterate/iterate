import { once } from "node:events";
import { newWebSocketRpcSession } from "@iterate-com/capnweb";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { LiveState, LiveStateRpcTarget, createLiveStateStore } from "./index.ts";

it("sends a 48-character append in a compact Cap'n Web frame and reseeds a reconnect", async () => {
  const prefix =
    "e. The fishermen stared. One by one, their boats followed it into the fog.\n\nElian stood";
  const suffix = " on the breakwater, calling names into the storm";
  const initial = {
    agent: {
      live: {
        steps: [{ responseText: { length: 9303, tailOffset: 0, groups: { 0: { 9: prefix } } } }],
      },
    },
  };
  const engine = new LiveState(initial, { debounceMs: 0 });
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (socket) => {
    // ws implements the WebSocket operations used by Cap'n Web; its DOM event
    // declarations differ from the browser types accepted by this adapter.
    newWebSocketRpcSession(socket as unknown as WebSocket, new LiveStateRpcTarget(engine));
  });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing test socket address");
  const url = `ws://127.0.0.1:${address.port}`;
  try {
    const socket = new WebSocket(url);
    const frames: string[] = [];
    socket.addEventListener("message", (event) => frames.push(String(event.data)));
    using remote = newWebSocketRpcSession<LiveStateRpcTarget<typeof initial>>(socket);
    const store = createLiveStateStore<typeof initial>();
    const applied = Promise.withResolvers<void>();
    using subscription = await remote.subscribe(
      (update) => {
        store.apply(update, () => {
          throw new Error("Unexpected revision gap");
        });
        if (store.getState()?.agent.live.steps[0]?.responseText.length === 9351) applied.resolve();
      },
      { patchVersion: 3 },
    );
    frames.length = 0;
    const next = {
      agent: {
        live: {
          steps: [
            {
              responseText: {
                length: 9351,
                tailOffset: prefix.length,
                groups: { 0: { 9: prefix + suffix } },
              },
            },
          ],
        },
      },
    };
    engine.setState(next);
    await applied.promise;
    const frame = frames.find((value) => value.includes(suffix));
    expect(frame).toBeDefined();
    expect(Buffer.byteLength(frame!)).toBeLessThan(200);
    expect(frame).not.toContain(prefix);
    expect(frame).not.toContain("responseText");
    expect(store.getState()).toEqual(next);
    await subscription.unsubscribe();

    using reconnected = newWebSocketRpcSession<LiveStateRpcTarget<typeof initial>>(
      new WebSocket(url),
    );
    const restored = createLiveStateStore<typeof initial>();
    using fresh = await reconnected.subscribe(
      (update) => {
        restored.apply(update, () => {
          throw new Error("Reconnect did not seed its baseline");
        });
      },
      { patchVersion: 3 },
    );
    expect(restored.getState()).toEqual(next);
    await fresh.unsubscribe();
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
