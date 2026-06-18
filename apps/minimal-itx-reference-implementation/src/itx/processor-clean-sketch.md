# Smaller `ItxProcessor` Sketch

The reduced state is already the provided capability table. Do not copy it into
another registry.

Keep only these fields:

```ts
#dynamicWorkers: DynamicWorkersRpcTarget | null;
#builtinCapabilities: CapabilityRecord[];
#providedLiveCapabilityRpcStubs = new Map<string, LiveRpcStub>();
#builtinLiveCapabilityRpcStubs = new Map<string, LiveRpcStub>();
```

The model:

- durable provided capabilities are rows in `this.state.capabilities`;
- durable capabilities have `record.address`;
- live capabilities have `record.address === null`;
- live provided stubs are in `#providedLiveCapabilityRpcStubs`;
- live builtin stubs are in `#builtinLiveCapabilityRpcStubs`;
- provided capabilities are matched first; builtin capabilities are fallback.

The whole invocation path should read like this:

```ts
async invokeCapability({ path, args = [] }: PathInvocation) {
  assertCapabilityPath(path);

  const control = path[0];
  if (control && ITX_CONTROL_NAMES.has(control)) {
    if (path.length !== 1) throw new Error(`reserved ITX control path "${control}"`);
    if (control === "provideCapability") return await this.provideCapability(args[0]);
    if (control === "invokeCapability") return await this.invokeCapability(args[0]);
    if (control === "revokeCapability") return await this.revokeCapability(args[0]);
    if (control === "describe") return await this.describe();
    if (control === "runScript") return await this.runScript(args[0]);
  }

  const provided = resolveLongestPrefix(this.state.capabilities, path);
  if (provided) {
    return await this.#invokeCapabilityRecord(
      provided,
      this.#providedLiveCapabilityRpcStubs,
      args,
    );
  }

  const builtin = resolveLongestPrefix(this.#builtinCapabilities, path);
  if (builtin) {
    return await this.#invokeCapabilityRecord(
      builtin,
      this.#builtinLiveCapabilityRpcStubs,
      args,
    );
  }

  throw new Error(`no capability "${path.join(".")}"`);
}
```

The record invocation is the only live-vs-durable branch:

```ts
async #invokeCapabilityRecord(
  hit: { record: CapabilityRecord; rest: string[] },
  liveCapabilityRpcStubs: Map<string, LiveRpcStub>,
  args: unknown[],
) {
  if (hit.record.address) {
    return await replayPath({
      args,
      path: hit.rest,
      target: this.#dynamicWorkers.get(
        withCacheKey(hit.record.address, `capability:${hit.record.path.join(".")}`),
      ),
    });
  }

  const liveRpcStub = liveCapabilityRpcStubs.get(liveRpcStubKey(hit.record.path));
  if (!liveRpcStub) {
    throw new Error(
      `capability "${hit.record.path.join(".")}" is offline (live provider disconnected)`,
    );
  }
  return await liveRpcStub.invoke(hit.rest, args);
}
```

Provide/revoke only update the provided live stub map. The stream fold updates
`this.state.capabilities`.

```ts
async provideCapability({ path, capability, instructions, types }: ProvideArgs) {
  this.#assertUserCapabilityPath(path);
  const address = durableCapabilityAddress(capability);
  const key = liveRpcStubKey(path);

  this.#providedLiveCapabilityRpcStubs.get(key)?.dispose();
  if (address) this.#providedLiveCapabilityRpcStubs.delete(key);
  else this.#providedLiveCapabilityRpcStubs.set(key, retainLiveRpcStub(capability));

  const committed = await this.ctx.stream.append({
    event: {
      type: "events.iterate.com/itx/capability-provided",
      payload: { path, address, instructions, types },
    },
  });
  await this.waitUntilEvent({ offset: committed.offset });
  return { path };
}
```

```ts
async revokeCapability({ path }: { path: string[] }) {
  this.#assertUserCapabilityPath(path);

  const key = liveRpcStubKey(path);
  this.#providedLiveCapabilityRpcStubs.get(key)?.dispose();
  this.#providedLiveCapabilityRpcStubs.delete(key);

  const committed = await this.ctx.stream.append({
    event: { type: "events.iterate.com/itx/capability-revoked", payload: { path } },
  });
  await this.waitUntilEvent({ offset: committed.offset });
}
```

Describe stays literal:

```ts
async describe(): Promise<DescribeResult> {
  return {
    capabilities: this.state.capabilities,
    builtinCapabilities: this.#builtinCapabilities,
  };
}
```
