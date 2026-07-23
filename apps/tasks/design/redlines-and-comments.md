# Layering redlines and comments on the collab lane

Jonas (2026-07-21): "What I want is to be able to render in the user interface really
easily segments like: markers where stuff was deleted, where stuff was added, where stuff
was edited — just like in a sort of red line Google Doc. … comments where you can add
comments to different parts of different files … visual … sort of like annotations."

The punchline first: **the rebase architecture makes both features derivations, not
systems.** The op log is already a totally ordered, per-author record of every change;
redlines are a fold of it, and comments are positions mapped through it. No new sync
machinery, no CRDT metadata, no schema in the files.

## 1. Redlines (tracked changes)

### What a redline IS here

A redline view is "changes between version A and version B of one file, attributed."
The engine has everything needed:

- The ops `(A..B]` are `ChangeSet`s with `clientId` attribution.
- `ChangeSet.iterChanges(fromA, toA, fromB, toB, inserted)` yields exactly the segment
  types wanted: a deleted range in the old doc, inserted text in the new doc; an "edit"
  is simply both at one site.
- Deleted TEXT is reconstructable by replaying from the nearest snapshot ≤ A (the same
  machinery boot already uses), so nothing new is persisted.

**The natural base A**: the last commit. The host's sessions table grows one column,
`committed_version`, stamped inside the commit barrier (reconcile already runs there).
"Redline vs base" = ops since `committed_version`; "what changed in this session" = ops
since any client-chosen version. Both are the same pure function.

### Two rendering paths, in order of effort

**Path 1 — near-zero code, no attribution: `@codemirror/merge`.** CodeMirror's
first-party `unifiedMergeView(original)` renders red struck-through deletions and green
insertions natively, with per-chunk accept/reject built in (Google-Docs "suggesting"
accept/reject for free). All it needs is the base text: one tiny platform addition,
`readBase(path)` = mount-only read bypassing the overlay (the workspace's fall-through
already knows how). Client-side only; ships in an afternoon; right for "show me what's
uncommitted in this card."

**Path 2 — attributed segments from the op log (the real feature).** A host method:

```
collabChanges(path, { sinceVersion? })   // default: committed_version
  → { base: number, head: number, segments: [
       { kind: "inserted", from: number, to: number, clientId: string }
       { kind: "deleted",  at: number, text: string, clientId: string }
     ] }
```

Server-side fold: replay doc states from the nearest snapshot, walk ops `(A..head]`
maintaining an attributed span set — each op's insertions enter tagged with its
clientId; existing spans map forward through `ChangeSet.mapPos`; deletions capture the
removed text from the pre-op doc. Coordinates come out in the CURRENT doc, ready for
decoration. Cacheable per `(path, base, head)`; cost bounded by ops-since-base (the
window is ≤1000 and boards care about far fewer).

Rendering: insertions = mark decorations (author-colored underline/background);
deletions = inline widgets at `at` showing `text` struck through; the board's card
badges (added/modified counts, who-touched) come from the same segments without any
editor. Accept/reject a segment = one ordinary `applyExternal` splice (reject an
insertion → delete it; reject a deletion → re-insert its text) — suggestions mode is
the same primitive with a policy flag on whose ops require acceptance.

## 2. Comments / annotations

### Anchoring — the part that's usually hard — is easy *within* the lane

A comment pins `{ path, from, to, version, author, body }`. Because every change flows
through one authority, the host maps every live comment's anchors forward on each
accepted op (`changes.mapPos(from)`, O(comments) per accept, in-memory) and persists
lazily. Within a session epoch, anchors are EXACT — the same mechanism that keeps
remote cursors correct.

Across session end / epoch rotation (file settled, session GC'd, reopened later):

- Store with each comment a **context snippet** (anchored text ± ~32 chars) refreshed
  at each persist, plus the settled `contentHash` at last mapping.
- On reopen: hash unchanged → anchors carry over verbatim (the cheap content-addressed
  guard). Hash changed → re-anchor by exact snippet search, then fuzzy (unique-prefix/
  suffix) — and if the text is truly gone, the comment enters an **orphaned** state
  listed in the margin ("comment on deleted text"), exactly Google Docs' behavior.

### Storage and wire

Sidecar SQLite in the workspace DO (`collab_comments`), NEVER file content — settling
must not destroy annotations, and markdown can't represent them (Rev 3 invariant).

```
comments.add(path, { from, to, body })      → comment (anchored at head version)
comments.list(path)                          → current positions + orphans
comments.resolve(id) / comments.reply(id, body)
```

Delivery rides the existing lanes: the broadcast/wait result gains an optional
`commentsVersion` bump; clients re-`list` on change (comments are low-frequency — no
per-keystroke traffic). Rendering: mark decoration over `[from, to]` + a margin/gutter
thread UI; board surfaces show per-card comment counts from the same `list`.

**Agents are first-class here too**: `comments.list` over the RPC lane means an agent
can read the review thread anchored to the exact text it's editing, and `comments.add`
lets it annotate its own changes — review-with-your-agent falls out of the same table.

## 3. Sequencing

1. `readBase(path)` + `@codemirror/merge` unified view in the task sheet (days,
   client-heavy, immediately demo-able redlines).
2. `committed_version` column + `collabChanges` segments + decorations (the attributed
   redline; also powers board badges).
3. Comments table + anchor mapping + margin UI; snippet re-anchoring across epochs.
4. Accept/reject on segments (suggestions mode) — same splice primitive, policy only.

Everything above runs on the already-proven engine; none of it touches the wire
protocol, the durability story, or the agent API.
