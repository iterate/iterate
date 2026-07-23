---
status: in-progress
size: small
---

# Icon buttons: hover text + lint rule

## Status summary

Spec fleshed out, implementation not started. Main pieces: Button auto-title in
the design system, jsx-a11y lint enforcement, fix violations.

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
- **Lint rule**: the popular off-the-shelf option is `eslint-plugin-jsx-a11y`'s
  `control-has-associated-label`. oxlint's native jsx-a11y plugin doesn't
  implement that rule, but this repo already runs ESLint plugins inside oxlint
  via `jsPlugins`, so load `eslint-plugin-jsx-a11y` there (aliased, since the
  bare name is reserved by oxlint) with `settings.jsx-a11y.components` mapping
  `Button -> button` so the custom component is checked too.
- If the off-the-shelf rule proves unworkable under oxlint (settings not
  forwarded, false-positive storm), fall back to a small custom rule in
  `lint/oxlint-plugin-iterate.ts` — but only after demonstrating the
  off-the-shelf route fails, and note why in this file.

## Checklist

- [ ] `Button`: derive `title` from `aria-label` for icon sizes
- [ ] load `eslint-plugin-jsx-a11y` into oxlint config, enable
      `control-has-associated-label` with `Button` component mapping
- [ ] fix all violations the rule finds (add `aria-label`s)
- [ ] confirm `pnpm lint` red on an unlabeled icon button, green after fix
