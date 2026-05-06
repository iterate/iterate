# Codemode Function Call Receiver Design: Two Callables For Return And Throw

## Thesis

Use two callable fields on `function-call-requested`: `returnCallable` and `throwCallable`.

Providers complete successful calls by invoking `returnCallable(result)` with the bare result. Providers complete failed calls by invoking `throwCallable(serializedException)` with a serialized exception. The callable descriptor wraps that bare value into the receiver input shape and bakes in correlation fields such as `functionCallId`.

This keeps provider callsites small, preserves Cloudflare RPC live values, and lets the shared codemode processor keep owning the durable event shape:

- Providers do not append `function-call-completed`.
- Providers do not know how codemode serializes returned live values.
- Providers do not repeat `functionCallId`, `scriptExecutionId`, or `path`.
- The Runtime dependency only receives raw live values and exceptions from the host runtime.
- The codemode processor owns promise resolution, event append, timeout policy, duplicate policy, result serialization, and JavaScript error reconstruction.

This design deliberately treats `function-call-completed` as the serialized audit record, not the live transport for Cloudflare RPC values.

## Terms

**Runtime dependency**

A backend-only service passed to a processor by the runner. It is not another processor contract and is not a stream dependency.

**Function Call Receiver**

The minimal Runtime dependency that lets the codemode processor create callable descriptors for a function call, and receive raw returned values or thrown exceptions from those callables.

The receiver should not own event schemas. It should not append completion events. It should not decide how to serialize live values. It exists because shared processor code cannot directly manufacture a Cloudflare RPC callable back into the currently running Codemode Session / runner instance.

## Event Schemas

### `script-execution-requested`

```ts
type ScriptExecutionRequested = {
  type: "script-execution-requested";
  payload: {
    scriptExecutionId: string;
    script: string;
  };
};
```

### `script-execution-completed`

```ts
type ScriptExecutionCompleted = {
  type: "script-execution-completed";
  payload: {
    scriptExecutionId: string;
    durationMs?: number;
    outcome:
      | {
          status: "succeeded";
          output: unknown;
        }
      | {
          status: "failed";
          error: SerializedException;
        };
  };
};
```

### `function-call-requested`

```ts
type FunctionCallRequested = {
  type: "function-call-requested";
  payload: {
    functionCallId: string;
    scriptExecutionId?: string;
    parentFunctionCallId?: string;
    path: string[];
    input: unknown;

    returnCallable: Callable;
    throwCallable: Callable;
  };
};
```

`returnCallable` and `throwCallable` are both serializable callable descriptors. They route back to the Codemode Session / runner, but they are not bearer tokens. Authority comes from the Worker binding context used to dispatch them.

### `function-call-completed`

```ts
type FunctionCallCompleted = {
  type: "function-call-completed";
  payload: {
    functionCallId: string;
    scriptExecutionId?: string;
    parentFunctionCallId?: string;
    path: string[];
    durationMs?: number;
    outcome:
      | {
          status: "succeeded";
          output: SerializedFunctionCallOutput;
        }
      | {
          status: "failed";
          error: SerializedException;
        };
  };
};
```

The completed event contains a serialized audit value. For JSON-safe values this can be the value itself. For live Cloudflare RPC values it should be a summary:

```ts
type SerializedFunctionCallOutput =
  | unknown
  | {
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
```

### `log-emitted`

```ts
type LogEmitted = {
  type: "log-emitted";
  payload: {
    scriptExecutionId?: string;
    level: "debug" | "info" | "warn" | "error" | "log";
    args: unknown[];
  };
};
```

### `tool-provider-registered`

Tool providers remain mostly documentation. A provider can also be a stream processor that reacts to paths it owns.

```ts
type ToolProviderRegistered = {
  type: "tool-provider-registered";
  payload: {
    path: string[];
    instructions?: string;
    types?: string;
  };
};
```

## Callable Transform Addition

