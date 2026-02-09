# Platform Layer Architecture

> **Document rules**
>
> - Sacrifice grammar for concision
> - This is a working document — notes, open questions, rough edges are fine
> - Clean up once all open questions resolved
> - ASCII diagrams only, keep them light

## Overview

```
          INGRESS                                          EGRESS
            │                                                ▲
            ▼                                                │
┌────────────────────────────────────┐                       │
│  OS Layer (Cloudflare)             │                       │
│                                    │                       │
│  ┌──────────────────────────────┐  │                       │
│  │  Ingress Worker (skinny)     │  │                       │
│  │  • resolve project from host |  │                       │
│  │  • auth / verify webhook sig │  │                       │
│  │  • forward via CF tunnel     │  │                       │
│  └──────────────┬───────────────┘  │                       │
│                 │                  │                       │
│           Cloudflare Tunnel        │                       │
│            (only way in)           │                       │
└─────────────────┬──────────────────┘                       │
                  │                                          │
                  ▼                                          │
┌────────────────────────────────────────────────────────────┼───┐
│  Project  (misha.iterate.app)                              │   │
│                                                            │   │
│  ┌──────────────────────────────────────────────────────┐  │   │
│  │  Project Machine (trusted)                           │  │   │
│  │  • sees real secrets                                 │  │   │
│  │  • terminates TLS                                    │  │   │
│  │  • runs HITL approval                                │  │   │
│  │  • injects secrets into egress                       │  │   │
│  │  • ingress routing to agent machines                 │──┘   │
│  │  • egress proxy (only exit for agent machines)       │      │
│  │  • webapp, SQLite, Doppler sync                      │      │
│  └─────────────┬──────────────────────▲─────────────────┘      │
│                │                      │                        │
│          only way in            only way out                   │
│                │                      │                        │
│                ▼                      │                        │
│  ┌────────────────────────────────────┼─────────────────────┐  │
│  │  Agent Machine(s) (untrusted)      │                     │  │
│  │  • agents run here (with root)                           │  │
│  │  • PTY / terminal                                        │  │
│  │  • NO secrets in memory, ever                            │  │
│  │  • no direct internet access                             │  │
│  │  • all ingress/egress via project machine                │  │
│  │  • currently 1, designed for N                           │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

**Auth model:** The OS edge does ALL authentication. By the time a request arrives at the project machine via the tunnel, it's already authenticated. The project machine is unauthenticated by default — the tunnel IS the access control. Two auth scenarios at the edge:

1. **Browser/API request** — OS checks cookies, access tokens, shared secrets. Adds auth header (JWT or similar).
2. **Webhook** — OS verifies webhook signature (e.g. Slack signing secret). Extracts external ID (Slack team ID) to resolve project.

## API surface at a glance

### Hosts

| Host                                       | Layer         | What                                                          |
| ------------------------------------------ | ------------- | ------------------------------------------------------------- |
| `os.iterate.com`                           | OS            | Webapp (Better Auth, billing UI), tRPC, skinny ingress worker |
| `{project}.iterate.app`                    | Project       | Project ingress via Cloudflare tunnel → project machine       |
| `{port}--{machine}--{project}.iterate.app` | Agent Machine | Service on a specific port of a specific agent machine        |

### Hostname scheme

One wildcard cert for `*.iterate.app`. All routing info is encoded in the subdomain prefix. The project machine knows its own base URL (e.g. `misha.iterate.app`) and parses incoming hostnames relative to that.

```
misha.iterate.app                        → project machine (default route)
3000--misha.iterate.app                  → project machine port 3000
3000--mach_abc--misha.iterate.app        → agent machine mach_abc, port 3000
```

The pattern: `{port}--{machineId}--{project}.iterate.app`

- If just `{project}` → project machine, default route
- If `{port}--{project}` → project machine, specific port
- If `{port}--{machineId}--{project}` → agent machine, specific port

The project machine parses the prefix, resolves the target machine + port, and proxies. The OS ingress worker doesn't need to understand this — it just forwards everything for `*.iterate.app` to the right project's tunnel. The project machine does the rest.

**Standalone / bring-your-own-domain:** The same prefix parsing works with any base domain. A user running `npx iterate` locally could use `localhost:8000` as their base URL, and the project machine would parse `3000--mach_abc--localhost:8000` the same way. Or they bring their own domain: `3000--mach_abc--myproject.example.com`. The project just needs to know its base URL.

### OS Layer — `os.iterate.com`

```
tRPC  /api/trpc/*
  user, organization, project, billing, accessToken

oRPC  /api/orpc/*
  project.reportStatus     (project machine → OS)
  TBD — OS only talks to projects, never directly to machines

REST
  /api/auth/*              Auth (Better Auth)
  /api/integrations/slack/{callback,webhook,interactive,commands}
  /api/integrations/github/{callback,webhook}
  /api/integrations/google/callback
  /api/integrations/stripe/webhook
  Webhook handler extracts external ID (e.g. Slack team ID)
    → looks up project → forwards to project ingress

Skinny worker
  Ingress worker:  resolves project from hostname → forwards via tunnel
```

### Project Layer — project machine (trusted)

```
oRPC  /api/orpc/*
  secrets.list, secrets.set, secrets.delete
  envVars.list, envVars.set, envVars.delete
  approvals.list, approvals.get, approvals.approve, approvals.reject
  machines.list, machines.health
  TBD — project lifecycle, routing config

REST
  /api/integrations/*/webhook    Receives forwarded webhooks from OS
    → routes to correct agent machine
  /api/egress-proxy              Egress proxy for agent machines
    → HITL check → inject secrets → forward to internet

