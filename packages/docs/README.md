# @iterate-com/docs

Live co-editing for a project's docs, the markdown files in its repos that
iterate's Docs app (`apps/docs`) edits. Git stays the source of truth; while a doc is open,
its processor holds the text as a Yjs `Y.Text` and saves it.

- **`DocProcessor`** ([src/processor.ts](src/processor.ts)), one per open doc on the context
  `/docs/<repo name>/<path>`: the Y.Doc in the facet's own SQLite, edits in and out as ephemeral
  `docs/edit-frame` events, `sync(stateVector, client)` for a tab joining, and a commit a minute
  after the first unsaved edit, or at once when the last tab sends `docs/left`. A commit's parent
  is the commit the text was last saved as; its author is the first person who typed, the others
  `Co-authored-by:`. A repo like `/repos/config` republishes the project's site on each commit, so
  a burst of typing is one commit. A refused save (someone else
  committed) merges their commit in like git and saves on top.
- **`DocsProcessor`** ([src/root.ts](src/root.ts)), on the project's root: remembers which docs
  have been opened and tells each one when a commit to its repo changed it, so an agent's
  commit reaches the open editors.
- **Installing it** ([src/install.ts](src/install.ts)): a project's config repo does, as it does
  agents: `docs.ts` re-exports the processors (`docsModule`) and the root `package.json` pins
  `@iterate-com/docs`. The processors load from that published config (`docsFacetSpec`), so a
  commit to the pin upgrades them. `installDocs(project, version)` writes both in one commit and
  waits for the project to run it. `ensureDoc(project, { repo, path })` is what the Docs page calls
  as a doc opens: it enables both processors. Idempotent.
- **Comments** ([src/comments.ts](src/comments.ts)): durable events on the doc's context, reduced
  by the doc's processor into its state and live state. A thread quotes its text
  ([src/anchor.ts](src/anchor.ts)) rather than holding a position, and after each save the
  processor re-anchors a quote that only matches loosely, or marks it detached.
- **The wire** ([src/frames.ts](src/frames.ts)): event types, payload schemas, the live state.
- **For agents** ([AGENTS.md](AGENTS.md)): reading, editing and commenting on docs from a script,
  the moves the page makes. `installDocs` points the project's own `AGENTS.md` at it.

```ts
import { ensureDoc } from "@iterate-com/docs/install";

// the project's config: docs.ts is `export { DocDurableObject, DocsDurableObject } from "@iterate-com/docs";`
const doc = await ensureDoc(project, { repo: "/repos/config", path: "plans/lisbon.md" });
const { update, stateVector } = await doc.facets.get("doc").sync(myStateVector, myClientId);
```

Published per commit on pkg.pr.new (`.github/workflows/pkg-pr-new.yml`). `pnpm test` runs the
processors over an in-memory stream, node:sqlite and a fake repo.
