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

### Forms

Use the `Field` components from apps/os/app/components/ui/field.tsx for consistent form layouts and proper accessibility. Check out the docs at https://ui.shadcn.com/docs/components/field for more details.

For advanced or optional fields, use `Accordion` to hide them by default. Accordion also works well for multi-stage forms where you want to break up complex flows into collapsible sections.

Here's a concise example showing how to use the Field components:

```tsx
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function ContactForm() {
  return (
    <form className="w-full max-w-md">
      <FieldGroup>
        <FieldSet>
          <FieldLegend>Contact Information</FieldLegend>
          <Field>
            <FieldLabel htmlFor="name">Full Name</FieldLabel>
            <Input id="name" placeholder="John Doe" required />
          </Field>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input id="email" type="email" placeholder="john@example.com" required />
            <FieldDescription>We'll never share your email</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="message">Message</FieldLabel>
            <Textarea id="message" placeholder="Your message here..." />
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="newsletter" />
            <FieldLabel htmlFor="newsletter" className="font-normal">
              Subscribe to newsletter
            </FieldLabel>
          </Field>
        </FieldSet>
        <Field orientation="horizontal">
          <Button type="submit">Send Message</Button>
          <Button variant="outline" type="button">
            Cancel
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
```

### Use the `Card` component with `variant="muted"` for structuring content in grids.

When laying out content in grids or multi-column layouts, prefer using `<Card variant="muted">` for a clean, borderless, muted background card. This provides visual grouping without heavy borders:

### We use the `Empty` component for empty states, which is a newer shadcn/ui component.

You can find it at apps/os/app/components/ui/empty.tsx and use it for clean, consistent empty state presentations.

### We use Sonner for toast notifications.

Import and use `toast` from "sonner" for user feedback and notifications. The Toaster component is already set up in the app root.

### We use the `Tabs` component for tabbed interfaces.

Use the `Tabs`, `TabsList`, `TabsTrigger`, and `TabsContent` components from `apps/os/app/components/ui/tabs.tsx` for clean, accessible tabbed interfaces.

**Prefer toast notifications over transient inline messages.** Instead of showing temporary success/error messages inline within forms or components, use toast notifications for a cleaner, less intrusive user experience:

```tsx
import { toast } from "sonner";

// ✅ Good - use toast for user feedback
toast.success("Settings updated successfully");
toast.error("Failed to save changes");

// ❌ Avoid - don't clutter the UI with inline messages
const [successMessage, setSuccessMessage] = useState(null);
// ... render inline message divs
```

### We use the `Spinner` component for loading states.

Use the `Spinner` component from `apps/os/app/components/ui/spinner.tsx` for all loading spinners. It provides consistent styling, proper accessibility with `role="status"` and `aria-label="Loading"`, and uses the Loader2Icon from Lucide React with smooth animation.

### We use the `Tooltip` component for contextual help.

Use the `Tooltip` components from `apps/os/app/components/ui/tooltip.tsx` to provide helpful hints and additional information on hover.
