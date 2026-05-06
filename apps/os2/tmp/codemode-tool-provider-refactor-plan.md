# Codemode Tool Provider Refactor Plan

## Status

This plan captures the agreed v1 direction for codemode Tool Providers after the event/RPC design pass. Backwards compatibility with old codemode provider descriptors, `docs`, `typeDefinitions`, `__describe`, result callables, or old `tool-function-call-*` events is not required.

The core design goal is: codemode scripts should stay ergonomic, while the event log remains the trace of what codemode requested and what returned or threw.

Every Tool Function Call produces the same durable event pair:

1. `events.iterate.com/codemode/function-call-requested`
2. `events.iterate.com/codemode/function-call-completed`

The provider mechanism only changes who appends the completion event. For an
RPC Tool Provider, the Codemode Processor appends both events around
`executeCodemodeFunctionCall(...)`. For an Event-Mediated Tool Provider, the
Codemode Processor appends the requested event and the provider implementation
owns appending the matching completed event when the work returns or throws.

## Target Script Scenarios

### Event-Mediated SDK Provider: Slack

```ts
await ctx.slack.chat.postMessage({
  channel: "C123",
  text: "hello",
});
```

Slack is an Event-Mediated Tool Provider. The Slack stream processor listens for Function Calls whose `providerPath` is `["slack"]`, dispatches `functionPath` into the Slack SDK, then appends `function-call-completed`.

Registration:

```ts
{
  type: "events.iterate.com/codemode/tool-provider-registered",
  payload: {
    path: ["slack"],
    instructions: `
Use ctx.slack to call the Slack Web API SDK.
Call Slack SDK methods using their SDK path, e.g.
ctx.slack.chat.postMessage({ channel, text }).
`,
    invocation: { kind: "event" },
  },
}
```

### Event-Mediated Stateful Provider: Discord

```ts
await ctx.discord.sendMessage({
  channelId: "123",
  content: "hello",
});
```

Discord is also Event-Mediated in v1, even if its implementation is backed by a long-running processor or Durable Object that owns a singleton Discord WebSocket connection.

The provider observes:

```ts
{
  type: "events.iterate.com/codemode/function-call-requested",
  payload: {
    invocationKind: "event",
    providerPath: ["discord"],
    functionPath: ["sendMessage"],
    path: ["discord", "sendMessage"],
    args: [{ channelId: "123", content: "hello" }],
  },
}
```

Then it sends a WebSocket message and appends:

```ts
{
  type: "events.iterate.com/codemode/function-call-completed",
  payload: {
    functionCallId,
    scriptExecutionId,
    invocationKind: "event",
    providerPath: ["discord"],
    functionPath: ["sendMessage"],
    path: ["discord", "sendMessage"],
    outcome: {
      status: "returned",
      value: { messageId: "..." },
    },
  },
}
```

### Event Provider Calling Another Provider

This is a required proof. An Event-Mediated provider must be able to use the session capability to create a Codemode Context and call another provider.

Script:

```ts
await ctx.discord.announceRelease({
  discordChannelId: "987",
  slackChannel: "C123",
  version: "v1.2.3",
});
```

Discord processor state:

```ts
type DiscordProcessorState = {
  sessionCapabilityCallable?: Callable;
};
```

Reducer:

```ts
if (event.type === "events.iterate.com/codemode/session-started") {
  return {
    ...state,
    sessionCapabilityCallable: event.payload.sessionCapabilityCallable,
  };
}
```

Handler:

```ts
const codemodeSessionCapability = await dispatchCallable({
  callable: state.sessionCapabilityCallable,
  payload: {},
  ctx: callableContext,
});

const ctx = createCodemodeContext({
  codemodeSessionCapability,
  scriptExecutionId: event.payload.scriptExecutionId,
});

const [request] = event.payload.args as [
  { discordChannelId: string; slackChannel: string; version: string },
];

const discordResult = await discord.sendMessage({
  channelId: request.discordChannelId,
  content: `Released ${request.version}`,
});

await ctx.slack.chat.postMessage({
  channel: request.slackChannel,
  text: `Released ${request.version} to Discord message ${discordResult.messageId}`,
});

await appendReturned(event, {
  discordMessageId: discordResult.messageId,
  mirroredToSlack: true,
});
```

The nested Slack call must produce its own Function Call lifecycle events.

### MCP Client Capability

```ts
const tools = await ctx.cloudflareDocs.listTools();
console.log("Cloudflare Docs MCP tools", tools);

const answer = await ctx.cloudflareDocs["docs.search"]({
  query: "Workers RPC promise pipelining",
});
```

MCP dynamic discovery is ordinary Tool Functions, not a metadata side channel. In v1, one MCP Client Capability Durable Object owns one MCP server connection for one Codemode Session stream.