Current callable transforms support `shallowMerge` and JSONata. That is not enough for live RPC values because JSONata should not wrap a function, stream, stub, `Request`, or `Response`.

Add a sibling transform:

```ts
type CallableTransformInput = {
  wrap?: {
    field: string;
  };
  shallowMerge?: Record<string, unknown>;
  jsonata?: string;
};
```

Ordering should be fixed:

1. `wrap`
2. `shallowMerge`
3. `jsonata`

Runtime behavior:

```ts
function transformInput(payload: unknown, transform?: CallableTransformInput) {
  let input = payload;

  if (transform?.wrap) {
    input = {
      [transform.wrap.field]: input,
    };
  }

  if (transform?.shallowMerge) {
    if (!isRecord(input)) {
      throw new Error("Callable shallowMerge requires object input after wrap");
    }

    input = {
      ...transform.shallowMerge,
      ...input,
    };
  }

  if (transform?.jsonata) {
    input = evaluateJsonata(transform.jsonata, input);
  }

  return input;
}
```

For codemode returns:

```ts
const returnCallable: Callable = {
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
    wrap: { field: "result" },
    shallowMerge: {
      functionCallId,
      scriptExecutionId,
      path,
    },
  },
};
```

Provider code can then send the bare result:

```ts
await dispatchCallable({
  callable: event.payload.returnCallable,
  payload: result,
  ctx,
});
```

The receiver sees:

```ts
{
  functionCallId: "fn_123",
  scriptExecutionId: "scr_456",
  path: ["slack", "chat", "sendMessage"],
  result
}
```

For exceptions:

```ts
const throwCallable: Callable = {
  type: "workers-rpc",
  via: {
    type: "env-binding",
    bindingType: "durable-object-namespace",
    bindingName: "CODEMODE_SESSION",
    durableObject: { name: codemodeSessionName },
  },
  rpcMethod: "receiveFunctionCallException",
  argsMode: "object",
  transformInput: {
    wrap: { field: "exception" },
    shallowMerge: {
      functionCallId,
      scriptExecutionId,
      path,
    },
  },
};
```

Provider code can throw remotely with a serialized exception:

```ts
await dispatchCallable({
  callable: event.payload.throwCallable,
  payload: serializeException(error),
  ctx,
});
```

## Runtime Dependency Interface

The dependency should be as small as possible. It should only cover what the shared codemode processor cannot do by itself: create serializable RPC callables that route to the live receiver, and wait for raw live values that arrived through those callables.

```ts
export type FunctionCallReceiver = {
  createReturnCallable(input: {
    functionCallId: string;
    scriptExecutionId?: string;
    parentFunctionCallId?: string;
    path: string[];
  }): Callable;

  createThrowCallable(input: {
    functionCallId: string;
    scriptExecutionId?: string;
    parentFunctionCallId?: string;
    path: string[];
  }): Callable;

  waitForFunctionCallResult(input: {
    functionCallId: string;
    requestedOffset: number;
    signal: AbortSignal;
  }): Promise<
    | {
        status: "returned";
        result: unknown;
      }
    | {
        status: "thrown";
        exception: SerializedException;
      }
  >;
};
```

The receiver deliberately does not expose:

- `appendFunctionCallCompleted`
- `serializeResult`
- `completeFunctionCall`
- `resolveScript`

Those are codemode processor responsibilities.

One possible internal runner API, not visible to providers:

```ts
export type FunctionCallReceiverIngress = {
  receiveFunctionCallResult(input: { functionCallId: string; result: unknown }): Promise<void>;

  receiveFunctionCallException(input: {
    functionCallId: string;
    exception: SerializedException;
  }): Promise<void>;
};
```

## Codemode Session Durable Object Sketch

The Codemode Session DO owns the RPC methods because it has the Cloudflare runtime identity needed to receive Workers RPC calls. It should pass results into a small in-memory receiver queue. It should not append `function-call-completed` itself unless the processor is also running inside this object and calls a processor-owned method.

