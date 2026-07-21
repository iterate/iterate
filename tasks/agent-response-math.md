---
status: in-progress
size: small
---

# Render maths in agent responses

Status: Scoped and ready to implement. The shared Streamdown-backed response renderer is the integration point; dependency wiring, rendering coverage, and localhost verification remain.

Add Streamdown's KaTeX-backed maths plugin to the shared UI response renderer so agent answers can render inline and display LaTeX instead of showing delimiter source.

## Assumptions

- Support Streamdown's documented `$$…$$` syntax for inline maths and display maths when the delimiters are on their own lines.
- Configure the shared `MessageResponse` component so the agent feed is covered and other existing rich-response surfaces get the same behaviour.
- Preserve the current client-only lazy renderer and plain-text SSR/loading fallback.
- Keep this branch local and stop after localhost handoff; do not open a pull request without a further request.

## Checklist

- [x] Record the intended scope in an isolated worktree. *Created `ui/agent-response-math` in `../worktrees/iterate/agent-response-math`.*
- [ ] Add the official Streamdown maths plugin and its required KaTeX styling.
- [ ] Prove inline and display maths render through the shared response component.
- [ ] Run focused tests and typechecks.
- [ ] Start local OS and provide a usable agent-chat URL for manual testing.
- [ ] Open a pull request. *Intentionally deferred until explicitly requested after manual testing.*

## Implementation log

- 2026-07-21: Selected `@streamdown/math`, the official plugin for the existing Streamdown renderer. Its documented default avoids ambiguous single-dollar currency syntax and emits accessible MathML via KaTeX.
