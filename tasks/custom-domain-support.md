---
state: todo
priority: high
size: large
dependsOn: []
---

# Custom domain support for projects

Allow projects to use a custom domain (e.g. `templestein.com`) instead of `<slug>.iterate.app`.

## Requirements

1. **DB column**: `custom_domain` nullable text on the `project` table.
2. **Settings UI**: input field on the project settings page to set/clear the custom domain.
3. **Env var override**: when `custom_domain` is set, `ITERATE_PROJECT_BASE_URL` and `ITERATE_PROJECT_INGRESS_DOMAIN` should use it instead of `<slug>.iterate.app`.
4. **Routing**: the CF Worker must recognise custom-domain hostnames and route them the same as `*.iterate.app` hostnames.
5. **Subdomain structure on custom domains**:
   - `templestein.com` → port 3000 on the active machine (same as `templestein.iterate.app`)
   - `4096.templestein.com` → port 4096 (note: dot separator, not `__` — friendlier for custom domains)
   - `4096__mach123.templestein.com` → port 4096 on specific machine
   - `opencode.templestein.com` → port 4096 (named service alias)
6. **Named service aliases**: a lookup map of friendly names → ports (`opencode` → 4096, `terminal` → 4096, etc.)

## Implementation plan

### Phase 1: DB + settings UI

1. **Migration**: add `custom_domain text` column to `project` table (nullable, no default).
2. **Schema**: add `customDomain: t.text()` to the project table definition in `apps/os/backend/db/schema.ts`.
3. **oRPC update endpoint**: extend `project.update` input schema to accept `customDomain` (optional string or null to clear). Add validation: must be a valid hostname, no scheme/port/path, no wildcard.
4. **Settings form**: add "Custom domain" input field below slug in `apps/os/app/routes/proj/settings.tsx`. Show helper text about DNS setup.

### Phase 2: Env var injection

5. **`buildMachineIngressEnvVars()`** in `packages/shared/src/project-ingress.ts`: accept optional `customDomain` param. When set:
   - `ITERATE_PROJECT_BASE_URL` = `https://<customDomain>` (instead of `https://<slug>.<ingressDomain>`)
   - `ITERATE_PROJECT_INGRESS_DOMAIN` = `<customDomain>` (instead of `iterate.app`)
6. **`buildMachineEnvVars()`** in `apps/os/backend/services/machine-creation.ts`: pass `project.customDomain` through.
7. **`resolveMachineSetupData()`** in `apps/os/backend/services/machine-setup.ts`: same — propagate custom domain into env file.

### Phase 3: Worker routing for custom domains

8. **`shouldHandleProjectIngressHostname()`** in `apps/os/backend/services/project-ingress-proxy.ts`: currently only checks against `PROJECT_INGRESS_DOMAIN`. Must also check against DB-stored custom domains.
   - **Performance concern**: this runs on EVERY request. Options:
     - (a) KV/cache lookup of known custom domains
     - (b) DB query with edge cache (short TTL)
     - (c) Load all custom domains into a Set at startup — won't scale but fine for now
     - (d) Check against an env-var list of custom domains (requires redeploy on change)
   - **Recommendation**: use (b) — DB query with `cache` API or a Durable Object map. For MVP, a simple DB query is fine since custom domains will be rare.

9. **`parseProjectIngressHostname()`** in `packages/shared/src/project-ingress.ts`: needs to handle custom domain hostnames. The parsing is currently tightly coupled to `<token>.<rootDomain>` where root domain = `iterate.app`. For custom domains, the root IS the custom domain, so:
   - `templestein.com` → project target, port 3000
   - `4096.templestein.com` → project target, port 4096
   - `opencode.templestein.com` → project target, port 4096 (alias lookup)
   - `4096__mach123.templestein.com` → machine target, port 4096
   - This requires a new parse path: when the hostname is a known custom domain (or subdomain of one), parse the subdomain label differently than the `<slug>` pattern.

