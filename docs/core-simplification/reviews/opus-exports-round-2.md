# Independent Opus review: exports-not-expressions — round 2

**Verdict:** direction approved, not ready for implementation until the seven
blockers below are incorporated. Raw prompt and JSON are private at
`/tmp/core-simplification-opus/round-2-prompt.md` and
`/tmp/core-simplification-opus/round-2.json`.

## Required corrections

1. Add a principal/platform-only `builtin` target. Otherwise a jailed scope
   cannot explicitly grant `run`, `repos` or the configuration operations it
   now grants through `itx.builtins.*`. A same-context target would recurse;
   a destination context target would be shadowable.
2. Add a pure export-admission table by stamped writer class. A typed context
   target must still be admitted through the writer's available `cd`, and
   loaded code must not create builtin/config/secret escape routes. Keep source,
   fixed-step, signing-secret, schedule and jail-lift checks.
3. `config` is a platform-written worker head, not a context pointer. Its
   typed source needs repo/commit/manifest identity; named-worker vouching and
   the unpublished `validUntil` outcome survive.
4. Specify call behavior at a matched export: arguments apply after fixed
   steps. This retains function providers without restoring argument-prefix
   rewrite matching.
5. Provider detach needs compare-and-set cleanup, including associated route
   and subscription records. A last close must not remove a newer re-lend.
6. Preserve the full snapshot fence: platform writes, additions shadowing an
   existing resolution, parent/jail changes, removal and repoint all fence.
7. Narrow the scope of deletion. Exports become typed; subscription, ingress
   and fetch-route invocation targets still use expressions in this phase but
   resolve through exports. Convert current hosted-facet/push/webhook
   classifications structurally before deleting their helpers.

## Architectural lesson

The reduction is not "rename rules to exports." It removes a state machine that
combines match syntax, target rewriting, callable argument substitution,
privilege admission, delivery-policy inference and provider lifecycle in one
log row. The replacement holds each independent fact once:

| Fact                                                                  | Single owner                                 |
| --------------------------------------------------------------------- | -------------------------------------------- |
| capability name, immutable identity, optional description/declaration | typed export table                           |
| parent and default-deny boundary                                      | scope state plus snapshot fence              |
| privilege to create a head                                            | writer-class admission                       |
| durable vs live guarantee                                             | subscription row delivery mode               |
| provider liveness                                                     | pager directory and compare-and-set detach   |
| processor checkpoint/retry                                            | processor/facet, never capability resolution |

That separation prevents the old accidental couplings: a capability re-point
changing delivery guarantee, a stale scope granting after revocation, a typed
cross-context row bypassing jail admission, or provider closure deleting a
replacement route.

## Follow-ups worth retaining

- App adapters are worker exports with ordinary JSON props and the owner
  context's `env.ITX`; do not invent an unsupported attenuated-facade prop or
  treat published app code as trusted.
- Table keys are canonical dotted strings, paths are absolute, and provider
  names keep their `itx.` prefix.
- The manifest needs identity-root and `cd`/`workers` placement cases; dynamic
  entries remain outside it.
- `writtenBy` comes from the stamped caller source. Declarations must use the
  concurrent `declaration` field and stay capped/out of normal snapshots.
- Replace product readers of `rewriteRules` (`voice`, GitHub sync, AI linter,
  agent prompt, MCP, UI/context stub) with `exports.get/list/resolve`.

The amended design incorporates every blocker in
[exports-not-expressions.md](../exports-not-expressions.md).
