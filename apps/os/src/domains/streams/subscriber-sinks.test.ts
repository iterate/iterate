import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  StreamPushEventBatch,
  StreamSubscriberPing,
  StreamWebhookDelivery,
} from "iterate/processors";

const dialMocks = vi.hoisted(() => ({
  evaluateItxExpression: vi.fn(),
  projectEgressFetcher: vi.fn(),
}));

vi.mock("../../itx/expression.ts", () => ({
  evaluateItxExpression: dialMocks.evaluateItxExpression,
}));
vi.mock("../projects/utils.ts", () => ({
  projectEgressFetcher: dialMocks.projectEgressFetcher,
}));
const {
  createSubscriberDial,
  retainProcessEventBatch,
  retainSubscriberPing,
  retainWakeHandshakeResponse,
} = await import("./subscriber-sinks.ts");

function remoteCallback<Arg, Result>(
  implementation: (arg: Arg) => Result,
  opts: {
    onDuplicateDispose?: () => void;
    onRawDispose?: () => void;
  } = {},
) {
  const rawDispose = vi.fn(opts.onRawDispose);
  const duplicateDispose = vi.fn(opts.onDuplicateDispose);
  const duplicate = Object.assign((arg: Arg) => implementation(arg), {
    [Symbol.dispose]: duplicateDispose,
  });
  const raw = Object.assign((arg: Arg) => implementation(arg), {
    dup: vi.fn(() => duplicate),
    [Symbol.dispose]: rawDispose,
  });
  return { duplicateDispose, raw, rawDispose };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("push delivery RPC ownership", () => {
  beforeEach(() => {
    dialMocks.evaluateItxExpression.mockReset().mockResolvedValue({
      receiver: undefined,
      value: undefined,
    });
  });

  test("uses fresh local roots and disposes overlapping ignored results on settlement", async () => {
    const roots = [{ batch: 1 }, { batch: 2 }];
    const createAuthorityRoot = vi.fn().mockReturnValueOnce(roots[0]).mockReturnValueOnce(roots[1]);
    const first = deferred<{ receiver: undefined; value: { [Symbol.dispose](): void } }>();
    const second = deferred<{ receiver: undefined; value: { [Symbol.dispose](): void } }>();
    const disposeFirstResult = vi.fn();
    const disposeSecondResult = vi.fn();
    dialMocks.evaluateItxExpression
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: {},
      createAuthorityRoot,
      onDurableDeliveryError: vi.fn(),
    });
    const expression = ["worker", "processEventBatch"];
    const batch = {} as StreamPushEventBatch;

    const firstPush = dial.push(expression, batch);
    const secondPush = dial.push(expression, batch);
    await vi.waitFor(() => expect(dialMocks.evaluateItxExpression).toHaveBeenCalledTimes(2));
    expect(createAuthorityRoot).toHaveBeenCalledTimes(2);
    expect(dialMocks.evaluateItxExpression.mock.calls[0]?.[0]).toBe(roots[0]);
    expect(dialMocks.evaluateItxExpression.mock.calls[1]?.[0]).toBe(roots[1]);

    first.resolve({ receiver: undefined, value: { [Symbol.dispose]: disposeFirstResult } });
    await firstPush;
    expect(disposeFirstResult).toHaveBeenCalledOnce();
    expect(disposeSecondResult).not.toHaveBeenCalled();

    second.resolve({ receiver: undefined, value: { [Symbol.dispose]: disposeSecondResult } });
    await secondPush;
    expect(disposeSecondResult).toHaveBeenCalledOnce();
  });

  test("preserves an evaluation rejection", async () => {
    const failure = new Error("processor rejected the batch");
    dialMocks.evaluateItxExpression.mockRejectedValue(failure);

    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: {},
      createAuthorityRoot: () => ({}),
      onDurableDeliveryError: vi.fn(),
    });

    await expect(
      dial.push(["worker", "processEventBatch"], {} as StreamPushEventBatch),
    ).rejects.toBe(failure);
  });

  test("does not retry an acknowledged batch when result disposal throws", async () => {
    const disposalError = new Error("native result disposal failed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    dialMocks.evaluateItxExpression.mockResolvedValue({
      receiver: undefined,
      value: {
        [Symbol.dispose]: () => {
          throw disposalError;
        },
      },
    });
    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: {},
      createAuthorityRoot: () => ({}),
      onDurableDeliveryError: vi.fn(),
    });

    try {
      await expect(
        dial.push(["worker", "processEventBatch"], {} as StreamPushEventBatch),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "stream push RPC result dispose failed after acknowledgement",
        { error: disposalError },
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("a failed root construction does not evaluate and the next batch creates afresh", async () => {
    const failure = new Error("root construction failed");
    const root = {};
    const createAuthorityRoot = vi.fn().mockImplementationOnce(() => {
      throw failure;
    });
    createAuthorityRoot.mockReturnValueOnce(root);

    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: {},
      createAuthorityRoot,
      onDurableDeliveryError: vi.fn(),
    });
    const push = () => dial.push(["worker", "processEventBatch"], {} as StreamPushEventBatch);

    await expect(push()).rejects.toBe(failure);
    expect(dialMocks.evaluateItxExpression).not.toHaveBeenCalled();
    await push();
    expect(createAuthorityRoot).toHaveBeenCalledTimes(2);
    expect(dialMocks.evaluateItxExpression).toHaveBeenCalledWith(root, expect.any(Array));
  });
});