10. **`handleProjectIngressRequest()`**: after parsing, resolve the project by custom domain instead of by slug. Add a DB lookup: `WHERE custom_domain = ?`.

11. **`buildCanonicalProjectIngressProxyHostname()`**: needs custom domain awareness for redirect logic.

### Phase 4: Cloudflare routing (implemented)

12. **CF for SaaS custom hostnames**: uses the outbox system to register/delete custom hostnames via CF API when a project's custom domain changes. Implementation:
    - `backend/services/cloudflare-custom-hostname.ts` — CF Custom Hostnames API wrapper
    - `backend/outbox/client.ts` — `project:custom-domain-set` and `project:custom-domain-removed` events
    - `backend/outbox/consumers.ts` — `registerCustomHostname` and `deleteCustomHostname` consumers
    - `backend/orpc/routers/project.ts` — emits outbox events on `project.update`
    - `alchemy.run.ts` — `CF_CUSTOM_HOSTNAME_API_TOKEN` and `CF_CUSTOM_HOSTNAME_ZONE_ID` env bindings
    - **One-time setup required**: Enable CF for SaaS on iterate.app zone, set fallback origin to `cname.iterate.app`, add env vars in Doppler

13. **DNS instructions for users**: the settings UI already shows DNS instructions (CNAME to `cname.iterate.app`).

### Phase 5: Named service aliases

14. **Port alias map**: define a static map in `packages/shared/src/project-ingress.ts`:
    ```
    opencode → 4096
    terminal → 4096
    ```
    During hostname parsing, if the subdomain label matches an alias name, resolve to the mapped port.

## Open questions

1. **Cloudflare for SaaS vs manual worker routes?** CF for SaaS is the clean path — it handles SSL certs, fallback origins, and routing automatically. Manual routes + custom certs would be fragile. **Recommendation: CF for SaaS.**

2. **Custom domain subdomain separator**: should we use `.` (dot) or `__` (double underscore) for port prefixes on custom domains?
   - `4096.templestein.com` (dot) — cleaner, standard subdomain, but requires wildcard DNS
   - `4096__templestein.com` (double underscore) — consistent with iterate.app, but ugly for custom domains
   - **Recommendation: use `.` (dot) for custom domains.** Users setting up custom domains will have wildcard DNS anyway. Keep `__` for iterate.app for backwards compat.

3. **Auth bridge for custom domains**: the current auth bridge redirects to `os.iterate.com` for login, then back to `*.iterate.app`. Custom domains need the same flow — the redirect target changes. The bridge-start logic in `worker.ts` needs to handle custom domain hosts. Is Better Auth session cookie sharing across custom domains feasible, or do we need per-domain auth cookies?
   - **Likely answer**: same one-time-token bridge pattern, just with the custom domain as the redirect target. No cookie sharing needed.

4. **Should `ITERATE_PROJECT_INGRESS_DOMAIN` change for custom domain machines?** If yes, daemon code that builds URLs (observability links, agent debug links) will use the custom domain. If no, we need a separate env var like `ITERATE_CUSTOM_DOMAIN`. **Recommendation: change it** — the whole point is that the custom domain IS the project's domain.

5. **Multiple custom domains?** For now, just one per project. If needed later, make it a separate table.

6. **Validation**: should we verify DNS is pointed correctly before accepting the custom domain? CF for SaaS has built-in hostname verification. For MVP, just accept the value and show DNS instructions.

## Files to modify (with inline comments in this PR)

- `apps/os/backend/db/schema.ts` — add `customDomain` column
- `apps/os/backend/orpc/routers/project.ts` — extend update input
- `apps/os/app/routes/proj/settings.tsx` — add custom domain field
- `packages/shared/src/project-ingress.ts` — handle custom domain parsing + env vars + aliases
- `apps/os/backend/services/project-ingress-proxy.ts` — custom domain routing
- `apps/os/backend/services/machine-creation.ts` — pass custom domain to env var builder
- `apps/os/backend/worker.ts` — custom domain hostname check
- `apps/os/alchemy.run.ts` — CF for SaaS setup (later phase)
