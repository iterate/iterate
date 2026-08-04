# 12 — Streams across shells: a context is a SCOPE, not an island of streams

Type: research
Status: resolved
Blocked by: —

Jonas: today there's a weird `__null__` projectId → a special `global.iterate` stream DO name. The control
plane needs to read/write streams (append `project-created` / creation-requests to project streams; inbound
webhooks). But on the way OUT, nothing in a project should append to or even SEE these outer streams. And
there's a further-out case: the **iterate product** wants a stream of ALL inbound Slack/GitHub webhooks (for
debugging). And we want to **write code the same way in outer and inner layers.** Terminology worry: "outer
shells are just contexts" — does that mean a context has its own **isolated** streams? "Probably not... seems
a bit crazy."

## The terminology fix (the crux)

**A context is NOT an island of isolated streams. A context is a SCOPE + a resolver — a _lens_ into ONE
shared stream namespace.** Streams aren't "inside" a context; a context is a view with a particular
visibility. This resolves the worry directly: the control-plane context and a project context look at the
**same** namespace; they differ only in **how much of it they can name**.

## The model to verify (against the apps/os research)

**One stream namespace** (faux-URL DO names, as today). Each shell's context has a **scope** = the set of
stream paths it may resolve. Scopes are **nested by containment** (product ⊇ control-plane ⊇ project):

```
PRODUCT context scope     : product/*   +  cp/*  +  prj_*/*        (sees everything)
CONTROL-PLANE context scope:              cp/*  +  prj_*/*         (all projects + its own global streams)
PROJECT context scope     :                       prj_<id>/*        (ONLY its own)
```

- **Outer reaches IN, inner cannot reach OUT.** The control plane can `streams.get("prj_x/…")` and append
  `project-created` to a project's stream (it's in scope). A project **cannot** name `cp/…` or another
  `prj_y/…` — out of scope → resolve denied. This is exactly the **call-time narrowing / downward-only**
  rule (`02`) applied to the stream namespace.
- **`__null__`/global reframed:** today's `global.iterate` (null projectId) streams become **the
  control-plane context's own streams** (`cp/directory`, `cp/webhook-ingress`, …) — not a special null case,
  just the outer shell's scope. The product's Slack-debug stream is a stream in the **product** scope
  (`product/webhooks/slack`). So today's single "global" level becomes **two** outer levels (cp + product).
- **Uniform code across layers:** a stream processor is a stream processor at ANY scope. The control plane's
  "route webhooks into projects" is a processor on `cp/webhook-ingress` that appends into `prj_x/…`; the
  product's "debug all Slack webhooks" is a processor on `product/webhooks/slack`. Both are the SAME
  `defineProcessor` shape — scope is a property of the _context they run in_, not of the code. That's "write
  code the same way in outer and inner layers."

## Big open questions to flag (Jonas asked)

1. **Hostnames + DO names.** Currently DO names are "faux URLs" (`events.iterate.com/…`, `global.iterate/…`).
   Keep that? How does a name encode its **scope level** (project vs cp vs product)? Is the faux-URL host the
   scope discriminator?
2. **Are ingress/egress really just `fetch`?** (still open — D13 says yes-through-the-onion, but the DO-name
   ↔ hostname relationship needs to hold up.)
3. **Exact visibility shape:** does the PRODUCT context see the control-plane's `cp/*` streams, or only
   `product/*` + `prj_*/*`? (Probably sees cp too — it's the outermost.)
4. **How does an outer shell append into an inner stream** — a scoped `streams.get(path).append` (because the
   path is in scope), or a `cross-post`? (apps/os has `acceptCrossPost` — research.)
5. **Enforcement:** the scope is enforced where? The context's stream-collection RpcTarget refuses
   out-of-scope names (constructive: it can only construct names within its prefix). That's the natural
   guard — a project's `streams` RpcTarget literally cannot build a `cp/…` DO name.

## Answer (CORRECTED by Jonas + apps/os research)

**Jonas (2026-08-03): "our own hosted deployment should only have ONE streams namespace."** So retract the
three-tier nested-namespace proposal above. The correct model = **ONE deployment namespace with TWO address
tiers** — which is exactly what apps/os already does:

- **DO names are faux URLs** (`apps/os/src/domains/durable-object-names.ts`, `DurableObjectNameCodec`):
  `{projectId}.iterate{path}` per-project, `global.iterate{path}` when `projectId === null`
  (`GLOBAL_DURABLE_OBJECT_HOST = "global"`, suffix `.iterate`). One reserved global host — **flat, not
  layered.** Parsed literally with `new URL(...)`.
- **⚠️ Naming disambiguation:** the DO-address namespace is `.iterate` (`{projectId}.iterate`,
  `global.iterate`). `events.iterate.com/*` is a **different** namespace — the _event-type vocabulary_
  (e.g. `events.iterate.com/integration/connection-claimed`). Do not conflate the two.
- **Two tiers, one bit of authority:** `assertCanAccessProject(projectId)` (`auth.ts:164`) — a project
  principal may name ONLY its own projectId; `projectId === null` (the global tier = "the platform project")
  requires **admin**. So the tiers are just **per-project** and **global/admin**, gated by one `isAdmin`
  branch. The control plane AND the product both run with that above-project authority and use the **same**
  `global.iterate/...` namespace at **different paths** — NOT separate namespaces. The product's Slack-debug
  stream is just a path like `global.iterate/product/webhooks/slack`.

**Both patterns Jonas wanted already exist:**

- **Outer writes INTO an inner (project) stream:** internal itx workers name `(projectId, path)` directly and
  append, bypassing the RpcTarget confinement — `integrationStreamStub(projectId|null, path)`
  (`integration-streams.ts:13`, `allowNullProjectId`). The webhook door does exactly this
  (`routeIntegrationWebhook`, `:143`): reads the global directory `global.iterate/integrations/_directory`,
  resolves `(slug, externalId) → (projectId, connection)`, appends straight into that project's stream. This
  IS "the control plane appends into a project stream from outside," proven.
- **Inner CANNOT see/write outer streams:** confinement is in the **RpcTarget constructors**
  (`assertCanAccessProject` at `StreamRpcTarget:541`, `StreamCollectionRpcTarget:977`). A project root
  literally cannot name `global.iterate/…` or another project — "cross-project delivery is _unexpressible_
  rather than checked" (streams README). Constructive isolation, exactly as hoped.

**Reconciling "two levels of global streams":** it was two _purposes/paths_ (control-plane directory vs
product webhook-debug), not two _namespaces_. Both live in the ONE `global.iterate` namespace. So: **one
deployment namespace; project tier confined by construction; global tier is above-project authority shared by
control-plane + product code.** The shell distinction is **code + authority**, not a separate stream store.

**The only case streams leave the one namespace = BYO-streams (data residency, D11):** override a project's
stream _collection RpcTarget_ to point at an external backing. That's a per-capability override, not a second
namespace in our deployment.

**Still open (own threads):** keep the faux-URL DO-name scheme? how do real ingress hostnames relate to it
(they resolve host→projectId, then the id — not the host — becomes the `{projectId}.iterate` prefix;
`ingress.ts`/`project-directory.ts`)? → those stay in `05`/hostname-structure fog, not this ticket.