describe("retained batch RPC result ownership", () => {
  const batch = {} as Parameters<ProcessEventBatch>[0];

  test("contains result disposal failure after a resolved durable delivery", async () => {
    const disposalError = new Error("result dispose exploded");
    const disposeResult = vi.fn(() => {
      throw disposalError;
    });
    const result = Object.assign(Promise.resolve(), {
      [Symbol.dispose]: disposeResult,
    });
    const onDeliveryError = vi.fn();
    const onSettled = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sink = retainProcessEventBatch(() => result, { onDeliveryError });

    try {
      sink(batch, { onSettled });
      await vi.waitFor(() => expect(disposeResult).toHaveBeenCalledOnce());

      expect(onDeliveryError).not.toHaveBeenCalled();
      expect(onSettled).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledWith("ok");
      expect(warn).toHaveBeenCalledWith(
        "stream delivery RPC result dispose failed after delivery outcome",
        { error: disposalError },
      );
    } finally {
      sink[Symbol.dispose]();
      warn.mockRestore();
    }
  });

  test("preserves a rejected durable delivery when result disposal also fails", async () => {
    const deliveryError = new Error("delivery rejected");
    const disposalError = new Error("result dispose exploded");
    const disposeResult = vi.fn(() => {
      throw disposalError;
    });
    const result = Object.assign(Promise.reject(deliveryError), {
      [Symbol.dispose]: disposeResult,
    });
    const onDeliveryError = vi.fn();
    const onSettled = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sink = retainProcessEventBatch(() => result, { onDeliveryError });

    try {
      sink(batch, { onSettled });
      await vi.waitFor(() => expect(disposeResult).toHaveBeenCalledOnce());

      expect(onDeliveryError).toHaveBeenCalledOnce();
      expect(onDeliveryError).toHaveBeenCalledWith(deliveryError);
      expect(onSettled).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledWith("error");
      expect(warn).toHaveBeenCalledWith(
        "stream delivery RPC result dispose failed after delivery outcome",
        { error: disposalError },
      );
    } finally {
      sink[Symbol.dispose]();
      warn.mockRestore();
    }
  });

  test("does not misclassify synchronous result disposal failure as delivery failure", () => {
    const disposalError = new Error("result dispose exploded");
    const disposeResult = vi.fn(() => {
      throw disposalError;
    });
    const onDeliveryError = vi.fn();
    const onSettled = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sink = retainProcessEventBatch(() => ({ [Symbol.dispose]: disposeResult }), {
      onDeliveryError,
    });

    try {
      expect(() => sink(batch, { onSettled })).not.toThrow();
      expect(disposeResult).toHaveBeenCalledOnce();
      expect(onDeliveryError).not.toHaveBeenCalled();
      expect(onSettled).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledWith("ok");
      expect(warn).toHaveBeenCalledWith(
        "stream delivery RPC result dispose failed after delivery outcome",
        { error: disposalError },
      );
    } finally {
      sink[Symbol.dispose]();
      warn.mockRestore();
    }
  });
});

