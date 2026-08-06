import { expect, test, vi } from "vitest";
import type { StreamConnectionHandle } from "iterate/processors";
import type { StreamDurableObject } from "./stream-durable-object.ts";
import { openRelayedStreamConnection } from "./stream-connection-relay.ts";

test("a dormant relay rejects an orphaned Subscriber Pager after the stream incarnation dies", async () => {
  const pager = new FakeSubscriberPager();
  let relayState: "live" | "dormant" | "dead" = "dormant";
  const probe = vi.fn(async () => relayState);
  const stub = {
    fetch: async () => ({ webSocket: pager }),
    openConnection: async () => connectionHandle(),
    relayedConnectionState: probe,
  } as unknown as DurableObjectStub<StreamDurableObject>;

  const relay = await openRelayedStreamConnection({
    stub: () => stub,
    args: { processEventBatch: () => undefined },
  });
  pager.receive('{"type":"idle"}');

  relayState = "dead";
  expect(await relay.isLive()).toBe(false);
  expect(probe).toHaveBeenCalledWith({
    connectionKey: relay.connectionKey,
    subscriberPagerId: expect.any(String),
  });
});

test("a relay reconciles a missed idle Page before the next work Page", async () => {
  const pager = new FakeSubscriberPager();
  const openConnection = vi.fn(async () => connectionHandle());
  const stub = {
    fetch: async () => ({ webSocket: pager }),
    openConnection,
    relayedConnectionState: async () => "dormant" as const,
  } as unknown as DurableObjectStub<StreamDurableObject>;

  const relay = await openRelayedStreamConnection({
    stub: () => stub,
    args: { processEventBatch: () => undefined },
  });

  expect(await relay.isLive()).toBe(true);
  pager.receive('{"type":"page"}');
  await vi.waitFor(() => expect(openConnection).toHaveBeenCalledTimes(2));
});

class FakeSubscriberPager extends EventTarget {
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