Registration:

```ts
{
  path: ["cloudflareDocs"],
  instructions: `
Use ctx.cloudflareDocs to talk to the Cloudflare Docs MCP server.
Call ctx.cloudflareDocs.listTools() to see the current tools.
Then call listed tools as ctx.cloudflareDocs["tool.name"](args).
`,
  invocation: {
    kind: "rpc",
    callable: buildMcpClientCapabilityCallable({ projectId, streamPath, serverUrl }),
  },
}
```

External tool names are exact Function Path segments. A tool named `docs.search` is called with bracket syntax and remains `functionPath: ["docs.search"]`.

### OpenAPI Client Capability

```ts
const operations = await ctx.petstore.listOperations();
console.log("Petstore operations", operations);

const pet = await ctx.petstore.getPetById({ petId: 123 });
```

OpenAPI works like MCP: short instructions in registration, dynamic operation/type discovery through a normal Tool Function.

### oRPC Capability

```ts
const procedures = await ctx.os.listProcedures();
console.log("OS2 oRPC procedures", procedures);

const result = await ctx.os.test.logDemo({
  label: "codemode",
});
```

The oRPC Capability exposes a selected OS2 oRPC subtree through codemode. It should resolve `functionPath` against the router and call the resolved procedure in-process with oRPC's server-side `call(...)` helper and a server-side caller context, not over HTTP.

`ctx.os.listProcedures()` should be a normal Tool Function that walks the exposed oRPC contract metadata and produces both procedure records and TypeScript declarations from the contract schemas. The generated declarations should describe the full `CodemodeExecutionContext` root named `ctx`, including `ctx.fetch`, `ctx.console`, and the oRPC functions nested at the provider's mounted path. `test.logDemo` is the first invocation proof because it already exists and is nested.

### Workers AI Capability

```ts
const answer = await ctx.ai.run("@cf/meta/llama-3.1-8b-instruct", {
  prompt: "Summarize the latest deployment log.",
});
```

This is an RPC Tool Provider backed by a small WorkerEntrypoint Capability that wraps `env.AI.run`.

### Repo Capability Returns Durable Object Handle

```ts
await ctx.repos.get({ slug: "web" }).proofOfConcept({
  callback: async (args) => {
    console.log("repo callback called", args);
  },
});
```

`ctx.repos.get({ slug })` is the Codemode Function Call. It returns a Live Tool Handle for `RepoDurableObject`. `.proofOfConcept(...)` is a Workers RPC method on that returned handle and is not a second Codemode Function Call.

Repo uses a WorkerEntrypoint Capability in front of the Durable Object namespace.

### Workspace Durable Object Is The Capability

```ts
await ctx.workspace.proofOfConcept({
  callback: async (args) => {
    console.log("workspace callback called", args);
  },
});
```

`ctx.workspace` is singular and implicit. `WorkspaceDurableObject` itself implements `executeCodemodeFunctionCall`.

### Root Unary Provider: Create Subagent

```ts
const result = await ctx.createSubagent().sendMessage({
  message: "hi",
  subPath: "bob",
});
```

`ctx.createSubagent()` is a root-level Unary Tool Provider. It has:

```ts
providerPath: ["createSubagent"];
functionPath: [];
path: ["createSubagent"];
```

It returns a Live Tool Handle for `AgentDurableObject`; `.sendMessage(...)` is Workers RPC on that handle.

### Sandbox / BrowserRun Promise Pipelining

```ts
const result = await ctx.sandbox.get({ name: "build" }).exec("pnpm test");

await ctx.browserRun.page({ session: "checkout" }).goto("https://example.com");
const png = await ctx.browserRun.page({ session: "checkout" }).screenshot();
```

The codemode proxy must not eagerly await the RPC thenable returned by the initial Function Call. Codemode traces the call returning the Live Tool Handle (`sandbox.get`, `browserRun.page`), not the later methods on the returned handle.

### Built-Ins

```ts
const response = await fetch("https://api.example.com/data");
console.log("status", response.status);

await ctx.streams.append({
  path: "/projects/proj_123/audit",
  event: {
    type: "events.example.com/audit/note-added",
    payload: { message: "hello" },
  },
});
```

`fetch` goes through the Codemode Fetch Capability. Project Egress policy belongs behind that capability as the egress design hardens. `console.*` appends `log-emitted`. `ctx.streams.append` is an ordinary Tool Function and may append to another allowed stream path when a path is provided.

## Core Events

### `events.iterate.com/codemode/session-started`

Processor-emitted singleton event. Idempotency key is the event type.

```ts
{
  type: "events.iterate.com/codemode/session-started",
  idempotencyKey: "events.iterate.com/codemode/session-started",
  payload: {
    sessionCapabilityCallable,
  },
}
```

