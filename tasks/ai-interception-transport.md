status: in-progress

# Intercept prepared AI requests

The Gateway work is saved on `codex/ai-gateway-metadata`. This prerequisite
extracts its interception changes onto current main. Implementation and independent
review are complete. Repository checks and preview validation are finishing.

Intercepted models should exercise the same request preparation and response
decoding as provider calls. Strip only `intercepted/`; tests choose their model
explicitly when provider behaviour matters, and keep generic test names otherwise.

- [x] Share request preparation and decoding between intercepted and real calls. *Both routes dispatch in workers-ai-transport; agent interception no longer bypasses decoding.*
- [x] Expose the prepared request to handlers without provider credentials. *Named OpenAI/Workers AI request types exclude the dispatch credential; parity matrix checks both.*
- [x] Use the reviewed HTTP-shaped result (`status`, `headers`, `body`) and migrate callers through existing test helpers. *Existing resilient-ai-interceptor helper now creates provider-shaped text/JSON fixtures; null represents absent bodies.*
- [x] Preserve public `ai.run` decoding and its existing `returnRawResponse` option. *JSON/media/raw e2e covers the binding’s decoding rules, HTTP failures, and empty versus absent bodies.*
- [ ] Verify text, usage, provider errors, and interception lifecycle through meaningful tests and a preview.
- [ ] Complete repository checks and independent PR review.

No Gateway metadata, budget rules, cost events, or budget-specific failure
handling belong here. Returning actual `Response` objects from callbacks remains
a possible next change to review; this extraction does not introduce live
response streaming over RPC. Leave the Gateway branch untouched until this lands.

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
