# Q — MCP must work in every self-host topology (Access-fronted + no-auth)

**Status: 🔬 researching (sub-agent).** Decision recorded in **ADR 0022** (MCP is a control-plane
concern). This ticket holds the mechanism + the test battery to prove it everywhere, early.

## Why MCP is a control-plane concern

MCP can **create projects** and **operate across projects** — a deployment-wide capability, so it can't
live inside a single project worker. It sits on the control plane alongside auth/ingress/webhooks/egress/
email (ADR 0017).

## What must be proven (the battery — Jonas wants this early + everywhere)

For each deployment topology, prove MCP works both ways:

1. **Access-fronted** — MCP through **Cloudflare Access**, on your own CF account, fully self-hosting.
   (How does an MCP client get _through_ Access — Managed OAuth / service token / the wall JWT?)
2. **No-auth** — a wide-open deployment: just hit **`/mcp`** on the deployed worker and it works.

Topologies to cover: iterate-hosted · self-hosted (own account, Access) · self-hosted wide-open ·
Miniflare/Pi. The hostname story must be clear self-hosted: default = the **`/mcp` route on the
control-plane host**; **no hardwired `mcp.iterate.com`** may break self-host.

## Open sub-questions

- **Auth through Access for a machine client** — MCP Managed OAuth (DCR+PKCE) vs Access service token vs
  the wall JWT. Which, and does it work on a self-hoster's own Access org?
- **Hostname** — is `/mcp` on the deployment host sufficient, or is a dedicated `mcp.` subdomain assumed
  anywhere? Any `mcpBaseUrl`/`mcp.iterate.com` hardwiring to remove.
- **Clean-room gap** — does `apps/kernel` expose `/mcp` at all yet? (Likely not — a lab build item.)

## Cross-refs

ADR 0022 (MCP = control-plane) · ADR 0017 (network edge) · phase-0-runbook.md (add MCP to the verify
checklist per topology) · the earlier proven Access+auth.iterate.com IdP work.

## Current facts (apps/os + kernel) — researched 2026-07-30

**Structurally control-plane ✅ (validates ADR 0022).** One deployment-wide MCP server per request
(`mcp-handler.ts:110`), tools `exec_typescript` + `ask_assistant` each taking an optional `project` slug
(`:56`); auth grants a **set** of projects (admin secret → any project by slug; OAuth → a `projects`
scope, `ProjectGrant[]` spanning many). A session is not pinned to one project — `resolveToolProject`
picks per-call (`:409`). This cross-project reach is _why_ it can't live in a project worker.

**Surface/host.** Served by the same OS worker; `rewriteMcpHostRequest` (`worker.ts:108`) rewrites the
`config.mcp.baseUrl` host onto `/api/mcp` before ingress. `mcpBaseUrl` is a dedicated 3rd-level host
(`mcp.iterate.com`, `envs.ts:151`). No `mcpBaseUrl` → only auto-derives `<appBaseUrl>/api/mcp` for
**localhost**; else throws `APP_CONFIG_MCP__BASE_URL is required` (`mcp-base-url.ts`, `mcp-handler.ts:462`).

**Auth today ≠ the wall, ≠ Cloudflare Access.** Two paths in `resolveMcpAuth` (`mcp-handler.ts:246`):
(a) admin bearer secret (deployment-wide superuser); (b) **iterate Auth OAuth resource-server** — JWT
scoped by RFC 8707 `resource` audience, opaque-token introspection via `env.AUTH`, `.well-known/oauth-
protected-resource` advertising `auth.iterate.com`. **No `cf-access-jwt` handling anywhere; no wide-open
`/mcp`** (unauth → 401; `iterateAuth` unset → 503). Both of Jonas's requirements (Access-fronted + no-auth)
are NOT met by current os code.

**Kernel has no `/mcp`** — `grep -i mcp apps/kernel` is empty; only `/api` + `DASHBOARD_APP` are reserved.
Docs assert "MCP works via the wall" but it's aspirational.

**Hardwired iterate assumptions to remove:** `mcp.iterate.com`/`mcp.iterate-preview-N.com` (`envs.ts:130,151`);
`authorization_servers` defaults to `https://auth.iterate.com/api/auth` (`mcp-handler.ts:449`);
`resolveMcpBaseUrl` only auto-derives for localhost.

## The model (Jonas, 2026-07-30): MCP is a SIBLING TO `/api` on the headless control plane

Not a path reserved on _project_ hostnames (my earlier bad framing). **MCP is a control-plane endpoint,
right next to `/api`** — both **headless control-plane surfaces** (no app, no UI), differing only in
_protocol_: `/api` speaks capnweb, `/mcp` speaks MCP. Both do the same job: **authenticate via the wall →
hit the directory to list your projects + create new ones → operate across them.**

**Three faces of the control plane:**

- **`/api`** — programmatic (capnweb).
- **`/mcp`** — agent/LLM (MCP). Cross-project: connect with no project → it lists yours and lets you
  **create** one → then operate. This _is_ "emerge with a project" (ADR 0029).
- **dashboard** — human (a UI; the one with an app). Cross-project-ish too — the resemblance Jonas spotted.

**Addressing (resolves the earlier path-route objection):** `/api` and `/mcp` are the control plane's OWN
endpoints, so a path is fine _here_ — they belong on the **control plane's own hostname**, headless. The
objection was only to carving `/mcp` out of _project_ hostnames. Note the current one-worker quirk: `/api`
is served on project hostnames today (the fetch handler resolves a project host first). The clean home for
`/api` + `/mcp` is the control plane's own front door — which is exactly what motivates the
control-plane/project-worker split (ADR 0017).

## Recommendation (updated)

The kernel **wall** is a cleaner fit than os's bespoke OAuth. Smallest to prove "MCP everywhere":

1. **`/mcp` as a sibling to `/api` on the (headless) control plane** — same auth (wall) + directory
   surface, MCP protocol instead of capnweb. On the control plane's own hostname (once split); no path
   reserved on project hostnames.
2. **MCP auth via the wall, not a ported resource-server:** Access-fronted = Access Managed-OAuth-for-MCP
   injects the JWT the wall verifies; no-auth = wall unset → anonymous. Both fall out of the 47-line wall.
3. **Config-driven URLs** — no `mcp.iterate.com`/`auth.iterate.com` literals.

## Test battery (Phase-0-adjacent)

Per topology, prove both: **MCP through Cloudflare Access** (own account, self-hosting) and **no-auth
`/mcp`** on a wide-open deploy. Add to phase-0-runbook.md verify checklist.
