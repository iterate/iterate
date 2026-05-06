# Capability-First Function Call Receivers

## Thesis

`function-call-requested` should carry a small **Function Call Receiver** capability object:

```ts
type FunctionCallReceiverCapability = {
  schema: "https://schemas.iterate.com/codemode/function-call-receiver/v1";
  kind: "callable-receiver";
  return: Callable;
  throw: Callable;
};
```

Providers complete a Function Call by invoking one of those capabilities:

```ts
await dispatchCallable({
  callable: requested.input.receiver.return,
  payload: result,
  ctx,
});
```

or:

```ts
await dispatchCallable({
  callable: requested.input.receiver.throw,
  payload: serializeException(error),
  ctx,
});
```

The shared codemode processor still owns the public event protocol:

- it appends `function-call-requested`;
- it waits for raw Function Call delivery through a minimal Runtime dependency;
- it appends `function-call-completed`;
- it reconstructs JavaScript results or throws JavaScript errors back into the Script.

The Runtime dependency does only the part shared processor code cannot do: construct receiver capabilities that route back to the running host, and expose a raw delivery queue/channel to the processor.

This is good because it keeps the event log serializable while still exploiting Cloudflare RPC object-capability semantics. Live callbacks, streams, Durable Object stubs, `RpcTarget`s, and thrown exceptions travel through the live RPC call path. The event log records a serialized audit record, not the live object itself.

## Glossary Alignment

Use **Runtime dependency**, not Processor dependency, for the backend-only receiver mechanism. A Processor dependency is another processor's public contract/reducer. The Function Call Receiver is not another public event processor; it is a host runtime endpoint supplied to the codemode processor.

Use **Function Call Receiver**, not sink or bridge.

Definition:

> A Runtime dependency endpoint that receives the raw result for one Function Call before the Codemode Session records the corresponding completion event.

## Exact Event Schemas

This design uses `input` for event data. If the current implementation still uses `payload`, treat this as the target schema.

```ts
type CodemodeEvent =
  | ToolProviderRegistered
  | ScriptExecutionRequested
  | ScriptExecutionCompleted
  | FunctionCallRequested
  | FunctionCallCompleted
  | LogEmitted;
```

### `function-call-requested`

```ts
type FunctionCallRequested = {
  type: "function-call-requested";
  input: {
    functionCallId: string;
    scriptExecutionId: string;
    path: string[];
    input: unknown;
    receiver: FunctionCallReceiverCapability;
    parentFunctionCallId?: string;
  };
};

type FunctionCallReceiverCapability = {
  schema: "https://schemas.iterate.com/codemode/function-call-receiver/v1";
  kind: "callable-receiver";
  return: Callable;
  throw: Callable;
};
```

The field is `receiver`, not `resultCallable`, because it is not one generic result endpoint. It is a capability object with JavaScript-like completion methods.

The request event stays serializable because `return` and `throw` are JSON `Callable` descriptors.

### `function-call-completed`

```ts
type FunctionCallCompleted = {
  type: "function-call-completed";
  input: {
    functionCallId: string;
    scriptExecutionId: string;
    path: string[];
    durationMs?: number;
    source: "receiver" | "event";
    outcome:
      | {
          type: "returned";
          result: EventLogValue;
        }
      | {
          type: "threw";
          exception: SerializedException;
        };
  };
};
```

`source` is optional in spirit but useful in practice. It says whether the codemode processor appended this completion after raw receiver delivery, or whether it observed an externally appended completion event. If that feels noisy, drop it. The correlation fields are enough.

Use `returned` / `threw`, not `succeeded` / `failed`, because a JavaScript function can successfully return an `Error` object. Throwing is separate from returning.

### Event Log Value

```ts
type EventLogValue = JsonValue | LiveValueSummary | NonSerializableValueSummary;

type LiveValueSummary = {
  kind: "rpc-live-value";
  type:
    | "function"
    | "ReadableStream"
    | "WritableStream"
    | "Request"
    | "Response"
    | "RpcTarget"
    | "DurableObjectStub"
    | "unknown";
  description?: string;
};

type NonSerializableValueSummary = {
  kind: "non-serializable-value";
  type: string;
  description?: string;
};
```

The live result itself is delivered through the Function Call Receiver. The completed event records a durable audit summary.

### Serialized Exception

```ts
type SerializedException = {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedException;
  code?: string;
  details?: JsonValue;
};
```

