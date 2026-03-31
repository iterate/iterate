# Service terminology in `apps/` and `packages/shared` service-related dependencies

This document inventories uses of the words **service** / **services** under `apps/`, and records which code depends on **service-related** APIs in `packages/shared/`. Generated for planning refactors or naming consistency (e.g. the events app vs “service platform” language).

---

## 1. `packages/shared` — what counts as “service-related”

### Dedicated modules

| Path                                                | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/jonasland/service-contract.ts` | Exported as `@iterate-com/shared/jonasland/service-contract`. Standard oRPC sub-router (`service.health`, `service.sql`, `service.debug`), Zod shapes, `ServiceManifestLike` / `ServiceManifestWithEntryPoint`, `createServiceSubRouterContract`.                                                                                                                                                                                                                        |
| `packages/shared/src/jonasland/service-server.ts`   | Hono middleware, `createSimpleServiceRouter`, `applyServiceMiddleware`, `createServiceOpenAPIHandler`. **Not** a separate `package.json` export; re-exported from `jonasland/index.ts`.                                                                                                                                                                                                                                                                                  |
| `packages/shared/src/jonasland/index.ts`            | Large “service platform” surface: `createServiceSubRouterHandlers`, OTEL helpers (`initializeServiceOtel`, etc.), `localHostForService`, URL resolution (`resolveServiceBaseUrl`, `resolveServiceOrpcUrl`, …), `createOrpcRpcServiceClient`, `registerServiceWithRegistry`, `serviceManifestToPidnapConfig`, SQL transforms for the service SQL endpoint (`transformSqlResultSet`, `transformLibsqlResultSet`), re-exports from `service-contract` and `service-server`. |

### Related but distinct: common router / registry

| Path                                                 | Role                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/apps/common-router-contract.ts` | `commonContract` includes **`updateServiceRegistry`** — naming is registry-oriented, not the `service-contract` module. |
| `packages/shared/src/apps/common-router.ts`          | Default stub for `updateServiceRegistry` (“not implemented for this app yet”).                                          |

### Logging