```ts
import { RpcTarget } from "cloudflare:workers";

export class CodemodeSession extends RpcTarget {
  #functionCallReceiver = new InMemoryFunctionCallReceiver({
    createCallableTarget: (input) => ({
      type: "workers-rpc",
      via: {
        type: "env-binding",
        bindingType: "durable-object-namespace",
        bindingName: "CODEMODE_SESSION",
        durableObject: { name: this.name },
      },
      rpcMethod: input.rpcMethod,
      argsMode: "object",
      transformInput: input.transformInput,
    }),
  });

  getRuntimeDeps(): CodemodeProcessorRuntimeDeps {
    return {
      functionCallReceiver: this.#functionCallReceiver,
    };
  }

  async receiveFunctionCallResult(input: {
    functionCallId: string;
    result: unknown;
  }): Promise<void> {
    await this.#functionCallReceiver.receiveReturned({
      functionCallId: input.functionCallId,
      result: input.result,
    });
  }

  async receiveFunctionCallException(input: {
    functionCallId: string;
    exception: SerializedException;
  }): Promise<void> {
    await this.#functionCallReceiver.receiveThrown({
      functionCallId: input.functionCallId,
      exception: input.exception,
    });
  }
}
```

The in-memory receiver is intentionally boring:

```ts
class InMemoryFunctionCallReceiver implements FunctionCallReceiver {
  #pending = new Map<
    string,
    {
      resolve(value: FunctionCallReceiverResult): void;
      reject(error: unknown): void;
      promise: Promise<FunctionCallReceiverResult>;
    }
  >();

  createReturnCallable(input: FunctionCallIdentity): Callable {
    this.#ensurePending(input.functionCallId);

    return this.#createCallableTarget({
      rpcMethod: "receiveFunctionCallResult",
      transformInput: {
        wrap: { field: "result" },
        shallowMerge: input,
      },
    });
  }

  createThrowCallable(input: FunctionCallIdentity): Callable {
    this.#ensurePending(input.functionCallId);

    return this.#createCallableTarget({
      rpcMethod: "receiveFunctionCallException",
      transformInput: {
        wrap: { field: "exception" },
        shallowMerge: input,
      },
    });
  }

  async waitForFunctionCallResult(input: {
    functionCallId: string;
    requestedOffset: number;
    signal: AbortSignal;
  }): Promise<FunctionCallReceiverResult> {
    const pending = this.#ensurePending(input.functionCallId);
    return await withAbortSignal(pending.promise, input.signal);
  }

  async receiveReturned(input: { functionCallId: string; result: unknown }): Promise<void> {
    const pending = this.#ensurePending(input.functionCallId);
    pending.resolve({ status: "returned", result: input.result });
  }

  async receiveThrown(input: {
    functionCallId: string;
    exception: SerializedException;
  }): Promise<void> {
    const pending = this.#ensurePending(input.functionCallId);
    pending.resolve({ status: "thrown", exception: input.exception });
  }
}
```

Open question: the receiver probably needs first-result-wins duplicate handling. That can still be inside `InMemoryFunctionCallReceiver`, while event append policy stays inside the codemode processor.

## Shared Codemode Processor Sketch

The processor creates both callables before appending the request, then waits through the receiver. When a result arrives, the processor appends the canonical completion event.

