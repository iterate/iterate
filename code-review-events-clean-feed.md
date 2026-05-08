# Events Clean Feed Review

## Findings

### 1. High: the reducer is crossing an unconfirmed package boundary

`packages/ui/src/components/events/stream-feed.tsx` imports `@iterate-com/events-contract`, and
`packages/ui/package.json` now depends on the events contract. Per `jonasland/RULES.md`, package
API shape and high-level architecture should be explicitly confirmed.

The reducer is domain logic: it understands event types, payload fields, stream paths, and feed item
semantics. Putting that in `packages/ui` makes the UI package own product behavior rather than just
rendering UI.

Options:

- Recommended: move reducer/feed item types to `apps/events/src/lib`, keep only renderer pieces in
  `packages/ui` if we really need them there.
- Local-only: move the whole clean implementation back into `apps/events` until the model settles.
- Bigger: create a dedicated shared events-feed package, but only after confirming this should be a
  stable public internal API.

### 2. High: `event=<offset>` deep links are inert in clean view

The route search contract still accepts `event`, but the clean branch in `StreamPage` renders
`EventsStreamFeed` without event selection or inspector wiring. A URL like `?view=clean&event=12`
looks meaningful but does nothing.

Options:

- Recommended: lift raw event inspector ownership into `StreamPage` so both views share it.
- Add event click/selection support directly to `EventsStreamFeed`.
- Clear `event` when switching to clean, but that weakens deep links.

### 3. Medium: search-param pattern is idiomatic, but naming and fallback behavior should change

Using `validateSearch`, `Route.useSearch()`, and functional `navigate({ search })` updates is the
right TanStack Router shape. The current parser resets every search field if any one field is
invalid. Also, `view=current|clean` is implementation language and will age badly in shared links.

Options:

- Recommended: rename to `feed=classic|reduced` and parse fields independently with Zod
  `.catch(...)` / `.default(...)`.
- Accept `view` only temporarily and rename before merge.
- Keep whole-object fallback only if any invalid param should reset the full stream view.

### 4. Medium: there are now two projection systems

The new reducer manually reads payload fields that existing app code already parses via contract
schemas. It also casts `childPath as StreamPath`, which can diverge from contract behavior.

Options:

- Recommended: extract one app-local reducer core and have old/current and new/reduced views consume
  that feed model differently.
- Keep clean reducer independent, but use event contract schemas and add tests immediately.
- Keep it manual only for the empty-rectangle experiment, then delete or replace once architecture
  is chosen.

### 5. Medium: the new file hides the important idea behind exported type surface

`stream-feed.tsx` starts with a large exported type block before the reducer/component. That
conflicts with the rule that the most important thing in a file should be at the top, and it exports
types/render helpers before external use exists.

Options:

- Recommended: export only the primary reducer/component, make helper types private, and move them
  below the main functions.
- If the feed item shape is meant to be the API, add a short docstring explaining that contract.
- Split into `feed-reducer.ts` and `feed-renderer.tsx` once the boundary is confirmed.

### 6. Low: naming and cleanup

`EventsStreamFeed` vs `StreamEventFeed` is easy to confuse. The clean view label also implies an
implementation state rather than a user-facing mode.

Options:

- Recommended: rename toward `ReducedStreamFeed` / `ClassicStreamFeed` or
  `EventFeedRenderer` / `StreamEventLog`.
- Remove any unused imports and keep component names aligned with URL naming.

## Recommended Next Patch

Move the reducer/feed model out of `packages/ui`, rename the URL param before links stabilize,
change search parsing to per-field defaults, and share raw event inspector state between both views.
Then add focused tests for search parsing and the reduced feed reducer.

# Plan (TODO)
