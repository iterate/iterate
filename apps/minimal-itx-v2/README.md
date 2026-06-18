# Minimal ITX v2

Run the local Miniflare-backed worker and test it:

```bash
pnpm verify:miniflare
```

Run the same suite against a deployed worker:

```bash
ITX_BASE=https://your-worker.workers.dev pnpm verify:deployed
```

Open a Node REPL against a running local or deployed worker:

```bash
pnpm repl
ITX_BASE=https://your-worker.workers.dev pnpm repl
```

The REPL exposes `itx`, `root`, `RpcTarget`, `baseUrl`, `projectId`, and `token`.
Defaults are `http://127.0.0.1:8789`, project `prj_ref`, and the demo tokens
from `src/auth.ts`.
