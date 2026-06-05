# IterateContext mounts POC

Working proof-of-concept for the mount model in `apps/os/docs/iterate-context.md`.

`/tmp/iterate-context-mounts-poc` is a symlink to this directory.

## Run tests

```bash
cd packages/shared
pnpm exec vitest run --config ./iterate-context-mounts-poc.vitest.config.ts
```

## Architecture

```
IterateContextCapability (RpcTarget)
├── baked-in: streams, project
├── callMounted(path, args)     # stable RPC dispatch surface
├── getMounted(path)            # object mounts (when value is serializable)
└── generated prototype methods # one per function mount at ctx root

props.workers   → dynamic worker source (compiled with env in scope)
props.mounts    → explicit mount table (no property guessing)

Mount modes
├── function        ctx.someMethod(args)
├── object          ctx.something.someMethod(args)
└── path-dispatch   ctx.some.chat.postMessage(args) → run({ path, args, input })
```

## Key implementation choices

1. **Mount worker source wrapping** (`mount-worker-compiler.ts`)
   - Rewrites `export default { ... }` into `__createExports(env)` so `env` is in scope.
   - Dynamic workers cannot reference bare module-global `env`.

2. **`env.ITERATE` is a loopback service stub**
   - RpcTargets cannot be placed in `WorkerCode.env`.
   - Use `ctx.exports.IterateContextService({ props: { contextId } })`.
   - Mount workers call `env.ITERATE.getIterateContext()`.

3. **RPC-safe root function mounts**
   - `createMountedIterateContextClass()` adds prototype methods that delegate to `callMounted()`.
   - Avoids per-instance function properties (not visible over Workers RPC).

4. **Local authoring proxy** (`local-proxy.ts`)
   - Codemode can wrap the stable RPC target so scripts write `ctx.someMethod()` while the host uses `callMounted`.
   - Prototype getters like `ctx.streams` are resolved with `Reflect.get`, not `prop in ctx`.

5. **Stream shortcut mount**
   - Returning live RpcTarget stubs from mount worker getters does not serialize across the dynamic-worker boundary.
   - Use a plain delegate object whose methods call back into `env.ITERATE.getIterateContext()`.

## Files

| File                             | Role                                                  |
| -------------------------------- | ----------------------------------------------------- |
| `src/iterate-context.ts`         | Host context + `callMounted` / mount class generation |
| `src/mount-index.ts`             | Explicit mount table indexing                         |
| `src/mount-runtime.ts`           | `LOADER.load()` + worker cache                        |
| `src/mount-worker-compiler.ts`   | Wrap user mount source                                |
| `src/iterate-context-service.ts` | Loopback entrypoint for `env.ITERATE`                 |
| `src/local-proxy.ts`             | Codemode-style dynamic property proxy                 |
| `test/mounts.test.ts`            | 9 vitest-pool-workers tests                           |
