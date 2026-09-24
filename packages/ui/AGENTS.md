# packages/ui

The UI kit every client app imports as `@iterate-com/ui/*`.

## shadcn components

These come from the shadcn registry (style `base-nova`, on Base UI), and the shadcn CLI manages them
through `components.json`: alert-dialog, avatar, badge, breadcrumb, button, card, checkbox,
command, dialog, dropdown-menu, empty, field, input, label, native-select, select, separator, sheet,
sidebar, skeleton, sonner, spinner, table, tabs, textarea, tooltip and `hooks/use-mobile.ts`.
`components/ai-elements/` is a fork of Vercel's AI Elements (a Radix registry), refreshed by hand.
Everything else here is our own code.

To see what upstream changed, then take it:

```sh
pnpm dlx shadcn@4.21.0 add button --dry-run --diff -c packages/ui
pnpm dlx shadcn@4.21.0 add button -o -y -c packages/ui
```

Before committing a refresh:

- Revert the CLI's `package.json` and `pnpm-lock.yaml` edits (it adds `cn` and `next-themes`).
- Import `cn` from `@iterate-com/ui/lib/utils`, strip every `dark:` class (light mode only), and
  run `oxfmt`.
- Delete the parts no app uses again. A refresh brings them back.
- Keep these local changes:

| File          | Change                                                     | Why                                                           |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| button        | An icon-size button takes its `title` from `aria-label`    | Hover text; `iterate/icon-button-has-hover-text` relies on it |
| dialog, sheet | The close button has `aria-label="Close"`, no sr-only span | `iterate/icon-button-has-hover-text`                          |
| sheet         | Full width on a phone (`w-full sm:w-3/4`)                  | Mobile polish, #1883                                          |
| sidebar       | A link click closes the phone sheet; constants inlined     | shadcn-ui/ui#5561; `iterate/no-shouting-constants`            |
| breadcrumb    | No `role="link"` on `BreadcrumbPage`                       | `jsx-a11y/prefer-tag-over-role`                               |
| label         | The `oxlint-disable` line                                  | `jsx-a11y/label-has-associated-control`                       |
| sonner        | No `next-themes`; re-exports `toast`                       | Light mode only                                               |
| command       | The ⌘K palette's own look (#2991)                          | Upstream's differs                                            |

`src/styles/globals.css` carries the part of `shadcn/tailwind.css` these components are written
against: the `data-*` variants and `no-scrollbar`.
