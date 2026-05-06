# Codemode Function Call Receiver Design 02: Single Receiver, Discriminated Post

## Thesis

Use one `functionCallReceiverCallable` on each `function-call-requested` event. Providers complete a call by invoking that callable with a tiny discriminated delivery object:

```ts
type FunctionCallDelivery =
  | { status: "returned"; value: unknown }
  | { status: "threw"; exception: SerializedException };
```

The callable descriptor bakes in `functionCallId`, `scriptExecutionId`, and `path`, so providers do not repeat correlation fields. The Codemode Session Durable Object exposes one small RPC method:

```ts
receiveFunctionCallResult(input: {
  functionCallId: string;
  scriptExecutionId: string;
  path: string[];
  delivery: FunctionCallDelivery;
}): Promise<void>;
```

The **Function Call Receiver** is a Runtime dependency, not a Processor dependency. It does only the part the shared codemode processor cannot do itself: provide a serializable callable that routes back into the running host, and deliver the raw live RPC value back to the processor's in-memory waiter. The shared codemode processor still owns request events, completion events, serialization, wait resolution, timeouts, duplicate policy, and JavaScript error rethrow.

This design is good because it gives providers one callable and one completion verb while preserving normal JS semantics:

```ts
await call(functionCallReceiverCallable, {
  status: "returned",
  value: result,
});

await call(functionCallReceiverCallable, {
  status: "threw",
  exception: serializeException(error),
});
```

It is slightly less ergonomic than separate `returnCallable(result)` / `throwCallable(exception)` callables, but it keeps the event schema smaller and the Codemode Session RPC surface narrower.

## Event Schemas

Use `input` in examples below if the current codemode contract migrates from `payload`; otherwise the same shape can sit under `payload`.

```ts
type ScriptExecutionRequested = {
  type: "script-execution-requested";
  input: {
    scriptExecutionId: string;
    script: string;
  };
};

type ScriptExecutionCompleted = {
  type: "script-execution-completed";
  input: {
    scriptExecutionId: string;
    durationMs?: number;
    outcome:
      | { status: "succeeded"; output: unknown }
      | { status: "failed"; error: SerializedException | unknown };
  };
};

type FunctionCallRequested = {
  type: "function-call-requested";
  input: {
    functionCallId: string;
    scriptExecutionId: string;
    path: string[];
    input: unknown;
    functionCallReceiverCallable: Callable;
    parentFunctionCallId?: string;
  };
};

type FunctionCallCompleted = {
  type: "function-call-completed";
  input: {
    functionCallId: string;
    scriptExecutionId: string;
    path: string[];
    durationMs?: number;
    outcome:
      | {
          status: "succeeded";
          output: unknown;
        }
      | {
          status: "failed";
          error: SerializedException | unknown;
        };
  };
};

type LogEmitted = {
  type: "log-emitted";
  input: {
    scriptExecutionId: string;
    level: "debug" | "info" | "warn" | "error";
    values: unknown[];
  };
};
```

`function-call-completed` is still codemode-owned. Providers should not append it directly in this design. The completed event is an audit record of what the processor received, not necessarily the live transport for the exact value.

## Callable Transform

Current `Callable` has `transformInput.shallowMerge` and `jsonata`. For this design, `shallowMerge` is sufficient if providers post a discriminated object:

```ts
const functionCallReceiverCallable: Callable = {
  type: "workers-rpc",
  via: {
    type: "env-binding",
    bindingType: "durable-object-namespace",
    bindingName: "CODEMODE_SESSION",
    durableObject: { name: codemodeSessionName },
  },
  rpcMethod: "receiveFunctionCallResult",
  argsMode: "object",
  transformInput: {
    shallowMerge: {
      functionCallId,
      scriptExecutionId,
      path,
    },
  },
};
```

Provider call:

