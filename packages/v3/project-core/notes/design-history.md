# Design history and current intent

This is a reading guide for the new `project-core`, not a specification copied
from the old clean room. It separates the stable design pressure from the
mechanisms that were explored, replaced, or explicitly parked. The evidence is
the design record as it stood on 2026-09-04; the working tree contains further
uncommitted clean-room changes, so source and current tests remain authoritative
for exact behaviour.

## Owner's current assignment

The requested successor is a new, condensed, layered implementation of an
iterate project. It needs many path-addressed contexts; one watched ingress and
egress `fetch` gate; append/follow streams; subscriptions and dynamically-loaded
worker code; repos; a project config worker with `processEvent`; secrets; human
approval; and signed events whose signature/trust level is inspectable. It also
needs a small web UI, an MCP server, and a click-through tutorial which builds
the layers. The hard budget is **under 5,000 lines for the whole result**.
Tests should exercise deployed environments end to end so the deployment target
can later move beyond Cloudflare. This is the user's brief, recorded in
`/Users/jonastemplestein/.codex/attachments/22fee103-7acd-43a2-ae10-342d05804576/pasted-text-1.txt`.

That assignment deliberately expands the September clean room: its own
assessment says project-host ingress, identity/attribution, repos/Git, and a
secret write surface are still missing. The new core must therefore treat the
clean room as a useful mechanical prototype, not as an endpoint.
([assessment](../../project-worker/docs/assessment-userspace-apps-on-the-clean-room.md))

## The durable intent

1. **One project is a small, self-hostable operating substrate.** It is a set
   of path-addressed contexts, each with durable history and executable
   behaviour. Hosted and self-hosted should be the same code with different
   identity, hostname, OAuth/billing, and egress configuration. The old
   simplification record calls the self-hostable floor the test for kernel
   membership. ([July summary](../../../../apps/os/docs/simplification/SUMMARY.md),
   [clean-room build](../../../../apps/os/docs/simplification/clean-room-build.md))
2. **History is the durable source of truth.** Append is the write primitive;
   reads/following and processors derive state and effects. Durable configuration
   is itself events, allowing reconstruction, audit, and an intelligible
   tutorial. Current clean-room code proves one context DO with one stream and
   an inline core reduce; it does not justify making every future feature a
   primitive. ([layers](../../project-worker/LAYERS.md),
   [simplification README](../../../../apps/os/docs/simplification/README.md))
3. **Keep the physical substrate distinct from its durable names.** A live RPC
   stub, socket, loader isolate, and facet are physical and may disappear; an
   expression/rule, event, address, source reference, and capability grant are
   durable data that can reconstruct a physical thing. The pager exists only
   for live browser/client capabilities that Cloudflare cannot restore. Never
   derive presence from stored rows. ([layers](../../project-worker/LAYERS.md),
   [pager research](../../project-worker/research/pager-vs-upstream-36.md))
4. **One capability tree, narrow kernel.** The project-facing surface is one
   `itx` tree reached through internal RPC, external API/MCP, and confined worker
   code. Inbound project behaviour (`fetch`, `processEvent`) remains distinct
   from outbound `itx.fetch`. Put policy and products above a small substrate
   wherever they can be expressed as ordinary code and events. ([clean-room
   build](../../../../apps/os/docs/simplification/clean-room-build.md),
   [as-built surface](../../project-worker/docs/itx-surface-as-built.md))
5. **One watched network boundary.** Ingress routes by project/app hostname;
   egress is the sole external exit, where secrets, approval, metering, and
   policy belong. Internal project routing stays cheap. This is an intended
   security and explanation seam, not merely a URL helper.
   ([TODO R2](../../../../apps/os/docs/simplification/TODO.md),
   [one-fetch plan](../../project-worker/docs/plan-one-fetch-rules.md))
6. **Authority is explicit and auditable.** The new brief strengthens the old
   event-provenance question: an event must carry platform-owned attribution and
   an inspectable signature/trust level; public callers must never forge it.
   A project may begin permissively and subsequently append policy that narrows
   who can write or spend, including locking itself out. This is a product
   model, not an excuse for a hidden bypass. The existing clean room has not
   solved it: `authenticate()` is a no-op and public append metadata can be
   forged, both documented as gaps/deferred defects.
   ([assessment](../../project-worker/docs/assessment-userspace-apps-on-the-clean-room.md),
   [defects 48--49](../../project-worker/DEFECTS.md))

## Minimal layering to preserve

| Layer                | Owns                                                                                                                                  | Must not absorb                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Platform substrate   | addressing, durable event storage, capability dispatch, loader/DO lifecycle, the ingress/egress gates, platform-owned event stamp     | app policy, agents, integrations, repo UX, approval decisions          |
| Project core         | context tree, event vocabulary and projection hooks, repo/config-worker/secrets/approval capabilities expressed through the substrate | a second routing system or hidden state that cannot be rebuilt/audited |
| Project userspace    | config worker's `fetch` and `processEvent`, processors, apps, policies, agents, MCP/UI adapters                                       | raw platform bindings or an alternate egress path                      |
| Hosted control plane | directory, hostname and membership lookup, leased credentials, billing/operations                                                     | semantic differences in the project core                               |

