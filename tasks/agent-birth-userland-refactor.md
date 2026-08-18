---
status: in-progress
size: large
blocked-by: worker-delivery-obligations
---

# Agent birth moves to the config worker; headless-only; one-shot

## Status summary

Implementation essentially complete; unit lanes green. Landed: the whole
decided model — worker-authored births with the finalize hold + degraded-start
deadline, headless-only keeper, `getDefaultBirthEvents` /
`interpretResponse` itx services, router channel-facts migration, the
same-change cleanup (defaults store, allowlist, prompt-pinning publish), both
templates rewritten, both boundary specs. Remaining: live verification on a
preview slot (fresh project first turn; broken-worker → visible degraded
start), and CI on the PR.

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

- [x] `agent/birth-finalized` in the agent contract
      (`apps/os/src/domains/agents/agent-processor-contract.ts`); reaches
      the SDK's generated vocabulary _v6.0.0 adds `agent/birth-finalized` +
      `agent/birth-timed-out`, `birthFinalizedAtOffset`/`birthTimedOutAtOffset`
      state, and deletes `config.driver`; `pnpm generate:itx-api` regenerated
      the SDK vocabulary (AgentEventInput carries both events)_
- [x] Readiness hold in the keeper (generalize the existing
      hold-until-prompt check in the turn loop): hold LLM send until
      finalize; deadline armed at first *held message* (not birth); expiry
      → degraded-start offer event + UI _agent-turn-loop.ts: the at-head
      pass holds while `birthFinalizedAtOffset` is unset and arms a
      sleeper at `trigger.atMs + AGENT_BIRTH_FINALIZE_DEADLINE_MS` (10s);
      expiry appends the visible `agent/birth-timed-out` fact (freshness-
      checked, reduce-guarded so a finalize that beat it wins), whose own
      delivery appends the default personality + finalize. "Offer" is the
      auto-start per the settled slice scope; the timed-out event is the
      UI-renderable fact_
- [x] Shrink `AgentRpcTarget.create()` (`apps/os/src/rpc-targets.ts`):
      core batch only; delete `agentBirthDefaultsForProject`
      _agentCreationForPath now emits only created + capability-host pair +
      workspace capability + keeper (`agent-headless`) / collection
      subscriptions + sibling; `agentBirthDefaultsForProject`, the defaults
      read, and the boot-facts/systemPromptPolicy params are gone_
- [x] `itx.agents.getDefaultBirthEvents({kind})`: web/channel variants,
      channel facts read from the birth certificate; `agent-defaults.ts`
      shrinks to its implementation _lives on the agent handle
      (`itx.agents.get(path).getDefaultBirthEvents({kind})`) so the birth
      certificate and coordinates are implied; kinds
      web/onboarding/mcp/slack/telegram/email; returns content-hash-keyed
      prompt + model config + boot context; `defaultAgentBirthEvents` in
      agent-defaults.ts is the one builder, shared with the degraded start_
- [x] `itx.agents.interpretResponse(event)`: platform-side implementation
      carrying the classic interpretation (incl. slash commands, error
      transcription, summary label, interrupt decisions); flag
      mechanism/opinion judgment calls in the PR for annotation
      _agent-response-interpreter.ts (`interpretAgentEvent`) behind
      `itx.agents.get(path).interpretResponse(event)` — re-reads the
      committed event by offset, appends race-tolerantly; carries response
      parsing, slash commands, settlement rendering + workspace spill,
      preamble + stream-error transcription, and the waiting clear.
      Judgment calls in the implementation log below_
- [x] Delete the classic processor + `config.driver`; keep slug
      `agent-headless` _agent-processor-implementation.ts and
      agent-codemode.ts deleted; HeadlessAgentProcessor is the one keeper
      (no driver gate); facet DO registers it alone_
- [x] `configs/default/worker.ts`: author births (defaults + the one
      illustrative tweak — a system context item
      "all responses should be in all-lowercase" under key
      `config/house-style`, as living documentation — + finalize) and call
      `interpretResponse` on replies. Every worker-authored birth event
      idempotency-keyed (redelivered handlers must converge)
      _`#authorAgentBirth` (kind from path prefix) + one interpret case for
      context-added/script-settled/preamble/stream-error on `/agents/**`;
      `#publishAgentBirthDefaults` deleted_
- [x] `configs/codemode-tag/`: becomes a normal template with a different
      interpreter + prompt; delete handover/retarget machinery and
      defaults-publishing _handover/driver-flip/defaults-publishing deleted;
      births authored the same way (defaults + its own prompt superseding
      the slot + finalize) for web agents; the vendored parser keeps
      interpreting web agents, while channel/mcp/onboarding agents get
      platform defaults + platform interpretResponse_