```ts
await dispatchCallable({
  callable: event.input.functionCallReceiverCallable,
  payload: {
    delivery: {
      status: "returned",
      value: result,
    },
  },
  ctx,
});
```

Receiver input:

```ts
{
  functionCallId: "fn_123",
  scriptExecutionId: "scr_123",
  path: ["slack", "chat", "sendMessage"],
  delivery: {
    status: "returned",
    value: result,
  },
}
```

Do not use `jsonata` for this path. A provider may return a live Cloudflare RPC value: a callback function, stream, request, response, RPC target, or stub. Expression transforms risk destroying those live values.

### Optional `wrap`

If the provider ergonomics goal is “call with the bare result”, add a minimal `wrap` transform:

```ts
type TransformInput = {
  wrap?: { field: string };
  shallowMerge?: Record<string, unknown>;
  jsonata?: string;
};
```

Defined order:

1. `wrap`: `payload` becomes `{ [field]: payload }`
2. `shallowMerge`: static fields are merged in
3. `jsonata`: last, and not used for live RPC values

For single-callable discriminated post, bare success could look like:

```ts
const functionCallReceiverCallable: Callable = {
  type: "workers-rpc",
  via: receiverVia,
  rpcMethod: "receiveFunctionCallResult",
  argsMode: "object",
  transformInput: {
    wrap: { field: "value" },
    shallowMerge: {
      functionCallId,
      scriptExecutionId,
      path,
      status: "returned",
    },
  },
};
```

Provider success:

```ts
await dispatchCallable({
  callable: event.input.functionCallReceiverCallable,
  payload: result,
  ctx,
});
```

Receiver input:

```ts
{
  functionCallId: "fn_123",
  scriptExecutionId: "scr_123",
  path: ["tools", "makeCallback"],
  status: "returned",
  value: result,
}
```

The downside is exception posting now needs a different transform or an explicit envelope. Because this design uses one callable, I recommend the explicit `{ delivery }` envelope for v1 and reserving `wrap` for a later callable ergonomics improvement.

## Runtime Dependency Interface

The shared codemode processor should receive one Runtime dependency named `functionCallReceiver`.

It should be deliberately small:

```ts
type FunctionCallReceiver = {
  createCallable(input: {
    functionCallId: string;
    scriptExecutionId: string;
    path: string[];
  }): Callable;

  receive(input: {
    functionCallId: string;
    scriptExecutionId: string;
    path: string[];
    delivery: FunctionCallDelivery;
  }): void;
};
```

Responsibilities:

- `createCallable`: backend-specific routing. The shared processor cannot know which Durable Object name, namespace binding, dynamic worker binding, or service binding routes back to this codemode execution.
- `receive`: live value ingress. The shared processor cannot receive arbitrary Cloudflare RPC live values unless the host runtime gives it an entry point.

Non-responsibilities:

- It does not append `function-call-completed`.
- It does not serialize live values for audit.
- It does not decide whether script awaits resolve or reject.
- It does not own timeout semantics.
- It does not interpret provider paths.
- It does not know about tool provider registration.

The processor can wire `receive` into its own pending map:

```ts
type CodemodeProcessorDeps = {
  functionCallReceiver: FunctionCallReceiver;
  serializeForEventLog(value: unknown): unknown;
  deserializeException(exception: SerializedException): Error;
};
```

`serializeForEventLog` can be a Runtime dependency only if it depends on host-specific live value detection. The codemode processor still decides when to call it and where the serialized result goes.

## Codemode Session DO Sketch

The Durable Object should expose only the small RPC method needed by the callable. It should then forward the raw result into the processor-owned receiver.

