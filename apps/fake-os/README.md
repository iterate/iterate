# fake-os

TanStack Start app for deployment management. Node-only runtime.

- App package: `apps/fake-os`
- Contract package: `apps/fake-os-contract`
- API: oRPC over OpenAPI at `/api`
- DB: Drizzle + SQLite (`./data/fake-os.db`)
- Runtime entry: `src/entry.node.ts`
- Pidnap/service manifest entrypoint: `apps/fake-os/server.ts`

## Dev

- `pnpm dev` for local development
- `pnpm build` then `pnpm start` to run the built Nitro bundle

## Important

- There is no workerd / Cloudflare runtime here
- `server.ts` runs the built Nitro output, so build before using it through pidnap or service-manifest automation
