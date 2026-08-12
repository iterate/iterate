---
status: ready
size: large
branch: mobile-notes
---

# Mobile notes capture

## Status summary

Spec approved via plannotator grill session (11 questions, all settled). Implementation not started.

- Done: full decision record below; media collection (#2466) merged, so all patterns to crib exist on main.
- Missing: everything — starter app, mobile lib + UI, tests, PR.

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

- [ ] `ref.ts` — `notesStreamPath = "/notes"`, `notesWorkerRef` (className `NotesApp`, durableWorkerKey `app-notes-stream`)
- [ ] `processor.ts` — contract slug `notes`; events `notes/captured`, `notes/deleted`, `notes/processed`, `notes/reanalyze-requested`; fold + analysis obligations (caughtUp-guarded, retries, settles exactly once)
- [ ] `analysis.ts` — one small-model call → `{title, tags}`
- [ ] `worker.ts` — `NotesApp extends StreamProcessorDurableObject`, `recovery = true`, RPC `list`/`search`/`get`
- [ ] `configured-worker.ts`, `app-ref.ts`, `index.ts` (`NotesApp.create` fan-in + `provideCapability({path: ["notes"]})`)
- [ ] package.json exports (src + dist) + tsdown entries
- [ ] `configs/default/worker.ts` wiring (`#notesApp` + `processEvent`)
- [ ] media `uploaded` event: optional `source` field

### Mobile: `apps/mobile/`

- [ ] `lib/notes.ts` — event constants, `buildNoteEvent`/`buildDeleteEvent`, `deriveNotesList` (tombstones, processed titles, first-line fallback), `filterNotes`
- [ ] `lib/pending-notes.ts` — pending store (text + attachment blobs), drain logic, prompt-state helpers; pure core with injected IO
- [ ] `components/note-composer.tsx` — global overlay + pill (state in query cache), route-derived target via `useSegments()`, slug label, hidden on chat, `+` attach → `files.put` + `media/uploaded {source:"note"}`
- [ ] `app/project/[projectId]/notes.tsx` — `useLiveEvents` on `/notes`, filter box, long-press delete, media-viewer
- [ ] `components/project-drawer.tsx` — `/notes` entry + pathname union
- [ ] drain prompts on app open / project selection (native Alert fine for POC)

### Tests

- [ ] processor node harness: captured → obligation → processed; deleted tombstone; reanalyze
- [ ] `lib/notes.test.ts`, `lib/pending-notes.test.ts`
- [ ] optional `e2e/notes.e2e.test.ts`

### Ship

- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test`
- [ ] draft PR with screenshots/video, session id in body, comment monitors

## Implementation log

(nothing yet)