```ts
export class CodemodeSession extends RpcTarget {
  #processorRuntime?: {
    functionCallReceiver: FunctionCallReceiver;
  };

  createFunctionCallReceiver(): FunctionCallReceiver {
    return {
      createCallable: ({ functionCallId, scriptExecutionId, path }) => ({
        type: "workers-rpc",
        via: {
          type: "env-binding",
          bindingType: "durable-object-namespace",
          bindingName: "CODEMODE_SESSION",
          durableObject: { name: this.initParams.name },
        },
        rpcMethod: "receiveFunctionCallResult",
        argsMode: "object",
        transformInput: {
          shallowMerge: {
            functionCallId,
            scriptExecutionId,
            path,
          },
        },
      }),

      receive: (input) => {
        this.#processorRuntime?.functionCallReceiver.receive(input);
      },
    };
  }

  async receiveFunctionCallResult(input: {
    functionCallId: string;
    scriptExecutionId: string;
    path: string[];
    delivery: FunctionCallDelivery;
  }): Promise<{ accepted: boolean }> {
    this.#processorRuntime?.functionCallReceiver.receive(input);
    return { accepted: true };
  }
}
```

The sketch above exposes a lifecycle question: a Durable Object method may be invoked after the script executor has yielded or after an isolate restart. For v1, this can be live-only:

```ts
if (!this.#processorRuntime) {
  // The call result arrived after the live processor runtime disappeared.
  // We can append a failed completion event or return accepted: false.
  return { accepted: false };
}
```

For a better v1, the DO keeps a tiny in-memory pending delivery queue:

```ts
class CodemodeSession extends RpcTarget {
  #pendingDeliveries = new Map<string, FunctionCallDeliveryInput>();

  async receiveFunctionCallResult(input: FunctionCallDeliveryInput) {
    const delivered = this.#processorRuntime?.functionCallReceiver.receive(input);
    if (!delivered) {
      this.#pendingDeliveries.set(input.functionCallId, input);
    }
    return { accepted: true };
  }

  drainPendingDeliveries(receiver: FunctionCallReceiver) {
    for (const delivery of this.#pendingDeliveries.values()) {
      receiver.receive(delivery);
      this.#pendingDeliveries.delete(delivery.functionCallId);
    }
  }
}
```

That queue is not durable. It only closes a same-isolate ordering gap. Durable recovery should be workflow-shaped later.

## Shared Codemode Processor Sketch

The shared processor owns function call lifecycle.

```ts
function createCodemodeProcessor(deps: CodemodeProcessorDeps) {
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      requestedAt: number;
    }
  >();

  deps.functionCallReceiver.receive = async (input) => {
    const waiter = pending.get(input.functionCallId);

    if (!waiter) {
      // Duplicate, late, or recovered delivery.
      // The processor owns duplicate policy.
      return;
    }

    pending.delete(input.functionCallId);

    if (input.delivery.status === "returned") {
      const outputForEvent = deps.serializeForEventLog(input.delivery.value);

      await streamApi.append({
        type: "function-call-completed",
        input: {
          functionCallId: input.functionCallId,
          scriptExecutionId: input.scriptExecutionId,
          path: input.path,
          durationMs: Date.now() - waiter.requestedAt,
          outcome: {
            status: "succeeded",
            output: outputForEvent,
          },
        },
      });

      waiter.resolve(input.delivery.value);
      return;
    }

    const error = reconstructJavaScriptError(input.delivery.exception);

    await streamApi.append({
      type: "function-call-completed",
      input: {
        functionCallId: input.functionCallId,
        scriptExecutionId: input.scriptExecutionId,
        path: input.path,
        durationMs: Date.now() - waiter.requestedAt,
        outcome: {
          status: "failed",
          error: input.delivery.exception,
        },
      },
    });

    waiter.reject(error);
  };

  async function callFunction(input: {
    scriptExecutionId: string;
    path: string[];
    input: unknown;
    parentFunctionCallId?: string;
  }): Promise<unknown> {
    const functionCallId = allocateFunctionCallId();
    const requestedAt = Date.now();

    const promise = new Promise((resolve, reject) => {
      pending.set(functionCallId, { resolve, reject, requestedAt });
    });

    const functionCallReceiverCallable = deps.functionCallReceiver.createCallable({
      functionCallId,
      scriptExecutionId: input.scriptExecutionId,
      path: input.path,
    });

    await streamApi.append({
      type: "function-call-requested",
      input: {
        functionCallId,
        scriptExecutionId: input.scriptExecutionId,
        path: input.path,
        input: input.input,
        parentFunctionCallId: input.parentFunctionCallId,
        functionCallReceiverCallable,
      },
    });

    return await promise;
  }

  return { callFunction };
}
```

