# Step 12 — codemode (the flourish): run a program against the context

**Adds:** the last shape of capability — a whole **program**. The code is an
`async (itx) => …` function; itx **loads it as a worker** (the Worker Loader, like
`dial`), runs it in a fresh isolate, and hands it an `itx` it can invoke and
provide against. The run is bracketed by durable events.

```ts
await itx.runScript(`async (itx) => {
  const g = await itx.invoke(["greeter"], ["world"]); // call an existing cap
  await itx.provideCapability(["scriptMade"], async () => "…"); // provide a new one
  return g;
}`);
```

- `ItxDO.runScript(code)` appends `script-execution-requested`, wraps the code in a
  `WorkerEntrypoint`, loads it via `env.LOADER`, calls `run(itxHandle)` (the handle's
  methods become RPC stubs in the loaded isolate so the script can call back), then
  appends `script-execution-completed`. The two events are the durable record;
  everything the script does between them is invisible to the log.

This is "code is a capability": the platform runs your program with itx in scope,
exactly as a project REPL or an agent's tool-call would.

**The failure it buys you out of:** not every capability is a fixed method — some
are ad-hoc programs. Codemode lets you hand the platform a script and have it run
with the full context's authority, recorded as a pair of events.

**Run:** `npm run dev`, then `node --experimental-strip-types steps/12-codemode/intent.test.ts`.
