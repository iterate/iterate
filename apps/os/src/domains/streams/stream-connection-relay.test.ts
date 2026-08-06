import { expect, test, vi } from "vitest";
import type { StreamConnectionHandle } from "iterate/processors";
import type { StreamDurableObject } from "./stream-durable-object.ts";
import { openRelayedStreamConnection } from "./stream-connection-relay.ts";

test("a dormant relay rejects an orphaned wake socket after the stream incarnation dies", async () => {
  const wakeSocket = new FakeWakeSocket();
  let dormantConnectionExists = true;
  const probe = vi.fn(async () => dormantConnectionExists);
  const stub = {
    fetch: async () => ({ webSocket: wakeSocket }),
    openConnection: async () => connectionHandle(),
    isRelayedSessionConnectionLive: probe,
  } as unknown as DurableObjectStub<StreamDurableObject>;

  const relay = await openRelayedStreamConnection({
    stub: () => stub,
    args: { processEventBatch: () => undefined },
  });
  wakeSocket.receive('{"type":"idle"}');

  dormantConnectionExists = false;
  expect(await relay.isLive()).toBe(false);
  expect(probe).toHaveBeenCalledWith({
    connectionKey: relay.connectionKey,
    wakeSocketId: expect.any(String),
  });
});

class FakeWakeSocket extends EventTarget {
  accept() {}

  close() {}

  receive(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function connectionHandle(): StreamConnectionHandle {
  return {
    connectionKey: "connection",
    streamMaxOffset: 0,
    ping: () => true,
    close: () => undefined,
    [Symbol.dispose]: () => undefined,
  };
}
