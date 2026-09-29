# Archived first-pass architecture

**Status: superseded.** This is an archive of the first audit design, which
recommended public target declarations, capability descriptors, type references,
and a typed export table. It is retained for its measurements, review
counterexamples, and platform evidence. It is not the current recommendation.

The complete first-pass report, including the detailed evidence ledger, is
checked in as [archived-first-design-full.md](archived-first-design-full.md).
The first-pass companion proposals are
[exports-not-expressions.md](exports-not-expressions.md) and
[design-capabilities.md](design-capabilities.md); both are prominently marked
paused. The independent review that found the required constraints is
[opus-exports-round-2.md](reviews/opus-exports-round-2.md).

The first design usefully established these durable facts:

- public descriptions cannot transparently serialize live capabilities or
  recover erased TypeScript types;
- a jail change, parent change, removal, or repoint needs a revision fence, not
  an eventual cache TTL;
- `provide` and live `subscribe` already share a pager/relay mechanism;
- generic cursor/fan-out delivery cannot be deleted until a replacement owns
  retry, dead-letter, concurrency, and idempotency behaviour;
- Cloudflare facet and alarm workarounds need named test/telemetry removal
  criteria rather than broad cleanup; and
- `workerd #3184` was fixed by
  [#3212](https://github.com/cloudflare/workerd/pull/3212), so it is not a
  current Proxy-serialization prohibition.

It reached the wrong public conclusion: it tried to make the implementation's
Cloudflare-specific routing and authority details into a general context
framework. The active report returns to existing names and a smaller model:
event log, ordinary `itx` RPC capabilities, explicit `cd`/jail inheritance,
and normal processor/application code. See [findings.md](findings.md).
