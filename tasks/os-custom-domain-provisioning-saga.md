---
state: todo
priority: high
size: large
dependsOn: []
tags: [os, cloudflare, custom-domains, stream-processors, saga]
---

# Custom domain provisioning as a multi-event saga

## Problem

Custom domains today are almost a one-shot side effect disguised as an event:

1. UI/CLI appends `events.iterate.com/project/custom-domain-add-requested`.
2. Reduce immediately marks the domain `status: "requested"`.
3. `processEvent` **synchronously** (via `blockProcessorWhile`) calls Cloudflare
   `POST /custom_hostnames`, snapshots the result, and appends either
   `custom-domain-cloudflare-observed` or `custom-domain-provision-failed`.
4. Routing KV is primed only when Cloudflare reports `status === "active"`.
5. The UI shows DNS checklist rows (ownership TXT, ACME TXT, apex + wildcard
   CNAME → `cname.<projectHostnameBase>`) and a manual **Refresh** button.

That is weaker than project creation, which is an explicit multi-step saga:

- birth certificate + durable subscriptions
- sibling births (capability host, scheduler, config repo, email, …)
- waits / cross-posts
- terminal `project/created`

Custom domains need the same discipline: **desired state is not live traffic**,
progress is event-sourced and observable, recovery is bounded, and the UI
reflects each stage without pretending “Add” finished provisioning.

Concrete gaps (seen in production cutover of `garple.com`):

- Eager CF create on `add-requested` conflates “user asked for domain” with
  “provider object exists / cert issued / DNS correct.”
- Wildcard app hosts (`counter.<domain>`) need `*.domain` CNAME as well as apex;
  the UI lists it but nothing verifies it, so apex can go green while app
  subdomains stay dead.
- No automatic re-observation while DNS is pending — only manual refresh.
- Failures and stuck `pending_validation` lack a clear terminal / retry model
  (compare: project bootstrap errors must not hang the processor forever).
- Customer DNS is always out-of-band; the platform should classify **missing
  CNAME vs missing TXT vs CF active** rather than one opaque CF status string.

## Goal

Turn custom-domain lifecycle into a **proper multi-event saga** on the project
processor (same architectural bar as project create), with:

1. Explicit stages as reduced state + emitted facts (not one ensure() blob).
2. Separation of **desired** (`*-requested`) from **progress** and **ready**.
3. Bounded observation / retry (alarms or scheduled refresh), not only UI
   refresh.
4. Clear DNS checklist + optional platform-side DNS checks that surface
   apex vs wildcard gaps.
5. Tests that prove the saga red→green without live Cloudflare (and a thin
   live/e2e path where we already have SaaS-enabled envs).

## Current map (do not invent a second path)

| Piece                                 | Location                                                     |
| ------------------------------------- | ------------------------------------------------------------ |
| UI add/refresh/remove                 | `apps/os/src/components/project-custom-domains-settings.tsx` |
| Events + `ProjectCustomDomain` state  | `apps/os/src/domains/projects/project-processor-contract.ts` |
| Reduce + `blockProcessorWhile` ensure | `apps/os/src/domains/projects/custom-domain-processor.ts`    |
| CF client + KV prime-on-active        | `apps/os/src/domains/projects/custom-domains.ts`             |
| Ingress exact + `<app>.<custom>`      | `apps/os/src/ingress.ts`, project hostname directory         |

Preserve: single project processor ownership, CF as certificate/hostname
authority, KV hostname directory as routing source of truth when active,
wildcard cert default (`ssl.wildcard: true` today).

## Proposed saga shape

Names are suggestive; implementer may refine contracts but must keep
**request → observe → ready/fail** as distinct facts.

### Desired state (user / product)

- `events.iterate.com/project/custom-domain-add-requested`  
  Payload: `{ hostname }`. Reduce: upsert domain `status: "requested"`.  
  **Must not** be the only place that performs unbounded CF work if that
  blocks the processor for long waits — either keep create short, or split
  “open CF object” into a follow-on step.

- `events.iterate.com/project/custom-domain-remove-requested`  
  (existing) → remove CF object + KV + drop state.

### Progress (system)

- `…/custom-domain-cloudflare-ensure-started` or fold into first observation  
  Optional if create is still immediate; useful for telemetry.

- `…/custom-domain-cloudflare-observed` (existing)  
  Snapshot: CF id, hostnameStatus, sslStatus, ownership + validation records,
  wildcard flag, mapped product `status` (`pending_validation` | `active` | …).

- `…/custom-domain-dns-observed` (**new**, recommended)  
  Platform-resolved (or CF verification_errors-derived) view of:
  - apex points at SaaS fallback (`cname.<base>` or documented target)
  - `*.hostname` points at same when wildcard cert is requested
  - ownership / ACME TXT present when CF still requires them  
    Does **not** replace CF as authority for TLS; it explains _why_ CF is stuck
    and why app subdomains 404 DNS.