The receiver can accept either a pre-serialized exception or a live `Error` object. The codemode processor normalizes before appending `function-call-completed`.

## Capability Object Mapping

There are two representations of the same concept:

1. **Serializable receiver capability**, stored in `function-call-requested.input.receiver`.
2. **Live receiver object**, optionally handed around inside a warm Workers RPC call graph.

The event always stores the serializable form:

```ts
const receiver = {
  schema: "https://schemas.iterate.com/codemode/function-call-receiver/v1",
  kind: "callable-receiver",
  return: {
    type: "workers-rpc",
    via: {
      type: "env-binding",
      bindingType: "durable-object-namespace",
      bindingName: "CODEMODE_SESSION",
      durableObject: { name: codemodeSessionName },
    },
    rpcMethod: "receiveFunctionCallReturn",
    argsMode: "object",
    transformInput: {
      wrap: { field: "result" },
      shallowMerge: { functionCallId },
    },
  },
  throw: {
    type: "workers-rpc",
    via: {
      type: "env-binding",
      bindingType: "durable-object-namespace",
      bindingName: "CODEMODE_SESSION",
      durableObject: { name: codemodeSessionName },
    },
    rpcMethod: "receiveFunctionCallThrow",
    argsMode: "object",
    transformInput: {
      wrap: { field: "exception" },
      shallowMerge: { functionCallId },
    },
  },
} satisfies FunctionCallReceiverCapability;
```

The warm-context live form can be an adapter over the same serialized receiver:

```ts
type LiveFunctionCallReceiver = {
  return(result: unknown): Promise<void>;
  throw(exception: unknown): Promise<void>;
  toJSON(): FunctionCallReceiverCapability;
};

function liveReceiverFromCapability(
  receiver: FunctionCallReceiverCapability,
  ctx: CallableContext,
): LiveFunctionCallReceiver {
  return {
    async return(result) {
      await dispatchCallable({ callable: receiver.return, payload: result, ctx });
    },
    async throw(exception) {
      await dispatchCallable({ callable: receiver.throw, payload: exception, ctx });
    },
    toJSON() {
      return receiver;
    },
  };
}
```

That live object must not be persisted in the stream. It is a convenience for provider implementations that already execute in a warm RPC context.

## Callable Transform Addition

Current `Callable.transformInput.shallowMerge` requires the runtime payload to already be an object. That is not enough for:

```ts
await receiver.return(callbackFunction);
```

because the raw payload is a function, stream, stub, `Response`, or any other live RPC value. JSONata is the wrong tool because it may evaluate or clone values that should retain Cloudflare RPC identity.

Add a sibling `wrap` transform:

```ts
type TransformInput = {
  wrap?: {
    field: string;
  };
  shallowMerge?: Record<string, JsonValue>;
  jsonata?: string;
};
```

Define transform order:

```ts
async function transformCallableInput({
  payload,
  transform,
}: {
  payload: unknown;
  transform?: TransformInput;
}) {
  let input = payload;

  if (transform?.wrap != null) {
    input = { [transform.wrap.field]: input };
  }

  if (transform?.shallowMerge != null) {
    if (!isPlainRecord(input)) {
      throw new CallableError(
        "PAYLOAD_VALIDATION_FAILED",
        "transformInput.shallowMerge requires object input after wrap",
      );
    }
    input = { ...transform.shallowMerge, ...input };
  }

  if (transform?.jsonata != null) {
    input = await evaluateJsonata(transform.jsonata, input);
  }

  return input;
}
```

The important rule is: `wrap` preserves the original payload as a property value. It does not serialize, clone, inspect, or transform the live value.

Example success callable:

```ts
{
  rpcMethod: "receiveFunctionCallReturn",
  transformInput: {
    wrap: { field: "result" },
    shallowMerge: { functionCallId: "fn_123" },
  },
}
```

Provider calls with a bare result:

```ts
await dispatchCallable({
  callable: receiver.return,
  payload: readableStream,
  ctx,
});
```

Receiver method receives:

```ts
{
  functionCallId: "fn_123",
  result: readableStream,
}
```

Example exception callable:

```ts
{
  rpcMethod: "receiveFunctionCallThrow",
  transformInput: {
    wrap: { field: "exception" },
    shallowMerge: { functionCallId: "fn_123" },
  },
}
```

