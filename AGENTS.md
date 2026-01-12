# Agent Instructions

## Quick Reference

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm format && pnpm test
```

Run these before opening PRs.

## Critical Rules

- **apps/os is DEPRECATED** - work in apps/os2 only
- **"iterate" is always lowercase**, even at the start of a sentence
- **No `as any`** - fix types properly or ask for help
- **No `console` in backend** - use logger from `backend/tag-logger.ts`
- **No `import { z } from "zod"`** - use `"zod/v4"`
- **No useEffect for data fetching** - use `useSuspenseQuery`
- **No inline error/success messages** - use toast notifications

## Detailed Documentation

| Topic                         | Location                                                 |
| ----------------------------- | -------------------------------------------------------- |
| Frontend (React, components)  | [apps/os2/app/AGENTS.md](apps/os2/app/AGENTS.md)         |
| Backend (Cloudflare, Drizzle) | [apps/os2/backend/AGENTS.md](apps/os2/backend/AGENTS.md) |
| E2E Testing (Playwright)      | [e2e/AGENTS.md](e2e/AGENTS.md)                           |
| Design System                 | [docs/design-system.md](docs/design-system.md)           |
| Vitest Patterns               | [docs/vitest-patterns.md](docs/vitest-patterns.md)       |

---

## Repository Structure

```
apps/os2/          # Primary application (React + Cloudflare Workers)
  app/             # Frontend (React + Vite)
  backend/         # Cloudflare Worker backend (Drizzle + Postgres)
apps/daemon2/      # Local daemon (Hono-based)
apps/os/           # DEPRECATED - do not use
packages/          # Shared packages
estates/           # Brand/deployment configurations
e2e/               # Playwright end-to-end tests
docs/              # Detailed documentation
```

---

## TypeScript

- Strict TypeScript with inferred types where possible
- File and folder names: **kebab-case** (e.g., `some-thing-template.tsx`)
- Include `.ts/.js` extensions in relative imports (not in package imports)
- Use `node:` prefix for Node imports (e.g., `node:fs`)
- Prefer named exports over default exports
- Acronyms: all caps except `Id` (e.g., `callbackURL`, `userId`)
- Use `pnpm` as package manager
- Use `remeda` for utilities, `dedent` for template strings
- Unit tests colocated as `*.test.ts` next to source files
- E2E tests go in `e2e/` folder as `*.e2e.ts` files

---

## Naming

Be explicit. If a concept is `SomeThingTemplate`, name the file `some-thing-template.tsx`, not `template.tsx`.

Prefer self-documenting code over comments. Only comment when explaining non-obvious design decisions.

---

## Task System

Tasks are markdown files in `tasks/` with optional YAML frontmatter:

```yaml
---
state: todo | next | in-progress | done
priority: high | medium | low
size: large | medium | small
dependsOn:
  - tasks/other-task.md
---
```

**Working on a task:** Read the file → check dependencies → clarify if unclear → execute.

**Recording a task:** Create file in `tasks/` → write brief description → confirm with user.

---

## JSON Schema

We use JSON Schema for validation and form generation with `@rjsf/shadcn`:

```typescript
import Form from "@rjsf/shadcn";
import validator from "@rjsf/validator-ajv8";

<Form schema={myJsonSchema} validator={validator} formData={data} />
```

Note: OpenAI function calling has limited JSON Schema support (no `$ref`, limited validation keywords).
