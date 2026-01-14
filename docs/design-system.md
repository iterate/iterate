# Design System

We use shadcn/ui components with vanilla shadcn style. Install additional components using `npx shadcn@latest add <component>`.

## App Consistency

Layout patterns, component usage, and structural patterns should stay in sync between `apps/os` and `apps/daemon`. When making structural changes to one app (layouts, shared components, navigation patterns), ask the user if they want to update the other app to match.

## Mobile-First Development

**All UI must work on mobile first.** Design for 375px width, then expand to desktop.

### Page Titles

Don't add page titles (h1) - the breadcrumbs in the header provide context. Use `HeaderActions` to place action buttons in the header.

```tsx
import { HeaderActions } from "@/components/header-actions.tsx";

<HeaderActions>
  <Button size="sm">
    <Plus className="h-4 w-4" />
    <span className="sr-only">New Item</span>
  </Button>
</HeaderActions>;
```

### Responsive Padding

Use `p-4 md:p-8` for page containers, never fixed `p-8`.

### Content Width

Main content is constrained to phone-width (`max-w-md` / 448px) in layouts. The sidebar is separate.

### Data Lists

Use card layout for data lists (not tables). Cards work well on all screen sizes:

```tsx
<div className="space-y-3">
  {items.map((item) => (
    <div className="flex items-start justify-between gap-4 p-4 border rounded-lg bg-card">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <Circle className="h-2 w-2 fill-green-500 text-green-500" />
          <span className="font-medium truncate">{item.name}</span>
        </div>
        <div className="text-sm text-muted-foreground">
          {item.type} · {item.date}
        </div>
      </div>
      <Button variant="ghost" size="icon" className="shrink-0">
        ...
      </Button>
    </div>
  ))}
</div>
```

Key patterns:

- `space-y-3` for card spacing
- `flex items-start justify-between gap-4 p-4` for card layout
- `min-w-0 flex-1` on content to enable truncation
- Status dots with `Circle` icon + fill color
- Text metadata instead of badges (cleaner look)

### Sheet over Dialog

Prefer `Sheet` (slides in from side) over `Dialog` (modal popup) for forms and actions. Sheets are more mobile-friendly and feel more native. See `apps/os/app/routes/org/project/machines.tsx` for example.

### Flex Layouts

Use `flex flex-col gap-4 sm:flex-row sm:items-center` for layouts that should stack on mobile.

### Standalone Pages (no sidebar)

Use `CenteredLayout` for pages without the sidebar (login, new-organization, user settings):

```tsx
import { CenteredLayout } from "@/components/centered-layout.tsx";

<CenteredLayout>
  <div className="w-full max-w-md space-y-6">{/* content */}</div>
</CenteredLayout>;
```

## Core Principles

- Use theme colors from Tailwind config - no random colors or gradients
- Don't repeat bland copy in multiple places to "fill space"
- Prefer toast notifications over inline success/error messages

## Component Reference

### Item

Use the `Item` component for lists, grids, or table-like layouts instead of raw `<div>`s.

Docs: https://ui.shadcn.com/docs/components/item

**Note:** `ItemDescription` has a default `line-clamp-2`. For longer content, use `Card` instead.

### Card

Use `<Card variant="muted">` for grid layouts with muted backgrounds. Use regular `Card` for rich, multi-paragraph content.

### Field Components

Use for consistent form layouts and accessibility:

```tsx
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";

<FieldGroup>
  <FieldSet>
    <FieldLegend>Contact Information</FieldLegend>
    <Field>
      <FieldLabel htmlFor="name">Full Name</FieldLabel>
      <Input id="name" placeholder="John Doe" required />
    </Field>
    <Field>
      <FieldLabel htmlFor="email">Email</FieldLabel>
      <Input id="email" type="email" />
      <FieldDescription>We'll never share your email</FieldDescription>
    </Field>
  </FieldSet>
</FieldGroup>;
```

Use `Accordion` for advanced/optional fields or multi-stage forms.

### EmptyState

Use the `EmptyState` component from `@/components/empty-state` for empty states.

### Sonner (Toast)

Use `toast` from "sonner" for notifications - the Toaster is already set up.

```tsx
import { toast } from "sonner";

// Prefer this
toast.success("Settings updated successfully");
toast.error("Failed to save changes");

// Avoid inline message state
const [successMessage, setSuccessMessage] = useState(null);
```

### Tabs

Use `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` for tabbed interfaces.

### Spinner

Use `Spinner` for loading states - it has proper accessibility attributes.

### Tooltip

Use `Tooltip` components for contextual help on hover.

### Accordion

Use for collapsible content sections, optional form fields, or multi-stage forms.

### Checkbox

Use the `Checkbox` component with `Field` for proper form integration:

```tsx
<Field orientation="horizontal">
  <Checkbox id="newsletter" />
  <FieldLabel htmlFor="newsletter" className="font-normal">
    Subscribe to newsletter
  </FieldLabel>
</Field>
```
