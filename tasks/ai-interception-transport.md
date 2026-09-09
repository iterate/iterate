status: in-progress

# Intercept prepared AI requests

The Gateway work is saved on `codex/ai-gateway-metadata`. This prerequisite
extracts its interception changes onto current main. Implementation and
validation are pending.

Intercepted models should exercise the same request preparation and response
decoding as provider calls. Strip only `intercepted/`; tests choose their model
explicitly when provider behaviour matters, and keep generic test names otherwise.

- [ ] Share request preparation and decoding between intercepted and real calls.
- [ ] Expose the prepared request to handlers without provider credentials.
- [ ] Use the reviewed HTTP-shaped result (`status`, `headers`, `body`) and migrate callers through existing test helpers.
- [ ] Preserve public `ai.run` decoding and its existing `returnRawResponse` option.
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
