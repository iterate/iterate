status: complete
size: medium

# Jev documentation context experiment

Complete and pushed, without a PR. The Jev template and opt-in core callback are deployed on preview-2. The final live e2e proves first-request context on two turns, settled state and clean stream telemetry; a real-model demo is ready to try.

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
- [x] Add an opt-in Jev documentation template and enforce ordering. *`configs/jev-docs` owns selection; the opt-in core callback atomically records context before request intent.*
- [x] Validate selection, bounded failure, and later-message behavior. *Real processor tests cover overlapping messages, eviction, failures, malformed output, timeout, tool continuation and six integration actor types.*
- [x] Deploy a leased preview and run the live e2e proof. *Final code `570af0ef4` deployed; real Jev e2e passed in 24.8s with both first requests inspected.*
- [x] Record evidence, complete task, commit and push; return compare + preview links. *Evidence and links below; the branch is pushed with proposed review bodies in commit messages.*

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


2026-09-21: Implemented `contextPreparation` configuration (disabled by default).
The agent awaits the configured project-worker method after debounce; a 10-second
budget bounds this template. Success, failure and timeout are durable
`agent/context-prepared` outcomes. A trigger-offset guard prevents stale work
from starting an answering request for newer input. Script continuation reuses
context; new user or integration messages select again.

The template searches 25 summaries via `itx.docs`, asks Jev for batched scores,
and includes at most three documents scoring at least 1.5/2. Keyword search is
the candidate bottleneck; this POC does not add semantic retrieval. Message
attachments are not classified. Historical documentation remains in prior turns.
The callback must be read-only: timing out cannot cancel a dispatched Workers RPC.

A real-model demo is available at
https://os.iterate-preview-2.com/projects/jev-docs-poc/agents/streams/agents/jev-demo.
It selected `files-roundtrip` and `workspace-files-transfer` in 985ms (Jev 704ms),
then the default answering model replied with the correct `files.put` / `url`
example. Its final processor state has no pending/open request, active scripts
or consecutive failures. Root, config-repo and agent streams have no errors or
halted deliveries.

Sign in to the demo test identity via
https://auth.iterate-preview-2.com/test-login?email=jev-docs%2Btest%40nustom.com&project=jev-docs-poc&return_to=https%3A%2F%2Fos.iterate-preview-2.com%2Fapi%2Fiterate-auth%2Flogin.
The new template is installed in this project through `repo.commitFiles`; its
source ref is `github:iterate/iterate#experiment/jev-doc-context&path:configs/jev-docs`.
This branch has no pkg-pr-new publication because no PR was opened; the preview
uses the main SDK package, whose existing runtime API supports the template.

Checks: OS TypeScript, every config-template typecheck, scoped oxlint and
formatting pass. The full agent unit-test directory has 250 passing tests and
one pre-existing expected failure. OS knip reports only four existing unused
exports/types in unchanged `egress-approvals.ts` and `stream-browser-db.ts`.


Preview deployment for code commit `570af0ef4`:
`bfb899cf-e262-4d84-a159-ad00e5309cc1`. Dashboard, event docs, API and auth Workers
RPC smoke checks passed. Deployment log: `/tmp/jev-os-deploy-verified.log`.

Reproduce the live proof from `apps/os`:

```sh
doppler run --project os --config preview_2 -- pnpm e2e run e2e/vitest/jev-doc-context.e2e.test.ts
```

The preview is leased until **22 September, 01:25 BST** (00:25 UTC). Leave it
available for review; after expiry another task may reuse the slot. To release
early from the repo root:

```sh
doppler run --project _shared --config prd -- pnpm preview release --slot 2 --lease-id 6687711e-18c9-4d33-b407-1cf08dc2ca4c
```

Review branch: https://github.com/iterate/iterate/compare/main...experiment/jev-doc-context.
No PR was created. Codex session: `01a0c535-0786-7a02-bc8e-6db66b7fb41a`.


Final live run: `os-vitest-run-20260921-194401`, project
`jev-docs-mublgc35-e3f671f3`. Passed in 24.8s against the final deployment:

| Message | Prepared → request offsets | Preparation / Jev | Selected docs |
| --- | --- | --- | --- |
| Image upload and signed URL | 42 → 43 | 1000ms / 778ms | files-roundtrip, workspace-files-transfer, chat-message-with-files |
| Recurring reminder and cancellation | 54 → 55 | 606ms / 511ms | scheduler-basics, docs-search-and-get |

The e2e captures the first exact answering-model request and checks the selected
content is present. Jev calls are real; only the answering model is intercepted
in that test. The separate demo above uses a real answering model too.
Final state: `openRequest = null`, `pendingLlmRequestTrigger = null`,
`consecutiveLlmFailures = 0`. Root, config-repo and agent streams have no error
or halted-delivery events. Input/output token counts were 5988/369 and 5936/369.
Log: `/tmp/jev-e2e-final.log`; artifacts:
`/var/folders/3f/w1drdpds7ls_09vcg6981cwm0000gn/T/os-e2e-lliaCR`.
