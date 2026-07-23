---
status: done
size: small
---

# Icon buttons: hover text + lint rule

## Status summary

Done, pending review. Button now derives `title` (hover text) from `aria-label`
on icon sizes; a custom oxlint rule (`iterate/icon-button-has-hover-text`)
enforces labels on icon-size Buttons; the three violations it found are fixed.
The off-the-shelf rule turned out to be structurally unable to catch this —
details below.

## Ask

Icon-only buttons (e.g. the Activity/Unplug buttons on integration connection
rows) have `aria-label`s but no hover text — hovering tells you nothing about
what the button does. Add hover text, and add a lint rule so unlabeled icon
buttons can't sneak in again. Prefer a popular off-the-shelf lint rule.

## Decisions (assumptions made while Misha is AFK)

- **Hover text mechanism**: native `title` attribute derived automatically from
  `aria-label` in the design-system `Button` when `size` is an icon size and no
  explicit `title` is passed. One change gives every labeled icon button hover
  text; no per-callsite churn, no DOM-structure change (a styled Tooltip wrapper
  would risk breaking `render`-prop composition and adds provider ceremony).
  Explicit `title` still wins.
- **Lint rule — off-the-shelf didn't survive contact**: the popular option is
  `eslint-plugin-jsx-a11y`'s `control-has-associated-label`, but its
  `mayHaveAccessibleLabel` helper assumes any uppercase-component child *might*
  render a text label and bails (`isReactComponent → return true`). Since icon
  buttons' only child is a lucide icon component, the rule can never flag
  `<Button size="icon"><Trash /></Button>`. oxlint's native jsx-a11y plugin
  doesn't implement the rule at all. So: a small custom rule
  (`iterate/icon-button-has-hover-text`) in the existing oxlint JS plugin —
  flags icon-size `<Button>`s with no `aria-label`/`aria-labelledby`/`title`;
  dynamic values and spreads are assumed to provide one.

## Checklist

- [x] `Button`: derive `title` from `aria-label` for icon sizes — _`packages/ui/src/components/button.tsx`_
- [x] ~~load `eslint-plugin-jsx-a11y` into oxlint config, enable `control-has-associated-label`~~ — _the rule structurally can't flag icon-component children (see decision above); custom rule instead_
- [x] lint rule enforcing labeled icon buttons — _`iterate/icon-button-has-hover-text` in `lint/oxlint-plugin-iterate.ts`, tests in `lint/oxlint-plugin-icon-button.test.ts`_
- [x] fix all violations the rule finds — _3 found, all in `packages/ui`: dialog + sheet close buttons (moved `sr-only` span label to `aria-label` so they get hover text too), combobox chip-remove (was fully unlabeled — genuine catch)_
- [x] confirm `pnpm lint` red on an unlabeled icon button, green after fix — _rule tests spawn the real oxlint binary against fixture files; repo lint green_

## Implementation log

- The integrations-page buttons from the screenshot already had `aria-label`s,
  so they get hover text purely from the Button change — no callsite edits.
- `eslint-plugin-jsx-a11y` was installed and then removed after reading its
  rule source ruled it out (see decision above).
- Rule message points people at `aria-label` and notes Button renders it as
  `title`, so the fix is self-explanatory at the lint error.