```ts
async function callFunction(input: {
  scriptExecutionId?: string;
  parentFunctionCallId?: string;
  path: string[];
  input: unknown;
}): Promise<unknown> {
  const functionCallId = createFunctionCallId();

  const returnCallable = runtimeDeps.functionCallReceiver.createReturnCallable({
    functionCallId,
    scriptExecutionId: input.scriptExecutionId,
    parentFunctionCallId: input.parentFunctionCallId,
    path: input.path,
  });

  const throwCallable = runtimeDeps.functionCallReceiver.createThrowCallable({
    functionCallId,
    scriptExecutionId: input.scriptExecutionId,
    parentFunctionCallId: input.parentFunctionCallId,
    path: input.path,
  });

  const requested = await stream.append({
    type: "function-call-requested",
    payload: {
      functionCallId,
      scriptExecutionId: input.scriptExecutionId,
      parentFunctionCallId: input.parentFunctionCallId,
      path: input.path,
      input: input.input,
      returnCallable,
      throwCallable,
    },
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort(new Error("Function call timed out"));
  }, 60_000);

  try {
    const received = await runtimeDeps.functionCallReceiver.waitForFunctionCallResult({
      functionCallId,
      requestedOffset: requested.offset,
      signal: abortController.signal,
    });

    if (received.status === "returned") {
      await stream.append({
        type: "function-call-completed",
        payload: {
          functionCallId,
          scriptExecutionId: input.scriptExecutionId,
          parentFunctionCallId: input.parentFunctionCallId,
          path: input.path,
          outcome: {
            status: "succeeded",
            output: serializeFunctionCallOutput(received.result),
          },
        },
      });

      return received.result;
    }

    await stream.append({
      type: "function-call-completed",
      payload: {
        functionCallId,
        scriptExecutionId: input.scriptExecutionId,
        parentFunctionCallId: input.parentFunctionCallId,
        path: input.path,
        outcome: {
          status: "failed",
          error: received.exception,
        },
      },
    });

    throw reconstructJavaScriptError(received.exception);
  } catch (error) {
    if (abortController.signal.aborted) {
      const exception = serializeException(error);

      await stream.append({
        type: "function-call-completed",
        payload: {
          functionCallId,
          scriptExecutionId: input.scriptExecutionId,
          parentFunctionCallId: input.parentFunctionCallId,
          path: input.path,
          outcome: {
            status: "failed",
            error: exception,
          },
        },
      });

      throw reconstructJavaScriptError(exception);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
```

The current messy fallback, where the processor sometimes resolves from a pre-appended completion event and sometimes from an injected waiter, should be deliberately tightened:

- Provider contract: call `returnCallable` or `throwCallable`.
- Recovery/debug contract: the event log contains completions.
- If a runner wants event-log-only recovery later, implement it inside `FunctionCallReceiver.waitForFunctionCallResult`, not as a public alternate provider protocol.

## Tool Provider Callsites

### Success

Provider does not know completion event schema:

```ts
async function afterAppend(event: StreamEvent, ctx: CallableDispatchContext) {
  if (event.type !== "function-call-requested") return;
  if (!matchesPath(event.payload.path, ["slack", "chat", "sendMessage"])) return;

  const result = await slack.chat.sendMessage(event.payload.input);

  await dispatchCallable({
    callable: event.payload.returnCallable,
    payload: result,
    ctx,
  });
}
```

### Failure

Provider serializes the exception and calls `throwCallable`:

```ts
async function afterAppend(event: StreamEvent, ctx: CallableDispatchContext) {
  if (event.type !== "function-call-requested") return;
  if (!matchesPath(event.payload.path, ["slack", "chat", "sendMessage"])) return;

  try {
    const result = await slack.chat.sendMessage(event.payload.input);

    await dispatchCallable({
      callable: event.payload.returnCallable,
      payload: result,
      ctx,
    });
  } catch (error) {
    await dispatchCallable({
      callable: event.payload.throwCallable,
      payload: serializeException(error),
      ctx,
    });
  }
}
```

### Returning A Live Callback

The provider can return an actual function. Cloudflare Workers RPC can preserve this as a live callable/stub across the RPC boundary.

```ts
await dispatchCallable({
  callable: event.payload.returnCallable,
  payload: async (input: { message: string }) => {
    return {
      received: input.message,
      handledBy: "provider",
    };
  },
  ctx,
});
```

Codemode script:

```ts
const callback = await ctx.provider.makeCallback();
const output = await callback({ message: "hello from codemode" });
```

Completion event:

