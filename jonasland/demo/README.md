# Jonas Land Demo

Host-side control plane + external egress proxy for Jonas Land sandbox work.

## What it does

- Uses one in-memory `JonaslandDemoState` as the source of truth.
- Exposes oRPC-style procedures at `/orpc/demo.*` (UI reads/writes only through procedures).
- Starts/stops a sandbox (`docker` now, `fly` placeholder).
- Starts baseline services + Jonasland services and the `home` app.
- Acts as the sandbox's external egress proxy:
  - matcher-based mock rules
  - fallback policy: `deny-all` or `proxy-internet`
- Captures full outbound request/response pairs for inspection.

## Run

```bash
pnpm jonasland demo
```

Then open `http://127.0.0.1:5173`.

## Core procedures

- `POST http://127.0.0.1:19099/orpc/demo.getState`
- `POST http://127.0.0.1:19099/orpc/demo.setProvider`
- `POST http://127.0.0.1:19099/orpc/demo.startSandbox`
- `POST http://127.0.0.1:19099/orpc/demo.stopSandbox`
- `POST http://127.0.0.1:19099/orpc/demo.patchConfig`
- `POST http://127.0.0.1:19099/orpc/demo.upsertMockRule`
- `POST http://127.0.0.1:19099/orpc/demo.deleteMockRule`
- `POST http://127.0.0.1:19099/orpc/demo.simulateSlackWebhook`
