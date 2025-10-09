---
globs: ["**/*.tsx"]
---

We like using vanilla shadcn style.

Don't add unnecessary tailwind classes all over the place with random colours of even gradients.

We rely on tailwind's builtin theming, so any colours you do use must come from the theme.

Make sure NEVER to repeat the same bland copy in two places just to "fill the space". Not everything needs a subheading that says the same thing again as the heading!

# Notable components

### We really like using the new `Item` component from shadcn/ui.

You can find the docs here: https://ui.shadcn.com/docs/components/item or just read apps/os/app/components/ui/item.tsx

Whenever you would otherwise use a bunch of `<div>`s in a grid or table or whatever with some gap and padding etc, just use `<Item>`.

**Important:** The `Item` component (specifically `ItemDescription`) is optimized for short, concise content and has a default `line-clamp-2` that limits text to 2 lines. For multi-paragraph or longer text content, use the `Card` component instead, which is better suited for rich content.

### Use the `Card` component with `variant="muted"` for structuring content in grids.

When laying out content in grids or multi-column layouts, prefer using `<Card variant="muted">` for a clean, borderless, muted background card. This provides visual grouping without heavy borders:

### We use the `Empty` component for empty states, which is a newer shadcn/ui component.

You can find it at apps/os/app/components/ui/empty.tsx and use it for clean, consistent empty state presentations.

### We use Sonner for toast notifications.

Import and use `toast` from "sonner" for user feedback and notifications. The Toaster component is already set up in the app root.
