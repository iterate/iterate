import {
  initialAgentUiState,
  type AgentUiState,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { describe, expect, it } from "vitest";
import {
  LiveAgentStateChannel,
  liveAgentStateChannelName,
  type LiveAgentStateChannelPort,
} from "./live-agent-state-channel.ts";

class MemoryBroadcastBus {
  readonly #ports = new Set<MemoryPort>();

  createPort = (): LiveAgentStateChannelPort => {
    const port = new MemoryPort(this);
    this.#ports.add(port);
    return port;
  };

  publish(sender: MemoryPort, message: unknown): void {
    for (const port of this.#ports) {
      if (port !== sender) port.receive(message);
    }
  }

  remove(port: MemoryPort): void {
    this.#ports.delete(port);
  }
}

class MemoryPort implements LiveAgentStateChannelPort {
  #handler: (message: unknown) => void = () => {};

  constructor(readonly bus: MemoryBroadcastBus) {}

  postMessage(message: unknown): void {
    this.bus.publish(this, message);
  }

  setMessageHandler(handler: (message: unknown) => void): void {
    this.#handler = handler;
  }

  receive(message: unknown): void {
    this.#handler(message);
  }

  close(): void {
    this.bus.remove(this);
  }
}

function state(eventCount: number): AgentUiState {
  return { ...initialAgentUiState(), eventCount };
}

describe("LiveAgentStateChannel", () => {
  it("relays only the writer's current volatile state to a reader", () => {
    const bus = new MemoryBroadcastBus();
    const received: Array<AgentUiState | null> = [];
    const writer = new LiveAgentStateChannel({
      name: "stream",
      createPort: bus.createPort,
      createSessionId: () => "writer-a",
      now: () => 100,
      onState: () => {},
    });

    writer.claim(state(1));
    writer.publish(state(2));
    const reader = new LiveAgentStateChannel({
      name: "stream",
      createPort: bus.createPort,
      onState: (value) => received.push(value),
    });
    reader.request();
    expect(received).toEqual([null, expect.objectContaining({ eventCount: 2 })]);

    writer[Symbol.dispose]();
    reader[Symbol.dispose]();
  });

  it("fences late state from a superseded writer session", () => {
    const bus = new MemoryBroadcastBus();
    const received: Array<AgentUiState | null> = [];
    const oldWriter = new LiveAgentStateChannel({
      name: "stream",
      createPort: bus.createPort,
      createSessionId: () => "old",
      now: () => 100,
      onState: () => {},
    });
    const newWriter = new LiveAgentStateChannel({
      name: "stream",
      createPort: bus.createPort,
      createSessionId: () => "new",
      now: () => 200,
      onState: () => {},
    });
    const reader = new LiveAgentStateChannel({
      name: "stream",
      createPort: bus.createPort,
      onState: (value) => received.push(value),
    });

    oldWriter.claim(state(1));
    newWriter.claim(state(2));
    oldWriter.publish(state(3));

    expect(received.at(-1)?.eventCount).toBe(2);
    oldWriter[Symbol.dispose]();
    expect(received.at(-1)?.eventCount).toBe(2);

    newWriter[Symbol.dispose]();
    expect(received.at(-1)).toBeNull();
    reader[Symbol.dispose]();
  });

  it("namespaces the relay by stream and strict processor version vector", () => {
    expect(
      liveAgentStateChannelName({
        projectId: "project:one",
        streamPath: "/agents/web one",
        processorSchemaVersionKey: "browser-feed@4|raw-events@7",
      }),
    ).toBe(
      "stream-live-agent:project%3Aone:%2Fagents%2Fweb%20one:browser-feed%404%7Craw-events%407",
    );
  });

  it("closes its port even when publishing the final cleared state throws", () => {
    let failPosts = false;
    let closed = false;
    const channel = new LiveAgentStateChannel({
      name: "stream",
      createPort: () => ({
        postMessage: () => {
          if (failPosts) throw new Error("broadcast port is closing");
        },
        setMessageHandler: () => {},
        close: () => {
          closed = true;
        },
      }),
      createSessionId: () => "writer",
      now: () => 100,
      onState: () => {},
    });
    channel.claim(state(1));
    failPosts = true;

    expect(() => channel[Symbol.dispose]()).toThrow(/broadcast port is closing/);
    expect(closed).toBe(true);
  });
});
