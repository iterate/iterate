# Namespaced AI interceptor types

Status: Complete. Namespaced types, generator support, and caller migration are implemented. Local checks and CI passed, including the deployed preview suite. Draft PR #2628 awaits user review; feedback monitoring runs through 2026-09-12 11:58 UTC.

- [x] Support exported type-only namespaces alongside same-named aliases/interfaces in the itx generator, including dependencies and qualified names. _Generator preserves type-only namespace blocks and scoped aliases; runtime members and cross-module clashes fail._
- [x] Keep merged declarations together through graph lookup, docs slices, and typechecker dependency closure. _One graph record retains merged declarations; compiler symbols identify dependency edges._
- [x] Publish `ProjectAiInterceptor.Input`, `.AgentTurnInput`, and `.AiRunInput`; migrate callers while preserving typed agent messages and arbitrary ai-run bodies. _model-interception.ts and server/spec callers use the namespaced inputs with no runtime changes._
- [x] Prove standalone SDK usage and graph consumption with meaningful tests; regenerate both byte-identical SDK copies. _Standalone SDK, namespace generation, graph slices, and the Worker typechecker pass; generated copies match._
- [x] Run formatting, freshness, and repository checks; open a draft PR and handle CI/review feedback. _Draft #2628: unit/static/autofix CI and all five preview app suites passed; no review threads. AI linter requires a non-draft PR; global monitor registered for later feedback._

## Scope

Start at main containing c512c12bc. Runtime interception behavior stays unchanged. No capnweb changes or fixes to the six `createFailing` interception/cancellation cases. Do not touch the separate metadata worktree at `/Users/mmkal/src/iterate`.

## Implementation log

- Initial spec follows the requested namespace API and generator follow-up from #2613.
- Full `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm knip`, `pnpm format`, and `pnpm test` passed. Additional namespace-block and ambiguity tests passed afterward.
- Post-commit validation: 92 focused tests passed, including all generator freshness guards; both SDK copies are byte-identical. Preview passed 87 browser specs and the OS integration suite. No capnweb or deferred interception tests changed.
