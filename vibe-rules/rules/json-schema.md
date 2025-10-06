---
description: "JSON Schema usage in TypeScript/TSX files"
globs: ["**/*.ts", "**/*.tsx"]
---

# JSON Schema

We use JSON Schema extensively throughout the codebase for data validation, API contracts, and form generation.

## Form Rendering

For rendering forms from JSON Schema, we use **@rjsf/shadcn** (React JSON Schema Form with shadcn theme).
This provides automatic form generation with shadcn-styled components from JSON Schema definitions.

Example usage:

```typescript
import Form from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";

<Form
  schema={myJsonSchema}
  validator={validator}
  formData={data}
  onChange={({ formData }) => setData(formData)}
/>
```

## Important Note

OpenAI's function calling doesn't support the full JSON Schema spec. Be aware of limitations when using JSON Schema for OpenAI tool definitions:

- No support for `$ref` references
- Limited support for complex validation keywords
- Some format validators may not be enforced

Always test your schemas with the actual OpenAI API to ensure compatibility.
