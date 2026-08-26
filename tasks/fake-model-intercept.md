---
status: in-review
size: large
---

# `fake/*` models: intercept-only deterministic agent/AI testing

## Status summary

Implemented; PR #2523. Both egress paths consult the Project DO's live AI
interceptor for `fake/*` models; unit tests, a three-turn sarcastic spec
(video in the PR), the `ai-intercept` example, and the testing-doc paragraph
are all in. dumbagent (separate repo) got server-free protocol/preset subpath
exports plus a pkg.pr.new workflow. Remaining: CI + review.

## Ask

Deterministic, fully-controlled LLM responses for e2e tests/specs. A spec creates
an agent with `model: "fake/main"`, installs a live handler via
`itx.ai.intercept(handler)`, and drives a real multi-turn conversation through
the whole agent loop — debounce, llm-request events, codemode, chat reply —
with the "model" being an in-memory function in the test process.

## Decisions (from the grill session)

1. **Hook points: both egress paths, small product seams.** `itx.ai.run` and
   agent turns are separate code paths; both consult the interceptor. Built-in
   `ai` is unshadowable by design and processor deps are constructor-built in
   the facet DO, so zero-product-change was ruled out (the only zero-change
   alternative, `appendSyntheticProviderOutput`, bypasses the turn loop).
2. **Intercept-only.** No static preset models in product code. `fake/*` is the
   interception namespace: any `fake/<name>` dials the installed live handler
   (capnweb-connected function in the test process); the test routes on the
   name. Post-disconnect answering is an explicit non-goal.
3. **Interception scoped to `fake/*`, not all models.** A turn whose journal
   says `openai/*` can never have been served by a handler. One registration on
   the Project DO, mirroring `egress.intercept` (live, last-writer-wins,
   session-bound); two consultation points (isolate `AiRpcTarget.run`; facet DO
   hops to project DO only for `fake/*` models — zero overhead otherwise).
4. **The lane exists everywhere, including prd, documented.** No gate, no
   config, no credential — `fake/*` without a handler is a loud recorded
   failure, identical in every env ("no test-only seams").
5. **No product presets; responders live test-side.** Handlers implement
   behavior; dumbagent grows semantic-level exports (pure eliza/sarcastic
   cores, message helpers) importable test-side.
6. **Adoption: new coverage only; existing paid tests stand.** New full-loop
   spec + new `ai-intercept` itx example (`e2eProven: true` — first automated
   `itx.ai.run` coverage). `agent-chat.spec` conversion and `.llm.` tagging are
   follow-ups.
7. **Handler contract: one `itx.ai.intercept(handler)`, semantic-level,
   source-discriminated.** Handler receives
   `{ source: "agent-turn" | "ai-run", model, body }`; agent turns return
   `{ text, usage? }` (or a plain string), `ai-run` returns arbitrary JSON
   passed through verbatim. Omitted `usage` → text-length default; `onChunk`
   word-split; missing handler → clear recorded error.
8. **Prefix: `fake/`.** Honest in the journal, matches the provider-prefix
   convention (`openai/…`, `@cf/…`).

## Checklist

- [x] Project DO: live `ai` interceptor state next to the egress interceptor
      (same last-writer-wins/session-bound semantics), plus an internal consult
      method callable from the facet DO — _`interceptAi`/`consultAiInterceptor`
      in `project-durable-object.ts`, slot mirrors `#egressInterceptor`_
- [x] `AiRpcTarget` (`rpc-targets.ts`): `intercept(handler)` + `fake/` branch in
      `run()` before `env.AI.run`; docstrings; `pnpm generate:itx-api` —
      _projectId threaded through both construction sites; contract regenerated_
- [x] Agent path (`agent-llm-request.ts` `attempt()`): `fake/` branch after the
      `callLlm` check — consult handler, word-split `onChunk`, usage default;
      no handler → recorded attempt failure — _dep `consultAiInterceptor` on
      `AgentProcessorDeps`, wired via `projectStub` in the facet DO_
- [x] Unit tests for the fake branch — _`agent-fake-model.test.ts`: 5 tests
      incl. callLlm precedence and usage estimate/verbatim_
- [x] e2e spec: multi-turn sarcastic conversation through the browser UI,
      `VIDEO_MODE=1` recording — _`specs/agent-fake-model-chat.spec.ts`, three
      turns in ~20s, exact-reply assertions; video in PR body_
- [x] itx example `ai-intercept` (`e2eProven: true`) — _first matrix-proven
      `itx.ai.run` coverage_
- [x] docs/testing.md: paragraph in the LLM-cost gap section
- [x] dumbagent (separate repo): semantic exports — _protocol split out of
      api.ts; `./protocol` + `./presets/*` subpaths, server-free; pushed_

## Requirements from Misha

- Implement in a worktree (this one), draft PR early.
- PR body must include a video of a spec showing a multi-turn conversation with
  a sarcastic-responding agent.