Provider calls with a bare serialized exception:

```ts
await dispatchCallable({
  callable: receiver.throw,
  payload: serializeException(error),
  ctx,
});
```

Receiver method receives:

```ts
{
  functionCallId: "fn_123",
  exception: {
    name: "TypeError",
    message: "Slack channel is required",
  },
}
```

## Minimal Runtime Dependency

The Runtime dependency should not append events, serialize results, decide completion status, reconstruct errors, or know codemode event schemas beyond the correlation fields it needs to bake into callables.

It should only:

1. construct a serializable Function Call Receiver capability for a Function Call;
2. receive raw deliveries from the host RPC method;
3. provide a queue/channel so the codemode processor can await those raw deliveries.

```ts
type CodemodeProcessorRuntime = {
  functionCallReceiver: FunctionCallReceiverRuntime;
};

type FunctionCallReceiverRuntime = {
  createReceiver(input: {
    functionCallId: string;
    scriptExecutionId: string;
    path: string[];
  }): FunctionCallReceiverCapability;

  waitForDelivery(input: {
    functionCallId: string;
    signal: AbortSignal;
  }): Promise<FunctionCallDelivery>;
};

type FunctionCallDelivery =
  | {
      type: "returned";
      functionCallId: string;
      result: unknown;
      receivedAt: Date;
    }
  | {
      type: "threw";
      functionCallId: string;
      exception: unknown;
      receivedAt: Date;
    };
```

The host-facing receive methods feed this runtime:

```ts
type FunctionCallReceiverInbox = {
  receiveReturn(input: { functionCallId: string; result: unknown }): Promise<void>;
  receiveThrow(input: { functionCallId: string; exception: unknown }): Promise<void>;
};
```

This split is intentionally narrow:

- `createReceiver` knows how to address the current Codemode Session Durable Object.
- `receiveReturn` / `receiveThrow` accept raw RPC values.
- `waitForDelivery` hands raw values to the shared processor.
- The processor owns everything after that.

## Codemode Session Durable Object Sketch

The Codemode Session DO exposes tiny RPC methods and an in-memory receiver queue.

```ts
export class CodemodeSession extends RpcTarget {
  readonly #receiverRuntime: InMemoryFunctionCallReceiverRuntime;

  constructor(state: DurableObjectState, env: Env) {
    super();
    this.#receiverRuntime = new InMemoryFunctionCallReceiverRuntime({
      codemodeSessionName: state.id.toString(),
      codemodeSessionBindingName: "CODEMODE_SESSION",
    });
  }

  createCodemodeProcessor() {
    return createCodemodeProcessor({
      runtime: {
        functionCallReceiver: this.#receiverRuntime,
      },
      codeExecutor: createCloudflareCodemodeScriptExecutor({
        env: this.env,
      }),
    });
  }

  async receiveFunctionCallReturn(input: {
    functionCallId: string;
    result: unknown;
  }): Promise<{ accepted: true } | { accepted: false; reason: string }> {
    return await this.#receiverRuntime.receiveReturn(input);
  }

  async receiveFunctionCallThrow(input: {
    functionCallId: string;
    exception: unknown;
  }): Promise<{ accepted: true } | { accepted: false; reason: string }> {
    return await this.#receiverRuntime.receiveThrow(input);
  }
}
```

The runtime implementation is just a pending map.

