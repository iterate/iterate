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
- `apps/os/alchemy.run.ts` has precedent for Cloudflare DNS management:
  resolve zone by name, list `dns_records` by `type=CNAME&name=...`, then create
  or update a proxied CNAME with `ttl: 1` and a managed comment.
- Cloudflare's DNS API supports:
  - `GET /zones?name=<zone>&status=active&per_page=1`
  - `GET /zones/<zoneId>/dns_records?type=CNAME&name=<record>&per_page=1`
  - `POST /zones/<zoneId>/dns_records`

## Target Behavior

On Project creation, after durable Project state and ingress projections are
written, OS2 kicks off DNS provisioning for the first configured project
hostname base when DNS management is configured.

For that canonical base:

1. Resolve the Cloudflare zone.
2. Read the existing source CNAME record at `*.<base>`.
3. Create `*.<project-slug>.<base>` as a CNAME with:
   - `content`: copied from the source wildcard CNAME.
   - `proxied`: copied from the source record, defaulting to `true` only if the
     source omits it.
   - `ttl`: `1` unless we explicitly decide to preserve source TTL.
   - `comment`: `Managed by apps/os2 for project <project-id>`.
4. Do not provision `*.<project-id>.<base>` in this slice unless a DNS-safe
   stable alias is introduced. Keep that separate from slug wildcard DNS.

The first slice should optimize for the happy path and the least code that makes
that path work. It should not try to solve idempotent target lookup, general DNS
ownership, target drift, or unusual zone layouts.

Provisioning should append project lifecycle events to the Project lifecycle
stream. The minimum event set is:

- `events.iterate.com/project/cname-record-created`
- `events.iterate.com/project/cname-record-creation-failed`

Each event should include useful debugging context: `projectId`, `projectSlug`,
`base`, `name`, `target`, Cloudflare record metadata when available, and failure
details when applicable. Do not include credentials. Treat idempotent "already
exists and is correct" as out of scope for this slice.

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

Derive the Cloudflare zone name from `projectHostnameBases[0]`. For the first
slice, assume that canonical project hostname base is also the Cloudflare zone
apex, for example `iterate2.app` or `iterate-preview-3.app`. Do the simplest
thing that works for current OS2 domains.

Do not rely on deployment-time `CLOUDFLARE_API_TOKEN` automatically existing in
the runtime Worker. Bind the runtime token through Doppler/AppConfig.

Add a Doppler note/config node for:

```text
APP_CONFIG_CLOUDFLARE__API_TOKEN=${_shared.<config>.CLOUDFLARE_API_TOKEN}
```

This token needs Cloudflare `DNS:Read` and `DNS:Edit` for the relevant project
hostname zones. It is intentionally separate from `_shared` deploy-time
`CLOUDFLARE_API_TOKEN`, but references the same underlying token in Doppler so
runtime DNS provisioning and Alchemy deployment use the same Cloudflare account
credentials per environment.

This has been configured on the `os2` root configs:

- `dev`: `${_shared.dev.CLOUDFLARE_API_TOKEN}`
- `preview`: `${_shared.preview.CLOUDFLARE_API_TOKEN}`
- `prd`: `${_shared.prd.CLOUDFLARE_API_TOKEN}`

### 2. Cloudflare DNS Helper

Add a small domain-local helper, likely:

```text
src/domains/projects/cloudflare-dns.ts
```

Keep it fetch-based and dependency-free. Suggested functions:

- `resolveZoneId({ apiToken, zoneName, zoneId })`
- `getCNAMERecord({ apiToken, zoneId, name })`
- `createCNAMERecord({ apiToken, zoneId, name, content, proxied, comment })`
- `provisionProjectWildcardDns({ config, projectId, projectSlug })`

Use plain errors that include the zone/base/record name but never include the
API token.

Add short comments around intentionally simple behavior, especially:

- no runtime token means log and skip DNS provisioning;
- local/localhost bases are skipped;
- existing target records may fail Cloudflare creation and are not reconciled;
- this is create-only happy-path DNS provisioning, not a DNS reconciler.

Return success details from the helper and throw on failure. Keep the call site
simple:

```ts
type ProvisionProjectWildcardDnsSuccess = {
  name: string;
  target: string;
  recordId: string;
};
```

Emit the lifecycle events wherever it takes the least code. In practice this is
probably the Project Durable Object wrapper, because it already knows the
Project lifecycle stream.

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

Emit lifecycle events from this scheduled task:

- `cname-record-created` after a successful create.
- `cname-record-creation-failed` when Cloudflare config/API/source-record lookup
  fails, including if the target record already exists.

### 4. Conflict Policy

Do not preflight-check whether `*.<project-slug>.<base>` exists. If Cloudflare
rejects creation because a record already exists, treat that as
`cname-record-creation-failed` in this slice.

If the source `*.<base>` record is missing or is not a CNAME, fail the DNS task
with a clear message. That is a deployment configuration problem.

### 5. Certificates

Creating proxied wildcard records may need Cloudflare Total TLS/advanced
certificate coverage before `https://app.<slug>.<base>` works. The OS1 dev
tunnel code has the same note after wildcard DNS creation.

Acceptance should verify both DNS and HTTPS. A successful DNS API response alone
is not enough for production readiness.

### 6. Proof

Do not add automated tests in the first slice. Prove the feature through a real
PR preview deployment:

1. Push the implementation branch and open a PR.
2. Deploy or wait for the OS2 preview deployment for that PR.
3. Ensure the preview Doppler config has
   `APP_CONFIG_CLOUDFLARE__API_TOKEN` configured.
4. Create a throwaway Project through the preview OS2 Project creation path.
5. Confirm Cloudflare has a CNAME for `*.<slug>.<preview-base>` with content
   copied from `*.<preview-base>`.
6. Confirm the Project lifecycle stream contains
   `events.iterate.com/project/cname-record-created`.
7. After DNS/certificate propagation, load
   `https://app1.<slug>.<preview-base>/`.

Also prove the failure branch once by temporarily using a bad token or a
throwaway base without a source wildcard, then confirm the lifecycle stream
contains `events.iterate.com/project/cname-record-creation-failed`.

## Acceptance Criteria

- Creating a Project with slug `demo` and base `iterate2.app` upserts:
  - `*.demo.iterate2.app`
- The new records copy the CNAME target from `*.iterate2.app`.
- Project creation still succeeds if DNS provisioning is skipped because runtime
  DNS config is absent.
- Cloudflare API failures are logged and represented as lifecycle events.
- DNS provisioning appends lifecycle events for created/creation-failed.
- Manual proof above is completed.
- A PR preview smoke check can load `https://app1.<slug>.<preview-base>/` after
  DNS and certificate issuance complete.

## Open Questions

- Do we want stable-ID dotted app hosts long-term? If so, they need a DNS-safe
  stable alias rather than raw TypeIDs with underscores. If not, remove them
  from `projectHosts(...)`.
- Should DNS provisioning status be persisted in Project DO storage for UI/admin
  display later, or are lifecycle events enough?
- Do preview environments need runtime DNS automation, or should this be
  production-only until preview zone/token scoping is settled?
- Source wildcard target drift is not reconciled in the first slice. If
  `*.iterate2.app` changes target, existing `*.<project>.iterate2.app` records
  must be repaired manually or by a later reconciliation task.