- [x] Integration agents (Slack/Telegram/email) migrate in the same change:
      routers create the core with channel facts in the birth certificate;
      worker authors personality via `getDefaultBirthEvents({kind})`;
      channel prompt plumbing moves behind it _routers put
      `{ channel: { type, connection, ... } }` in the created payload and no
      longer pass systemPromptPolicy; prompt builders stay in
      agent-defaults.ts as the service's implementation_
- [x] Onboarding: zero accommodations; uniform rule (likely scrapped soon)
      _onboarding is just kind "onboarding" (same prompt as web); its
      instructions/start message stay ordinary worker appends and its first
      turn waits for finalize like everyone. The MCP session agent's platform
      prompt append was removed too (kind "mcp" replaces it)_
- [x] Failure handling (basic, in this change): "setting up your project…"
      state during first build; deadline → degraded-start offer;
      `project/worker-update-failed` surfaced at project level. (Rollback-
      to-last-good-commit offer: follow-up, lives on the project-level
      banner, per-agent dialog links to it) _deadline → degraded start with
      the visible `agent/birth-timed-out` stream fact (renders in the event
      feed; a held trigger presents as pending-not-runnable in the runtime
      badge). Dedicated "setting up your project…" / worker-update-failed
      banners: not built — see implementation log_
- [x] Cleanup, same change: delete the generic defaults store
      (`project/defaults-configured` + legacy event handling + fold slot,
      merged in #2497) and the validation/allowlist in `agent-defaults.ts`;
      remove the default template's prompt-pinning publish _project contract
      v0.8.0 drops the event + `defaults` slot; `AgentBirthDefaults`,
      `validateAgentBirthEvents`, the allowlist, and the SDK
      `AgentBirthDefaultsValue` type are gone_
- [x] Two vitest specs pinning the restart-idea boundary: (a) keyed
      supersession heals late-personality-after-degraded-start in place;
      (b) a wrong-personality turn already in model-visible history cannot
      be un-said (the standing, executable argument for logical/physical
      stream paths — which are NOT built now)
      _agent-birth-degraded-start.test.ts_
- [x] UI: interpreted replies render via existing event linkage
      (`llmRequestOffset`); verify raw-behind-toggle still holds under
      headless-everywhere _no UI reads `config.driver` or the processor
      slug; the interpreter emits the same events with the same keys the
      classic component did, so the agent-ui-reducer's llmRequestOffset
      linkage is unchanged_
- [ ] Full lanes green: `pnpm typecheck && pnpm lint && pnpm knip &&
      pnpm format && pnpm test`; live verification on a preview slot
      (fresh project first turn correct; broken-worker commit → visible
      degraded-start offer, not silence or wrong format) _local pipeline
      green (format → lint:fix → knip → typecheck → full test, 2800+
      tests); preview-slot live verification not yet run_

## Explicitly out of scope (follow-up rounds)

- The speed round (warm workers, delivery batching, per-turn hop
  measurement) — pure UX once correctness is ordering-based.
- Generic watchdog primitive; rollback-offer UX.
- Logical vs physical stream paths (build only if the "unfixable" spec
  starts matching production).
- Renaming the `agent-headless` slug.

## Implementation log

Judgment calls, per the audit rule ("service unless physically inseparable
from the request lifecycle"; when unsure, keep mechanism in the core):

- **Kept in the keeper (mechanism / physically inseparable):** the interrupt
  (abortInFlight reaches the in-memory in-flight attempt — impossible from a
  service), the at-head lifecycle (debounce/adopt/expire/breaker), the
  web-message-sent → assistant-history mirror (history integrity for
  script-sent messages, driven by the fold's llmRequestOffset suppression),
  and the slash-command TRIGGER gate in the fold/turn loop (whether a message
  schedules a turn is scheduling mechanism; the same pure resolver keeps the
  fold, loop, and interpreter agreeing). Compaction stays in the LLM
  component (it is an LLM request).
- **Moved to the interpreter (opinion):** response parsing/script requests,
  slash-command EXECUTION, settlement rendering + workspace spill, preamble
  transcription, stream-error transcription, and the qualifying-wake waiting
  clear ("summary label" in the spec's list).
- **Kept in the creation core:** the workspace capability mount and the
  capability-host pair (mechanism-ish per the spec's own note). The
  boot-context item MOVED to `getDefaultBirthEvents` (explicitly "no
  boot-context" in the core), which is also why the service needs
  coordinates + directory facts; the degraded-start batch omits it (the turn
  loop lacks the coordinates) — prompt + model only, same content-hash keys
  as the service's, so a late worker still dedupes/supersedes cleanly.
- **`getDefaultBirthEvents`/`interpretResponse` live on the AGENT handle**
  (`itx.agents.get(path).…`), not the collection: both need the agent's
  identity (birth certificate, stream, state), and the task file's
  `itx.agents.…` spelling reads as shorthand. `interpretResponse` accepts
  the delivered event but trusts only its offset — the committed event is
  re-read server-side.
- **Interpreter's executable-output gate** is the FOLD's acceptance
  (presence of the assistant item in reduced contextItems — the reduce-guard
  already drops offset-claiming raw appends and interrupt-closed output),
  not a processor-stamp check: matches classic semantics exactly and keeps
  the e2e synthetic-provider lane (raw atomic turn batches) interpretable.
- **Degraded-start race handling:** the deadline sleeper appends ONLY the
  timed-out fact (after a best-effort finalize read); the fold applies it
  only while unfinalized (`birthTimedOutAtOffset`), and the default
  personality + finalize are a per-event consequence of the APPLIED fact —
  so a worker finalize that reaches the stream first wins outright, with no
  check-then-append window on the personality itself. If new input arrives
  while held, later sleepers re-arm off the newer trigger (harmless: keyed,
  reduce-guarded); after eviction the deadline re-anchors to the pending
  trigger — "first held message" is exact in the common case, approximate
  across evictions.
- **Degraded personality is always kind "web"** — the turn loop has no
  channel facts. A slack/telegram agent whose worker misses the deadline
  gets the web default (it can't post to its channel until the worker
  recovers and supersedes). Loud > wrong; acceptable for the failure path.
- **Added kind "mcp"** (not in the spec's list): the MCP session prompt
  existed as a platform append after create(), which the uniform rule
  forbids; the default template maps `/agents/mcp/**` to it. Onboarding maps
  to kind "onboarding" (same content as web today; enum room for later).
- **Channel kinds are loud about missing facts**: `getDefaultBirthEvents`
  throws when the birth certificate lacks `channel` — the worker's delivery
  fails visibly and the degraded start covers the turn, rather than shipping
  a silently mis-addressed personality.
- **`activeScriptExecutionIds` fold guard** switched from processor-stamp to
  executionId-prefix membership (`agent-output:`/slash): script requests now
  arrive as ordinary rpc appends (the service, or vendored interpreters like
  codemode-tag), and the set is presentation bookkeeping (runningScripts);
  the settlement render gate uses the same prefixes.
- **codemode-tag split**: web agents keep the vendored parser + prompt
  (no interpretResponse — that's the pinning demonstration); integration/
  mcp/onboarding agents get platform defaults + platform interpreter,
  preserving the old template's "integration agents keep classic behavior"
  split under the new model. Its known limits (slash inert, no error
  transcription on web agents) are documented in the file header.
- **No dedicated project-level failure banners built**: `agent/birth-timed-out`
  is the per-agent renderable fact (event feed); `project/worker-update-failed`
  already journals at project level and renders in the project event feed.
  A styled banner + rollback offer is the follow-up the spec already lists.
- **No migration for pre-existing agents**: streams subscribed to the retired
  `agent` slug (and old `agents/birth-defaults` publishes) are not rewritten;
  preview/dev environments get erased, and prod agents are short-lived
  threads. Flagged for the PR rather than silently handled.
- **Unit harness plays the worker**: agent-processor.test.ts auto-interprets
  every committed event after each step (exactly the default template's
  loop), so the classic lifecycle specs still read as real usage;
  agent-headless-processor.test.ts runs WITHOUT that loop to pin that the
  keeper interprets nothing.

### Preview post-mortem (2026-08-18)

First preview run: 16 e2e failures, all one bug — the snapshot/liveState
relays dialed facet "agent" but births subscribe "agent-headless" (fixed in
02207e20d, not by this session). The one remaining failure
(create-project.spec, no assistant message on the SECOND project) was NOT the
deadline sleeper's durability: preview stream forensics showed the degraded
start firing exactly on schedule on a cold bootstrap (held trigger 18:23:53 →
birth-timed-out +10.03s → defaults + finalize + turn → settled succeeded
+10s later), and the default template's project on the same run worked fully
end-to-end (worker birth at +2s, interpretation, script run, lowercase
welcome via web-message-sent). The real cause: **configs/with-voice was never
migrated** — no birth job (so only the degraded start ever dispatched) and no
interpretResponse delegation (so the model's scripted welcome —
itx.chat.sendMessage inside a ```ts fence — was never executed; the UI's
visible assistant message IS that script's web-message-sent). Fixed by
migrating with-voice like the default template (defaults + finalize, no
tweaks; per-event interpreter delegation). The sleeper-durability concern was
tested anyway: an eviction between the held trigger and the deadline is
revived by the recovery keepalive (the keeper registers with recovery), and
the revived at-head pass re-arms off the same trigger's atMs — pinned by the
new eviction spec in agent-birth-degraded-start.test.ts, so no facet-alarm
rearchitecture was needed.