describe("pulled RPC result ownership", () => {
  const input = { t0: 1 };
  const reply = { t0: 1, t1: 2, t2: 3 };

  test("preserves an asynchronous fulfillment when result disposal fails", async () => {
    const disposalError = new Error("result dispose exploded");
    const disposeResult = vi.fn(() => {
      throw disposalError;
    });
    const result = Object.assign(Promise.resolve(reply), {
      [Symbol.dispose]: disposeResult,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ping = retainSubscriberPing(() => result)!;

    try {
      await expect(ping(input)).resolves.toBe(reply);
      expect(disposeResult).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "stream pulled RPC result dispose failed after RPC outcome",
        { error: disposalError },
      );
    } finally {
      ping[Symbol.dispose]();
      warn.mockRestore();
    }
  });

  test("preserves an asynchronous rejection when result disposal also fails", async () => {
    const rpcError = new Error("ping rejected");
    const disposalError = new Error("result dispose exploded");
    const disposeResult = vi.fn(() => {
      throw disposalError;
    });
    const result = Object.assign(Promise.reject(rpcError), {
      [Symbol.dispose]: disposeResult,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ping = retainSubscriberPing(() => result)!;

    try {
      await expect(ping(input)).rejects.toBe(rpcError);
      expect(disposeResult).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "stream pulled RPC result dispose failed after RPC outcome",
        { error: disposalError },
      );
    } finally {
      ping[Symbol.dispose]();
      warn.mockRestore();
    }
  });

  test("preserves a synchronous return when result disposal fails", () => {
    const disposalError = new Error("result dispose exploded");
    const result = Object.assign(
      { ...reply },
      {
        [Symbol.dispose]: vi.fn(() => {
          throw disposalError;
        }),
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ping = retainSubscriberPing(() => result)!;

    try {
      expect(ping(input)).toBe(result);
      expect(result[Symbol.dispose]).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "stream pulled RPC result dispose failed after RPC outcome",
        { error: disposalError },
      );
    } finally {
      ping[Symbol.dispose]();
      warn.mockRestore();
    }
  });
});

describe("wake-handshake RPC ownership", () => {
  test("retains every returned capability and disposes the original RPC result", async () => {
    const sink = remoteCallback<Parameters<ProcessEventBatch>[0], void>(() => {});
    const getRuntimeState = remoteCallback<void, { snapshot: { offset: number; state: object } }>(
      () => ({ snapshot: { offset: 17, state: {} } }),
    );
    const ping = remoteCallback<{ t0: number }, { t0: number; t1: number; t2: number }>(
      ({ t0 }) => ({
        t0,
        t1: t0 + 1,
        t2: t0 + 2,
      }),
    );
    const disposeResult = vi.fn(() => {
      sink.raw[Symbol.dispose]();
      getRuntimeState.raw[Symbol.dispose]();
      ping.raw[Symbol.dispose]();
    });
    const retained = retainWakeHandshakeResponse({
      onDeliveryError: vi.fn(),
      value: {
        checkpointOffset: 17,
        sink: sink.raw as ProcessEventBatch,
        getRuntimeState: getRuntimeState.raw as GetProcessorRuntimeState,
        ping: ping.raw as StreamSubscriberPing,
        [Symbol.dispose]: disposeResult,
      },
    });

    expect(disposeResult).toHaveBeenCalledOnce();
    expect(sink.rawDispose).toHaveBeenCalledOnce();
    expect(getRuntimeState.rawDispose).toHaveBeenCalledOnce();
    expect(ping.rawDispose).toHaveBeenCalledOnce();
    expect(sink.raw.dup).toHaveBeenCalledOnce();
    expect(getRuntimeState.raw.dup).toHaveBeenCalledOnce();
    expect(ping.raw.dup).toHaveBeenCalledOnce();

    retained.sink({
      events: [],
      path: "/",
      projectId: "prj_test",
      scannedAfterOffset: 17,
      scannedThroughOffset: 17,
      state: {},
      streamMaxOffset: 17,
    });
    expect(await retained.getRuntimeState?.()).toEqual({
      snapshot: { offset: 17, state: {} },
    });
    expect(await retained.ping?.({ t0: 10 })).toEqual({ t0: 10, t1: 11, t2: 12 });

    retained.sink[Symbol.dispose]();
    expect(sink.duplicateDispose).toHaveBeenCalledOnce();
    expect(getRuntimeState.duplicateDispose).toHaveBeenCalledOnce();
    expect(ping.duplicateDispose).toHaveBeenCalledOnce();
  });

  test("keeps a healthy retained handshake when original result disposal fails", () => {
    const disposalError = new Error("original result dispose exploded");
    const sink = remoteCallback<Parameters<ProcessEventBatch>[0], void>(() => {});
    const getRuntimeState = remoteCallback<void, { snapshot: { offset: number; state: object } }>(
      () => ({ snapshot: { offset: 0, state: {} } }),
    );
    const ping = remoteCallback<{ t0: number }, { t0: number; t1: number; t2: number }>(
      ({ t0 }) => ({ t0, t1: t0, t2: t0 }),
    );
    const onDeliveryError = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const retained = retainWakeHandshakeResponse({
        onDeliveryError,
        value: {
          checkpointOffset: 0,
          sink: sink.raw as ProcessEventBatch,
          getRuntimeState: getRuntimeState.raw as GetProcessorRuntimeState,
          ping: ping.raw as StreamSubscriberPing,
          [Symbol.dispose]: () => {
            sink.raw[Symbol.dispose]();
            getRuntimeState.raw[Symbol.dispose]();
            ping.raw[Symbol.dispose]();
            throw disposalError;
          },
        },
      });

      expect(retained.checkpointOffset).toBe(0);
      expect(onDeliveryError).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "stream wake handshake original RPC result dispose failed during ownership release",
        { error: disposalError },
      );
      retained.sink[Symbol.dispose]();
    } finally {
      warn.mockRestore();
    }
  });

  test("preserves a duplication failure through every fallible cleanup", () => {
    const order: string[] = [];
    const duplicationError = new Error("sink dup failed");
    const pingCleanupError = new Error("ping cleanup failed");
    const runtimeCleanupError = new Error("runtime cleanup failed");
    const originalCleanupError = new Error("original cleanup failed");
    const runtime = remoteCallback<void, object>(() => ({}), {
      onDuplicateDispose: () => {
        order.push("runtime");
        throw runtimeCleanupError;
      },
    });
    const ping = remoteCallback<{ t0: number }, { t0: number; t1: number; t2: number }>(
      ({ t0 }) => ({ t0, t1: t0, t2: t0 }),
      {
        onDuplicateDispose: () => {
          order.push("ping");
          throw pingCleanupError;
        },
      },
    );
    const sink = Object.assign(() => undefined, {
      dup: () => {
        throw duplicationError;
      },
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      expect(() =>
        retainWakeHandshakeResponse({
          onDeliveryError: vi.fn(),
          value: {
            checkpointOffset: 0,
            sink,
            getRuntimeState: runtime.raw as GetProcessorRuntimeState,
            ping: ping.raw as StreamSubscriberPing,
            [Symbol.dispose]: () => {
              order.push("original");
              throw originalCleanupError;
            },
          },
        }),
      ).toThrow(duplicationError);
      expect(order).toEqual(["ping", "runtime", "original"]);
      expect(errorLog).toHaveBeenCalledWith(
        "stream wake handshake retained capability disposal failed",
        {
          failures: [
            { capability: "ping", error: pingCleanupError },
            { capability: "getProcessorRuntimeState", error: runtimeCleanupError },
          ],
        },
      );
      expect(warn).toHaveBeenCalledWith(
        "stream wake handshake original RPC result dispose failed during ownership release",
        { error: originalCleanupError },
      );
    } finally {
      errorLog.mockRestore();
      warn.mockRestore();
    }
  });

  test("snapshots the retained response before releasing the original RPC group", () => {
    const order: string[] = [];
    const responseReadError = new Error("subscriber getter failed");
    const sink = remoteCallback<Parameters<ProcessEventBatch>[0], void>(() => {}, {
      onDuplicateDispose: () => order.push("sink"),
    });
    const runtime = remoteCallback<void, object>(() => ({}), {
      onDuplicateDispose: () => order.push("runtime"),
    });
    const ping = remoteCallback<{ t0: number }, { t0: number; t1: number; t2: number }>(
      ({ t0 }) => ({ t0, t1: t0, t2: t0 }),
      { onDuplicateDispose: () => order.push("ping") },
    );
    const value = Object.defineProperties(
      {
        checkpointOffset: 0,
        sink: sink.raw as ProcessEventBatch,
        getRuntimeState: runtime.raw as GetProcessorRuntimeState,
        ping: ping.raw as StreamSubscriberPing,
        [Symbol.dispose]: () => order.push("original"),
      },
      {
        subscriber: {
          enumerable: true,
          get: () => {
            throw responseReadError;
          },
        },
      },
    );

    expect(() =>
      retainWakeHandshakeResponse({
        onDeliveryError: vi.fn(),
        value,
      }),
    ).toThrow(responseReadError);
    expect(order).toEqual(["ping", "runtime", "sink", "original"]);
  });

  test("releases retained sidecars before the sink that carries their RPC chain", () => {
    const order: string[] = [];
    const sink = remoteCallback<Parameters<ProcessEventBatch>[0], void>(() => {}, {
      onDuplicateDispose: () => order.push("sink"),
    });
    const runtime = remoteCallback<void, object>(() => ({}), {
      onDuplicateDispose: () => order.push("runtime"),
    });
    const ping = remoteCallback<{ t0: number }, { t0: number; t1: number; t2: number }>(
      ({ t0 }) => ({ t0, t1: t0, t2: t0 }),
      { onDuplicateDispose: () => order.push("ping") },
    );
    const retained = retainWakeHandshakeResponse({
      onDeliveryError: vi.fn(),
      value: {
        checkpointOffset: 0,
        sink: sink.raw as ProcessEventBatch,
        getRuntimeState: runtime.raw as GetProcessorRuntimeState,
        ping: ping.raw as StreamSubscriberPing,
        [Symbol.dispose]: vi.fn(),
      },
    });

    retained.sink[Symbol.dispose]();

    expect(order).toEqual(["ping", "runtime", "sink"]);
  });

  test("disposes the RPC result when the handshake is invalid", () => {
    const disposeResult = vi.fn();

    expect(() =>
      retainWakeHandshakeResponse({
        onDeliveryError: vi.fn(),
        value: {
          checkpointOffset: -1,
          sink: () => {},
          [Symbol.dispose]: disposeResult,
        },
      }),
    ).toThrow("checkpointOffset");
    expect(disposeResult).toHaveBeenCalledOnce();
  });

  test("ignores a late delivery rejection after that exact sink was replaced", async () => {
    let rejectDelivery!: (error: Error) => void;
    const delivery = new Promise<void>((_resolve, reject) => {
      rejectDelivery = reject;
    });
    const sink = remoteCallback<Parameters<ProcessEventBatch>[0], Promise<void>>(() => delivery);
    const onDeliveryError = vi.fn();
    const retained = retainWakeHandshakeResponse({
      onDeliveryError,
      value: {
        checkpointOffset: 0,
        sink: sink.raw as ProcessEventBatch,
        [Symbol.dispose]: vi.fn(),
      },
    });

    retained.sink({
      events: [],
      path: "/",
      projectId: "prj_test",
      scannedAfterOffset: 0,
      scannedThroughOffset: 0,
      state: {},
      streamMaxOffset: 0,
    });
    retained.sink[Symbol.dispose]();
    rejectDelivery(new Error("old delivery failed late"));
    await Promise.allSettled([delivery]);
    await Promise.resolve();

    expect(sink.duplicateDispose).toHaveBeenCalledOnce();
    expect(onDeliveryError).not.toHaveBeenCalled();
  });
});

describe("webhook egress RPC ownership", () => {
  test("preserves the delivery failure when egress disposal also fails", async () => {
    const deliveryError = new Error("webhook network failed");
    const disposalError = new Error("egress dispose exploded");
    const disposeEgress = vi.fn(() => {
      throw disposalError;
    });
    dialMocks.projectEgressFetcher.mockReset().mockReturnValue({
      fetch: vi.fn().mockRejectedValue(deliveryError),
      [Symbol.dispose]: disposeEgress,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: {},
      createAuthorityRoot: () => ({}),
      onDurableDeliveryError: vi.fn(),
    });

    try {
      await expect(
        dial.webhook("https://example.com/hook", {} as StreamWebhookDelivery),
      ).rejects.toBe(deliveryError);
      expect(disposeEgress).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "stream webhook egress dispose failed after delivery failure",
        { deliveryError, error: disposalError },
      );
    } finally {
      warn.mockRestore();
    }
  });
});
