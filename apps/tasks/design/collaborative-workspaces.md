# Collaborative workspaces — design collaboration file

Working file for the Jonas ⇄ Claude design conversation about converging Tasks checkouts
(and future collaborative surfaces) onto the apps/os workspace abstraction. Keeps verbatim
requirements, established facts, decisions, and open questions. Update as we go.

## Verbatim requirements from Jonas (2026-07-21)

> "I would like agents to use the standard ITX.workspace API. I would like to be able to do
> this with really large repos like the @iterate/iterate repo and it should be really
> performant. Everything should just work."

> "I do think we want [Yjs] just because it works so well … maybe one sub-agent could explore
> since we already have this stream abstraction. Just using ephemeral events on a workspace or
> something like that to send the individual character modifications to the stream and all
> that and stream it to consumers. I'm kind of open to that but I wonder if it would just be
> too much."

> "i find the idea of giving workspace streams a 'collaborative session mode' quite appealing tbh"

> "we will also have a collaborative Google Docs-style rich text editor for markdown files in
> there and potentially collaborative source code editing and other things like that. They
> should all be powered by a workspace. It should work on really really massive repos, really
> massive. You can assume that we have the repo in the artefact and now we want to collaborate
> on it and we want to do things such as render the file tree and so on."

> "Of course the workspace is there, this mount concept as well, which adds another dimension
> that could potentially throw Spanner in the works. … I do want the mounting to exist. I
> think the way that agents interact with the workspace is an okay API right now. Maybe really
> let's just lock in what are the APIs and interactions and external requirements of this
> system."

> "I wonder what would happen in the lock file case where we have truly massive files …
> I don't even know how that will work with CloudFlare's WebSocket message cap. … would
> there be OT transform events? … I wonder also maybe you can think about what is a way we
> can prove out that this design works, right? Including through the extra hop of the
> tasks app. … It needs to be ergonomic to do maybe somehow with a local app/os dev server
> and a local tasks dev server strung together in just the right way."

## Corrections from Jonas

- **2026-07-21**: Claude claimed the iterate monorepo can't be ingested (128MB isolate OOM on
  isomorphic-git clone). Jonas: wrong — public GitHub repos can now be imported directly
  through Artifacts. **Verified**: PR #2157 "Import public GitHub repos through Artifacts"
  (repo-processor events `github-import-requested/started/completed/failed`). Working
  assumption going forward: *the repo content lives in Artifacts; collaboration is built on
  top of that substrate.*

## Requirements (locked so far)

1. Agents use the **standard `itx.workspace` API** — current agent-facing surface
   (readFile/writeFile/edit/glob/gitStatus/gitCommit) is "an okay API right now"; keep it.
2. **Mounts stay.** Multi-repo mount tables with per-mount commit policy are a core dimension,
   not an implementation detail to design away.
3. Works on **really massive repos** (iterate/iterate and beyond), assuming repo-in-Artifacts.
4. Collaboration surfaces powered by workspaces: **task boards, Google-Docs-style rich text
   markdown editing, collaborative source-code editing**, file-tree rendering, and more.
5. Yjs favoured for the collab layer ("it works so well"); streams open question resolved:
   raw keystroke app-events = no; **Yjs updates as ephemeral stream events + durable
   snapshots/facts** = the doctrine-compatible shape ("collaborative session mode").

## Established facts (verified against source, 2026-07-21)

- Workspace DO = overlay (DO SQLite + R2 spill >1.5MB) + whiteouts + event-sourced mount
  table; reads fall through to repo DO at floating HEAD; `gitCommit` routes one mount's diff
  to that repo's main. No watch/subscribe, no realtime, request-response only.
- Streams: durable event log first (append = commit point, replay-based processors);
  **ephemeral events** exist (second-class, eviction-licensed, excluded from replay) with a
  live subscribe lane at ~1–15ms; precedent = LLM chunk streaming (ephemeral chunks + one
  durable settled fact). Design envelope R3 already targets 10²–10³ events/sec/stream.
