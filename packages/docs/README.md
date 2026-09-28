# @iterate-com/docs

Live co-editing for a project's docs, the markdown files in `/repos/docs` that
[apps/docs](../../apps/docs/README.md) edits. Git stays the source of truth; while a doc is open,
its processor holds the text as a Yjs `Y.Text` and saves it.

- **`DocProcessor`** ([src/processor.ts](src/processor.ts)), one per open doc on the context
  `/docs/<path>`: the Y.Doc in the facet's own SQLite, edits in and out as ephemeral
  `docs/edit-frame` events, `sync(stateVector)` for a tab joining, and autosave 1.5 s after the
  last edit (8 s at most): a commit whose parent is the commit the text was last saved as, authored
  by the first person who typed, the others as `Co-authored-by:`. A refused save (someone else
  committed) merges their commit in like git and saves on top.
- **`DocsProcessor`** ([src/root.ts](src/root.ts)), on the project's root: remembers which docs
  have been opened and tells each one when a commit to `/repos/docs` changed it, so an agent's
  commit reaches the open editors.
- **`ensureDoc(project, path, version)`** ([src/install.ts](src/install.ts)): what the Docs page
  calls as a doc opens. Idempotent.
- **The wire** ([src/frames.ts](src/frames.ts)): event types, payload schemas, the live state.

```ts
import { ensureDoc } from "@iterate-com/docs/install";

const doc = await ensureDoc(project, "plans/lisbon.md", version);
const { update, stateVector } = await doc.facets.get("doc").sync(myStateVector);
```

Published per commit on pkg.pr.new (`.github/workflows/pkg-pr-new.yml`). `pnpm test` runs the
processors over an in-memory stream, node:sqlite and a fake repo.
