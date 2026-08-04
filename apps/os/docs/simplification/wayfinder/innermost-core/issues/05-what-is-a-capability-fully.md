# 05 — What is a capability, fully? (callable + type + provenance)

Type: research
Status: open
Blocked by: —

Jonas: "every concept needs to know what a capability is and how to express it, and probably things that come
with it — for example how to provide TYPES for the capabilities so that dynamically-run code can be
type-checked."

## The claim: a capability is richer than a pure-ocap stub

Pure ocap: a capability = a callable RpcTarget (method/branch). In THIS system, because capabilities are
dynamically provided AND consumed by dynamically-run, type-checked code, a capability must carry more:

1. **A callable** — the RpcTarget branch/method (invoke over either transport). _(pure ocap)_
2. **A type descriptor** — the shape (methods, params, returns) so dynamic code (`itx.*`) can be
   **type-checked** at author/build time. This exists today: `__describe()`, the Itx Type Graph
   (`itx-api-graph.generated.ts`), `itx-types-text.ts`. A provided capability must be able to _emit its own
   type_ so a project's config worker/agent typechecks against it.
3. **Provenance / authority** — who provided it, at what scope (for call-time narrowing, `02`) + metering.

So **"expressing a capability" = { callable, type, provenance }.** Every layer that provides a capability
provides all three; every layer that consumes one consumes the type (for typecheck) and the callable (to
call), subject to authority.

## Questions

- How does a **dynamically provided** capability (a Pi's live mount) supply its **type** to a consumer's
  type-check, when the consumer builds _before_ the Pi connects? (static type registration at provide-config
  time vs runtime `__describe`?)
- Is the type descriptor itself a capability / an event in the mount fold (so types are event-sourced too)?