```ts
class InMemoryFunctionCallReceiverRuntime implements FunctionCallReceiverRuntime {
  readonly #pending = new Map<string, Deferred<FunctionCallDelivery>>();
  readonly #delivered = new Set<string>();

  constructor(
    private readonly options: {
      codemodeSessionName: string;
      codemodeSessionBindingName: string;
    },
  ) {}

  createReceiver(input: {
    functionCallId: string;
    scriptExecutionId: string;
    path: string[];
  }): FunctionCallReceiverCapability {
    this.#pending.set(input.functionCallId, createDeferred());

    return {
      schema: "https://schemas.iterate.com/codemode/function-call-receiver/v1",
      kind: "callable-receiver",
      return: this.#callable({
        rpcMethod: "receiveFunctionCallReturn",
        wrapField: "result",
        functionCallId: input.functionCallId,
      }),
      throw: this.#callable({
        rpcMethod: "receiveFunctionCallThrow",
        wrapField: "exception",
        functionCallId: input.functionCallId,
      }),
    };
  }

  async waitForDelivery(input: {
    functionCallId: string;
    signal: AbortSignal;
  }): Promise<FunctionCallDelivery> {
    const pending = this.#pending.get(input.functionCallId);
    if (pending == null) {
      throw new Error(`No pending Function Call Receiver for ${input.functionCallId}`);
    }

    try {
      return await abortable(pending.promise, input.signal);
    } finally {
      this.#pending.delete(input.functionCallId);
    }
  }

  async receiveReturn(input: { functionCallId: string; result: unknown }) {
    return this.#deliver({
      type: "returned",
      functionCallId: input.functionCallId,
      result: input.result,
      receivedAt: new Date(),
    });
  }

  async receiveThrow(input: { functionCallId: string; exception: unknown }) {
    return this.#deliver({
      type: "threw",
      functionCallId: input.functionCallId,
      exception: input.exception,
      receivedAt: new Date(),
    });
  }

  #deliver(delivery: FunctionCallDelivery) {
    if (this.#delivered.has(delivery.functionCallId)) {
      return { accepted: false, reason: "already-delivered" };
    }

    const pending = this.#pending.get(delivery.functionCallId);
    if (pending == null) {
      return { accepted: false, reason: "not-pending" };
    }

    this.#delivered.add(delivery.functionCallId);
    pending.resolve(delivery);
    return { accepted: true };
  }

  #callable(input: {
    rpcMethod: "receiveFunctionCallReturn" | "receiveFunctionCallThrow";
    wrapField: "result" | "exception";
    functionCallId: string;
  }): Callable {
    return {
      type: "workers-rpc",
      via: {
        type: "env-binding",
        bindingType: "durable-object-namespace",
        bindingName: this.options.codemodeSessionBindingName,
        durableObject: { name: this.options.codemodeSessionName },
      },
      rpcMethod: input.rpcMethod,
      argsMode: "object",
      transformInput: {
        wrap: { field: input.wrapField },
        shallowMerge: { functionCallId: input.functionCallId },
      },
    };
  }
}
```

The sketch intentionally does not append `function-call-completed`. That belongs in the shared codemode processor.

## Shared Codemode Processor Sketch

The codemode processor owns the completion semantics.

```ts
async function callFunction(input: {
  scriptExecutionId: string;
  path: string[];
  input: unknown;
}): Promise<unknown> {
  const functionCallId = nextFunctionCallId();
  const startedAt = performance.now();

  const abortController = new AbortController();

  const receiver = runtime.functionCallReceiver.createReceiver({
    functionCallId,
    scriptExecutionId: input.scriptExecutionId,
    path: input.path,
  });

  const requestedEvent = await stream.append({
    type: "function-call-requested",
    input: {
      functionCallId,
      scriptExecutionId: input.scriptExecutionId,
      path: input.path,
      input: input.input,
      receiver,
    },
  });

  const delivery = await waitForFirstFunctionCallCompletion({
    functionCallId,
    requestedOffset: requestedEvent.offset,
    signal: abortController.signal,
  });

  if (delivery.source === "receiver") {
    await appendCompletionFromReceiverDelivery({
      delivery: delivery.delivery,
      scriptExecutionId: input.scriptExecutionId,
      path: input.path,
      durationMs: performance.now() - startedAt,
    });
  }

  if (delivery.outcome.type === "returned") {
    return delivery.outcome.result;
  }

  throw reconstructException(delivery.outcome.exception);
}
```

The processor can resolve from either source, but this is internal. The provider-facing contract is still: call the receiver.

```ts
async function waitForFirstFunctionCallCompletion(input: {
  functionCallId: string;
  requestedOffset: number;
  signal: AbortSignal;
}): Promise<
  | {
      source: "receiver";
      delivery: FunctionCallDelivery;
      outcome: { type: "returned"; result: unknown } | { type: "threw"; exception: unknown };
    }
  | {
      source: "event";
      completedEvent: FunctionCallCompleted;
      outcome:
        | { type: "returned"; result: unknown }
        | { type: "threw"; exception: SerializedException };
    }
> {
  return await Promise.race([
    runtime.functionCallReceiver
      .waitForDelivery({
        functionCallId: input.functionCallId,
        signal: input.signal,
      })
      .then((delivery) => ({
        source: "receiver" as const,
        delivery,
        outcome:
          delivery.type === "returned"
            ? { type: "returned" as const, result: delivery.result }
            : { type: "threw" as const, exception: delivery.exception },
      })),
    waitForCompletedEvent({
      functionCallId: input.functionCallId,
      afterOffset: input.requestedOffset,
      signal: input.signal,
    }).then((completedEvent) => ({
      source: "event" as const,
      completedEvent,
      outcome: decodeEventOutcome(completedEvent.input.outcome),
    })),
  ]);
}
```

