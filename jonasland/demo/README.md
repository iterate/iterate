# Jonas Land Demo

Host-side control plane + mock third-party egress for Jonas Land sandbox work.

## What it does

- Starts/stops a Jonas Land sandbox container on-demand.
- Starts required services (`daemon`, `egress-proxy`, `opencode`, `agents`, `opencode-wrapper`, `slack`).
- Mocks third-party APIs on host (`/v1/responses`, `/api/chat.postMessage`).
- Captures full request/response pairs from mocked egress traffic.
- Exposes a small Vite/React UI for control + inspection.

## Run

```bash
pnpm --filter @iterate-com/jonasland-demo dev
```

Then open `http://127.0.0.1:5173`.

## Useful endpoints

- `GET http://127.0.0.1:19099/healthz`
- `GET http://127.0.0.1:19099/records`
- `POST http://127.0.0.1:19099/records/clear`
- `GET http://127.0.0.1:19099/__demo/state`
- `POST http://127.0.0.1:19099/__demo/actions/start`
- `POST http://127.0.0.1:19099/__demo/actions/simulate-slack`
- `POST http://127.0.0.1:19099/__demo/actions/stop`
