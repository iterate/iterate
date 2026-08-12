---
status: ready
size: large
branch: mobile-notes
---

# Mobile notes capture

## Status summary

Implementation done and verified; awaiting review ([PR #2483](https://github.com/iterate/iterate/pull/2483)).

- Done: notes starter app (analysis obligations + itx.notes + harness spec), mobile composer/pending-queue/screen with unit tests, live e2e (real model-call settlement) and Playwright web spec both green against local dev, PR media uploaded.
- Missing: nothing known; review feedback + preview e2e on the PR.

## Why

Opening the mobile app usually means "I want to capture something." Today the capture surfaces are agent chat (wakes an LLM) and media (photos only). This adds frictionless note capture: a composer that's there the moment the app opens, persisting to a `/notes` stream per project, with media-style analysis, browseable on a notes screen, reachable by agents via `itx.notes.*`.

## Decisions (from grill session)

1. **Storage**: dedicated `/notes` stream via new userland starter app `packages/iterate/src/starter-apps/notes/`, mirroring media's registration. Phone appends `notes/captured` facts. Git-commit-as-settlement is a later side-effect, not this round.
2. **Surface**: global capture composer overlay mounted in mobile `_layout.tsx` + a `notes.tsx` browse screen behind a standard drawer `/notes` entry.
3. **Composer lifecycle**: auto-appears (docked bottom bar, not auto-focused) on cold start and on foreground after >5 min backgrounded (tunable constant). ✕ collapses to a floating 📝 pill; tap re-expands. Hidden on screens with their own composer (chat).
4. **Target project**: route-derived inside `project/[projectId]/*`; anywhere else captures go to a local **pending notes** store. Drain prompt ("store pending notes here?") fires at project selection and on app open with a project selected. Yes → append; No → follow-up "delete or keep pending?"; keep → asked again next drain moment.
5. **Offline/failure**: failed appends land in the same pending store with a quiet "saved locally" toast. Capture never blocks or loses data.
6. **Content**: text + photos. `+` attach like the chat composer; images via `files.put`, referenced from `notes/captured`. Pending store persists attachment blobs locally until drained.
7. **Photos double-append to `/media`** with `source: "note"` provenance → MediaProcessor analyzes them for free; gallery stays filterable. Wipe-orphaning accepted as POC risk.
8. **Text analysis in POC, always-on**: obligation pattern — `notes/captured` → small-model call → `notes/processed {title, tags}`. First line of text is title fallback while pending/failed. No preference toggle (userland wiring means an agent can rewrite behavior later).
9. **Agents**: `itx.notes.list/search` capability from day one, like `itx.media.*`.
10. **Notes screen**: newest-first list (derived title, snippet, relative time, photo thumbnails; tap to expand; media-viewer for images), client-side text filter, long-press delete via `notes/deleted` tombstone. No edit.
11. **Packaging**: this one draft PR off main, analysis included ("make it real").

## Checklist

### Server: `packages/iterate/src/starter-apps/notes/`

- [x] `ref.ts` — `notesStreamPath = "/notes"`, `notesWorkerRef` (className `NotesApp`, durableWorkerKey `app-notes-stream`) _done — [ref.ts](../packages/iterate/src/starter-apps/notes/ref.ts), dependency-free literal like media's_
- [x] `processor.ts` — contract slug `notes`; events `notes/captured`, `notes/deleted`, `notes/processed`, `notes/reanalyze-requested`; fold + analysis obligations (caughtUp-guarded, retries, settles exactly once) _done — settlement event named `notes/analysis-settled` per stream-processor doctrine (not `notes/processed` as first drafted)_
- [x] `analysis.ts` — one small-model call → `{title, tags}` _done — llama-4-scout text call, defensive JSON parse_
- [x] `worker.ts` — `NotesApp extends StreamProcessorDurableObject`, `recovery = true`, RPC `list`/`search`/`get` _done — recovery=true; search returns signed attachment URLs_
- [x] `configured-worker.ts`, `app-ref.ts`, `index.ts` (`NotesApp.create` fan-in + `provideCapability({path: ["notes"]})`) _done — fan-in + provideCapability at path ["notes"], media shape_
- [x] package.json exports (src + dist) + tsdown entries _done_
- [x] `configs/default/worker.ts` wiring (`#notesApp` + `processEvent`) _done — plus regenerated config-repo-template.generated.ts via pnpm lint:fix_
- [x] media `uploaded` event: optional `source` field _done differently — merged media uses `media/captured` with an existing `source` string; extended the phone union with "note" and the schema doc, no server schema change needed_

### Mobile: `apps/mobile/`

- [x] `lib/notes.ts` — event constants, `buildNoteEvent`/`buildDeleteEvent`, `deriveNotesList` (tombstones, processed titles, first-line fallback), `filterNotes` _done — pure fold mirrors server processor; displayTitle falls back to first line_
- [x] `lib/pending-notes.ts` — pending store (text + attachment blobs), drain logic, prompt-state helpers; pure core with injected IO _done — AsyncStorage-shaped seam (AsyncStorage was already a dep; no expo-file-system needed), drain removes each note as it lands_
- [x] `components/note-composer.tsx` — global overlay + pill (state in query cache), route-derived target via `useSegments()`, slug label, hidden on chat, `+` attach → `files.put` + `media/uploaded {source:"note"}` _done — module-level AppState listener + query-cache state (no useEffect/useState beyond drafts); drain prompt runs inside a queryFn keyed on projectId+foreground generation_
- [x] `app/project/[projectId]/notes.tsx` — `useLiveEvents` on `/notes`, filter box, long-press delete, media-viewer _done — search box, long-press + expanded delete, Re-analyze, media-viewer for photos_
- [x] `components/project-drawer.tsx` — `/notes` entry + pathname union _done_
- [x] drain prompts on app open / project selection (native Alert fine for POC) _done — native Alert two-step (store? → delete/keep) per D4_

### Tests

- [x] processor node harness: captured → obligation → processed; deleted tombstone; reanalyze _done — 8 scenarios incl. eviction recovery, expiry-without-dial, full-stream replay_
- [x] `lib/notes.test.ts`, `lib/pending-notes.test.ts` _done — 9 tests_
- [x] optional `e2e/notes.e2e.test.ts` _done — live proof: capture → real model-call settlement → worker RPC + itx.notes doors → tombstone_

### Ship

- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test` _all green_
- [x] draft PR with screenshots/video, session id in body, comment monitors _PR #2483; video-mode demo inline; CI + comment monitors armed_

## Implementation log

- Server first commit: full obligation-pattern processor (docs/writing-stream-processors.md checklist), cribbed from github-ai-linter's publication obligation rather than media (merged media does analysis inline in a phone-issued runScript; notes wants instant dumb capture, so analysis is a server-side obligation instead).
- Attachments reuse the media pipeline wholesale: same content-hash file paths (mediaFilePath), and the phone fires media's buildProcessScript with source "note" fire-and-forget after the note append (D7 double-append).
- Composer state (open/pill, drain generation) lives in the query cache, flipped by a module-level AppState listener — no useEffect. Drain prompt is an Alert inside a queryFn keyed [projectId, foregroundGeneration]: re-prompts on project switch or foreground return, not on every pending change.
- notes/reanalyze-requested is consumed by the processor but deliberately not in the phone's NOTE_EVENT_TYPES read set (it changes no list state).

## Follow-ups (post-review feedback)

- [ ] **"Chat" note action** — from an expanded note, jump to the chat view with the note referenced (path prefilled in the input, or pre-added as a feed item the agent sees on next message). Needs design: how a note is addressed in agent context (path? quoted text? keyed context item?), and whether it targets a new or existing thread.
- [ ] **Agent tag-writeback door** — "when a note is created, classify it and tag it" almost works today (an agent can hook `notes/captured` in the config worker), but there's no clean write door for the tag: `notes/analysis-settled` is guarded by the open-obligation fold, so a foreign settlement no-ops. Options: a `notes/tagged` fact anyone may append (fold unions tags), or move the analysis prompt/taxonomy into config-repo data so the agent edits *that*.

_Both intentionally left out of PR #2483 to keep it scoped; captured 2026-08-12 from review feedback._
- [ ] **Starter-app rollout to existing projects** — new starter apps only reach *new* projects (the template seeds at creation). Verified on nustom/preview-8: `itx.notes` absent, no analysis, because its config repo predates the PR. Manual rollout took two config-repo commits: (1) the 3-line NotesApp wiring in `worker.ts`, and (2) re-pinning the `iterate` dep in `package.json` — the first rebuild failed with "Failed to resolve 'iterate/starter-apps/notes'" because the repo pins an old commit sha and the deployment did NOT ref-pin the build. Worth a doc note or a platform story ("adopt latest template diff" as an agent task or one-click).
- [ ] **Notes will grow toward docs features** (Misha, post-review): formatting, organization, richer search/federation, promote-to-doc are all wanted eventually. That makes the notes↔docs boundary a real design question, not a hypothetical — decide whether notes stays a separate stream that *promotes* into workspace documents (one-way valve, D1's deferred git-settlement as the mechanism), or whether notes becomes the capture door into the workspace-documents system itself (a note IS a nascent doc). Worth its own grill session before building any of those features.