Completion from receiver delivery:

```ts
async function appendCompletionFromReceiverDelivery(input: {
  delivery: FunctionCallDelivery;
  scriptExecutionId: string;
  path: string[];
  durationMs: number;
}) {
  await stream.append({
    type: "function-call-completed",
    input: {
      functionCallId: input.delivery.functionCallId,
      scriptExecutionId: input.scriptExecutionId,
      path: input.path,
      durationMs: input.durationMs,
      source: "receiver",
      outcome:
        input.delivery.type === "returned"
          ? {
              type: "returned",
              result: serializeForEventLog(input.delivery.result),
            }
          : {
              type: "threw",
              exception: normalizeException(input.delivery.exception),
            },
    },
  });
}
```

Timeout is processor-owned:

```ts
async function callFunctionWithTimeout(input: CallFunctionInput) {
  try {
    return await withTimeout(callFunction(input), 30_000);
  } catch (error) {
    const exception = normalizeException(error);

    await stream.append({
      type: "function-call-completed",
      input: {
        functionCallId: input.functionCallId,
        scriptExecutionId: input.scriptExecutionId,
        path: input.path,
        source: "receiver",
        outcome: {
          type: "threw",
          exception,
        },
      },
    });

    throw reconstructException(exception);
  }
}
```

## Tool Provider Callsites

### Success With Serialized Value

```ts
async function afterAppend(event: StreamEvent) {
  if (event.type !== "function-call-requested") return;
  if (!matchesPath(event.input.path, ["slack", "chat", "sendMessage"])) return;

  const result = await slack.chat.postMessage(event.input.input);

  await dispatchCallable({
    callable: event.input.receiver.return,
    payload: {
      channel: result.channel,
      ts: result.ts,
    },
    ctx: callableContext,
  });
}
```

### Success With Live Callback

```ts
async function afterAppend(event: StreamEvent) {
  if (event.type !== "function-call-requested") return;
  if (!matchesPath(event.input.path, ["tools", "makeCallback"])) return;

  const callback = async (input: { message: string }) => {
    return {
      fromProvider: true,
      message: input.message,
    };
  };

  await dispatchCallable({
    callable: event.input.receiver.return,
    payload: callback,
    ctx: callableContext,
  });
}
```

Codemode Script:

```ts
const callback = await ctx.tools.makeCallback();
const result = await callback({ message: "hello from script" });
ctx.log.info(result);
```

The event log stores a summary such as:

```ts
{
  type: "function-call-completed",
  input: {
    functionCallId: "fn_123",
    scriptExecutionId: "scr_1",
    path: ["tools", "makeCallback"],
    source: "receiver",
    outcome: {
      type: "returned",
      result: {
        kind: "rpc-live-value",
        type: "function",
        description: "Function returned by tools.makeCallback"
      }
    }
  }
}
```

### Failure

```ts
async function afterAppend(event: StreamEvent) {
  if (event.type !== "function-call-requested") return;
  if (!matchesPath(event.input.path, ["slack", "chat", "sendMessage"])) return;

  try {
    const result = await slack.chat.postMessage(event.input.input);

    await dispatchCallable({
      callable: event.input.receiver.return,
      payload: result,
      ctx: callableContext,
    });
  } catch (error) {
    await dispatchCallable({
      callable: event.input.receiver.throw,
      payload: serializeException(error),
      ctx: callableContext,
    });
  }
}
```

Codemode Script:

```ts
try {
  await ctx.slack.chat.sendMessage({ channel: "", text: "hello" });
} catch (error) {
  if (error instanceof Error) {
    ctx.log.error({ name: error.name, message: error.message });
  }
}
```

The script sees a normal JavaScript throw. It does not inspect an `{ ok: false }` result envelope.

## Provider A Calls Provider B

Provider A can express its tool in terms of Provider B by using the same receiver shape for a nested Function Call.

Provider A owns the nested receiver because A is the initiator of the nested call. For v1 this is in-memory promise juggling.