The exact boundary is intentionally still a design task. Repos are a build and
storage capability rather than a loader concern; secrets belong at the egress
and identity seam; approvals are a policy/processor which can withhold an egress
or privileged event until an approved event releases it. These placements keep
the tutorial honest while avoiding a giant kernel. ([boundary calls](../../../../apps/os/docs/simplification/core-boundary.md),
[clean-room gap analysis](../../project-worker/docs/assessment-userspace-apps-on-the-clean-room.md))

## What the clean room established

The September implementation is valuable evidence for a compact inner mechanism:

- A context is one named DO, stream, inline reduced core state, and capability
  resolver. A context path is an address; it is not necessarily a filesystem
  or an inheritance hierarchy.
- `provide(match, target)` gives one durable rewrite-rule front door; rules are
  pure data. A subscription is a named delivery, and a processor is a
  subscription targeting a hosted facet. This is the clearest layering result
  from the onion design. ([layers](../../project-worker/LAYERS.md),
  [onion design](../../project-worker/docs/design-onion-subscriptions-processors.md))
- Cap'n Web terminates at the stateless edge; DOs use Workers RPC and must not
  be pinned by clients. This is a Cloudflare implementation constraint, not a
  universal architectural law: preserve the boundary in an adapter so another
  target can implement the same end-to-end contract. ([layers](../../project-worker/LAYERS.md))
- A processor owns its own derived-state progress when it can repair gaps;
  otherwise the stream owns an at-least-once cursor. Bounded delivery backlog,
  byte-limited reads, event-size limits, and replay proofs are required for an
  operationally honest event system. ([layers](../../project-worker/LAYERS.md),
  [performance learnings](../../project-worker/docs/perf/learnings-and-bigger-refactors.md))

## Explicitly historical or rejected directions

- Treat `ARCHITECTURE.md`, `PLAN.md`, `WALKING-SKELETON.md`, `ITX-KERNEL-SHAPE.md`,
  `docs/iterate-context.md`, and `docs/state-of-play.md` as history. Their own
  banners redirect to the as-built surface, walkthrough, layers, and onion
  design. Do not revive their separate stream/runner/config shapes by accident.
- The proposal synthesis's preferred `rewrite` verb lost: the implemented front
  door is `provide(match, target)`. It survives only as decision history.
  ([as-built surface](../../project-worker/docs/itx-surface-as-built.md))
- July's `built-ins -> mounts` programme was an important boundary probe, not a
  command to make dispatch slower. Its stated performance constraint was
  in-isolate resolution for common capabilities; the current fixed-point
  `itx.builtins` design is the newer answer.
  ([TODO](../../../../apps/os/docs/simplification/TODO.md),
  [as-built surface](../../project-worker/docs/itx-surface-as-built.md))
- Do not resurrect a universal VFS, content-addressed-everything, wallet system,
  or an OS worker as a special project without a concrete need. They were
  exploratory lenses, while the selected direction keeps ordinary repos,
  config, and policy as layers above the core.
  ([simplification README](../../../../apps/os/docs/simplification/README.md),
  [July summary](../../../../apps/os/docs/simplification/SUMMARY.md))
- The old “all config is a capability mount” and complicated expression-pattern
  proposals are not the tutorial's core. Keep expressions/rules only where
  they are the simplest durable name for a capability; ordinary TypeScript is
  the escape hatch and primary product language.

## Non-negotiable pitfalls for the successor

- **Do not create two configuration/dispatch regimes.** One event-backed
  capability name/route mechanism, plus explicit physical built-ins, is easier
  to explain and recover than parallel magic tables.
- **Never retain raw live authority as durable state.** Store a revocable name,
  grant, expression, or source reference; reconnect or re-materialize it. A
  client disconnect must clean up its live authority and cannot leave fake
  presence.
- **Do not make append attribution client-controlled.** Seal actor, signature
  level, origin, and approval evidence at the authenticated ingress/append door;
  make the evidence readable in projections and immutable afterward.
- **No bypass around ingress/egress.** Repo fetches, integrations, secret use,
  MCP, config workers, and agents all share the same enforced boundary.
- **No unbounded retry or unobservable stuck delivery.** Use one retry ladder,
  durable halt/progress facts, bounded memory, and recovery from history.
- **Do not optimize the tutorial away.** Each layer should run end to end and
  add one idea: context/address, events, projection/processor, code host,
  repo-config worker, gated network/secrets, signed approval, then UI/MCP.

## Source precedence

For new design choices, use this order: the user's attached brief; the current
package source and deployed E2E tests; `docs/itx-surface-as-built.md` and
`LAYERS.md`; the clean-room gap assessment; then Wayfinder and the July
simplification pile as rationale. Documents carrying `SUPERSEDED` or `HISTORY`
banners provide archaeology only. This order prevents a persuasive old sketch
from overriding the newly requested repo/config/secrets/approval/signed-event
scope.
