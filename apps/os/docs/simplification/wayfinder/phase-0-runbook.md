# Phase 0 runbook — prove the deployment topologies (no streams)

**Goal:** stand up the clean-room kernel in each topology and prove ingress routing + auth + confinement
work — repeatably, across accounts and machines. **No capability behind it** (no streams): the served
thing is just the confined config worker's page + the dashboard + `whoami`/`/__debug`.

**The proof, per topology (the observable):**

1. `create` a project (capnweb dial — `scripts/dial-create.mjs`).
2. reach it at `<slug>.<hostBase>` → the confined config worker serves.
3. reach `dashboard--<slug>.<hostBase>` → the kernel-reserved dashboard serves.
4. auth behaves: walled → Access challenge + verified caller; wide-open → anonymous, no challenge.
5. confinement holds: `/__debug` shows `seenBindings === ["ITX"]`.
6. **MCP** (ADR 0022): both **through Cloudflare Access** (Managed-OAuth-for-MCP → wall verifies) _and_
   **no-auth `/mcp`** on a wide-open deploy. _(Kernel has no `/mcp` yet — a lab build item; see
   mcp-everywhere.md.)_

**Two `pnpm dev` modes (ADR 0023) — both are lab topologies:**

- **project-worker-only** — spin up just the project worker behind iterate's hosted control plane.
- **full-stack** — spin up your own control plane + project hosting locally (self-hosted/Pi floor). This
  is the "run the entire control plane locally" topology — a Miniflare _whole-stack_ run, distinct from
  the project-worker-only one.

## Inventory (real values)

| thing                                                    | value                                                                                                                                               | source                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **prd account** (ours)                                   | `04b3b57291ef2626c6a8daa9d47065a7`                                                                                                                  | wrangler.jsonc:6 / envs.ts:33                  |
| **preview account** (ours, unused by kernel)             | `376ef7ed81b0573f93524de763666c15`                                                                                                                  | envs.ts:35 — quick stand-in "customer account" |
| **Jonas personal account** (the real "customer" account) | `05958bb7b57a2ac7eb5d3906fd3cf8bb` — token-accessible, `workers:write`                                                                              | `wrangler whoami`                              |
| **customer test domain**                                 | `iterate-e2e-test-custom-cloudflare-domain.com` (in personal `05958…`, purpose-built) + spare `jispwoso.com`/`lispwoso.com`/`mispwoso.com`          | personal account zones                         |
| **spare domain pools**                                   | garple + iterate dev/preview accounts hold _hundreds_ of parked domains                                                                             | zone listing                                   |
| **tunnel (Homelab findability)**                         | `<name>.tunnels.iterate.com` — captun gateway (`apps/tunnels`), `CAPTUN_TOKEN`; public → local Miniflare                                            | docs/tunnels.md, envs.ts:420                   |
| **hosted domain**                                        | `templestein.iterate2.app` (route `*.templestein.iterate2.app/*`, zone `iterate2.app`, prd)                                                         | wrangler.jsonc:29,39                           |
| **self-host base domain**                                | `shiterate.com` (route `*.shiterate.com/*`, prd) — wildcard **proven live**                                                                         | wrangler.jsonc:55 / README:90                  |
| **wildcard base we provide**                             | `iterate.app` / `iterate2.app` — our CP hands out `<slug>.iterate2.app` even for remote project workers                                             | envs.ts:154                                    |
| **dashboard vessel**                                     | `kernel-mini-os.iterate.workers.dev`                                                                                                                | wrangler.jsonc:30                              |
| **wall (hosted)**                                        | Cloudflare Access app AUD `1086cc92…96db0`, issuer `iterate-com.cloudflareaccess.com`, header `cf-access-jwt-assertion`; **IdP = auth.iterate.com** | wrangler.jsonc:29                              |
| **wall (self-host)**                                     | Cloudflare Access app AUD `f878523…b28` (same team, different app); **IdP intended = Google-direct** (confirm in CF dashboard)                      | wrangler.jsonc:51                              |
| **directory KV** (selfhost/dev)                          | `DIRECTORY_KV` = `402ac6e2e34f45d38d171abb630d434d`                                                                                                 | wrangler.jsonc:49                              |
| **secret**                                               | `PROJECT_APP_SESSION_SECRET` — committed POC var (same across profiles); real deploy must supply via Doppler/`wrangler secret`                      | wrangler.jsonc:33 / README:31                  |
| **CF API token**                                         | ambient (`wrangler login` / `CLOUDFLARE_API_TOKEN`) — required to deploy; not scripted in kernel                                                    | —                                              |

## The matrix — archetype × substrate × wrangler profile

