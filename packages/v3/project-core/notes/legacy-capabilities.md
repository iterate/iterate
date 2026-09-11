# Legacy capability reconnaissance

This note records the minimum semantics worth carrying from `apps/os` into
`packages/v3/project-core`. It is deliberately a design input, not a porting
plan: the old system has considerably more topology and compatibility machinery
than the requested clean-room core should inherit.

## Boundary to preserve

An Iterate project is a tenant and authority boundary. A context is a
path-addressed event log plus its durable reduction, subscriptions and hosted
code. The platform must retain the few operations that userspace must never
implement itself:

1. authenticate a caller and attach an authority/identity to every append;
2. protect secret material and substitute it only at the final egress hop;
3. decide whether a signed approval is valid before releasing held egress;
4. load a project config worker with only the project's scoped `itx` and
   egress bindings.

Repositories, approval policy, approval presentation, and the config worker's
event reactions can all be ordinary event-sourced applications above that
boundary.

## Repositories

The useful legacy model is not a filesystem API. It is a repository lifecycle
saga whose durable record is the repo stream:

- `repos/create-requested` is intent; `repos/created` or
  `repos/create-failed` is the terminal certificate. A transient infrastructure
  failure remains open and is redriven; a classified domain failure settles the
  saga and closes further reactions. See
  `apps/os/src/domains/repos/repo-processor-implementation.ts`.
- Every default-branch change becomes one normalized `repo/commit-completed`
  fact. OS writes have a durable outbox before acknowledgement; external
  Cloudflare Artifact/GitHub pushes normalize to the same fact with an idempotency key.
  This is what makes a config worker react once per committed revision.
- A repository has one authoritative head. Reads may cache it, but a worker
  build must refuse a head known to be converging rather than acknowledge an
  event with stale config. The precise cache/observed-push logic is in
  `apps/os/src/domains/repos/repo-durable-object.ts` and
  `repo-head-authority.ts`; retain the invariant, not the Artifacts/Git
  implementation.
- GitHub is ingress/mirroring, not a competing history. The compact first
  version can provide a local immutable revision/file-map repository and
  `commit` event. GitHub sync, workspaces, branch operations and a full Git
  object store are later adapters.

Minimal project-core API shape: `project.repos.get(name).commit(files,
message)` emits a durable revision fact; `read(revision?)` returns a pinned
file map. A config worker is selected from an explicit repo/revision source.
Do not make a source branch implicitly reproducible: build/replay needs a
pinned revision (and eventually a resolved dependency lock) in its cache key.

## Project config worker and `processEvent`

OS installs its default repo-backed project worker as a subscription on the
project root stream. `ProjectRpcTarget.processEventBatch()` delegates to the
loaded worker and translates an unseeded repo/cold build into a retryable
receiver-unavailable result, so delivery is not skip-confirmed. Source:
`apps/os/src/rpc-targets.ts` (the `ProjectRpcTarget.processEventBatch` method)
and `apps/os/src/domains/workers/worker-runner.ts`.

The clean-room already has the better primitive: a subscription target whose
only acknowledgement is successful `processEventBatch(events, range)`. A
project config worker should therefore be a normal hosted processor/facet that
subscribes to the project root, not a special runner. Its code should expose:

```ts
processEvent({ event, state, append, egress, actor });
```

or the existing batch processor base which invokes that hook serially. Preserve
these delivery rules from `packages/v3/project-worker/src/stream/processor.ts`
and the old repo processor:

- reduce is deterministic and replayable;
- per-event facts needed for correctness block the cursor until appended;
- state-derived slow work is represented by durable intent/state and is
  redrivable at the head;
- a non-ready config worker is a bounded, observable retry state, never a
  successful skipped delivery;
- the configuration source and loaded-worker identity are visible on the
  subscription, so a new revision has an explicit lineage transition.

Do not retain the OS bootstrap stack (repo facet, worker bundler sidecar,
project-wide special worker alias) in project-core. A tutorial can first use
an inline config processor, then replace its source reference with a repo
revision; that demonstrates the exact same contract in two layers.

## Secrets

The legacy secret-cell invariant is the one non-negotiable design to carry:
"material goes in; nothing comes out except a request to a pinned host."
Authoritative source: `apps/os/docs/adr/0005-the-secret-cell-invariant.md` and
`apps/os/src/domains/secrets/secret-durable-object.ts`.

Required semantics:

- `put(name, material, { origins })` writes material; `list/describe` reveal
  metadata only. There is no general read, compute, export, cross-secret or
  userspace binding lane.
- Encrypt at rest with associated data binding project/context, secret name,
  approved origins and the committed material revision. OS recomputes on
  compare-and-append contention; see `domains/secrets/crypto.ts` and
  `secret-durable-object.ts`.
- Substitute only in trusted final egress code, then validate the final URL
  against the pin. Reject host/query placeholders, foreign/multiple secret
  references and unpinned redirects; follow credential-bearing redirects
  manually and boundedly. Append an audit event before dispatch.
