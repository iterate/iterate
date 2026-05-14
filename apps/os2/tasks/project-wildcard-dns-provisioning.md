---
state: todo
priority: high
size: medium
dependsOn:
  - project-ingress-architecture.md
---

# Project Wildcard DNS Provisioning

Captured: 2026-05-14

## Objective

When an OS2 Project is created, provision a Cloudflare wildcard CNAME for the
Project's dotted app host namespace:

```text
*.<project-slug>.<project-hostname-base>
```

For production today this means:

```text
*.<project-slug>.iterate2.app
```

The CNAME should point at the same target as the existing platform wildcard:

```text
*.iterate2.app
```

Use the configured `APP_CONFIG_PROJECT_HOSTNAME_BASES` list rather than
hard-coding `iterate2.app`, so preview/dev bases follow the same path when DNS
management is enabled for them.

## Current Facts

- `apps/os2/alchemy.run.ts` registers Worker route hostnames for each configured
  project base as `<base>` and `*.<base>`.
- `ProjectDurableObject.createProject(...)` computes hosts from
  `projectHosts(...)`, writes Project state, writes global `ingress_routes`, and
  emits `events.iterate.com/project/created`.
- Dotted app hosts already exist in desired state:
  `app1.<slug>.<base>`, `app2.<slug>.<base>`, and stable-ID equivalents.
- The stable Project IDs are TypeIDs such as `proj_...`; underscores are not
  valid ordinary DNS hostname label characters, so public DNS provisioning
  should not blindly create wildcard records from `projectId`.
- Single-label aliases such as `app1__<slug>.<base>` work with ordinary
  `*.<base>` DNS and cert coverage, but they are fallback aliases rather than
  the canonical dotted app shape.
- `apps/os/alchemy.run.ts` has precedent for Cloudflare DNS upsert:
  resolve zone by name, list `dns_records` by `type=CNAME&name=...`, then create
  or update a proxied CNAME with `ttl: 1` and a managed comment.
- Cloudflare's DNS API supports:
  - `GET /zones?name=<zone>&status=active&per_page=1`
  - `GET /zones/<zoneId>/dns_records?type=CNAME&name=<record>&per_page=1`
  - `POST /zones/<zoneId>/dns_records`
  - `PATCH /zones/<zoneId>/dns_records/<recordId>`

## Target Behavior

On Project creation, after durable Project state and ingress projections are
written, OS2 kicks off DNS provisioning for every configured project hostname
base that has DNS management config.

For each base:

1. Resolve the Cloudflare zone.
2. Read the existing source CNAME record at `*.<base>`.
3. Upsert `*.<project-slug>.<base>` as a CNAME with:
   - `content`: copied from the source wildcard CNAME.
   - `proxied`: copied from the source record, defaulting to `true` only if the
     source omits it.
   - `ttl`: `1` unless we explicitly decide to preserve source TTL.
   - `comment`: `Managed by apps/os2 for project <project-id>`.
4. Do not provision `*.<project-id>.<base>` in this slice unless a DNS-safe
   stable alias is introduced. Keep that separate from slug wildcard DNS.

The operation must be idempotent. Re-running it should treat an existing record
that already points at the source wildcard target as success. This first slice
does not update existing records whose targets drift.

Provisioning should append project lifecycle events to the Project lifecycle
stream. The minimum event set is:

- `events.iterate.com/project/cname-record-created`
- `events.iterate.com/project/cname-record-creation-failed`

Each event should include `projectId`, `projectSlug`, `base`, `name`, `target`,
and enough Cloudflare record metadata or failure details to debug without
storing credentials. Treat idempotent "already exists and is correct" as
created for product semantics, but use an idempotency key based on project ID,
record name, target, and result type so retries do not spam duplicate success
events.

## Implementation Plan

### 1. Runtime Config

Extend `AppConfig` with a minimal redacted Cloudflare config:

```ts
cloudflare: z
  .object({
    apiToken: redacted(z.string().trim().min(1)).optional(),
  })
  .default({}),
```

Derive Cloudflare zone names from `projectHostnameBases`. For the first slice,
assume each configured project hostname base is also the Cloudflare zone apex,
for example `iterate2.app` or `iterate-preview-3.app`. If OS2 later needs a
base like `projects.example.com` where the Cloudflare zone is `example.com`, add
an override then.

Do not rely on deployment-time `CLOUDFLARE_API_TOKEN` automatically existing in
the runtime Worker. Bind the runtime token through Doppler/AppConfig.

Add a Doppler note/config node for:

```text
APP_CONFIG_CLOUDFLARE__API_TOKEN=<runtime DNS edit token>
```