```ts
{
  type: "function-call-completed",
  payload: {
    functionCallId: "fn_1",
    path: ["provider", "makeCallback"],
    outcome: {
      status: "succeeded",
      output: {
        kind: "rpc-live-value",
        type: "function",
        description: "Function returned by provider.makeCallback"
      }
    }
  }
}
```

The event log remains inspectable without pretending to persist the live function.

## Provider A Calls Provider B

Provider A can implement one tool in terms of Provider B by participating in the same request/callable protocol. In v1 it juggles promises in memory.

Provider A receives:

```ts
{
  type: "function-call-requested",
  payload: {
    functionCallId: "fn_a",
    path: ["a", "compose"],
    input: { value: 2 },
    returnCallable: aReturnCallable,
    throwCallable: aThrowCallable
  }
}
```

Provider A appends a nested request for B. It creates its own local return/throw callables that resolve an in-memory promise owned by A:

```ts
const bFunctionCallId = createFunctionCallId();

const bResult = deferred<unknown>();

await stream.append({
  type: "function-call-requested",
  payload: {
    functionCallId: bFunctionCallId,
    parentFunctionCallId: event.payload.functionCallId,
    path: ["b", "primitive"],
    input: { value: event.payload.input.value },
    returnCallable: providerAReceiver.returnCallable({
      functionCallId: bFunctionCallId,
      wrapField: "result",
      onReceive: (input) => bResult.resolve(input.result),
    }),
    throwCallable: providerAReceiver.throwCallable({
      functionCallId: bFunctionCallId,
      wrapField: "exception",
      onReceive: (input) => bResult.reject(reconstructJavaScriptError(input.exception)),
    }),
  },
});

try {
  const primitive = await bResult.promise;

  await dispatchCallable({
    callable: event.payload.returnCallable,
    payload: { composed: primitive },
    ctx,
  });
} catch (error) {
  await dispatchCallable({
    callable: event.payload.throwCallable,
    payload: serializeException(error),
    ctx,
  });
}
```

Events show the causal chain:

```ts
function-call-requested fn_a path=["a", "compose"]
function-call-requested fn_b parentFunctionCallId="fn_a" path=["b", "primitive"]
function-call-completed fn_b
function-call-completed fn_a
```

This is intentionally vanilla. A later helper can hide the promise map, but the protocol does not need a helper.

## Exception Semantics

The two-callable design avoids ambiguity between:

```ts
return new Error("domain value");
```

and:

```ts
throw new Error("failure");
```

With one callable, `resultCallable(new Error("boom"))` cannot cleanly tell whether the function returned an `Error` object or failed. With two callables:

- `returnCallable(errorObject)` means the function returned an Error-like value.
- `throwCallable(serializedException)` means the function threw.

Serialized exception shape:

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

Provider failure:

```ts
await dispatchCallable({
  callable: event.payload.throwCallable,
  payload: serializeException(error),
  ctx,
});
```

Codemode processor receives:

```ts
{
  functionCallId: "fn_1",
  exception: {
    name: "SlackRateLimitError",
    message: "rate limited",
    code: "rate_limited"
  }
}
```

Codemode script observes normal JavaScript throw behavior:

```ts
try {
  await ctx.slack.chat.sendMessage({ channel, text });
} catch (error) {
  console.log(error instanceof Error); // true
  console.log(error.name); // "SlackRateLimitError"
  console.log(error.message); // "rate limited"
}
```

Reconstruction:

```ts
function reconstructJavaScriptError(exception: SerializedException): Error {
  const error = new Error(exception.message);
  error.name = exception.name;

  if (exception.stack) {
    error.stack = exception.stack;
  }

  if (exception.cause) {
    Object.assign(error, {
      cause: isSerializedException(exception.cause)
        ? reconstructJavaScriptError(exception.cause)
        : exception.cause,
    });
  }

  if (exception.code) {
    Object.assign(error, { code: exception.code });
  }

  if (exception.details !== undefined) {
    Object.assign(error, { details: exception.details });
  }

  return error;
}
```