- A secret revision can be used conditionally, so a late provider rejection
  cannot clear newly rotated material. Refresh is a trusted named strategy,
  not user-provided code run with the secret.

Current v3 has plaintext `SECRETS_KV` and whole-URL/header substitution in the
egress tail (`project-worker/wrangler.jsonc`,
`packages/v3/shared/src/egress.ts`). The clean-room's own assessment calls out
the missing write door and origin pin:
`project-worker/docs/plan-one-fetch-rules.md` §§C13 and risks. Build those as
a compact `itx.secrets` built-in before any repo/config-worker code can spend
secret placeholders. Choose one grammar now; the existing v3 spelling is
`{{secret:project:NAME}}`.

## Human approval

OS's strongest approval idea is that an approval is cryptographically bound to
the exact held request batch, not a mutable UI row. The source is
`apps/os/src/domains/projects/egress-approvals.ts`.

Its canonical `approval.v2` bytes cover project id, the request event offset,
each request subject, its index and the complete verdict vector. A decision is
verified against an enrolled public key and rejects stale/malformed/signature
invalid input. The lifecycle is:

```text
approval/requested -- signed decision --> approval/decided
    --> approval/released | approval/refused
```

Expiry is an all-reject decision. A request offset plus index is the stable
identity of an individual held request; the gate must never let a signature
for one batch release another. Key enrolment/revocation and policy are ordinary
project events reduced by an approval processor. The egress door only holds,
matches and releases requests. This is the right layering for the tutorial:

1. the egress middleware emits `approval/requested` and waits;
2. a userspace approval facet reduces policy/keys and verifies decisions using
   a shared pure canonicalisation module;
3. a human CLI or UI signs the canonical bytes with a private key;
4. the final gate releases only a verified, unexpired matching index.

Time is a real prerequisite: expiry needs a durable alarm that appends an
ordinary `alarm/fired` event. The clean-room review identifies this as a small
missing core feature (`project-worker/docs/reviews/2026-09-02-futures.md` §3.2).

## Signed event identity and authority (historical sketch)

This was an early design proposal, not the current contract. The implemented
envelope uses plural `provenance.signatures[]`, not a singular signature or
authenticated `issuer`/`authority` claims. See the current
[signature model](signatures.md) and [provenance prior art](provenance-prior-art.md).
The sketch below is retained to explain the design's evolution.

OS has principals for RPC authentication (`apps/os/src/auth/principal.ts`) and
special approval signatures, but ordinary stream records do not make a
verifiable author signature a first-class portable datum. Project-core should
fix that at append time, rather than bolt it onto approval events later.

Use an immutable event envelope with separate fields for:

```ts
{
  id, context, offset, occurredAt, type, payload,
  issuer: { kind: "anonymous" | "project" | "user" | "service", id },
  authority: { scopes: string[], credentialId?: string },
  signature?: { algorithm: "Ed25519", keyId, value }
}
```

The signed bytes must be canonical and include an explicit domain/version plus
context, event id, event type, payload bytes, issuer and authority claims.
Do not sign the server-assigned offset unless the server co-signs after commit;
the client cannot know it. Verify a client signature before appending, bind it
to an enrolled key/credential, and store the verification result as immutable
server-attested provenance. Loaded code receives the resulting `actor`, never
ambient credentials.

This permits intentionally unsafe bootstrap projects: anonymous unsigned
appends can be allowed by a root policy, then ordinary policy/key events can
progressively require signed scopes. The rule must be evaluated at the single
append gate and visibly recorded for every event; otherwise a second append
path becomes an authority bypass. Approval is then a specialized signed event
whose canonical body additionally binds its held request subjects.

## E2E/deployment evidence available now

`packages/v3/project-worker` already supplies the production-shaped harness
to copy, rather than inventing tests:

- `e2e/vitest.config.ts` and `e2e/support/global-setup.ts` run the real worker
  from `wrangler.jsonc` in local workerd, speaking Cap'n Web over `/api`.
- `WORKER_BASE_URL=<deployed URL> pnpm e2e` runs that exact suite against a
  deployed worker, with no local boot. This is the acceptance lane requested
  for project-core; support for public remote fixtures is explicit.
- `e2e/support/solo-config.ts` patches the checked-in config only in memory to
  bind the fallback to a local `DummyControlPlane`; it prevents tests from
  requiring a live deployment for every iteration.
- A genuine multi-worker test requires the control-plane shell plus project
  worker in the same workerd. `packages/v3/cloudflare-os-conventions.md` §4
  describes the intended `wrangler dev -c ...` fleet command and notes that
  the current one-worker e2e lane does not prove the cross-script fallback
  hop.

For the new package, the essential deployed E2E scenarios are: an unsigned
bootstrap append followed by policy lock-down; rejected wrong-context/wrong-key
signatures; config worker exactly-once event effect through eviction/retry;
repo revision causes the next config reaction to use the pinned revision;
secret egress succeeds only for its exact origin and never appears in RPC/log
state; and a signed approval releases only its matching held request while
expiry refuses it.
