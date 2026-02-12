---
state: todo
priority: high
size: medium
dependsOn:
  - project-ingress-proxy-improvements
tags:
  - ingress-proxy
  - daemon
  - machine
---

# Unify canonical machine ingress links across OS worker + daemon

## Why this follow-up exists

Current PR (`machine-ingress-proxy`) changed OS machine service links to canonical ingress host form:

- `<port>__<machine_id>.<PROJECT_INGRESS_PROXY_CANONICAL_HOST>`
- Example: `https://4096__mach_123.p.os.iterate.com/`

That fixed OS-side link generation in `apps/os/backend/trpc/routers/machine.ts` via `apps/os/backend/utils/project-ingress-url.ts`.

But daemon still builds some links from OS machine-proxy paths using `ITERATE_OS_BASE_URL`:

- `apps/daemon/server/utils/observability-links.ts`
- format today: `/org/:org/proj/:project/:machine/proxy/:port/...`

Risk: inside-machine links (opencode web UI, trace links, tool output links) drift from OS canonical ingress model.

## Current code reality (duplication / split logic)

- `apps/os/backend/utils/project-ingress-url.ts`
  - canonical host normalize/validate
  - canonical URL builder
  - scheme parsing from `VITE_PUBLIC_URL`
- `apps/project-ingress-proxy/proxy-target-host.ts`
  - parses target host/port for machine ingress proxy
- `apps/os/backend/services/project-ingress-proxy.ts`
  - hostname matcher + route token parsing logic

No shared module used by both OS worker + daemon for canonical link construction yet.

## Goal

One shared source for canonical ingress URL/host parsing used by both:

1. OS worker (service link generation + env validation)
2. daemon (in-machine links like opencode web UI + jaeger + other harness URLs)

Also provide daemon/sandbox processes an explicit canonical base URL signal.

## Proposed approach

### 1) Move canonical ingress URL helpers to daemon-shared module

Create shared module in daemon package (suggestion):

- `apps/daemon/shared/project-ingress-url.ts`

Move/publish pure functions:

- `normalizeProjectIngressCanonicalHost`
- `isCanonicalIngressHostCoveredByMatchers`
- `getIngressSchemeFromPublicUrl`
- `buildCanonicalMachineIngressUrl`

Then OS imports from daemon shared module (OS already has daemon dependency in repo graph).

### 2) Inject canonical URL env into machine at create time

Add env var(s) in `apps/os/backend/services/machine-creation.ts`:

- `ITERATE_MACHINE_CANONICAL_HOST` (host only)
- `ITERATE_MACHINE_INGRESS_SCHEME` (`http|https`)
- `ITERATE_MACHINE_CANONICAL_BASE_URL` (optional convenience base URL for daemon port; or document per-port derivation)

Source of truth:

- `PROJECT_INGRESS_PROXY_CANONICAL_HOST`
- `VITE_PUBLIC_URL` scheme
- machine id from creation flow

### 3) Update daemon link builders to prefer canonical ingress links

Target files:

- `apps/daemon/server/utils/observability-links.ts`
- any other daemon link emitters returning direct UI URLs

Behavior:

- prefer canonical ingress env vars
- keep fallback to existing `/org/.../proxy/:port` links when canonical env missing

### 4) Tests + docs

- move/add tests for shared helper module
- add daemon tests for canonical-link mode + fallback mode
- update docs:
  - `apps/os/README.md`
  - daemon docs for new env vars if needed

## Implementation plan

1. Extract canonical helper functions to daemon shared module and update OS imports.
2. Wire canonical env vars in machine creation env map.
3. Switch daemon observability/session links to canonical-url-first.
4. Add unit tests for canonical + fallback behaviors.
5. Smoke-test in sandbox:
   - machine detail service links
   - daemon-generated opencode web link
   - jaeger link

## Acceptance criteria

- OS + daemon use same canonical ingress helper module.
- Daemon can construct working opencode web UI links inside machine using canonical ingress host.
- Canonical ingress env vars are present in machine process environment.
- Backward-compatible fallback works when canonical env vars absent.
- Tests cover success + fallback paths.

## Open questions

- Do we want host+scheme only, or one explicit per-port canonical base URL env var?
- Does every daemon-generated path work unchanged on canonical ingress host, or do any need proxy-path rewrite behavior?
- Should this eventually become a dedicated workspace package instead of daemon-shared file?