| Path                                 | Role                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/apps/logging/*` | Structured logs may include a **`service`** field (e.g. manifest package name). Semantic overlap with “service” naming only at the log-schema level. |

### Other `packages/shared` hits (lower relevance)

- `jonasland/deployment/deployment.ts`: **`registryService`** — lazy client for the daemon registry API (word “service”, different concept).
- Fly OpenAPI JSON / generated types: Fly.io **`MachineService`**, **`service_name`**, etc. — upstream API vocabulary.
- `deployment-utils.ts`, tests: incidental “service” in comments or Fly payloads.

---

## 2. Who depends on service-related `packages/shared` APIs

### `@iterate-com/shared/jonasland/service-contract` (direct)

| Consumer                    | Usage                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`apps/fake-os-contract`** | Only app package that imports this subpath directly: `createServiceSubRouterContract`, `ServiceManifestWithEntryPoint`; builds fake-os contract + manifest.                                       |
| **`apps/fake-os`**          | **Indirect** via `@iterate-com/fake-os-contract` (env schema, oRPC contract, manifest). Implements the standard `service.*` health/sql/debug surface without importing `service-contract` itself. |

No other `apps/*` packages import this subpath.

### `@iterate-com/shared/jonasland` (barrel) — service-adjacent symbols in use

| Consumer                                            | Symbols                                    | Notes                                                          |
| --------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| **`apps/daemon-v2/scripts/run-app.ts`**             | `localHostForService`                      | Computes host URLs for registry / app slugs.                   |
| **`apps/daemon-v2/src/lib/registry-db-browser.ts`** | `transformLibsqlResultSet`, `SqlResultSet` | Aligns DB browser output with service SQL result shaping.      |
| **`apps/daemon-v2/src/lib/registry-store.ts`**      | `SqlResultSet` (type)                      | Same barrel import.                                            |
| **`apps/daemon-v2/src/orpc/routers/registry.ts`**   | `infoFromContext`                          | Same barrel; not “service”-named but shared `jonasland` entry. |

### Exported from `jonasland/index.ts` but **not** referenced from production apps (today)

Examples: `createServiceSubRouterHandlers`, `resolveServiceBaseUrl` / `resolveServiceOrpcUrl`, `createOrpcRpcServiceClient`, `registerServiceWithRegistry`. Used inside `packages/shared` and in **`packages/shared/src/jonasland/service-url.test.ts`** for URL helpers.

**`serviceManifestToPidnapConfig`** is imported from the barrel by **`jonasland/e2e`** vitest networking specs (`02a`, `02c`, `02d`, etc.), not by `apps/*` packages.

### `commonContract` / `updateServiceRegistry`

These apps’ contracts merge **`commonContract`** from `@iterate-com/shared/apps/common-router-contract`:

- `apps/fake-os-contract`
- `apps/events-contract`
- `apps/example-contract`
- `apps/daemon-v2-contract`

That pulls in **`updateServiceRegistry`** procedure naming (registry wiring), separate from `service-contract.ts`.

---

## 3. “Service” / “services” under `apps/` (grep-oriented inventory)

Roughly **79 files** matched `service` (case-insensitive) under `apps/`. Not exhaustive line-by-line; grouped by **kind of usage**.

### Strong product/domain: **fake-os** “Services” UI and registry routes

- **`apps/fake-os`**: oRPC `service.*` + `deployments.services.list`, route **`/deployments/$slug/services`**, sidebar “Services”, copy about “registry service registrations”.
- **`apps/fake-os-contract`**: `DeploymentServiceRegistration`, `services.list` in OpenAPI, `FakeOsServiceEnv`, `fakeOsServiceManifest`, `createServiceSubRouterContract` usage.

### **events** (legacy tree): Effect `services/` directory

- Historical **`apps/events/effect-stream-manager/services/*`** (removed): `stream-manager`, `stream-storage`, `stream-client` — Effect “service” pattern (`service.ts` files), not `packages/shared` service-contract.

### **events** / **events-contract** (current)

- Copy: “stream **service**” in UI/contract strings; **`apps/events/SPEC.md`** “Events service” (if present).

### **os**

- Backend **`apps/os/backend/services/`** — internal modules (machine-creation, ingress-proxy, etc.).
- Machine router: “**service** URLs” for daemons.
- Worker `service: "os"`, **`SERVICE_AUTH_TOKEN`**, etc.

### **ingress-proxy**

- Comments describing host forms: `service__…`, `service.…`; “downstream services”.

### **cf-ingress-proxy**

- **`worker-configuration.d.ts`**: generated Cloudflare types (`ServiceWorkerGlobalScope`, `Service<…>`, `LoopbackServiceStub`, `service_tier`, etc.) — noise for product naming.

### **semaphore-contract**

- Tunnel **`--service`** URL, `service` in ingress config.

### **daemon** / **daemon-v2**

- **`apps/daemon/server/app.ts`**: “local-only service” comment.
- **`apps/daemon-v2/scripts/run-app.ts`**: `localHostForService` (shared).

### **example**, **iterate-com**, **project-ingress-proxy**

- Smoke tests / README / legal copy — incidental “services” wording.

---

## 4. Implications for **events** / **events-contract**

- **events-contract** already depends on **`commonContract`** → includes **`updateServiceRegistry`** naming from shared (registry, not `service-contract.ts`).
- The **events** app code does **not** appear in the **direct** `service-contract` dependency chain; primary overlap is **shared common router** + **user-facing copy** (“stream service”).
- If you rename or split “service” concepts repo-wide, **fake-os / fake-os-contract** and **daemon-v2** are the main app touchpoints for **`packages/shared`** service-platform APIs; **events** is mostly affected by **common-contract** procedure names and documentation tone.

---

## 5. Dead / almost-dead code (`jonasland/`, `packages/shared`)

Static import analysis (ripgrep); dynamic imports and unpublished consumers not covered.

### Broken or stale infrastructure

| Issue                                  | Detail                                                                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`./apps/middleware/require-header`** | Declared in `packages/shared/package.json` → `./src/apps/middleware/require-header.ts`, but that file is **missing** in the tree. Export is broken until restored or removed.                                         |
| **Jonasland Playwright CI**            | `.github/workflows/e2e-specs.yml` runs `pnpm --filter ./jonasland/e2e spec:e2e`, but **`jonasland/e2e/package.json` has no `spec:e2e` script** (local entry is `pnpm playwright`). CI likely fails or is out of sync. |

### `packages/shared` — exports with no external `@iterate-com/shared/...` usage (or only internal)

| Export / module             | Notes                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `./jonasland/logging`       | Re-exports apps logging runtime; **zero** imports of this package path.                                       |
| `./jonasland/strip-ansi.ts` | No subpath imports; `stripAnsi` used only via relative paths inside `packages/shared`.                        |
| `./jonasland/test-helpers`  | No direct package imports; may be re-exported from `jonasland` barrel only.                                   |
| `./apps/logging/runtime`    | No external importers; only chained from `jonasland/logging.ts`.                                              |
| `./zod-helpers`             | No package imports; **`jonasland/scripts/deployments.ts`** deep-imports `packages/shared/src/zod-helpers.ts`. |
| `./dev/exec-concurrently`   | No references found outside `package.json`.                                                                   |

### `jonasland/index.ts` barrel — large “service platform” surface mostly unused outside shared

**Actually used from the barrel (examples):** `localHostForService` (daemon-v2 `run-app`), `infoFromContext` / `transformLibsqlResultSet` / `SqlResultSet` (daemon-v2 registry), `serviceManifestToPidnapConfig` + `createSlug` (**jonasland e2e** + `vitest-artifacts`).

**No monorepo consumers found** for much of the rest: e.g. `createServiceSubRouterHandlers`, `initializeServiceOtel` / evlog helpers, `createServiceRequestLogger`, `createOrpcErrorInterceptor`, SQL `transformSqlResultSet` (externals use `transformLibsqlResultSet`), healthz/observability helpers, `resolveServiceBaseUrl` / `resolveServiceOrpcUrl` (aside from **`service-url.test.ts`**), ORPC client factories (`createOrpcRpcServiceClient`, …), `registerServiceWithRegistry`, `createLocalServiceOrpcClient`, browser bridge plugin, etc.

### `service-server.ts`

`createServiceOpenAPIHandler`, `createSimpleServiceRouter`, `applyServiceMiddleware`, `applyOpenAPIRoute` — **only** referenced from `jonasland/index.ts` re-exports; **no app imports**.

### Duplication / redundancy

- **`proxyPosthogRequest`** re-exported from `jonasland` barrel; PostHog call sites tend to use **`@iterate-com/shared/posthog`** instead.
- **`getRequestIdHeader`** (or equivalent) may overlap with **`@iterate-com/shared/request-logging`** — verify single source of truth before refactors.

### `jonasland/e2e` — “old” is not dead

- **`jonasland/e2e/test-helpers/old/`** (`frp-egress-bridge`, `use-cloudflare-tunnel`, `public-ingress-config`) — still imported by vitest + harness; **legacy bucket, not deletion-ready**. `tsconfig` excludes this folder while tests import it (possible typecheck gap).
- Parallel newer helper: **`use-cloudflare-tunnel-from-semaphore.ts`** — two tunnel code paths, not duplicates of one file.

### Docs/config drift

- **`tests/old` / `spec/old`** excluded in e2e tsconfig; folders may be empty — migration docs could be stale.

### Takeaways for refactors

- Treat **`jonasland/index.ts`** as a **kitchen sink**: trimming or splitting subpaths (e.g. service-template vs daemon/registry helpers) reduces accidental API surface.
- Fix **broken export** and **Playwright CI script name** before relying on those paths in automation.

---

## 6. How to refresh this inventory

```bash
# apps/ mentions of service(s)
rg -i 'service' apps/

# shared service modules and imports
rg '@iterate-com/shared/jonasland/service-contract|service-contract|service-server|createServiceSubRouter|ServiceManifestWithEntryPoint|localHostForService|serviceManifestToPidnap|registerServiceWithRegistry|resolveServiceBaseUrl' --glob '*.ts' --glob '*.tsx'
```
