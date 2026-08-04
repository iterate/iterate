---
status: in-progress
size: small
---

# Mobile activity card: move step meta lines into a Meta tab

## Status

Spec committed, implementation starting. Nothing done yet.

## Ask

In the mobile app's expanded activity card ("ran code" expandable), each round
currently renders like:

```
Round 2
LLM - openai/gpt-5.5-terra | 61.6s | 1061 tok
Script | Approvals | Result
```

The LLM meta line (and the `CODE · 3.2s` line above the tab bar) take up
vertical space. Move that info into a new trailing `Meta` tab:

```
Round 2
Script | Approvals | Result | Meta
```

## Decisions (assumptions where unspecified)

- `Meta` is the **last** tab and is **always offered** — which means the tab
  bar now always renders (it used to hide when Script was the only tab).
  That's the point: the tab bar replaces the meta lines as the round's
  compact header.
- The `code · 3.2s · failed` label above the tab bar moves into Meta too —
  same category of noise the ask is about.
- Meta tab body: one line per step, same faint uppercase style as before:
  - `llm · openai/gpt-5.5-terra · 61.6s · 1061 tok` (plus failed/cancelled
    suffixes as today)
  - `code · 3.2s · failed`
- `LlmStepView` keeps rendering thinking text / streamed response / error —
  only its meta label line moves. While the llm step is streaming (no code
  step yet, so no tabs exist), the meta label stays where it is as a
  fallback; once the round has a code step, the label lives in Meta only.

## Checklist

- [ ] Add `meta` to the tab union + tabs array in `CodeStepTabs`
      (apps/mobile/src/components/activity-card.tsx)
- [ ] Render Meta tab body with llm + code meta lines; pass the round's llm
      step into `CodeStepTabs`
- [ ] Drop the `code · …` label above the tab bar; drop the llm meta label
      from `LlmStepView` when the round has a code step
- [ ] typecheck / lint / test for apps/mobile