The real implementation should avoid mutating `deps.functionCallReceiver.receive` after construction. A cleaner shape is:

```ts
type FunctionCallReceiver = {
  createCallable(input: FunctionCallReceiverCallableInput): Callable;
  onDelivery(handler: (input: FunctionCallDeliveryInput) => Promise<void>): void;
};
```

But that risks turning the Runtime dependency into a mini event emitter. The minimum useful shape is probably:

```ts
type FunctionCallReceiver = {
  createCallable(input: FunctionCallReceiverCallableInput): Callable;
  takeNextDelivery(functionCallId: string): Promise<FunctionCallDeliveryInput>;
};
```

Then the processor does:

```ts
const delivery = await deps.functionCallReceiver.takeNextDelivery(functionCallId);
```

This keeps the processor in control and makes the dependency only a receiver plus waiter.

## Tool Provider Callsites

Provider success:

```ts
async function afterAppend(event: StreamEvent, ctx: CallableContext) {
  if (event.type !== "function-call-requested") return;
  if (event.input.path.join(".") !== "slack.chat.sendMessage") return;

  const message = await slack.chat.postMessage(event.input.input);

  await dispatchCallable({
    callable: event.input.functionCallReceiverCallable,
    payload: {
      delivery: {
        status: "returned",
        value: {
          channel: message.channel,
          ts: message.ts,
        },
      },
    },
    ctx,
  });
}
```

Provider returns a live callback:

```ts
await dispatchCallable({
  callable: event.input.functionCallReceiverCallable,
  payload: {
    delivery: {
      status: "returned",
      value: async (input: { text: string }) => {
        return await sendFollowup(input.text);
      },
    },
  },
  ctx,
});
```

Codemode script:

```ts
const followup = await ctx.tools.makeFollowupSender({
  channel: "C123",
});

await followup({ text: "called from codemode" });
```

Provider failure:

```ts
try {
  const output = await toolImplementation(event.input.input);

  await dispatchCallable({
    callable: event.input.functionCallReceiverCallable,
    payload: {
      delivery: { status: "returned", value: output },
    },
    ctx,
  });
} catch (error) {
  await dispatchCallable({
    callable: event.input.functionCallReceiverCallable,
    payload: {
      delivery: {
        status: "threw",
        exception: serializeException(error),
      },
    },
    ctx,
  });
}
```

This is a little more verbose than two callables, but provider authors only learn one completion path.

## Provider A Calls Provider B

Provider A can still be a stream processor. It receives A's requested call, creates its own in-memory waiter, appends a nested B request with a receiver callable that routes back to A, waits, then completes A by invoking A's receiver callable.

