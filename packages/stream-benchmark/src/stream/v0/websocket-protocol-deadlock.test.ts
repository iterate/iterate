import { describe, expect, it } from "vitest";

type TestEvent = {
  offset: number;
  type: string;
};

describe("WebSocket stream append/subscription deadlock", () => {
  it("shows the trivial broken design can deadlock when append waits for subscribe to yield its event", async () => {
    const transport = new BrokenAppendViaSubscriptionTransport({
      initialEvents: [
        { offset: 100, type: "trigger" },
        { offset: 101, type: "backlog" },
        { offset: 102, type: "backlog" },
        { offset: 103, type: "backlog" },
      ],
    });

    const processorTurn = transport.processNextEvent({
      afterAppend: async ({ event }) => {
        expect(event.offset).toBe(100);
        await transport.append({
          event: { type: "follow-up" },
        });
      },
    });

    await flushMicrotasks();

    expect(transport.pendingOffsets()).toEqual([101, 102, 103, 104]);
    expect(await isSettled({ promise: processorTurn })).toBe(false);
  });

  it("lets append resolve from a request-id ack while event delivery remains queued", async () => {
    const transport = new AckDemuxTransport({
      initialEvents: [
        { offset: 100, type: "trigger" },
        { offset: 101, type: "backlog" },
        { offset: 102, type: "backlog" },
        { offset: 103, type: "backlog" },
      ],
    });

    let appendedOffset: number | undefined;
    const processorTurn = transport.processNextEvent({
      afterAppend: async ({ event }) => {
        expect(event.offset).toBe(100);
        const appended = await transport.append({
          event: { type: "follow-up" },
        });
        appendedOffset = appended.offset;
      },
    });

    await flushMicrotasks();

    expect(transport.pendingOffsets()).toEqual([101, 102, 103, 104]);
    expect(await isSettled({ promise: processorTurn })).toBe(true);
    expect(appendedOffset).toBe(104);
  });
});

class BrokenAppendViaSubscriptionTransport {
  private readonly eventQueue: TestEvent[];
  private readonly waiters = new Map<number, (event: TestEvent) => void>();
  private nextOffset: number;

  constructor({ initialEvents }: { initialEvents: TestEvent[] }) {
    this.eventQueue = [...initialEvents];
    this.nextOffset = Math.max(...initialEvents.map((event) => event.offset), 0) + 1;
  }

  async append({ event }: { event: { type: string } }) {
    const committed = { offset: this.nextOffset++, type: event.type };
    this.eventQueue.push(committed);

    // This is the bug: the append promise waits for the processor's ordered
    // subscription loop to eventually consume the same event. If the processor
    // is currently blocked inside afterAppend, nobody can consume that event.
    return await new Promise<TestEvent>((resolve) => {
      this.waiters.set(committed.offset, resolve);
    });
  }

  async processNextEvent({
    afterAppend,
  }: {
    afterAppend(args: { event: TestEvent }): Promise<void>;
  }) {
    const event = this.eventQueue.shift();
    if (event === undefined) throw new Error("Expected a queued event.");

    this.waiters.get(event.offset)?.(event);
    this.waiters.delete(event.offset);
    await afterAppend({ event });
  }

  pendingOffsets() {
    return this.eventQueue.map((event) => event.offset);
  }
}

class AckDemuxTransport {
  private readonly eventQueue: TestEvent[];
  private readonly pendingAppends = new Map<number, (event: TestEvent) => void>();
  private nextRequestId = 1;
  private nextOffset: number;

  constructor({ initialEvents }: { initialEvents: TestEvent[] }) {
    this.eventQueue = [...initialEvents];
    this.nextOffset = Math.max(...initialEvents.map((event) => event.offset), 0) + 1;
  }

  async append({ event }: { event: { type: string } }) {
    const requestId = this.nextRequestId++;
    const committed = { offset: this.nextOffset++, type: event.type };
    const ack = new Promise<TestEvent>((resolve) => {
      this.pendingAppends.set(requestId, resolve);
    });

    // A real WebSocket reader would keep draining frames while the processor is
    // blocked in afterAppend. Event frames are queued for ordered processing;
    // ack frames resolve the append RPC by request id.
    this.receiveServerFrame({ type: "event", event: committed });
    this.receiveServerFrame({ type: "append/ok", requestId, event: committed });

    return await ack;
  }

  async processNextEvent({
    afterAppend,
  }: {
    afterAppend(args: { event: TestEvent }): Promise<void>;
  }) {
    const event = this.eventQueue.shift();
    if (event === undefined) throw new Error("Expected a queued event.");
    await afterAppend({ event });
  }

  pendingOffsets() {
    return this.eventQueue.map((event) => event.offset);
  }

  private receiveServerFrame(
    frame:
      | { type: "event"; event: TestEvent }
      | { type: "append/ok"; requestId: number; event: TestEvent },
  ) {
    if (frame.type === "event") {
      this.eventQueue.push(frame.event);
      return;
    }

    this.pendingAppends.get(frame.requestId)?.(frame.event);
    this.pendingAppends.delete(frame.requestId);
  }
}

async function isSettled({ promise }: { promise: Promise<unknown> }) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flushMicrotasks();
  return settled;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