The **wall is Cloudflare Access** whenever walled (the `WallConfig` carries the Access app's AUD). Two
things vary behind it: the **IdP** (a Cloudflare-dashboard setting — Google-direct or auth.iterate.com)
and the **directory** (our config — kv or auth). "Wide open" = no wall at all.

| archetype                     | wrangler env                                     | account                           | domain / host                     | wall           | IdP (behind Access)                                                                 | directory        | status                                                                                  |
| ----------------------------- | ------------------------------------------------ | --------------------------------- | --------------------------------- | -------------- | ----------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------- |
| **iterate-hosted**            | _(default)_ `pnpm deploy`                        | prd `04b3…`                       | `<slug>.templestein.iterate2.app` | Access `1086…` | **auth.iterate.com**                                                                | auth.iterate.com | ✅ live                                                                                 |
| **self-hosted, walled**       | `--env selfhost`                                 | prd `04b3…` _(our account today)_ | `<slug>.shiterate.com`            | Access `f878…` | **Google-direct** _(the "no auth.iterate.com" proof; confirm the Access app's IdP)_ | kv               | ✅ proven live                                                                          |
| **self-hosted, wide-open**    | _(new — clone selfhost, drop `wall`)_            | prd or preview                    | a zone you own                    | none           | —                                                                                   | kv               | 🟡 config only                                                                          |
| **Miniflare / Pi**            | `--env dev` (`pnpm dev`)                         | none (local workerd)              | `<slug>.localhost:<port>`         | none           | —                                                                                   | kv               | ✅ works (Loader on workerd, e2e-verified)                                              |
| **separate customer account** | selfhost-shaped, new `account_id` + token        | **customer** ⬜                   | a customer zone                   | Access or none | Google-direct or —                                                                  | kv               | ⬜ **the real Phase-0 build**                                                           |
| **Tenant/Homelab ingress**    | control plane reverse-proxies to a remote origin | prd (CP) → remote (PW)            | `<slug>.<hostBase>` → remote      | at CP          | (CP's IdP)                                                                          | —                | 🟡 prototype via `serveDashboard`-style `fetch` proxy; full ITX needs capnweb (Phase 1) |

The two walled rows are the clean IdP contrast: **iterate-hosted = Access→auth.iterate.com→auth
directory** (multi-tenant); **self-hosted walled = Access→Google-direct→kv directory** (single-tenant,
zero auth.iterate.com dependency). One live check to run: confirm the `shiterate.com` Access app's IdP is
actually Google-direct (it's a Cloudflare-dashboard setting, not in our config).

Note: "self-hosted" today still runs in **our** prd account (`shiterate.com` is our zone). The genuinely
new thing Phase 0 must prove is the **separate customer account** row — same bundle, different
`account_id` + API token + zone — which we have never done. That is the isolation proof.

## Per-topology steps

### A. iterate-hosted (baseline — already live)

- **Deploy:** `cd apps/kernel && pnpm deploy`
- **Create + verify:** `node scripts/dial-create.mjs` against the host; browse `https://<slug>.templestein.iterate2.app` (Access challenge → login) and `dashboard--<slug>.…`; check `/__debug`.
- **Teardown:** projects are directory rows (auth.iterate.com); remove test rows.

### B. self-hosted walled (proven live)

- **Deploy:** `cd apps/kernel && npx wrangler deploy --env selfhost` (+ `cd mini-apps/os && pnpm run deploy` for the dashboard vessel)
- **Verify:** same, against `<slug>.shiterate.com`; Access AUD `f878…`.
- **Prereq (manual, once per zone):** wildcard DNS + Total TLS on the zone (routes alone don't provision it — README:185).

### C. self-hosted wide-open

- Add a `selfhost-open` env: copy `selfhost`, **remove `wall`** from `APP_CONFIG`, point `hostBase`/`routes` at a zone you own. Deploy. Verify **no** auth challenge; caller anonymous; confinement still holds.

### D. Miniflare / Pi

- **Run:** `cd apps/kernel && pnpm dev` → `wrangler dev --env dev`
- **Verify:** create offline; browse `http://<slug>.localhost:<port>`; kill + restart → directory state (kv) intact. This is the Pi floor.

### E. separate customer account ⬜ the real build

- Pick/obtain a **distinct Cloudflare account** + a scoped **API token**.
- New env (`--env customerN`): its `account_id`, a zone in that account, `directory:{provider:"kv"}` (fresh KV namespace **in that account**), `PROJECT_APP_SESSION_SECRET` supplied as a real secret (not the committed var), wall optional.
- **`ensure-resources` gap:** kernel has no resource-provisioning script — creating the KV namespace + route in a fresh account is manual today (the future `provision-account` script, D11).
- **Deploy** with that account's token; create + verify. **This proves same-bundle-different-account.**

### F. Tenant/Homelab ingress (optional prototype, no capnweb)

- Reuse the `serveDashboard` reverse-proxy shape (`kernel.ts:439`, generic `fetch(proxied)`) so the control plane forwards `<slug>.<hostBase>` to a **remote** origin (a worker in another account, or a box behind a tunnel). Proves the ingress-routing half of Tenant/Homelab without capnweb; full ITX-over-capnweb is Phase 1.

## MCP test matrix (ADR 0022) — prove both auth modes per topology

MCP is part of the topology playbook. Prove it across topologies **and** both auth modes:

| topology                                             | no-auth `/mcp`                                    | authenticated MCP                                |
| ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| **iterate-hosted**                                   | — (walled)                                        | Access Managed-OAuth-for-MCP → the wall verifies |
| **self-hosted, walled** (your account + your Access) | —                                                 | MCP through **your own** Access org              |
| **self-hosted, wide-open**                           | hit `/mcp` directly, anonymous caller             | —                                                |
| **Miniflare / local self-host** (`pnpm dev`)         | connect locally to the **config-driven** MCP host | optional local wall                              |

**Miniflare / local self-host is a form of self-hosting:** `pnpm dev` with the appropriate `APP_CONFIG`
→ connect locally to the configured MCP host (e.g. `APP_CONFIG_MCP__BASE_URL` = `http://mcp.<slug>.localhost:<port>`
or just `/mcp` on the dev host). Requires the MCP base URL to be **config-driven** — the kernel must not
assume `mcp.iterate.com`.

**Kernel build items to make any of this real** (kernel has no `/mcp` today): (1) a **kernel-reserved
`/mcp` route** carved before `resolveIngress` (like `/api`/`DASHBOARD_APP`); (2) **MCP auth via the wall**
— Access JWT when walled, anonymous when the wall is unset; (3) **config-driven MCP base URL** (no
`mcp.iterate.com`/`auth.iterate.com` literals). See mcp-everywhere.md.

## The repeatable harness (what to build)

- A `lattice up --mode <hosted|selfhost|selfhost-open|dev|customerN>` wrapper over `wrangler deploy --env …` + the dashboard-vessel deploy + a create-and-verify smoke (`dial-create.mjs` + a curl/`/__debug` check). One command, any substrate.
- A fixed **verify checklist** (the 5 observables above) run identically per mode.

## Gaps & decisions surfaced

1. **Second/customer account** — use the preview account `376ef…` as a quick stand-in, or obtain a
   genuinely third-party account for a real isolation proof? _(Rec: preview account first to move fast;
   a true third-party account before claiming the isolation guarantee.)_
2. **`ensure-resources` for a fresh account** — manual for now; the `provision-account` script (D11) is
   the eventual fix.
3. **Custom-domain → project routing table (KV)** — not built; only slug parsing. Defer (slug convention
   suffices for Phase 0). Needed later for "project = your own domain".
4. **Secret handling** — `PROJECT_APP_SESSION_SECRET` is a committed POC var; a real deploy (esp. a
   customer account) must supply it via `wrangler secret`/Doppler. Kernel has **no Doppler wiring** today.
5. **Wildcard DNS/TLS is manual per zone** — not provisioned by `routes`.

## Proven live (2026-07-30)

- ✅ **Self-hosted, walled** — `kernel-selfhost` deployed to `*.shiterate.com` (prd `04b3…`); confinement
  holds live (`smoke-test.shiterate.com/__debug` → `seenBindings:["ITX"]`, anonymous public site).
- ✅ **Routing table, live** — a `route:` key written to the live `ROUTING_KV` made
  `routing-proof.shiterate.com` resolve to `routed-live` (overriding slug-parse), then cleaned up. The KV
  read path works in production.
- ✅ **Separate customer account (isolation)** — the SAME bundle deployed to **Jonas personal `05958…`**
  as `kernel-personal` (`kernel-personal.templestein.workers.dev`); `/__debug` → `seenBindings:["ITX"]`
  in a different account. **Finding: the customer account needs Workers Paid** — Worker Loaders are
  paid-plan-only (`error 10195`); personal was upgraded. workers.dev only for now; a burnable personal
  domain + route is the next step (the OS custom-domain e2e zone `iterate-e2e-test-custom-cloudflare-domain.com`
  is off-limits — it CNAMEs to `cname.ingress.iterate.com`).
- ⬜ **iterate-hosted** (default, iterate2.app) + **Miniflare/dev** — not yet re-smoked this pass.
