---
status: ready
size: large
blocked-by: worker-delivery-obligations
---

# Agent birth moves to the config worker; headless-only; one-shot

## Status summary

Not started. Plan fully settled and approved via plannotator (5 review
rounds). Local explainer with diagrams:
`explainers.ignoreme/agent-birth-refactor-plan.html` (gitignored) — all
decisions inlined below so this file is self-contained. Blocked on
[worker-delivery-obligations](worker-delivery-obligations.md).

## The decided model

- **Births are authored by the project's config worker**, reacting to
  `agent/created` in `processEvent` — for every agent, including the default
  template's. `create()` shrinks to an atomic core: `agent/created` + the
  keeper subscription + capability host. No prompt, no wishes read, no
  interpreter chosen.
- **Inert until ready**: messages accumulate on the stream (storage is
  free); the keeper holds the LLM send until `agent/birth-finalized` (new
  agent-contract event, appended by the worker after its birth events) or a
  ~10s deadline (platform constant, deliberately not configurable — a
  configurable pre-birth deadline would need exactly the stored-wishes
  mechanism this refactor deletes). On expiry: visible "this project's setup
  didn't respond" + one-click start-with-platform-defaults (keyed, so a late
  worker supersedes rather than conflicts). **Never auto-answer with a wrong
  personality — the failure mode is visible waiting, never a wrong answer.**
- **Headless-only**: the classic processor
  (`agent-processor-implementation.ts`) and `config.driver` are deleted. One
  built-in agent program remains (today's `agent-headless-processor.ts`,
  slug kept for now): schedule turns, call the LLM, commit the raw reply,
  hold for readiness, execute cancels when told. It interprets nothing.
- **Interpretation is a service call**: `itx.agents.interpretResponse(event)`
  — platform-implemented (live-updates on platform deploy, output events
  can't drift from platform vocabulary, appends happen next to the stream),
  but **the platform never decides to interpret; it acts only when project
  code asks, per event**. Subsumes everything opinion-shaped from the
  classic processor: slash commands, error transcription, summary label,
  interrupt decisions. Audit rule: service unless physically inseparable
  from the request lifecycle. Pinning = vendoring your own interpreter.
- **"Making an agent headed" is two itx one-liners** in a template's worker:
  append `await itx.agents.getDefaultBirthEvents({kind})` (+ project tweaks)
  + finalize at birth; `await itx.agents.interpretResponse(event)` on
  assistant replies. Signatures: minimal; `interpretResponse` parameterless
  beyond the event until a real need appears.
- **Debounce** returns to its two real jobs (message batching + a
  best-effort post-birth opinion beat). Birth is the one explicit wait.
- **One-shot**: at no commit on main do two birth models coexist. Cleanup
  ships in the same change.

## Checklist

- [ ] `agent/birth-finalized` in the agent contract
      (`apps/os/src/domains/agents/agent-processor-contract.ts`); reaches
      the SDK's generated vocabulary
- [ ] Readiness hold in the keeper (generalize the existing
      hold-until-prompt check in the turn loop): hold LLM send until
      finalize; deadline armed at first *held message* (not birth); expiry
      → degraded-start offer event + UI
- [ ] Shrink `AgentRpcTarget.create()` (`apps/os/src/rpc-targets.ts`):
      core batch only; delete `agentBirthDefaultsForProject`
- [ ] `itx.agents.getDefaultBirthEvents({kind})`: web/channel variants,
      channel facts read from the birth certificate; `agent-defaults.ts`
      shrinks to its implementation
- [ ] `itx.agents.interpretResponse(event)`: platform-side implementation
      carrying the classic interpretation (incl. slash commands, error
      transcription, summary label, interrupt decisions); flag
      mechanism/opinion judgment calls in the PR for annotation
- [ ] Delete the classic processor + `config.driver`; keep slug
      `agent-headless`
- [ ] `configs/default/worker.ts`: author births (defaults + the one
      illustrative tweak — a system context item
      "all responses should be in all-lowercase" under key
      `config/house-style`, as living documentation — + finalize) and call
      `interpretResponse` on replies. Every worker-authored birth event
      idempotency-keyed (redelivered handlers must converge)
- [ ] `configs/codemode-tag/`: becomes a normal template with a different
      interpreter + prompt; delete handover/retarget machinery and
      defaults-publishing
- [ ] Integration agents (Slack/Telegram/email) migrate in the same change:
      routers create the core with channel facts in the birth certificate;
      worker authors personality via `getDefaultBirthEvents({kind})`;
      channel prompt plumbing moves behind it
- [ ] Onboarding: zero accommodations; uniform rule (likely scrapped soon)
- [ ] Failure handling (basic, in this change): "setting up your project…"
      state during first build; deadline → degraded-start offer;
      `project/worker-update-failed` surfaced at project level. (Rollback-
      to-last-good-commit offer: follow-up, lives on the project-level
      banner, per-agent dialog links to it)
- [ ] Cleanup, same change: delete the generic defaults store
      (`project/defaults-configured` + legacy event handling + fold slot,
      merged in #2497) and the validation/allowlist in `agent-defaults.ts`;
      remove the default template's prompt-pinning publish
- [ ] Two vitest specs pinning the restart-idea boundary: (a) keyed
      supersession heals late-personality-after-degraded-start in place;
      (b) a wrong-personality turn already in model-visible history cannot
      be un-said (the standing, executable argument for logical/physical
      stream paths — which are NOT built now)
- [ ] UI: interpreted replies render via existing event linkage
      (`llmRequestOffset`); verify raw-behind-toggle still holds under
      headless-everywhere
- [ ] Full lanes green: `pnpm typecheck && pnpm lint && pnpm knip &&
      pnpm format && pnpm test`; live verification on a preview slot
      (fresh project first turn correct; broken-worker commit → visible
      degraded-start offer, not silence or wrong format)

## Explicitly out of scope (follow-up rounds)

- The speed round (warm workers, delivery batching, per-turn hop
  measurement) — pure UX once correctness is ordering-based.
- Generic watchdog primitive; rollback-offer UX.
- Logical vs physical stream paths (build only if the "unfixable" spec
  starts matching production).
- Renaming the `agent-headless` slug.

## Implementation log

(append as work happens)