- `…/custom-domain-refresh-requested` (existing)  
  Force re-observation; also emitted by scheduler/alarm while not terminal.

### Terminal

- Ready for traffic: reduced `status: "active"` **and** KV primed (today’s
  `reconcileProjectHostnameRegistration` when CF status active). Prefer an
  explicit fact if it helps audit, e.g. `…/custom-domain-ready`, but avoid
  dual sources of truth — either derive ready from last observation or emit
  one ready event from the saga step that primes KV.

- `…/custom-domain-provision-failed` (existing) for hard CF/API failures with
  durable error string; retry via refresh/add, not silent swallow.

### Processor rules

- Match project-create style: short critical sections, durable progress on
  the stream, **no** multi-minute `blockProcessorWhile` waits for customer DNS.
- While status is non-terminal (`requested` / `pending_validation`), schedule
  bounded re-observation (project scheduler, stream alarm, or existing
  obligation pattern — pick one consistent with stream-processor docs).
- Stop scheduling once `active` or removed; cap retries / backoff; surface
  last error and last observation time in state for the UI.
- Never mark routing active (KV) until CF hostname is active (keep current
  safety). Optionally require dns-observed apex OK before celebrating in UI
  even if CF is active (edge: CF can activate before wildcard DNS exists).

## UI

- Keep checklist (authorize / certificate / connect traffic including
  `*.domain`).
- Drive status badge from saga stages, not only raw CF strings.
- Show **per-record** hints when `dns-observed` or CF verification_errors
  imply missing CNAME / TXT (especially wildcard).
- Auto-refresh while pending (poll or liveState), with manual refresh kept.
- Copy: “Requested” means we accepted the domain; “Active” means traffic can
  serve this project on that hostname.

## Tests

1. **Unit / processor harness** (primary):
   - add-requested → requested state, ensure called once
   - observed pending → pending_validation, no KV prime
   - observed active → active + KV prime
   - dns-observed missing wildcard → UI-facing state still explains gap
   - remove → CF delete + KV clear
   - refresh while pending re-runs observation  
     Follow `docs/writing-stream-processors.md` and existing
     `custom-domain` / project-processor tests.

2. **Contract examples** updated for any new events.

3. **E2E** (optional follow-up or same PR if cheap): preview SaaS slot where
   custom hostnames exist; assert checklist + status transitions. Link
   `tasks/os-iterate-com-custom-domain-preview-e2e.md` if that lands first.

## Out of scope

- Auto-writing DNS in the customer’s Cloudflare/Route53 account (no OAuth DNS
  provider product yet).
- Changing ingress resolution rules for `<app>.<custom-hostname>`.
- Custom metadata entitlement / account SaaS enablement (ops, not this saga).
- Fixing cold project-create DO failures (separate incident).

## Acceptance criteria

- [ ] Custom domain lifecycle is modeled as multi-step events + reduced state
      comparable in clarity to project bootstrap (request ≠ ready).
- [ ] CF create/observe/remove remain in the project processor; no second
      provisioning path.
- [ ] Pending domains re-observe on a bounded schedule; active/removed stop.
- [ ] Wildcard traffic requirement is first-class in state and/or UI (apex OK
      does not hide missing `*.domain` DNS when wildcard cert is on).
- [ ] KV hostname registration only when CF hostname is active (preserve
      current invariant).
- [ ] Processor tests cover request → pending → active and failure paths
      without live Cloudflare.
- [ ] UI reflects stages and DNS steps without requiring a code dig to
      understand CNAME setup.

## Implementation notes

- Start from `custom-domain-processor.ts` + contract; avoid rewriting
  `createCloudflareCustomDomainProvisioner` unless the ensure/refresh split
  needs cleaner interfaces for “create only” vs “snapshot only.”
- Prefer extending `ProjectCustomDomain` with optional dns fields over a
  parallel array.
- Idempotency keys: keep per-hostname keys so retries do not spam CF creates
  (already partial via find + metadata ownership).
- Telemetry: stage transitions should be classifiable (no unexplained error
  spam from expected pending DNS) — see monorepo “no deviant system
  behaviour” principle.

## References

- Project create saga: `apps/os/src/domains/projects/project-processor-implementation.ts`,
  `apps/os/src/rpc-targets.ts` (`projects.create`)
- Current custom domains: `custom-domain-processor.ts`, `custom-domains.ts`,
  `project-custom-domains-settings.tsx`
- Stream processor obligations / recovery: `docs/writing-stream-processors.md`
- Preview apex e2e (related): `tasks/os-iterate-com-custom-domain-preview-e2e.md`
