---
status: preview-only
size: small
---

# Render maths in agent responses

Status: The shared response renderer now produces styled, accessible inline and display maths. Automated checks and a real local agent conversation pass; a draft, preview-labelled sandbox PR is requested solely for evaluation and is not intended for merge.

Add Streamdown's KaTeX-backed maths plugin to the shared UI response renderer so agent answers can render inline and display LaTeX instead of showing delimiter source.

## Assumptions

- Support Streamdown's documented `$$…$$` syntax for inline maths and display maths when the delimiters are on their own lines.
- Configure the shared `MessageResponse` component so the agent feed is covered and other existing rich-response surfaces get the same behaviour.
- Preserve the current client-only lazy renderer and plain-text SSR/loading fallback.
- Open a draft PR with the `preview` label, clearly marked as an experiment that is not intended for merge yet.

## Checklist

- [x] Record the intended scope in an isolated worktree. *Created `agent-response-math-preview` in `../worktrees/iterate/agent-response-math`.*
- [x] Add the official Streamdown maths plugin and its required KaTeX styling. *`message-response-rich.tsx` places `@streamdown/math` after Streamdown's sanitizer; shared globals include KaTeX CSS.*
- [x] Prove inline and display maths render through the shared response component. *The agent-feed test asserts KaTeX display markup and accessible MathML for both forms.*
- [x] Run focused tests and typechecks. *The agent-feed suite and both `@iterate-com/ui` and `@iterate-com/os` typechecks pass.*
- [x] Start local OS and provide a usable agent-chat URL for manual testing. *Local OS runs on port 61293 with project `math-rendering` and agent `/agents/web/math-demo`.*
- [ ] Open a draft, `preview`-labelled pull request that is explicitly not intended for merge.

## Implementation log

- 2026-07-21: Selected `@streamdown/math`, the official plugin for the existing Streamdown renderer. Its documented default avoids ambiguous single-dollar currency syntax and emits accessible MathML via KaTeX.
- 2026-07-21: A red rendering test exposed that Streamdown 1.6's bundled KaTeX transform runs before its sanitizer, which strips KaTeX's presentation classes. The shared rich-response module removes that transform and appends the official plugin after sanitization.
- 2026-07-21: Verified a real local agent response in a headed browser: one `.katex-display`, one `<math>` accessibility tree, correct visual layout, and no browser console errors.
- 2026-07-21: After the localhost check, the user requested a draft preview PR for sandbox evaluation, explicitly not for merge. Merged the latest `origin/main` before preparing it.
