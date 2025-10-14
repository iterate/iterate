---
description: "How to write good typescript"
globs: ["**/*.ts", "**/*.tsx"]
eslint:
  ignores: ["**/*test*/**", "**/*test*"]
  rules:
    iterate/no-as-never: "error"
    iterate/no-as-any: "error"
---

- Use inferred types where possible. If you're creating super complex generic type expressions you're probably doing it wrong
- Use strict typescript
- File and folder names should be kebab-cased
- Do not use template literals if interpolation and special-character handling are not needed
- Always put utility functions _below_ the rest of the code
- Prefer named exports over default exports
- Include .ts/.js extension in relative import statements (but not in package imports even within the monorepo)
- Use node: prefix for node imports (e.g. import { readFile } from "node:fs")
- Unit tests are always colocated in \*.test.ts files alongside the tested file. We use vitest.
- You do not need to ever import React
- Do not ever cast with 'as any' or 'as never' to work around typescript issues. Instead, fix the typescript issues if the solution is obvious, or ask your human for help. It's better to leave the human with a type error than to hack the types.
- Acronyms in identifiers should be all caps (e.g. `callbackURL`, `getHTMLElement`), with the bizarre exception that `Id` should be capitalized as a word (e.g. `userId`, `organizationId`).

# Third party dependencies

We use pnpm as our package manager.

Use remeda for various utilities.
Use dedent for multiline prompt template strings.
Don't ever install ts-node or similar. We use node 24 which can run typescript natively.
Use import { z } from "zod/v4" to import v4 of zod (the latest version), do not use import ... from "zod" without the /v4