```ts
class ProviderAProcessor {
  #pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();

  async afterAppend(event: StreamEvent, ctx: CallableContext) {
    if (event.type !== "function-call-requested") return;

    if (event.input.path.join(".") === "a.compose") {
      const bFunctionCallId = `fn_${crypto.randomUUID()}`;

      const bResultPromise = new Promise((resolve, reject) => {
        this.#pending.set(bFunctionCallId, { resolve, reject });
      });

      await stream.append({
        type: "function-call-requested",
        input: {
          functionCallId: bFunctionCallId,
          scriptExecutionId: event.input.scriptExecutionId,
          parentFunctionCallId: event.input.functionCallId,
          path: ["b", "primitive"],
          input: { x: event.input.input.x },
          functionCallReceiverCallable: {
            type: "workers-rpc",
            via: providerAVia,
            rpcMethod: "receiveNestedFunctionCallResult",
            argsMode: "object",
            transformInput: {
              shallowMerge: {
                functionCallId: bFunctionCallId,
                scriptExecutionId: event.input.scriptExecutionId,
                path: ["b", "primitive"],
              },
            },
          },
        },
      });

      const bResult = await bResultPromise;

      await dispatchCallable({
        callable: event.input.functionCallReceiverCallable,
        payload: {
          delivery: {
            status: "returned",
            value: { composed: bResult },
          },
        },
        ctx,
      });
    }
  }

  async receiveNestedFunctionCallResult(input: FunctionCallDeliveryInput) {
    const pending = this.#pending.get(input.functionCallId);
    if (!pending) return { accepted: false };
    this.#pending.delete(input.functionCallId);

    if (input.delivery.status === "returned") {
      pending.resolve(input.delivery.value);
    } else {
      pending.reject(reconstructJavaScriptError(input.delivery.exception));
    }

    return { accepted: true };
  }
}
```

This confirms the model still supports processor A calling provider B without making tool providers special callables. Provider A juggles promises in memory for now, exactly as expected.

## Exception Semantics

Provider exceptions should become normal JavaScript throws in codemode scripts.

Serialized shape:

```ts
type SerializedException = {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedException | unknown;
  code?: string;
  details?: unknown;
};
```

Serialize:

```ts
function serializeException(error: unknown): SerializedException {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
      code: "code" in error ? String(error.code) : undefined,
    };
  }

  return {
    name: "Error",
    message: typeof error === "string" ? error : "Non-Error exception",
    details: error,
  };
}
```

Reconstruct:

```ts
function reconstructJavaScriptError(exception: SerializedException): Error {
  const error = new Error(exception.message);
  error.name = exception.name || "Error";
  error.stack = exception.stack;

  if (exception.cause !== undefined) {
    Object.defineProperty(error, "cause", {
      value: exception.cause,
      enumerable: false,
      configurable: true,
    });
  }

  if (exception.code !== undefined) {
    Object.defineProperty(error, "code", {
      value: exception.code,
      enumerable: true,
      configurable: true,
    });
  }

  return error;
}
```

Codemode script:

```ts
try {
  await ctx.slack.chat.sendMessage({ channel: "C123", text: "hello" });
} catch (error) {
  console.log(error instanceof Error); // true
  console.log(error.name);
  console.log(error.message);
}
```

This follows the Cloudflare RPC philosophy better than returning `{ ok: false }` values from tool calls. Remote failure behaves like JavaScript failure.

One caveat: a tool may intentionally return an `Error` object as a successful value. The discriminant solves this:

```ts
{ status: "returned", value: new Error("this is data") }
{ status: "threw", exception: { name: "Error", message: "this is failure" } }
```

## Durable Workflow Implications

This design intentionally separates live codemode from durable workflows.

Live codemode:

- `functionCallReceiverCallable` can carry live Cloudflare RPC values back to the running script.
- The event log records a serialized audit result.
- A returned callback, stream, stub, or RPC target is valid only within the live execution context unless it is represented by a durable handle.

Durable codemode workflow:

- Workflow steps should not persist live RPC values across step boundaries.
- Workflow-owned function calls should require JSON-serializable results or durable handles.
- A workflow step can still use the same event names:

```ts
const call = await step.do("request function call", async () => {
  return await appendFunctionCallRequested({
    path: ["sandbox", "exec"],
    input: { command: "pnpm test" },
  });
});

const completion = await step.waitForEvent("function-call-completed", {
  timeout: "24 hours",
});
```

But the durable form should expect:

```ts
type DurableFunctionCallResult =
  | { kind: "serialized"; value: JsonValue }
  | { kind: "durable-handle"; handleType: string; id: string };
```

