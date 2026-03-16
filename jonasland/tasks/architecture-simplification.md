---
state: pending
priority: high
size: large
---

# jonasland Architecture Simplification

Simplify jonasland with sensible abstractions: dedupe code, split tests, and make service-registry the source of truth with event-driven Caddy sync.

## Phase 1: Split Test Suite

Break smoke.e2e.ts (9 tests) into 3 focused files.

```
tests/
├── caddy.e2e.ts (4 tests)
│   ├── caddy admin is API-only and typed caddy client works
│   ├── home and outerbase host routes are reachable
│   ├── tls mitm to real upstream via caddy→egress-proxy
│   └── egress supports x-iterate-target-url direct mode
├── services.e2e.ts (3 tests)
│   ├── fixture returns typed pidnap/caddy/services clients
│   ├── events service is reachable and supports CRUD
│   └── orders service emits order_placed events
├── runtime-state.e2e.ts (2 tests)
│   ├── services sqlite state persists across restart
│   └── pidnap can imperatively add/control a process
├── mock-egress-proxy.e2e.ts (unchanged)
└── fixtures-stress.e2e.ts (unchanged)
```

Files: `e2e/tests/smoke.e2e.ts` → split into 3 files, delete original

## Phase 2: Fix Duplicates

### 2a: Schema Helper

Move `nonEmptyStringWithTrimDefault` to shared.

Files:

- `services/shared/src/index.ts` — add export
- `services/example-contract/src/index.ts` — import, remove local
- `services/events-contract/src/index.ts` — import, remove local
- `services/services-contract/src/index.ts` — import, remove local

### 2b: Outerbase Imports

Remove 60 LOC of duplicated SQL utilities.

Files:

### 2c: Use Existing Handler Factory

Use `createServiceSubRouterHandlers()` that's defined but never imported.

Files:

- `services/example/src/router.ts` — use factory
- `services/events/src/router.ts` — use factory

## Phase 3: Create Server Factory

Extract ~190 LOC duplicated between example/events servers.

Create: `services/shared/src/hono-server-factory.ts`

Modify:

- `services/shared/package.json` — add Hono deps
- `services/example/src/server.ts` — reduce to ~30 lines
- `services/events/src/server.ts` — reduce to ~30 lines

Interface:

```typescript
export interface HonoServiceServerOptions {
  serviceName: string;
  manifest: ServiceManifest;
  router: Router;
  portEnvKey: string;
  openAPITitle: string;
  initializeDb: () => Promise<void>;
  getDbRuntimeConfig: () => Promise<unknown>;
}
```

Result:

```typescript
await createHonoServiceServer({
  serviceName: "jonasland-example",
  manifest: exampleServiceManifest,
  router: exampleRouter,
  portEnvKey: "EXAMPLE_SERVICE_PORT",
  openAPITitle: "jonasland example API",
  initializeDb: initializeExampleDb,
  getDbRuntimeConfig: getExampleDbRuntimeConfig,
});
```

## Phase 4: Rename services → service-registry

Clearer naming.

- `services/services/` → `services/service-registry/`
- `services/services-contract/` → `services/service-registry-contract/`
- Package names: `@iterate-com/registry-service` → `@iterate-com/registry-service`
- Update all imports across codebase
- pidnap.config.ts process name
- Caddy routes and home-service links

## Phase 5: Event-Driven Caddy Sync

Service-registry becomes source of truth. Caddy updates reactively via events-service.

```
service-registry                 events-service              caddy-sync (new)
     │                                │                           │
     ├── routes.upsert() ────────────→│ POST /events              │
     │   type: "route:changed"        │ (stores event)            │
     │                                │                           │
     └── routes.remove() ────────────→│                           │
         type: "route:changed"        │                           │
                                      │                           │
                                      │←── GET /events?type=...  ─┤ (polls)
                                      │                           │
                                      │                           └── calls Caddy /load
```

Create: `sandbox/services/caddy-sync-service.ts` (~80 LOC)

Modify:

- `services/service-registry/src/router.ts` — emit events after route changes
- `sandbox/caddy/Caddyfile` — minimal bootstrap only
- `sandbox/pidnap.config.ts` — add caddy-sync process

Service-Registry changes:

```typescript
// In routes.upsert handler:
await eventsClient.events.create({
  type: "route:changed",
  payload: { action: "upsert", host, target },
});
```

Caddy-Sync service:

```typescript
let lastSeenId: string | null = null;

setInterval(async () => {
  const events = await eventsClient.events.list({
    type: "route:changed",
    afterId: lastSeenId,
  });

  if (events.length === 0) return;
  lastSeenId = events.at(-1)!.id;

  const routes = await serviceRegistryClient.routes.list();
  const config = buildCaddyConfig(routes);
  await fetch("http://127.0.0.1:2019/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}, 1000);
```

May need to add `afterId` filter to events.list.

## Phase 6: Standardize oRPC Prefix

All services use `/orpc` (service-registry currently uses `/rpc`).

Files:

- `services/service-registry/src/server.ts` — `/rpc` → `/orpc`
- `services/service-registry/src/client.ts` — default URL
- `e2e/test-helpers/index.ts` — client URLs

## Execution Order

| Phase | Description                | Risk   | LOC Impact |
| ----- | -------------------------- | ------ | ---------- |
| 1     | Split tests                | Low    | 0 (reorg)  |
| 2     | Fix duplicates             | Low    | -100       |
| 3     | Server factory             | Medium | -350       |
| 4     | Rename to service-registry | Low    | 0 (rename) |
| 5     | Event-driven Caddy sync    | Medium | +50, -30   |
| 6     | Standardize /orpc          | Low    | 0          |

## Verification

After each phase:

```bash
cd jonasland
pnpm install
pnpm typecheck
pnpm test
RUN_JONASLAND_E2E=true doppler run --config dev -- pnpm --filter @iterate-com/jonasland-e2e test
```
