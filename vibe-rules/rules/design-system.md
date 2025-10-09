---
globs: ["**/*.tsx"]
---

We like using vanilla shadcn style.

Don't add unnecessary tailwind classes all over the place with random colours of even gradients.

We rely on tailwind's builtin theming, so any colours you do use must come from the theme.

# Notable components

### We really like using the new `Item` component from shadcn/ui.

You can find the docs here: https://ui.shadcn.com/docs/components/item or just read apps/os/app/components/ui/item.tsx

Whenever you would otherwise use a bunch of `<div>`s in a grid or table or whatever with some gap and padding etc, just use `<Item>`.

When using Items in a grid layout, ensure all items have the same height by omitting `items-start` from the grid container (allowing items to stretch), then add `items-start` to each `<Item>` className to top-align the icon and content within each card.

### We use the `Empty` component for empty states, which is a newer shadcn/ui component.

You can find it at apps/os/app/components/ui/empty.tsx and use it for clean, consistent empty state presentations.