This token needs Cloudflare `DNS:Read` and `DNS:Edit` for the relevant project
hostname zones. It is intentionally separate from `_shared` deploy-time
`CLOUDFLARE_API_TOKEN`, which Alchemy uses before the Worker is running.

### 2. Cloudflare DNS Helper

Add a small domain-local helper, likely:

```text
src/domains/projects/cloudflare-dns.ts
```

Keep it fetch-based and dependency-free. Suggested functions:

- `resolveZoneId({ apiToken, zoneName, zoneId })`
- `getCNAMERecord({ apiToken, zoneId, name })`
- `upsertCNAMERecord({ apiToken, zoneId, name, content, proxied, comment })`
- `provisionProjectWildcardDns({ config, projectId, projectSlug })`

Use structured errors that include the zone/base/record name but never include
the API token.

Return a small result union from the helper instead of only throwing:

```ts
type ProvisionProjectWildcardDnsResult =
  | { type: "created"; name: string; target: string; recordId: string }
  | { type: "already-existed"; name: string; target: string; recordId: string }
  | { type: "failed"; name: string; target?: string; reason: string }
  | { type: "skipped"; reason: "not-configured" };
```

That keeps event emission in the Project Durable Object where the lifecycle
stream is already available.

### 3. Hook Into Project Creation

In `ProjectDurableObject.createProject(...)`, after:

```ts
await this.writeProjectCreatedLifecycleEvent(summary);
await this.writeAgentsRootRule(summary);
```

kick off DNS provisioning without using `this.ctx.waitUntil(...)`. Durable
Object `waitUntil` should not be relied on for this path.

Do not block Project creation on Cloudflare DNS. A Cloudflare outage, missing
token, or certificate delay should not roll back the Project. Log failures with
enough context to retry.

Add a Project DO method such as `provisionDns()` or `repairDns()` so an admin
route/script can retry without recreating the Project.

Emit lifecycle events from this scheduled task:

- `cname-record-created` after a successful create or after confirming the
  intended record already exists and points at the right target.
- `cname-record-creation-failed` when Cloudflare config/API/source-record lookup
  fails, or when an unmanaged conflicting record already exists.

### 4. Conflict Policy

If `*.<project-slug>.<base>` exists:

- If it already matches the intended CNAME target, treat it as success.
- If it points elsewhere, do not overwrite it in this slice. Log a
  `cname-record-creation-failed` event and expose it through the retry/status
  path. This includes records with an OS2 managed comment whose source wildcard
  target has changed since initial provisioning.

If the source `*.<base>` record is missing or is not a CNAME, fail the DNS task
with a clear message. That is a deployment configuration problem.

### 5. Certificates

Creating proxied wildcard records may need Cloudflare Total TLS/advanced
certificate coverage before `https://app.<slug>.<base>` works. The OS1 dev
tunnel code has the same note after wildcard DNS creation.

Acceptance should verify both DNS and HTTPS. A successful DNS API response alone
is not enough for production readiness.

### 6. Tests

Add focused unit coverage for the DNS helper with mocked `fetch`:

- Resolves zone ID by zone name.
- Reads source `*.<base>` CNAME.
- Creates missing `*.<slug>.<base>` record.
- Patches existing managed record.
- Refuses to overwrite unmanaged conflicting record.
- Skips cleanly when DNS config/token is absent.

Add Project DO/workerd coverage that project creation schedules DNS provisioning
for configured non-local bases. Keep local `iterate.localhost` tests from
calling Cloudflare by leaving DNS config absent in the vitest app config.

## Acceptance Criteria

- Creating a Project with slug `demo` and base `iterate2.app` upserts:
  - `*.demo.iterate2.app`
- The new records copy the CNAME target from `*.iterate2.app`.
- Project creation still succeeds if DNS provisioning is skipped because runtime
  DNS config is absent.
- Cloudflare API failures are logged and retryable without Project recreation.
- DNS provisioning appends lifecycle events for created/creation-failed.
- Existing OS2 ingress tests still pass.
- A deployed smoke check can load `https://app1.<slug>.iterate2.app/` after DNS
  and certificate issuance complete.

## Open Questions

- Do we want stable-ID dotted app hosts long-term? If so, they need a DNS-safe
  stable alias rather than raw TypeIDs with underscores. If not, remove them
  from `projectHosts(...)`.
- Should DNS provisioning status be persisted in Project DO storage for UI/admin
  display, or is logging plus an admin repair method enough for the first slice?
- Do preview environments need runtime DNS automation, or should this be
  production-only until preview zone/token scoping is settled?
- Source wildcard target drift is not reconciled in the first slice. If
  `*.iterate2.app` changes target, existing `*.<project>.iterate2.app` records
  must be repaired manually or by a later reconciliation task.
