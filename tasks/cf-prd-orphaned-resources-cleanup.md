---
state: draft
priority: medium
size: large
dependsOn: []
tags: [cloudflare, os-rename, cleanup]
---

# Cloudflare prd account: orphaned resource cleanup

## Context

`apps/os2` → `apps/os` rename with **no backwards compatibility**. Prod (`ALCHEMY_STAGE=prd`) will be destroyed and recreated on new hostnames (`os.iterate.com`, `*.iterate.app`). We are **pre-customer** — safe to delete stale Workers, D1, R2, routes, and DO-related assets.

Related: the completed OS rename cutover and current Doppler audit task.

## Goal

Inventory and remove orphaned resources in the **prd Cloudflare account** (`_shared/prd` → account `04b3b57291ef2626c6a8daa9d47065a7` per `docs/devops-cloudflare-doppler-alchemy-setup.md`) left by deleted `apps/os`, old `os-*` deploys, and failed/abandoned Alchemy runs.

## Expected naming patterns (from codebase)

| Resource           | Pattern                                            | Notes                                                                           |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Worker script      | `os-prd`, `os-prd` (after rename)                  | `slugify(\`${manifest.slug}-${stage}\`)`in`packages/shared/src/alchemy/init.ts` |
| D1                 | `{workerName}-db` e.g. `os-prd-db`                 | `apps/os/alchemy.run.ts`                                                        |
| R2 / artifacts     | `{workerName}-repos`                               | Artifacts namespace in alchemy                                                  |
| DO namespaces      | bound to worker deploy                             | Recreated with worker                                                           |
| Routes             | from `APP_CONFIG_BASE_URL`, `projectHostnameBases` | `iterate.com`, `iterate.app`, `os.iterate.com`, `*.iterate.app`                 |
| Legacy deleted app | `os-*` without `os`, Daytona/Archil-era names      | Unknown — sweep required                                                        |

Preview account (`376ef7ed81b0573f93524de763666c15`) is **out of scope** unless listed for later.

## Sweep checklist (prd account)

Use Cloudflare dashboard or API / MCP. For each category, list **all** resources, mark keep vs delete.

- [ ] **Workers** — scripts not in active deploy set (`os-prd`, `auth-*`, `events-*`, `semaphore-*`, `agents-*`, `example-*`, …)
- [ ] **Worker routes** — `os.iterate.com`, `*.iterate.app`, stale `os.*`, deleted-app hostnames
- [ ] **D1 databases** — `*-db` with no bound worker or wrong worker name
- [ ] **R2 buckets** — `*-repos`, legacy artifact buckets
- [ ] **Durable Object namespaces** — orphaned after worker delete (often removed with script)
- [ ] **KV namespaces** — Alchemy state store, old app state
- [ ] **DNS records** — zones `iterate.com`, `iterate.app` after cutover to `iterate.com` / `iterate.app`
- [ ] **Certificates / custom hostnames** — stale edge certs for removed hostnames
- [ ] **Queues / Workflows / Hyperdrive** — if any were created for deleted apps
- [ ] **Tunnels** — personal dev tunnels should not be in prd account; flag strays

## Deletion order (safe)

1. Document inventory (this task or PR comment).
2. `alchemy:down` / destroy for known stacks (`os-prd` before rename).
3. Remove worker routes → delete worker scripts → D1 → R2.
4. DNS only after nothing routes to old names.
5. Re-deploy fresh `os-prd` from renamed app.

## Sub-agent sweep output (2026-05-18)

Account: prd (`os` Doppler `CLOUDFLARE_ACCOUNT_ID` from `_shared/prd`).

### Scale

| Resource       | Total in account | Iterate-tagged (heuristic) |
| -------------- | ---------------- | -------------------------- |
| Worker scripts | **1026**         | ~197                       |
| D1 databases   | **100**          | ~52                        |

Most workers are abandoned **estate / `*-production-*` / `*-state-store`** experiments (e.g. `asterix-production-platform`, `bead-state-store`, `local-nick-*`). Not all listed below — full API list available via Workers Scripts API.

### Keep (active monorepo apps, prd)

| Worker          | D1 / notes                     |
| --------------- | ------------------------------ |
| `os-prd`        | `os-prd-db`, R2 `os-prd-repos` |
| `agents-prd`    | `agents-prd-db`                |
| `auth-prd`      | `auth-prd-auth-db`             |
| `events-prd`    | `events-prd-db`                |
| `example-prd`   | `example-prd-db`               |
| `semaphore-prd` | `semaphore-prd-resources`      |

Preview workers in **same account** (confirm before delete): `os-preview-*`, `agents-preview-*`, `events-preview-*`, `semaphore-preview-*`, `example-preview-*`.

### Delete candidates — OS / OS legacy (prd)

| Worker                                                              | Notes                        |
| ------------------------------------------------------------------- | ---------------------------- |
| `os`                                                                | Deleted `apps/os` era        |
| `os-v2`, `os` (no stage suffix)                                     | Old naming                   |
| `os-staging`, `os-test`, `os-test-2`                                |                              |
| `os-os-dev-jonas`, `os-os-dev-mmkal`                                | Dev stacks in prd account    |
| `codemode-prd`, `codemode-prd-outbound`                             | Superseded by os DOs? verify |
| `ci-ingress`, `prd-ingress-proxy`                                   | Verify unused                |
| `iterate-os-local-*`, `iterate-production-*`, `iterate-state-store` | Old iterate OS estate        |
| `ostemplate-production-*`, `ostemplate-state-store`                 | Template experiments         |

### Delete candidates — agents e2e debris

`agents-e2e-0355660c` … `agents-e2e-d95e7283` (+ matching `*-db` D1s).

### Delete candidates — cfg / proof deploys

`cfgfinalprd-example`, `cfgproofprd-example`, `cfgretestprd*`, `spacfgprd-example`, `example-proof-*` (+ D1s).

### Delete candidates — dev/stg scripts in prd account

`dev-events`, `dev-events2`, `dev-example`, `dev-example-v2`, `events-stg`, `semaphore-stg`, `prd-events2`, `prd-example`, `prd-example-v2`, `dev-*` (long tail).

### Delete candidates — estate platform cruft (~800+ workers)

Pattern: `{name}-production-{app1|platform|autopilot|…}`, `{name}-state-store`, `{name}--prod--estate`, `est-*-production-*`, `local-*-production-*`, `pr-*-platform`, etc.

**Recommendation:** scripted delete by prefix denylist + keeplist above; spot-check `alchemy-state-service`, `alchemy-asset-routing-*`, `cf-artifact-viewer-prd` before removing.

### D1 orphan pattern

Any `*-db` / `*-resources` whose worker script is deleted. Examples already orphaned-looking: `codemode-prd-db` if `codemode-prd` removed, preview DBs for destroyed previews.

### Codebase expected names after rename

| App         | Worker (prd) | D1          | R2             |
| ----------- | ------------ | ----------- | -------------- |
| os (was os) | `os-prd`     | `os-prd-db` | `os-prd-repos` |

Run second sweep post-rename; delete `os-prd` / `os-prd-db` / `os-prd-repos` after cutover.

## Acceptance

- prd account has only resources for active apps + new `os-prd` stack.
- No `os-*` or deleted `apps/os` workers/DBs remain (unless explicitly documented).
- DNS for prod points at `os.iterate.com` / `iterate.app` only.

## Not in scope (follow-ups)

- Preview account cleanup (`376ef7ed…`)
- Doppler `os-legacy-backup` secret pruning if that archive project still exists
