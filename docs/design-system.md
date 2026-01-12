# Design System

We use shadcn/ui components with vanilla shadcn style. Install additional components using `npx shadcn@latest add <component>`.

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
