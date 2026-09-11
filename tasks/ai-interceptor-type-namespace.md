# Namespaced AI interceptor types

Status: Specified; implementation and validation remain. The callback and its input variants will share one type-only import.

- [ ] Support exported type-only namespaces alongside same-named aliases/interfaces in the itx generator, including dependencies and qualified names.
- [ ] Keep merged declarations together through graph lookup, docs slices, and typechecker dependency closure.
- [ ] Publish `ProjectAiInterceptor.Input`, `.AgentTurnInput`, and `.AiRunInput`; migrate callers while preserving typed agent messages and arbitrary ai-run bodies.
- [ ] Prove standalone SDK usage and graph consumption with meaningful tests; regenerate both byte-identical SDK copies.
- [ ] Run formatting, freshness, and repository checks; open a draft PR and handle CI/review feedback.

## Scope

Start at main containing c512c12bc. Runtime interception behavior stays unchanged. No capnweb changes or fixes to the six `createFailing` interception/cancellation cases. Do not touch the separate metadata worktree at `/Users/mmkal/src/iterate`.

## Implementation log

- Initial spec follows the requested namespace API and generator follow-up from #2613.
