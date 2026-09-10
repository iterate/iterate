status: in-progress

# Intercept prepared AI requests

The Gateway work is saved on `codex/ai-gateway-metadata`. This prerequisite
extracts its interception changes onto current main. The initial extraction passed
review and preview CI. The requested native `Response` / live SSE follow-up is
left uncommitted. Stream cancellation remains unresolved. The user closed the
external RPC PR and stopped that work; its dependency pin has been removed.

Intercepted models should exercise the same request preparation and response
decoding as provider calls. Strip only `intercepted/`; tests choose their model
explicitly when provider behaviour matters, and keep generic test names otherwise.

- [x] Share request preparation and decoding between intercepted and real calls. *Both routes dispatch in workers-ai-transport; agent interception no longer bypasses decoding.*
- [x] Expose the prepared request to handlers without provider credentials. *Named OpenAI/Workers AI request types exclude the dispatch credential; parity matrix checks both.*
- [x] Return native `Response` objects from interceptors, including live SSE bodies. *Callbacks use `Response.json` or `new Response`; the existing text helper returns a Response.*
- [ ] Verify incremental SSE, cancellation, producer errors, disconnects, and invalid responses across the real RPC chain.
- [ ] Resolve streaming limitations within the agreed scope. *External RPC work stopped at user request; do not reopen or create external PRs.*
- [x] Preserve public `ai.run` decoding and its existing `returnRawResponse` option. *JSON/media/raw e2e covers the binding’s decoding rules, HTTP failures, and empty versus absent bodies.*
- [x] Verify text, usage, provider errors, and interception lifecycle through meaningful tests and a preview. *119 focused tests, four local and deployed API tests, and both deployed agent browser scenarios passed.*
- [x] Complete repository checks and independent PR review. *Full CI passed on 8c5e2fca9; independent review and Iterate GitHub AI linter found no remaining issues.*

No Gateway metadata, budget rules, cost events, or budget-specific failure
handling belong here. Native `Response` callbacks and live SSE were subsequently
requested in this PR. Leave the Gateway branch untouched until this lands.

## Implementation notes

- Source: `9a07f929e`; base: current `origin/main` (`7a6face91b`). Adapt the
  extraction to newer main instead of replacing files wholesale.
- Coding session: `01a07b03-100a-7803-ba3f-caed48046317`.

- Tracer proved red before implementation (intercepted OpenAI request dialed
  provider), then green through shared preparation/SSE decoding. Focused
  transport + agent suites passed (120 tests before removing one redundant
  deadline test); scoped lint passed.
- Native binding error class is private. Decoded ai.run HTTP failures preserve
  status and body excerpt in Error rather than InferenceUpstreamError.
- Unified agent calls retain no gateway option; direct ai.run retains caller
  gateway options. Cache masking and asynchronous Web Crypto are unchanged.
- New main's root-stream restart/reinstall regression retained. Main's file
  mention browser test now reads the prepared request body.
- Independent review caught empty-string bodies being collapsed into absent
  bodies; the serialized contract now preserves both. Full tests caught missing
  API summaries on the two request types; summaries added and all 16 graph
  tests passed on rerun.

- Preview slot 9: all six live test suites passed. One unrelated
  `stream-resume-after-suspend.spec.ts` test passed on its existing retry;
  interception scenarios passed first time. No retries or skips were added.
- PR: https://github.com/iterate/iterate/pull/2613. Gateway branch left untouched.
