## codemode

Cloudflare app that runs user-provided TypeScript snippets inside Dynamic Workers and exposes a generated `ctx` surface from selected oRPC/OpenAPI sources.

### Runtime

- Doppler project: `codemode`
- Deploy route(s): set `WORKER_ROUTES` in Doppler for non-local deploys
- Main app follows the same TanStack Start + Alchemy pattern as `apps/events`
- Extra bindings:
  - `LOADER`: Dynamic Worker loader used by `@cloudflare/codemode`
  - `OUTBOUND`: dedicated outbound worker used for public fetches and OpenAPI source traffic

### Commands

- `pnpm --dir apps/codemode run dev`
- `pnpm --dir apps/codemode run deploy`
- `pnpm --dir apps/codemode run destroy`

### Notes

- `APP_CONFIG` is the single app-config binding. Redacted config values are parsed back into `Redacted` at runtime.
- Public OpenAPI sources can require source-level headers. Weather.gov is the current example.