Live RPC values can be consumed inside a single step, then converted into durable output:

```ts
const result = await step.do("read stream", async () => {
  const stream = await ctx.files.readStream("build.log");
  const text = await new Response(stream).text();
  return { kind: "serialized", value: text };
});
```

So this design does not pretend arbitrary JavaScript async execution is durable. It lays a clear future path:

- live codemode: RPC capabilities allowed
- durable codemode workflows: JSON values and durable handles only

## Compared With Two Callables

Two-callable design:

```ts
returnCallable(result);
throwCallable(serializedException);
```

Advantages:

- Best provider ergonomics for success.
- Failure is out-of-band from returned values.
- Receiver methods can be narrower.

Disadvantages:

- More event surface on `function-call-requested`.
- Providers must choose between two callable fields.
- Correlation metadata is duplicated in two descriptors.
- More capability descriptors to audit in the event log.

Single-callable discriminated design:

```ts
functionCallReceiverCallable({
  delivery: { status: "returned", value },
});

functionCallReceiverCallable({
  delivery: { status: "threw", exception },
});
```

Advantages:

- One event field.
- One receiver RPC method.
- One routing capability per function call.
- Easy duplicate policy: one function call, one receiver endpoint.
- Explicit success/failure semantics without needing two capabilities.

Disadvantages:

- Success callsite is not as minimal as `returnCallable(result)`.
- The provider must construct `{ delivery }`.
- A future `wrap` transform does not solve both success and failure ergonomically with one callable unless we add richer transform modes.

Recommendation for this design: choose the single callable if the priority is minimal codemode event surface and one receiver method. Choose two callables if the priority is making provider success and failure callsites maximally JavaScript-like.

## Tradeoffs

Good:

- Keeps the Function Call Receiver as a tiny Runtime dependency.
- Codemode processor owns completion event schema and serialization.
- Providers never append `function-call-completed` directly.
- Works with live Cloudflare RPC values because delivery is RPC, not event serialization.
- Exceptions become normal JS throws in scripts.
- One callable field is easy to inspect in the event log.

Costs:

- Provider callsites need a discriminated envelope.
- The event log is an audit trail, not the canonical live result transport.
- In-memory waiting means live results are not durable across isolate loss.
- The Codemode Session DO must route receiver RPC calls into the active processor runtime.
- Late results need a clear accepted/rejected/timeout policy.

## Open Questions

1. Should `functionCallReceiverCallable` be the canonical field name, or is `completeCallable` clearer?

   Recommendation: `functionCallReceiverCallable`. It names the capability by the domain term and avoids implying providers complete events directly.

2. Should the callable payload be `{ delivery }` or the delivery object itself?

   Recommendation: `{ delivery }`. It leaves room for provider-side metadata without colliding with baked-in fields.

3. Should `transformInput.wrap` be added now?

   Recommendation: not required for this design. Add it only if we choose two callables or decide provider success must be bare-result ergonomic.

4. Should `function-call-completed` store live-value summaries under `output`, or should it have a separate `liveResult` field?

   Recommendation: store the serialized audit representation directly under `output`. For example:

   ```ts
   {
     kind: "rpc-live-value",
     type: "function",
     description: "Callback returned by tools.makeFollowupSender"
   }
   ```

5. Should late receiver deliveries append failed completion events?

   Recommendation: the processor owns timeout failure. A late delivery after timeout should not append a second completion event. The receiver should return `{ accepted: false, reason: "already-completed" }`.

6. Should provider A calling provider B reuse the codemode Function Call Receiver type?

   Recommendation: yes as a protocol shape, but Provider A can implement its own receiver callable. It does not need to reuse Codemode Session DO.

7. Should workflow-backed codemode use the same callable receiver?

   Recommendation: no for durable waits. Workflow-backed codemode should use JSON events and durable handles. It can use live receiver callables only inside a single workflow step.