```ts
class ProviderAProcessor {
  readonly #pending = new Map<string, Deferred<FunctionCallDelivery>>();

  async afterAppend(event: StreamEvent) {
    if (
      event.type === "function-call-requested" &&
      matchesPath(event.input.path, ["a", "compose"])
    ) {
      await this.#handleCompose(event);
      return;
    }

    if (event.type === "function-call-completed") {
      this.#maybeResolveNestedCallFromEvent(event);
    }
  }

  async #handleCompose(parentEvent: FunctionCallRequested) {
    const nestedFunctionCallId = createFunctionCallId();
    const nested = createProviderAReceiver({
      functionCallId: nestedFunctionCallId,
      pending: this.#pending,
    });

    await stream.append({
      type: "function-call-requested",
      input: {
        functionCallId: nestedFunctionCallId,
        parentFunctionCallId: parentEvent.input.functionCallId,
        scriptExecutionId: parentEvent.input.scriptExecutionId,
        path: ["b", "primitive"],
        input: { x: parentEvent.input.input.x },
        receiver: nested.capability,
      },
    });

    try {
      const delivery = await nested.wait();
      if (delivery.type === "threw") {
        throw reconstructException(normalizeException(delivery.exception));
      }

      const transformed = {
        composed: true,
        value: delivery.result.value * 2,
      };

      await dispatchCallable({
        callable: parentEvent.input.receiver.return,
        payload: transformed,
        ctx: callableContext,
      });
    } catch (error) {
      await dispatchCallable({
        callable: parentEvent.input.receiver.throw,
        payload: serializeException(error),
        ctx: callableContext,
      });
    }
  }
}
```

Provider B stays simple:

```ts
async function providerBAfterAppend(event: StreamEvent) {
  if (event.type !== "function-call-requested") return;
  if (!matchesPath(event.input.path, ["b", "primitive"])) return;

  await dispatchCallable({
    callable: event.input.receiver.return,
    payload: { value: event.input.input.x + 1 },
    ctx: callableContext,
  });
}
```

Trace:

```ts
function-call-requested fn_1 path=["a","compose"]
function-call-requested fn_2 path=["b","primitive"] parentFunctionCallId=fn_1
function-call-completed fn_2 outcome=returned
function-call-completed fn_1 outcome=returned
```

This is deliberately vanilla. Provider A manually juggles the nested promise. Later, a small provider-side utility can reduce boilerplate without changing the protocol.

## Exception Semantics

The receiver capability has separate `return` and `throw` paths because a bare value cannot distinguish:

```ts
await receiver.return(new Error("returned error object"));
```

from:

```ts
await receiver.throw(new Error("thrown exception"));
```

This mirrors JavaScript and Cloudflare RPC:

- returning an `Error` object is a normal returned value;
- throwing/rejecting is exceptional control flow;
- the Script should observe a normal `throw`.

Provider code should catch local failures and call `receiver.throw`.

```ts
try {
  await receiver.return(await doWork());
} catch (error) {
  await receiver.throw(serializeException(error));
}
```

The receiver's own RPC failure is different. If `dispatchCallable(receiver.return, ...)` throws because the receiver is unavailable, that means result delivery failed. The provider may retry, but it should not reinterpret delivery failure as the tool's domain exception unless it owns that policy.

The codemode processor reconstructs thrown exceptions:

```ts
function reconstructException(serialized: SerializedException): Error {
  const error = new Error(serialized.message, {
    cause: serialized.cause == null ? undefined : reconstructException(serialized.cause),
  });

  error.name = serialized.name || "Error";
  if (serialized.stack != null) error.stack = serialized.stack;

  if (serialized.code != null) {
    Object.defineProperty(error, "code", {
      value: serialized.code,
      enumerable: true,
    });
  }

  if (serialized.details != null) {
    Object.defineProperty(error, "details", {
      value: serialized.details,
      enumerable: true,
    });
  }

  return error;
}
```

From the Script perspective:

```ts
await ctx.slack.chat.sendMessage(...); // returns
await ctx.slack.chat.sendMessage(...); // throws Error
```

No result envelope leaks into user code.

## Durable Workflow Implications

Live codemode and durable workflow codemode should share event names but not pretend to share value semantics.

In live codemode:

