status: in-progress
size: medium

# Jev documentation context experiment

The selector and pre-request hook are implemented; 110 focused tests and template typechecks pass. Live preview proof, race/failure coverage and final review remain.

## Request

Use Cloudflare's `typesafe/jev` to select documentation relevant to each incoming
agent message, then include those docs before the first answering LLM request.
Prefer an opt-in, userland config template. Worktreeify; no PR. Deploy a leased
preview manually and prove the ordering through the public agent API.

## Assumptions and decisions

- Base: `origin/main` at `79411edced`; branch `experiment/jev-doc-context`.
- Start with Iterate API docs and working examples from `itx.docs`, rather than
  inventing a separate documentation store. The user confirmed this corpus.
- Jev runs one batched decision request. Its output is parsed, ranked and capped;
  only selected documents enter the answering model's context.
- No embedding service, vector store, or agent-initiated documentation tool round.
- Ordinary project event delivery is asynchronous and cannot enforce pre-request
  ordering. Investigate the smallest reliable opt-in boundary; do not treat a
  longer debounce as a correctness guarantee. The user initially chose a small core hook, then asked us to try existing request controls first while they are AFK.
- Record timing, selected sources and failure outcomes; bound added latency.
- Cover the first message, a subsequent different topic, and selection failure.
- No history rewriting. Each implementation commit carries the proposed review
  body; push the branch and return its compare link, without creating a PR.

## Checklist

- [x] Research the model and Cloudflare access. *Cloudflare documents direct `AI.run("typesafe/jev", { state, questions })`; Score returns a fractional score and confidence.*
- [x] Create an isolated worktree. *`../worktrees/iterate/experiment/jev-doc-context`, based on current main.*
- [x] Commit this specification before implementation. *`b540c051b`, pushed independently.*
- [x] Write a failing behavior test for docs in the first answering request. *`agent-context-preparation.test.ts`: red without the hook, green with it.*
- [ ] Add an opt-in Jev documentation template and enforce ordering.
- [ ] Validate selection, bounded failure, and later-message behavior.
- [ ] Deploy a leased preview and run the live e2e proof.
- [ ] Record evidence, complete task, commit and push; return compare + preview links.

## Research

- https://developers.cloudflare.com/ai/models/typesafe/jev/ — direct binding and
  REST calls, `state` plus `questions`, Noul / Choice / Score; 32K input window.
- https://openrouter.ai/typesafe/jev-1.13/ — latest published version is 1.13;
  OpenRouter lists input-only billing ($0.042/M tokens), but Cloudflare's own
  model page directs billing questions to its dashboard.
- Existing integration: `itx.ai.run` exposes the Workers AI binding with
  platform-owned gateway and billing metadata.

## Implementation log

2026-09-21: Created worktree and installed dependencies. The existing 60-second
birth debounce is only a customization window, not a per-message barrier.

2026-09-21: Tried the requested userland hold before resorting to core. A real
AgentProcessor harness ran three variants where the template reaction arrived
immediately, before the original 250ms timer, and Jev remained pending at 500ms.
All three intended "no model call yet" assertions failed (3/3, 64ms total):
`agent/paused` is automatically resumed for external input; `dont-trigger-request`
on new context leaves an existing pending trigger intact; raising the debounce
leaves the existing sleep-and-append scheduled. There is no public
`llmRequestNeeded = false` mutation. Probe source/output retained in
`/tmp/jev-userland-hold-probe.test.ts` and `/tmp/jev-userland-hold.log` locally.
A longer birth delay can make the first-turn race unlikely but cannot cover normal
later chat reliably. Proceeding with the authorized hook fallback.

Preview slot: `preview-2`, lease `6687711e-18c9-4d33-b407-1cf08dc2ca4c`, expires
2026-09-22T00:25:30.625Z. Auth deployed and smoke-tested. Jev live REST probe on the
preview Cloudflare account returned model `jev-1.13.0`, score 1.99 for file docs
against an image-storage question (331 input tokens, 17 output tokens).
