import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  GetProcessorRuntimeState,
  ProcessEventBatch,
  StreamPushEventBatch,
  StreamSubscriberPing,
} from "iterate/processors";

const dialMocks = vi.hoisted(() => ({
  evaluateItxExpression: vi.fn(),
}));

vi.mock("../../itx/expression.ts", () => ({
  evaluateItxExpression: dialMocks.evaluateItxExpression,
}));
const { createSubscriberDial, isWorkersHungEntrypointError, retainWakeHandshakeResponse } =
  await import("./subscriber-sinks.ts");

const WORKERS_HUNG_ENTRYPOINT_ERROR =
  "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response. Refer to: https://developers.cloudflare.com/workers/observability/errors/";

function remoteCallback<Arg, Result>(implementation: (arg: Arg) => Result) {
  const rawDispose = vi.fn();
  const duplicateDispose = vi.fn();
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

  test("classifies a runtime-canceled receiver as unavailable, never as event poison", async () => {
    const runtimeCancellation = new Error(WORKERS_HUNG_ENTRYPOINT_ERROR);
    dialMocks.evaluateItxExpression.mockRejectedValue(runtimeCancellation);

    const dial = createSubscriberDial({
      projectId: "prj_test",
      exports: {},
      createAuthorityRoot: () => ({}),
      onDurableDeliveryError: vi.fn(),
    });

    await expect(
      dial.push(["worker", "processEventBatch"], {} as StreamPushEventBatch),
    ).rejects.toMatchObject({
      name: "StreamReceiverUnavailableError",
      cause: runtimeCancellation,
    });
  });

  test("does not mistake an ordinary receiver exception for runtime cancellation", () => {
    expect(isWorkersHungEntrypointError(new Error("processor rejected the batch"))).toBe(false);
    expect(
      isWorkersHungEntrypointError(
        new TypeError(
          "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.",
        ),
      ),
    ).toBe(false);
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
});