The payload intentionally does not include `projectId` or `streamPath`. The event is already in a project-scoped stream namespace and is appended to a specific stream.

Invoking `sessionCapabilityCallable` returns a live `CodemodeSessionCapability` RPC handle.

```ts
type CodemodeSessionCapability = {
  callFunction(input: {
    path: string[];
    args: unknown[];
    scriptExecutionId?: string;
    functionCallId?: string;
  }): Promise<unknown>;
};
```

### `events.iterate.com/codemode/tool-provider-registered`

```ts
{
  type: "events.iterate.com/codemode/tool-provider-registered",
  payload: {
    path: string[];
    instructions: string;
    invocation:
      | { kind: "event" }
      | { kind: "rpc"; callable: Callable };
  },
}
```

`invocation` is required. No guessing.

### `events.iterate.com/codemode/function-call-requested`

```ts
{
  type: "events.iterate.com/codemode/function-call-requested",
  payload: {
    functionCallId: string;
    scriptExecutionId?: string;
    invocationKind: "event" | "rpc";
    path: string[];
    providerPath: string[];
    functionPath: string[];
    args: unknown[];
  },
}
```

`args` is best-effort serialized for RPC calls. Live values may become summaries such as `[Function]`; the real live args only travel over Workers RPC.

### `events.iterate.com/codemode/function-call-completed`

```ts
{
  type: "events.iterate.com/codemode/function-call-completed",
  payload: {
    functionCallId: string;
    scriptExecutionId?: string;
    invocationKind: "event" | "rpc";
    path: string[];
    providerPath: string[];
    functionPath: string[];
    durationMs?: number;
    outcome:
      | { status: "returned"; value: unknown }
      | { status: "threw"; error: unknown };
  },
}
```

Live return values are serialized as well as possible. If a returned value is a live RPC handle, the event should store a readable summary such as:

```ts
{ kind: "live", type: "RpcTarget" }
```

## Capability Conventions

Capability class names use the `Capability` suffix when they are WorkerEntrypoint or DO surfaces used to interact with a backend, SDK, binding, or live resource.

RPC Tool Providers implement:

```ts
executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput): unknown | Promise<unknown>;
```

```ts
type ExecuteCodemodeFunctionCallInput = {
  functionCallId: string;
  scriptExecutionId?: string;
  invocationKind: "rpc";
  path: string[];
  providerPath: string[];
  functionPath: string[];
  args: unknown[];
  codemodeSessionCapability: CodemodeSessionCapability;
};
```

Provider implementations should switch on `functionPath`, not full `path`, so they do not care where they are mounted.

Callable construction should be hidden behind small functions, not hand-written at every registration site:

```ts
export function buildAiCapabilityCallable(input: {
  bindingName: string;
  props: { projectId: string };
}): Callable {
  return {
    type: "workers-rpc",
    via: {
      type: "env-binding",
      bindingType: "service",
      bindingName: input.bindingName,
      props: input.props,
    },
    rpcMethod: "executeCodemodeFunctionCall",
    argsMode: "object",
  };
}
```

Do not build a static-method framework yet.

## Implementation Plan

1. Update shared codemode contract.
   - Add `session-started`.
   - Replace `ToolProviderDocumentation` with `ToolProviderRegistration`.
   - Remove `docs`, `typeDefinitions`, and `resultCallable`.
   - Use `instructions`, `invocation`, `providerPath`, `functionPath`, `args`, `returned`, and `threw`.

2. Update shared codemode reducer/state.
   - Track session started.
   - Track providers by `path`.
   - Track Function Calls by `functionCallId`.

3. Update shared processor implementation.
   - Emit `session-started` once with `sessionCapabilityCallable`.
   - Resolve provider by longest path prefix.
   - For `event` providers: append requested, then wait for the provider-owned completed event.
   - For `rpc` providers: append requested, call `executeCodemodeFunctionCall`, then append the processor-owned completed event.
   - Preserve returned Workers RPC thenables for promise pipelining.

4. Update `createCodemodeContext`.
   - Forward `args: unknown[]`.
   - Keep `then`/`catch`/`finally` safeguards.
   - Do not collapse calls back to only `args[0]`.

5. Update OS2 `CodemodeSession`.
   - Provide the processor runtime dependency that builds `sessionCapabilityCallable`.
   - Remove result-callable / `receiveFunctionCallResult` core path.
   - Keep only code needed for current tests after refactor.

6. Add example capabilities and Durable Objects.
   - `AiCapability`
   - `RepoCapability`
   - `RepoDurableObject`
   - `WorkspaceDurableObject`
   - `AgentCapability`
   - `AgentDurableObject`
   - `OrpcCapability`
   - adapt or replace MCP/OpenAPI bridges with `McpClientCapability` and `OpenApiClientCapability`

