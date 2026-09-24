# Grandfather existing violations

A new rule usually lands with violations it cannot fix in the same PR. `grandfatherRule` lets it
land armed: the violations that exist today are listed in
[`grandfathered.json`](grandfathered.json) and suppressed; every other report is an error.

```ts
import { grandfatherRule } from "./grandfather-rule.ts";

export const noShoutingConstants = grandfatherRule({
  meta: {
    /* normal rule metadata */
  },
  create(context) {
    /* normal rule listeners */
  },
});
```

`grandfathered.json` maps rule id → file → the trimmed text of each grandfathered report's
start line, once per report:

```json
{
  "iterate/prefer-object-property-match": {
    "apps/dummy-petshop/src/worker.test.ts": [
      "expect(response.status).toBe(302);",
      "expect(response.status).toBe(302);"
    ]
  }
}
```

- **Moved lines stay grandfathered.** A report is matched by its line's text, not its line
  number, so code added above it or a reindent changes nothing.
- **Edited, copied and new lines are checked.** An edit changes the text. Each entry covers one
  report, so a third `expect(response.status).toBe(302);` in that file is an error, and so is
  the same line in another file.
- **The file only shrinks.** An entry that no report uses any more is itself an error on the
  file, until `pnpm lint:baseline` drops it. Without `--add`, that script only removes entries.
- **A renamed file** loses its entries: rename its key in `grandfathered.json`, or fix the
  violations. The lint tests fail on a key whose file no longer exists.

To arm a new rule with its existing violations, wrap it and run
`pnpm lint:baseline --add iterate/<rule>`. When a rule's entries reach zero, drop its
`grandfatherRule` wrapper; the lint tests fail while a grandfathered rule has no entries.

Rules keep their metadata, listeners, options, messages, suggestions and fixes. Suppressed
reports do not apply fixes. Linting reads no Git history, so it works the same in a shallow,
blobless or exported checkout, and a pull request's result does not change when it is merged.