- Yjs: partial sync within one doc is protocol-impossible (state vectors partition by
  author). y-partyserver: no subdoc/multiplex support; ~360-line server, doc-name-framing
  fork viable (Hocuspocus precedent). Scaling shape: metadata index doc + lazy per-file docs.
- Tasks app today: single Y.Doc per checkout with full file contents + `meta.base` duplicate;
  breaks ~5k tasks (single-blob persistence cliff, O(all files) reparse per keystroke,
  unpaginated seeding).
- Repo DO pre-Artifacts path: isomorphic-git clone into memory, 128MB isolate bound
  (iterate pack ~21MB → ~290MB inflated). Artifacts import (#2157) is the new path;
  lazy per-object reads design: `apps/os/tasks/lazy-artifacts-repo-reads.md`.
- Mounts are whole-repo only today; repo `listFiles()` has no prefix parameter; workspace
  `glob()` enumerates full tree then filters.

## Direction (agreed so far)

- Endgame: **collaborative session mode on workspaces** — the workspace owns the live
  collaborative head; `writeFile`-door (agents) and Yjs-door (humans) converge inside the
  workspace so agent writes splice into live docs when a session is active.
- Overlay **is** the diff — no separate base-snapshot bookkeeping in app docs.
- Next deliverable: proposal locking in the APIs, interactions, and external requirements
  of the whole system. (In progress — sub-agent exploration round running.)

## Proposal

See **[`session-mode-proposal.md`](session-mode-proposal.md)** (2026-07-21 strawman):
three-tier model (lazy Artifacts base / overlay as settled truth / per-file session DOs),
agent RPC routed through live sessions, Yjs-over-streams wire, mounts × sessions rules
(pinned bases, explicit base-motion events, commit barriers), readDir tree API, rich text
via canonical markdown serialization, 12 invariants, external-requirements ledger, and 7
contested decisions to argue about.

## Open questions

- Exact read surface Artifacts gives us today vs. needs building (per-oid tree/blob reads,
  prefix listing, file-tree-at-scale rendering support).
- How mounts interact with sessions: addressing, commit routing, base motion when a mount's
  HEAD moves under a live session, whiteouts vs live docs, subtree mounts.
- Rich text: markdown ↔ Y.XmlFragment round-trip strategy vs plain Y.Text + editor-side
  structure; one answer for docs-style editing and code editing?
- Session lifecycle: creation, GC, persistence of live docs vs overlay, offline/reconnect.
- Presence scopes: repo/workspace-level (who's here, file tree) vs file-level (cursors).

## Log

- 2026-07-21: Initial exploration (4 sub-agents): tasks-app architecture map, workspace
  domain map, large-repo breakpoints, streams assessment, Yjs-at-scale research. Phased
  convergence plan sketched (prereqs → tasks restructure → workspace truth + change events
  → session mode upstream).
- 2026-07-21: Jonas widens scope to all collaborative surfaces; corrects large-repo import
  claim (Artifacts import path exists); asks for radical reimagination round + API/
  requirements proposal. This file created.
- 2026-07-21: Radical-reimagination round (3 sub-agents): Artifacts substrate contract
  (import EXISTS, lazy per-oid reads MISSING — probe is the gate; tree objects never
  deserialized anywhere in the codebase today), industry precedents (Zed/Figma/Google
  Docs/github.dev/GitBook/Hocuspocus all converge on cold-base/settled/hot-session tiers;
  agent-via-fs-API into live sessions has no published prior art), mounts × sessions design
  pass. Synthesized into `session-mode-proposal.md`.
- 2026-07-21: **Rev 2** after Jonas's pushback on per-file session DOs ("don't cruft up the
  world with a million durable objects"; "one doc for basically the files that we have
  touched in this checkout … everything else is a fall through read"). Session unit is now
  the workspace: one live Y.Doc per workspace hosted by the workspace DO, doc = overlay's
  live mirror (touched set only), near-stateless (flush-only persistence, epoch on
  quiesce/commit), no new DO namespace. Cost accepted: all subscribers see all touched-file
  traffic; size-threshold + per-file split noted as future policy knobs, not built.
- 2026-07-21: **Wild round** (Jonas: "go a bit more wild … the extreme option where we
  just say everything is just streams, there's no Yjs, we implement whatever 500 lines we
  need ourselves"; also asked for a Codex/gpt-5.6-sol xhigh second opinion). Three
  independent evaluations converged 3–0 → **Rev 3**: no Yjs; per-file rebase engines
  (@codemirror/collab 188 LOC + prosemirror-collab 184 LOC, vendored; authority =
  workspace DO, history = per file); WAL-before-ack (2s loss window rejected); keystrokes
  on a hibernating WS at the workspace DO, NOT the journaled stream ("ephemeral" stream
  events still write journal rows in a different DO — double-write + atomicity gap;
  `publishVolatile` is the platform ask if streams-must-carry-it); dirty ≠ live; epochs
  for destruction only; bounded-offline (24h floor + three-way recovery). Rev 2 rejected
  by adversarial review (1MiB WS cap wedges the workspace doc; every deploy = epoch;
  tombstones never GC; per-mount auth impossible). Top program risk: markdown↔ProseMirror
  fidelity. Yjs re-entry gate defined. PoC plan written → `poc-plan.md`.
- 2026-07-21 (later): **PoC executed — all five phases green locally** (see the status
  block in `poc-plan.md`). Rev 3 is now empirically validated end to end: rebase-model
  engine survives its fault harness (which caught two real bugs before any UI existed),
  agents co-edit through the unchanged `itx.workspace` API, checkout=workspace works with
  the overlay as the only diff. Work lives uncommitted on `collab-poc` branches in the
  `iterate-collab-poc` and `tasks-collab-poc` worktrees.
- 2026-07-21 (thermo-nuclear review round): two independent reviewers (Cursor
  thermo-nuclear skill via sub-agent; Codex gpt-5.6-sol xhigh) both returned **BLOCK**
  with converging findings. Top code-judo (both): liveness must be DURABLE state, not
  memory — after DO eviction the old design silently committed stale overlays and could
  stomp agent writes. **Applied**: new `collab-host.ts` coordinator with a
  `collab_sessions` table (head_version/overlay_version), `reconcile()` as the single
  barrier primitive (status/commit/configure), destructive ops end sessions durably,
  idle sweep, size gates (2MB SQLite cell cap → MAX_DOC_BYTES 1MB open refusal +
  MAX_PUSH_BYTES typed `too-large`), one acceptance primitive in the engine (push +
  applyExternal unified), open-race fix, op-log compaction + clientSeq LRU, canonical
  edit helpers ($&-literal bug fixed), waiter cleanup, path canonicalization, vessel
  consolidation (one `TasksWorkspaceApi`, typed wire, bounded board reads), client
  hardening (typed push switch, bounded backoff, snapshot reseed that CARRIES
  unconfirmed edits — no reload, no silent discard). 84 platform tests green (26
  collab-specific incl. crash-into-commit, $&, idle-end, size gates); all live probes
  re-verified (hop p50 2-3ms, direct p50 2ms). **Deliberately deferred**: platform-side
  filtered board snapshot (workspace listTaskFiles equivalent — the glob+read board seed
  stays PoC-shaped with a concurrency cap), workerd-level DO tests, epoch-rotation
  client recovery beyond best-effort carry, R2 spill for >1MB collab docs.
- 2026-07-21: Feature-layer design written → `redlines-and-comments.md` (redlines as a
  fold of the op log — @codemirror/merge path 1, attributed-segments path 2; comments as
  sidecar anchors mapped through accepted ops with snippet re-anchoring across epochs).