This follows the Cloudflare RPC philosophy better than making all failures into tagged result objects at the script boundary. From script code, a remote failure behaves like a thrown JavaScript error.

## Durable Workflow Implications

This design is honest about live codemode versus durable workflow codemode.

Live codemode:

```ts
const sandbox = await ctx.sandboxes.get("main"); // can be a live RPC stub
await sandbox.exec("pnpm test");
```

The live result travels through `returnCallable`. The event log stores a summary.

Durable workflow codemode should not try to persist arbitrary live RPC values across Workflow steps. A future workflow API should force step boundaries to return JSON-safe values or durable handles:

```ts
const handle = await ctx.workflow.step("get sandbox handle", async () => {
  return await ctx.sandboxes.getHandle("main");
});

await ctx.workflow.step("run tests", async () => {
  const sandbox = await ctx.sandboxes.open(handle);
  return await sandbox.exec("pnpm test");
});
```

Workflow waiting can still use the same event concepts:

```ts
await step.do("append function-call-requested", async () => {
  return await stream.append(requestedEvent);
});

await step.waitForEvent(`function-call-completed:${functionCallId}`);
```

But workflow payloads should only contain serialized values or durable handles, not live stubs. The `function-call-completed` event already gives the durable audit representation needed for future workflow inspection.

## Key Tradeoffs

### Advantages

- Provider success callsite is as small as possible: `returnCallable(result)`.
- Provider failure callsite preserves JavaScript throw semantics: `throwCallable(serializedException)`.
- No ambiguity between returning an Error object and throwing an Error.
- Live Cloudflare RPC values do not pass through JSONata or event serialization.
- The codemode processor owns completion events and trace shape.
- The Runtime dependency is narrow: live ingress only.
- The event log remains useful for auditing without claiming to be full live replay.

### Costs

- The request event has two callables instead of one.
- Callable transform gains a new primitive and a defined transform order.
- Providers must understand success versus failure callables.
- Durable replay cannot resurrect live RPC values from the event log.
- Nested provider calls still require promise bookkeeping in v1.

### Why Not One Callable With `{ outcome }`?

One callable with `{ outcome }` is simpler in the event schema, but worse at the provider boundary:

```ts
await resultCallable({
  outcome: { status: "succeeded", output: result },
});
```

It also makes bare-result wrapping less useful and makes failures feel like tagged data rather than JavaScript throws.

Two callables are more explicit and better preserve JS semantics.

## Open Questions

1. Should the receiver expose two RPC methods:

   ```ts
   receiveFunctionCallResult({ functionCallId, result });
   receiveFunctionCallException({ functionCallId, exception });
   ```

   or one discriminated method:

   ```ts
   receiveFunctionCallOutcome(
     | { functionCallId, kind: "returned", result }
     | { functionCallId, kind: "thrown", exception }
   )
   ```

   Recommendation: use two methods. It mirrors the two callables and keeps each callable transform trivial.

2. Should `throwCallable` accept only `SerializedException`, or should it accept any thrown value and let codemode serialize it?

   Recommendation: accept `SerializedException`. Providers crossing process boundaries should make failure shape explicit. Codemode can still defensively normalize malformed exception payloads.

3. Should completed events include `liveValueId` for later disposal?

   Recommendation: not in v1. Start with summaries. Add lifecycle tracking when we introduce explicit `using` / disposal conventions.

4. Should the processor still resolve from an already-appended `function-call-completed` event?

   Recommendation: not as a provider protocol. If needed for recovery, hide it inside `FunctionCallReceiver.waitForFunctionCallResult` or a future workflow runner, so the public rule remains: providers call `returnCallable` or `throwCallable`.

5. Where should duplicate handling live?

   Recommendation: the receiver records first delivery by `functionCallId`, but the processor decides whether a duplicate should append a diagnostic event, return the prior accepted state, or be ignored.

6. Should `path` and `scriptExecutionId` be baked into callable transforms?

   Recommendation: yes for audit/debug input validation, but `functionCallId` is the only required correlation field for delivery.
