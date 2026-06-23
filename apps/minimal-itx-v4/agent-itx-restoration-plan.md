# Minimal Agent ITX Restoration Plan

## Goal

Bring back the smallest useful agent host in `apps/minimal-itx-v4` without
changing the v4 shape.

The project surface should expose agents like this:

```ts
const agent = project.agents.get("/agents/some-agent");
await agent.sendMessage("hello");
```

The agent is intentionally tiny: `sendMessage(...)` appends an agent input
event, `ask({ message })` appends the same input and waits for the next output,
and the agent stream processor hardcodes a fake response.

## Desired Agent Behavior

- `project.agents.get(path)` returns an `AgentRpcTarget`.
- `AgentRpcTarget.sendMessage(message)` appends
  `events.iterate.com/agent/input-added` to the agent stream with
  `{ message }` in the payload and returns the committed event.
- `AgentRpcTarget.ask({ message })` calls `sendMessage(message)`, then waits on
  the same stream for `events.iterate.com/agent/output-added` after the input
  event offset, and returns that committed output event.
- `AgentProcessor` handles `events.iterate.com/agent/input-added` by waiting one
  second, then appending `events.iterate.com/agent/output-added` with:

```ts
{
  message: `This is the response to '${input}'`,
}
```

This is deliberately not a real agent loop. It only proves the host, stream,
processor, and project-to-agent ITX path.

## Plan

1. Restore the public contract in `types.ts`.
   - Un-comment `Project.agents: Agents`.
   - Add `Agent.ask(input: { message: string }): Promise<StreamEvent>`.
   - Keep `Agent.sendMessage(message: string): Promise<StreamEvent>`.
   - Keep `Agent`, `Agents`, and `AgentItx` in the pass-by-reference
     `RpcTargetCapability` union.
   - Keep `AgentItx` as the project surface plus an explicit `agent` handle, so
     project-scoped built-ins stay at top level while `itx.agent` is the
     agent-local capability host.

2. Rebuild `AgentDurableObject` after `ProjectDurableObject`.
   - Parse the DO name with `DurableObjectNameCodec.parseProjectScoped(...)` and
     reject paths outside `/agents/...`.
   - Create one stream processor host, add `AgentProcessor`, create the stream
     stub for the agent path, create `DynamicWorkersRpcTarget`, and register
     `ItxProcessor` on that host.
   - Expose `itxProcessor`, `requestStreamSubscription(...)`,
     `getCapability()`/`rpcTarget`, `runScript(...)`,
     `provideCapability(...)`, and `revokeCapability(...)` by delegating to the
     hosted processor, matching the project DO method shape.
   - Return RPC adapter targets from `getCapability()` instead of importing the
     stale `rpc_targets.ts` symbols.

3. Add the agent RPC adapters in `src/rpc-targets.ts`.
   - Add `normalizeAgentPath(...)`, `AgentsRpcTarget`, `AgentRpcTarget`, and
     `AgentItxRpcTarget`.
   - Change `ProjectRpcTarget.agents` to return `new AgentsRpcTarget(...)`.
   - Make `AgentsRpcTarget.get(path)` validate `/agents/...`, resolve the
     `AGENT` DO by `DurableObjectNameCodec.stringify({ projectId, path })`, and
     return an `AgentRpcTarget`.
   - Make `AgentsRpcTarget.create({ path })` call the target's `create()`.
   - Make `AgentRpcTarget` extend `ItxCapabilityHostRpcTarget` and resolve
     `itxProcessor()` from the `AGENT` DO, mirroring
     `ProjectRpcTarget.itxProcessor()`.
   - Implement `AgentRpcTarget.sendMessage(message)` by appending
     `events.iterate.com/agent/input-added` to `this.stream`.
   - Implement `AgentRpcTarget.ask({ message })` by calling `sendMessage`, then
     `this.stream.waitForEvent({ afterOffset, eventTypes:
["events.iterate.com/agent/output-added"], timeoutMs })`.
   - Implement the remaining built-ins on `AgentRpcTarget`: `itx`, `stream`,
     `create`, and `whoami`.
   - Make `AgentItxRpcTarget` compose the project surface and add `agent`, so
     agent ITX has the same project built-ins plus the current agent handle.

4. Shrink the agent processor to the fake loop.
   - Replace the old `agent/create-requested`, `agent/created`, and
     `agent/message-sent` behavior with the minimum event contract:
     `agent/input-added` is consumed and `agent/output-added` is emitted.
   - In `processEvent`, when the input event arrives, use
     `blockProcessorWhile(async () => { await sleep(1000); append(output); })`.
   - Reduce state only enough to prove behavior, for example arrays of inputs
     and outputs.

5. Wire the Worker export and bindings.
   - Un-comment the `AgentDurableObject` import/export in `src/worker.ts`.
   - Un-comment the `AGENT` binding and migration entry in `wrangler.jsonc`.
   - Regenerate `worker-configuration.d.ts` with `pnpm types:wrangler`.

6. Prove the restored behavior with one smoke path.
   - Create a project.
   - Call `project.agents.get("/agents/some-agent").sendMessage("hello")`.
   - Verify the agent stream contains `events.iterate.com/agent/input-added`.
   - Call `project.agents.get("/agents/some-agent").ask({ message: "hello" })`.
   - Verify the returned event is `events.iterate.com/agent/output-added` with
     `This is the response to 'hello'`.
   - Run `pnpm --dir apps/minimal-itx-v4 typecheck` and the focused e2e test.
