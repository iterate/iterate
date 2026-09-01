---
status: needs-grilling
size: medium
---

# Liquid-templated messages after codemode scripts

Deliberately carved out of the codemode-tag rendering design (see
[codemode-tag-message-rendering](codemode-tag-message-rendering.md)). Idea: the
model emits a script plus a templated message that resolves once the script
result lands:

```
<codemode status="factorizing">
return primeFactors(484214)
</codemode>

the factors are {{ result | join ", " }}
```

No extra LLM turn to say "the factors are 2, 61, 3967". Related plan: most
assistant replies become streamed plaintext (token-by-token), so post-script
templated text would be the way scripts talk back to the user.

## How it would fit the derivation-processor model

Mechanically clean under the design being grilled: the project's derivation
processor holds the template from the assistant emission; when the
script-settled fact arrives it renders the template and emits the resolved
`message-said` fact with provenance to *both* raw offsets (assistant emission +
script result). Renderers never see liquid syntax.

## Open questions (why this is parked)

- [ ] **Does the rendered text enter the model's context?** The model has
      template + result and can reconstruct, but "what the user saw" and "what
      the model remembers saying" diverge textually. Lean: keep context raw
      (facts, prompt-cache identity) and trust reconstruction — but it's a real
      fork and needs a decision.
- [ ] **Error path.** Script throws but the template references `result` — emit
      a render-failed fact? Render with the error value? Suppress? Principle
      from the prompting-failure capture ("a raw error is more useful than a
      hand-built one") suggests: show something honest, never silently drop.
- [ ] **Template language + sandboxing.** Liquid proper, or a tiny expression
      subset? Filters allowed? Runs in project-space (processor) so it's not a
      kernel question, but the template surface is LLM-prompted, so the spec
      prompt and the renderer's failure modes need to agree.
- [ ] **Provenance timing.** One raw assistant event now yields derived facts
      at different times (prose immediately, templated message only after the
      script settles). The supersede/provenance rule must tolerate
      late-arriving derived children — no "derive once, atomically"
      simplification. (The main design already leans this way; this task is the
      strongest forcing function.)

## Notes

- 2026-09-01: split out of the codemode-tag rendering grill at Misha's request
  ("don't include liquid template/post-`</codemode>` stuff in scope because I
  don't really know the answers to your questions").
