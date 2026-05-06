# OS2 codemode depth debug repro

Minimal workerd/Vitest repro for the OS2 call shape:

`public fetch route -> ctx.exports WorkerEntrypoint -> Durable Object -> ctx.exports WorkerEntrypoint`

Run from the repository root:

```bash
pnpm --dir packages/shared exec vitest run --config ../../apps/os2/tmp/codemode-depth-debug/repro/vitest.config.ts
```

The suite contains:

- `/shallow`: one shallow route-to-entrypoint-to-DO-to-entrypoint call, expected to pass.
- `/recurse?remaining=2`: a bounded recursive call chain, expected to pass.
- `/recurse?remaining=128`: intentionally recurses deep enough to expose whether workerd reports a platform limit in a fast local run. The route catches thrown platform errors and returns them as JSON with `x-repro-result: error`; on the observed runtime this completed with `x-repro-result: ok`.

The repro is intentionally isolated under `apps/os2/tmp/codemode-depth-debug/repro` and does not import product code.