React webapp (SPA)
  Full-stack app, hits project oRPC + agent machine oRPC
  Includes /terminal UI (xterm) — but PTY websocket is on agent machine
```

**Storage:** SQLite per project (self-contained, no external DB dependency)

### Agent Machine Layer — agent daemon (untrusted)

```
oRPC  /api/orpc/*
  agent.list, agent.create, agent.start, agent.stop
  agent.conversation.*
  daemon lifecycle

REST
  /api/pty/ws                    Terminal WebSocket
  /api/files/{read/*,upload}     File access
  /api/health
```

## Layer 1: OS Layer

Cloudflare Workers. Skinny, idiomatic, edge-native. **Optional** — projects can run without it.

**Owns:**

- Billing & metering
- Project topology (which projects exist, where they live)
- Authentication of external requests to projects
- **Iterate-owned OAuth clients** (Slack, Gmail, GitHub, etc.) — shared across all projects
- **Webhook multiplexing** — receives webhooks from third parties, extracts external ID (Slack team ID, GitHub installation ID, etc.), routes to correct project
- Supplies OAuth client credentials to project machines as env vars / secrets
- Creates Cloudflare tunnels via API on project creation → gives access token to project machine
- Supervision / health monitoring

**Does NOT own:**

- Machines — the OS layer does not know about individual machines. It only knows projects.
- Secrets management at runtime — it supplies credentials, but the project machine manages them
- HITL — that's project-layer
- Egress — the project machine talks directly to the internet. No OS-layer egress proxy.

**One skinny worker:**

- **Ingress worker** — resolves project from hostname, auths request, forwards via Cloudflare tunnel to project machine

**Hosts:** `os.iterate.com`

**Key implementation:** Durable Objects for per-project state (tunnel lifecycle, project config)

## Layer 2: Project Layer

Runs on the **Project Machine** (trusted). This is the core of the system — most "business logic" lives here. Machine-resident, not Cloudflare-resident.

**Owns:**

- Secrets storage and injection (OAuth tokens, API keys, env vars)
- HITL approval queue and enforcement (SQLite table)
- Egress proxy — intercepts outbound requests from agent machines, does HITL + secret injection, forwards directly to internet
- Ingress routing — HTTP lookup table mapping routes to agent machines + ports
- Cloudflare tunnel client (receives access token from OS layer as env var, establishes tunnel)
- **Full-stack React webapp** — the primary UI for interacting with the project
  - Hits project oRPC router (secrets, env vars, approvals)
  - Hits agent machine oRPC routers (agent CRUD, conversations)
  - Includes terminal UI (xterm.js) — renders locally, connects to PTY WebSocket on agent machine
- Metering data collection → reports to OS layer
- Integration webhook routing — receives webhooks from OS, routes to correct agent machine

**Does NOT own:**

- Billing (that's OS layer)
- OAuth client registration (OS layer holds the shared clients)
- Agent orchestration (that's agent machine layer)

**Storage:** SQLite per project. Self-contained. No external database dependency. (Currently PlanetScale — migrating to SQLite.)

**Hosts:** `{project}.iterate.app` (via Cloudflare tunnel)

**Trust model:** Trusted. Users do not get shell access. Secrets can live in memory. This machine runs our code only.

## Layer 3: Agent Machine

Where agents actually run. Agents have root. **Assume hostile to secrets — no raw credentials in memory, ever.**

**Owns:**

- Agent lifecycle (create, start, stop, destroy)
- Agent conversations and tool execution
- PTY/terminal WebSocket (`/api/pty/ws`)
- File system access (`/api/files/*`)
- Health reporting

**Does NOT own:**

- Secrets (must request through project machine egress proxy)
- HITL decisions
- Ingress routing
- Any database

**Hosts:** `{port}--{machine}--{project}.iterate.app`

**Trust model:** Untrusted. Agents have root and may try to exfiltrate secrets. All network egress goes through the project machine's egress proxy. No direct internet access.

**Codebase:** Same monorepo, both project machine and agent machine run PIDNAP but with different app configurations. Different daemon entrypoints.

Currently: 1 project machine + 1 agent machine per project. Designed for N agent machines.

## Ingress path

### Browser → project webapp

```
Browser → GET misha.iterate.app/
  │
  ▼
OS Layer (skinny ingress worker)
  ├─ resolve project "misha"
  ├─ auth request (cookies / access token / shared secret)
  ├─ add auth header
  └─ forward via Cloudflare tunnel
        │
        ▼
      Project Machine
        ├─ ingress routing table
        │   GET / → project webapp (local, port 3000)
        └─ serve React app
```

### Webhook → agent

```
Slack → POST os.iterate.com/api/integrations/slack/webhook
  │
  ▼
OS Layer
  ├─ extract Slack team ID from payload
  ├─ look up project for this team ID
  └─ forward to project ingress via tunnel
        │
        ▼
      Project Machine
        ├─ route webhook to correct agent machine
        └─ forward to agent machine
              │
              ▼
            Agent Machine → agent handles webhook
```

### Browser → agent API

```
Browser → POST misha.iterate.app/agents/banana-king
  │
  ▼
OS Layer (skinny ingress worker)
  └─ forward via tunnel (same as above)
        │
        ▼
      Project Machine
        ├─ ingress routing table
        │   POST /agents/* → agent machine
        └─ proxy to agent machine oRPC/API
              │
              ▼
            Agent Machine → daemon handles request
```

## Egress path

```
Agent process → HTTP request to api.stripe.com
  │
  ▼
Agent Machine (no direct internet)
  └─ routed to project machine egress proxy
        │
        ▼
      Project Machine (egress proxy)
        ├─ HITL check (block / allow / ask user via approval queue)
        ├─ inject secrets (e.g. replace placeholder with real API key)
        ├─ meter request
        └─ forward directly to internet
              │
              ▼
            api.stripe.com
```

## Key design principles

1. **Standalone-first.** A project (project machine + agent machines) must work without the OS layer. OS adds billing, auth, webhook mux — not runtime capability.

2. **Machine-agnostic.** Machines are Linux environments with a network connection. Currently Fly.io. Architecture must not depend on any provider.

3. **Secrets never touch agent machines.** Project machine holds and injects secrets. Agent machines are assumed compromised.

4. **OS layer is thin.** Skinny Cloudflare workers. No heavy compute. Webhook multiplexing, auth, billing, tunnel provisioning.

5. **OS doesn't know about machines.** OS knows about projects. Project machine manages its own agent machines internally.

6. **N agents per machine, N machines per project.** Currently 1:1:1. Architecture must not prevent scaling either dimension.

7. **`npx iterate` must work.** It must be possible to run a project locally with your own domain (or localhost). No dependency on `iterate.app`, Cloudflare, or the OS layer. Bring your own domain, bring your own everything.

8. **Prefixed opaque IDs.** All database IDs are prefixed by entity type (e.g. `proj_abc123`, `mach_def456`, `agnt_ghi789`). IDs are opaque strings — never rely on slugs being stable. Prefixes prevent cross-entity confusion across layers.

## Deployment configurations

Three ways to run iterate. Each uses the same project machine + agent machine architecture. What changes is who provisions machines and where they run.

### Config 1: Hosted platform (production)

The full stack. Customers pay us. OS layer runs in Cloudflare.

```
OS Layer (Cloudflare)  →  Project Machine (Fly.io)  →  Agent Machine (Fly.io)
```

**What the customer gets:**

- We set up OAuth clients (Slack, GitHub, Gmail, etc.) — shared across all projects
- Webhook multiplexing — webhooks just work, no customer config
- Pass-through billing for LLM usage, compute, etc.
- Web UI for project management, secrets, HITL approvals
- Tunnel-based ingress — project gets `{project}.iterate.app` automatically
- Doppler-managed secrets — customer sets secrets in UI, they sync to project machine

**What the customer doesn't do:**

- No Docker, no Fly account, no infra management
- No OAuth app registration with third parties
- No DNS config

### Config 2: `npx iterate` (self-hosted / local)

User runs a project locally. No OS layer. No Cloudflare. Everything runs on their machine.

```
npx iterate
  ├─ install Docker (or use Fly.io if user has a key)
  ├─ run project machine (container or Fly)
  ├─ run agent machine (container or Fly)
  └─ open project UI at localhost
```

**Two paths on first run:**

1. **Existing customer** — `npx iterate login` → OAuth with `os.iterate.com` → pick project → CLI points at the hosted project. Gives you local access to a deployed project.
2. **New / local-only** — `npx iterate init` → creates `iterate.config.ts` + `.env` → spins up project machine + agent machine in Docker → project UI at `localhost:8000`.

**What works:**

- HITL approval — project machine runs it locally, UI in project webapp
- Secrets — user provides own `.env`, no Doppler needed
- Egress proxy — project machine proxies agent traffic, injects secrets
- Webhooks — user configures their own webhook URLs pointing at their machine (or uses a tunnel tool like ngrok)
- OAuth — user registers their own OAuth apps with third parties, provides client ID/secret in `.env`

**What the user brings:**

- Their own env vars / secrets (`.env` file)
- Their own OAuth clients (if they want integrations)
- Their own domain or just use localhost
- Docker or a Fly.io account

**Upsell path:** CLI can prompt "want us to handle OAuth, webhooks, billing? Sign up for hosted iterate."

### Config 3: Iterate engineers (development)

Full platform running locally for development. Used by iterate engineers working on the platform itself.

```
OS Layer (miniflare / wrangler dev)  →  Project Machine (Docker)  →  Agent Machine (Docker)
```

**What this looks like:**

- `pnpm dev` runs the OS worker locally via wrangler/miniflare
- Can provision new projects → spins up project machine + agent machine in local Docker (or Fly.io)
- Full end-to-end testing of the three-layer stack
- Uses `doppler run --config dev` for dev secrets

**Future:** Dockerize the miniflare OS worker so the entire stack runs in `docker compose up`.

## Tunnel lifecycle

1. OS layer creates a Cloudflare tunnel via API when a project is created
2. OS gives the tunnel access token to the project machine (as env var)
3. Project machine uses the token to establish the tunnel
4. **THE ONLY WAY to reach the project from outside is through this tunnel**
5. OS ingress worker routes `{project}.iterate.app` requests through the tunnel

## Clarity checklist

- [ ] **Third-party integration with external IDs.** When Slack sends a webhook, the OS layer extracts the Slack team ID from the payload and looks up which project this belongs to. Same pattern for GitHub (installation ID), Google, etc. The OS layer is a webhook multiplexer keyed by external integration IDs.
- [ ] **OAuth client ownership.** Iterate owns the OAuth clients (Slack app, GitHub app, etc.). These are shared across all projects. The OS layer stores the client ID + secret. It supplies them to project machines so they can make authenticated API calls.
- [ ] **Secret flow.** OS supplies integration credentials → project machine stores them + other user secrets → project machine injects them into agent egress requests. Agent never sees raw values.
- [ ] **Two webapps.** OS layer has a skinny React app (Better Auth, billing, org/project management). Project machine has a full React app (agent interaction, terminal, secrets management, HITL approvals).
- [ ] **PTY split.** Terminal UI (xterm.js) lives in the project webapp. PTY WebSocket endpoint lives on the agent machine. The project webapp connects to the agent machine's `/api/pty/ws` directly (proxied through project machine).
- [ ] **SQLite per project.** Each project machine has its own SQLite database for HITL approvals, secrets, env vars, routing config. No shared external database.
- [ ] **Same codebase, different apps.** Project machine and agent machine both run PIDNAP with different app configurations/entrypoints.

## Open questions

- [ ] **Standalone ingress.** Without Cloudflare tunnel, project machine exposes ports directly (or user brings ngrok/cloudflared). Needs to be documented per deployment config.
- [ ] **Agent machine internet access.** Fully blocked except through project machine? Or some direct access with monitoring? How is this enforced at the network level?
- [ ] **Auth between project machine and agent machines.** What's the internal auth model? mTLS? Shared secret? Network isolation only?
- [ ] **Machine topology control.** Can the project machine add/remove its own agent machines? Or does this go through the OS layer? (If standalone-first, projects need to self-manage.)
- [ ] **OS-layer egress in future?** Currently no egress worker. If we ever need OS-level egress policy (rate limiting, billing metering, IP allowlisting), we'd add a skinny egress worker. For now, project machine goes directly to internet.
- [ ] **Project machine naming.** Currently "Project Machine." Other options: "Gateway," "Coordinator," "Hub." The document uses "Project Machine" throughout.
- [ ] **Browser → agent machine direct path.** For PTY WebSocket and oRPC calls from the project webapp to agent machines — does this go through the project machine as a proxy? Or does the browser connect more directly? Latency matters for terminals.
- [ ] **OS layer naming.** Document currently uses "OS Layer." Confirm this is final — it matches existing codebase (`apps/os/*`).

## Secrets delivery: Doppler

Two categories of env vars:

1. **Bootstrap env vars** — set at machine provisioning time by OS layer (via Fly API, or manually for standalone). Tiny set: `DOPPLER_TOKEN`, tunnel access token, machine addresses.

2. **User-managed secrets** — Slack bot token, Stripe API key, OAuth tokens, etc. Managed via Doppler. Synced periodically to `.env` on disk.

The only thing a project machine needs from its parent is a `DOPPLER_TOKEN`. Everything else flows from that.

```
OS webapp → user sets secret "STRIPE_KEY"
  │
  ▼
OS layer → writes to Doppler (one config per customer project)


Project machine (has DOPPLER_TOKEN as bootstrap env var)
  └─ periodic sync: doppler pull → .env on disk
  └─ secrets are plain env vars, easy to debug
  └─ survives Doppler outage (cached .env)
```

**Standalone:** user just writes `.env` manually. No Doppler needed. Project machine reads env vars from environment, doesn't care where they came from.

- [ ] **Doppler at scale.** Check pricing. Confirm API supports creating configs per customer project programmatically.

## Raw notes (still to process)

- Platform worker ingress pattern: `return getFetcher(req)(req)` — skinny worker resolves a fetcher per request then delegates
- Gateway operates at L2/3 of network stack for ingress/egress interception
- Auth options at OS layer: cookies, access tokens from static list, future OAuth, shared secrets between user and third party
