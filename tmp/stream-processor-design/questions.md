# Open Questions

## 1. How far should the shared host helper go?

We currently have good low-level primitives:

- `runProcessorOnStart`
- `runProcessorReduce`
- `runProcessorAfterAppend`

The host sequence is easy to write explicitly. A larger helper risks hiding the
persistence boundary:

```ts
const reduction = runProcessorReduce(...);
await saveState(reduction.state);
await runProcessorAfterAppend(...);
```

Recommendation: keep this explicit until we implement one real DO host and one
real pull host.

## 2. Should `withStreamProcessor` support one stream or many streams?

One stream per DO is simple:

```ts
stream - processor - state;
```

Many streams per DO needs path-keyed storage:

```ts
stream-processor-state:/agents/a
stream-processor-state:/agents/b
```

Recommendation: implement one-stream first. Add a separate many-stream host
later instead of adding a boolean option.

## 3. Does `runProcessorOnStart` run once per DO or once per stream?

For one stream per DO, same thing.

For many streams per DO, it must run once per processor instance per stream
path, because runtime state is reconciled from that stream's reduced state.

Recommendation: define "processor instance" as `(processor contract, stream
path, host)`.

## 4. How should processor registration docs be generated?

The contract has Zod schemas. We likely want:

```ts
z.toJSONSchema(event.payloadSchema);
```

But some schemas use `z.unknown`, `z.custom`, or callables. These may not
produce useful JSON Schema.

Recommendation: generate best-effort JSON Schema, but include plain text
descriptions and event type strings as the reliable baseline.

## 5. Should Codemode consume `agent-input-added` or only a narrower event?

Currently Codemode reads assistant `agent-input-added` rows and extracts code.
That works, but it couples Codemode to AgentLoop's general context event.

Alternative:

- AgentLoop emits `assistant-response-added`
- Codemode consumes only that
- AgentLoop can still reduce it into history if desired

Recommendation: discuss this. A narrower event may make Codemode cleaner.

## 6. Should LLM request execution be inside AgentLoop or another processor?

AgentLoop currently both schedules and runs LLM calls.

Alternative:

- AgentLoop emits `llm-request-scheduled`
- `LlmRequestProcessor` consumes it and emits `started/completed/failed`

That would separate scheduling policy from model execution, but adds another
processor.

Recommendation: probably split later, not in the first cut.

## 7. Where does access policy live for StreamApi?

`StreamApi` props can grow:

```ts
{
  streamPath?: string;
  allowAppend?: boolean;
  allowRead?: boolean;
  allowSubscribe?: boolean;
  allowedPrefixes?: string[];
}
```

Recommendation: do not add this now. Keep props shape ready for it.

## 8. Does built-in processor state use the same contract shape?

Yes, ideally. Built-ins differ only by having `beforeAppend`.

Recommendation: `implementBuiltinProcessor(contract, { beforeAppend, afterAppend })`
should be the only difference.