- the Function Call Receiver can deliver live functions, streams, stubs, and `RpcTarget`s;
- `function-call-completed` stores a serialized audit summary;
- replay can reconstruct control flow but cannot resurrect ephemeral object identity.

In durable workflow codemode:

- live values cannot cross durable step boundaries;
- Function Calls inside `step.do` should return JSON values or durable handles;
- long waits should use workflow events keyed by `functionCallId`;
- a future workflow runner can wake on `function-call-completed`, then read the stream as canonical audit state.

Sketch:

```ts
const requested = await step.do("append function call requested", async () => {
  return await stream.append({
    type: "function-call-requested",
    input: {
      functionCallId,
      scriptExecutionId,
      path,
      input,
      receiver: workflowReceiverCapability,
    },
  });
});

await step.waitForEvent(`function-call-completed:${functionCallId}`, {
  timeout: "24 hours",
});

const completed = await step.do("read function call completed", async () => {
  return await readCompletedEvent(functionCallId, requested.offset);
});
```

For live values in workflow code, the durable result should be a handle:

```ts
type DurableHandle =
  | {
      kind: "durable-handle";
      type: "sandbox";
      id: string;
    }
  | {
      kind: "durable-handle";
      type: "r2-object";
      bucket: string;
      key: string;
    };
```

Then later steps reacquire live capabilities from the handle:

```ts
const sandbox = await ctx.sandboxes.getByHandle(handle);
await sandbox.exec("pnpm test");
```

The same Function Call Receiver shape can still be used in workflow mode, but the receiver should reject or summarize non-durable live values unless the workflow step consumes them before checkpointing.

## Key Tradeoffs

### Pros

- Provider callsites are minimal: call `receiver.return(value)` or `receiver.throw(exception)`.
- The event stays serializable.
- The codemode processor owns event shape, completion appends, serialization, timeouts, and JS error reconstruction.
- The Runtime dependency is narrow: create receiver capabilities and deliver raw values.
- Live Cloudflare RPC values travel over the live RPC path, not through JSON.
- Separate return/throw capabilities preserve normal JavaScript semantics.
- The capability object is clearer than one overloaded `resultCallable`.

### Cons

- `function-call-requested` now contains two callables, not one.
- `Callable.transformInput` needs `wrap` to support bare live values.
- The event log is an audit trail for live values, not a replay-complete value store.
- Provider A calling Provider B still requires in-memory promise bookkeeping in v1.
- Receiver callables are durable descriptors, not object authority by themselves; dispatch authority comes from the runtime `CallableContext`.

## Open Questions

1. Should the completed event use `outcome.type: "returned" | "threw"` or preserve the existing `status: "succeeded" | "failed"` convention?

   Recommendation: use `returned` / `threw` for codemode Function Calls because it matches JavaScript semantics and avoids the returned-`Error` ambiguity.

2. Should `function-call-completed.input.source` be stored?

   Recommendation: probably yes during the refactor. It makes it obvious whether completion came from receiver delivery or direct event append. It can be dropped later if noisy.

3. Should providers be allowed to append `function-call-completed` directly?

   Recommendation: yes as an internal recovery/event-only path, but no as the recommended provider contract. New providers should call the receiver. The codemode processor can still resolve from externally appended completions because that keeps the event-sourced model usable.

4. Should a live receiver object be passed in memory alongside the serializable event?

   Recommendation: only as a runner optimization. The persisted event must contain the serializable capability object. Provider code should be able to work from the serialized receiver alone.

5. Should `throw` accept raw live `Error` objects or only `SerializedException`?

   Recommendation: accept both. The receiver should normalize before the processor appends `function-call-completed`.

6. Should `wrap` run before or after `shallowMerge`?

   Recommendation: before. That lets bare live values become object fields, then correlation fields are baked in by `shallowMerge`.

7. Should `functionCallId` be the only baked-in field?

   Recommendation: yes for receiver RPC methods. `scriptExecutionId` and `path` are useful in the request event and completion event, but the receiver method only needs `functionCallId` to find the pending delivery. This keeps the Runtime dependency smaller.

8. How should duplicate delivery behave?

   Recommendation: first delivery wins. Later deliveries return `{ accepted: false, reason: "already-delivered" }` and do not append another completion.

9. What is the lifecycle policy for live returned values?

   Recommendation: valid for the current Script Execution unless the returned value is explicitly represented as a durable handle. Later add disposal conventions for stubs/streams that need explicit lifetime management.