7. Add OS2 codemode examples.
   - Each target scenario above should be represented in `apps/os2/src/codemode/examples.ts`.
   - Examples should include real provider registration payloads and runnable script blocks.

8. Update UI and API parsing.
   - Provider JSON should validate the new shape.
   - Examples page should let these examples create sessions with providers prefilled.

## Tests And Proofs

### Shared Unit Tests

Command:

```bash
pnpm --dir packages/shared exec vitest run \
  src/stream-processors/codemode/contract.test.ts \
  src/stream-processors/codemode/implementation.test.ts \
  src/codemode/context-proxy.test.ts
```

Required test cases:

- Reduces `session-started` once and stores `sessionCapabilityCallable`.
- Provider registration requires explicit `invocation`.
- Longest provider path match computes `providerPath` and `functionPath`.
- Unary provider mounted at `["createSubagent"]` has empty `functionPath`.
- Event provider appends request and waits for completed event.
- RPC provider calls `executeCodemodeFunctionCall` and appends `returned`.
- RPC provider thrown error appends `threw` and script sees an Error.
- RPC args with callbacks/functions are serialized best-effort in requested event.
- `createCodemodeContext` forwards all positional args.
- Provider-to-provider composition via `CodemodeSessionCapability` produces nested Function Call events.

### OS2 Workerd Tests

Command:

```bash
pnpm --dir apps/os2 test:codemode-session
```

Required test cases:

- `session-started` event is appended with idempotency key equal to the event type and only `sessionCapabilityCallable` in payload.
- Event-mediated Discord example reduces `sessionCapabilityCallable`, builds a Codemode Context, calls Slack, and completes the parent call.
- Repo example returns `RepoDurableObject`; callback passed to `proofOfConcept` is invoked.
- Workspace example calls `executeCodemodeFunctionCall` directly on `WorkspaceDurableObject`.
- `createSubagent().sendMessage(...)` proves root unary provider plus returned live handle.
- oRPC capability resolves the provider-relative path against the exposed oRPC router and calls the procedure in-process with server-side context.
- MCP capability exposes `listTools`.
- OpenAPI capability exposes `listOperations`.

### OS2 Typecheck / App Tests

Commands:

```bash
pnpm --dir apps/os2 typecheck
pnpm --dir apps/os2 test
```

Known prior caveat: if unrelated `packages/ui` or stream-runtime type errors are present in the worktree, record them separately and do not hide them.

### Local Dev Worker Verification

Start OS2 locally:

```bash
pnpm --dir apps/os2 dev
```

Use the dev tunnel URL, not `localhost:5173`, unless the local config explicitly says otherwise.

Manual checks:

1. Open an OS2 project.
2. Go to codemode examples.
3. Create a session from each new example.
4. Confirm the event feed includes:
   - one `events.iterate.com/codemode/session-started`
   - one or more `tool-provider-registered`
   - `function-call-requested`
   - `function-call-completed`
   - `log-emitted` where scripts call `console.log`
5. For live-handle examples, confirm the script result proves the returned handle method ran:
   - repo callback logged
   - workspace callback logged
   - subagent `sendMessage` returned a response
6. For provider composition, confirm both parent and nested Function Calls appear:
   - `discord.announceRelease`
   - `slack.chat.postMessage`

### Preview Deployment Verification

After deploying a preview, use the preview OS2 URL, for example:

```bash
OS2_BASE_URL=https://os2.iterate-preview-N.com pnpm --dir apps/os2 test:e2e:preview
```

Manual preview checks:

1. Open the preview URL in a browser.
2. Sign in and open a test project.
3. Run each codemode example from the examples page.
4. Confirm the codemode session opens without `MALFORMED_ORPC_ERROR_RESPONSE`.
5. Confirm event feed contains the same event sequence as local verification.
6. For RPC/live examples, confirm no event claims to serialize the full live object; completion value should be a readable summary or result.
7. For MCP/OpenAPI/oRPC discovery examples, confirm the first call is a normal Function Call:
   - `cloudflareDocs.listTools`
   - `petstore.listOperations`
   - `os.listProcedures`

### Acceptance Criteria

- Every target script scenario has a runnable OS2 example.
- Event-Mediated and RPC providers use the same `function-call-requested` / `function-call-completed` lifecycle.
- No result callable exists in the core Function Call protocol.
- Event-Mediated providers can call other providers with two local steps:
  - invoke `sessionCapabilityCallable` to get `CodemodeSessionCapability`
  - call `createCodemodeContext`
- RPC providers receive `executeCodemodeFunctionCall` with `providerPath`, `functionPath`, full `path`, `args`, IDs, and `codemodeSessionCapability`.
- Promise-pipelined live handles work for at least one proof.
- Preview deployment can run the examples end to end.
