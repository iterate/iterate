import { expect, test, vi } from "vitest";
import type { StreamConnectionHandle } from "iterate/processors";
import type { StreamDurableObject } from "./stream-durable-object.ts";
import { openRelayedStreamConnection } from "./stream-connection-relay.ts";

test("a dormant relay rejects an orphaned wake socket after the stream incarnation dies", async () => {
  const wakeSocket = new FakeWakeSocket();
  let relayState: "live" | "dormant" | "dead" = "dormant";
  const probe = vi.fn(async () => relayState);
  const stub = {
    fetch: async () => ({ webSocket: wakeSocket }),
    openConnection: async () => connectionHandle(),
    relayedConnectionState: probe,
  } as unknown as DurableObjectStub<StreamDurableObject>;

  const relay = await openRelayedStreamConnection({
    stub: () => stub,
    args: { processEventBatch: () => undefined },
  });
  wakeSocket.receive('{"type":"idle"}');

  relayState = "dead";
  expect(await relay.isLive()).toBe(false);
  expect(probe).toHaveBeenCalledWith({
    connectionKey: relay.connectionKey,
    wakeSocketId: expect.any(String),
  });
});

test("a relay reconciles a missed idle frame before the next wake", async () => {
  const wakeSocket = new FakeWakeSocket();
  const openConnection = vi.fn(async () => connectionHandle());
  const stub = {
    fetch: async () => ({ webSocket: wakeSocket }),
    openConnection,
    relayedConnectionState: async () => "dormant" as const,
  } as unknown as DurableObjectStub<StreamDurableObject>;

  const relay = await openRelayedStreamConnection({
    stub: () => stub,
    args: { processEventBatch: () => undefined },
  });

  expect(await relay.isLive()).toBe(true);
  wakeSocket.receive('{"type":"wake"}');
  await vi.waitFor(() => expect(openConnection).toHaveBeenCalledTimes(2));
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
