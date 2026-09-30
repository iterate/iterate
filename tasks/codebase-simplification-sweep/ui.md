# Sweep candidates: ui

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## packages/ui navigates through the router it already imports, not a threaded onNavigate/locationKey protocol

- Sweep index: 61; risk: medium; payoff: 4/10
- LOC: −66 net across 12 files, measured on a scratch copy (+64/−130). packages/ui is −34 of that and the apps are −32. packages/ui tsc passes and all 164 of its tests pass. (skeptic measured: +78/−149, net −71 across 13 files, measured in scratchpad/skeptic-nav against wt-main with `git diff --no-index --numstat` after oxfmt. This includes a new 22-line router-anchor.tsx and a +10 unmount hang-up in Voice's Phone. packages/ui −32, apps −39.)
- Concepts: About 6 concepts become 2.

Before:

- the onNavigate pair threaded through 4 components
- ContextPathLinks.onNavigate
- navigateToPath
- the re-wrapped links
- locationKey
- 3 identical app lambdas

After:

- RouterAnchor
- plain href functions

### Evidence

packages/ui is 'router-agnostic on purpose' (app-shell.tsx:5-6, #2731), but that reason has expired: packages/ui already imports @tanstack/react-router in apps/router.tsx:6, apps/document.tsx:1, environment-head-content.tsx:1, first-project-redirect.tsx:1 and hooks/use-context-explorer.ts:8.

Where the navigation job is spread:

- app-shell.tsx:95-116, 185-194, 300-311
- app-shell-palette.tsx:104-118, 151-165, 229-246
- app-shell-palette-entries.ts:128-142 (plainLeftClick)
- context-path.tsx:9-26, 44-58 (navigateToPath and its page-load fallback)
- context-tree.tsx:163-175 (a second copy of that fallback)
- use-context-explorer.ts:40-54

What the apps pass in:

- Three apps pass an identical `router.navigate({ href })` lambda: admin _auth.tsx:49-52, dash _auth.tsx:111-116, and use-context-explorer.
- All five apps pass `locationKey={useRouterState(s => s.location.href)}`.
- Agents, Notes and Voice pass no onNavigate, so switching project does a full page load there.

### Current shape

Each navigation component takes an href function and an optional `onNavigate(href, event)`, checks plainLeftClick by hand, and falls back to a page load. The affected components are AppShell, its palette, the project switcher, ContextPath, ContextTree and ContextTreeSheet. On top of that, every app passes the router's href back in as `locationKey`.

### Proposed shape

```tsx
// router-anchor.tsx (22 lines)
export function RouterAnchor({ href, onClick, ...props }: ComponentProps<"a"> & { href: string }) {
  const router = useRouter();
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (!plainLeftClick(event)) return;
        event.preventDefault();
        void router.navigate({ href });
      }}
    />
  );
}
```

- AppShell keeps only `projectHref`.
- CloseMobileSidebarOnNavigate reads `useRouterState` itself.
- `ContextPathLinks = { hrefOf }`.
- ContextTreeSheet passes `onGo={() => setOpen(false)}`.
- The apps drop onNavigate, locationKey and their useRouterState line.

### What changes

- Agents, Notes and Voice switch project with the client router instead of a page load.
- Notes' base path is stripped by the router on navigate (router-core buildLocation `executeRewriteInput`).
- ContextTreeSheet closes on any link click, modified clicks included.
- AppShell and PathLink need a RouterProvider; every app has one.
- Risk: Voice's Phone has no unmount hang-up, so a mid-call project switch would leave the call and mic open. Either add an unmount cleanup, or keep a page load for Voice.

### Pinned by

No unit test covers this. Specs that exercise it:

- specs/admin/admin.spec.ts:40-52
- specs/dash/contexts.spec.ts:19-23
- The 'Switch project' waits in forged-session.ts:67, notes/pr-body-link.spec.ts:69 and dash/sign-in-link.spec.ts:43

### Skeptic's amended proposal

Add `packages/ui/src/components/router-anchor.tsx`:

```tsx
export function RouterAnchor({ href, onClick, ...props }: ComponentProps<"a"> & { href: string }) {
  const router = useRouter();
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (!plainLeftClick(event)) return;
        event.preventDefault();
        void router.navigate({ href });
      }}
    />
  );
}
```

**AppShell**

- Drop `onNavigate` and `locationKey`.
- ProjectSwitcher's item becomes `render={<RouterAnchor href={projectHref(project)} aria-label=… />}`.
- `CloseMobileSidebarOnNavigate` reads `useRouterState({ select: s => s.location.href })` itself.
- Replace the "Router-agnostic on purpose" header comment.

**Palette:** the project row becomes a `RouterAnchor` with `onClick={(e) => { e.stopPropagation(); if (plainLeftClick(e)) onClose(); }}`.

**ProjectAppShell:** drop `locationKey`.

**context-path.tsx**

- `ContextPathLinks = { hrefOf }`.
- Delete `navigateToPath`.
- PathLink renders a `RouterAnchor` and takes an optional `onClick`.

**context-tree.tsx**

- ContextTree takes `onGo?: () => void`, passed as each PathLink's `onClick`.
- The typed-path submit does `onGo?.(); void useRouter().navigate({ href: links.hrefOf(path) })`.
- ContextTreeSheet drops its `useMemo` links and passes `onGo={() => setOpen(false)}`.

**use-context-explorer:** drop `useRouter` and `onNavigate`.

**Apps:** admin and dash drop `onNavigate`, `locationKey`, `useRouter` and `useRouterState`. Agents, notes and voice drop `locationKey` and their `useRouterState` line.

**Required in the same PR: Voice's `Phone` gets an unmount hang-up**, because a project switch is now a route change:

```ts
useEffect(() => {
  if (!call) return;
  return () => {
    const opened = audio.current;
    if (opened) void call.hangUp().finally(() => opened.close());
  };
}, [call]);
```

Hang up clears `audio.current` in its `finally` before React commits, so its own end is not repeated.

**Proof before merge:** a browser drive of three things:

- the dash and agents switcher and ⌘K on desktop and phone (Base UI's render merge with `RouterAnchor`)
- Notes under paths ingress (base-path rewrite)
- a Voice mid-call project switch (the mic light goes off)

### Skeptic's verdict

The claim holds. I implemented the proposal in an APFS clone at scratchpad/skeptic-nav. packages/ui tsc passes, all 5 apps pass tsc, oxlint --deny-warnings is clean on the 13 files, and packages/ui vitest passes 166/166. PR #3446 (merged) only touches the agents route's upgrade cast, so it does not overlap.

**The reason for the current shape has expired.**

- #2731 (09-18) said "no TanStack imports in packages/ui".
- #2990 (09-24) added `@tanstack/react-router` to packages/ui/package.json.
- #3343 (09-28) made packages/ui's own `use-context-explorer.ts:40-53` call `useRouter()`, only to build an `onNavigate` closure. That closure is handed back into packages/ui's own PathLink and ContextTree, which then check whether it exists. This round trip is the illogical part.

**Half of it is dead code.** Every `ContextPathLinks` comes from `useContextExplorer`, which always sets `onNavigate`: admin global.$ and projects.$slug.$, and dash contexts.$ via context-activity. So these never run, and dropping them changes nothing:

- the `window.location.assign` fallback in `navigateToPath` (context-path.tsx:22-26)
- the second copy in `ContextTreeSheet` (context-tree.tsx:165-175)
- the `links.onNavigate &&` guard in PathLink (context-path.tsx:52)

**What actually changes (a):**

1. In Agents, Notes and Voice, the switcher and the ⌘K project rows switch project through the router instead of a full page load.
   - Agents and Notes are fine: their content is keyed by project, and loaders re-run.
   - Notes' base path works. router-core 1.171.32 `buildLocation` runs `executeRewriteInput` on `href` (router.ts:1904-1912), so `${basePath}/projects/B` becomes `/projects/B` internally.
   - Voice is a real regression unless fixed. `Phone` has no unmount cleanup, so a mid-call switch would leave the call and the mic open. This must be part of the PR, not optional. The fix is a 10-line effect, measured and typechecked.
2. `ContextTreeSheet` also closes on a modified click.
3. AppShell, PathLink and ContextTree now need a RouterProvider. Every app has one, and no unit test mounts them.

No spec pins the page load: the "Switch project" waits in forged-session.ts:67, notes/pr-body-link.spec.ts:69 and dash/sign-in-link.spec.ts:43 never click a switch.

**It is simpler, not just different (b):**

- **Goes:**
  - `onNavigate`: the same optional signature declared in AppShell, ProjectSwitcher, AppShellPalette and PaletteBody, plus `ContextPathLinks.onNavigate`
  - `navigateToPath` and its page-load fallback
  - ContextTreeSheet's re-wrapped links object
  - `locationKey`: declared in AppShell and ProjectAppShell and fed by five apps' `useRouterState` lines
  - two app lambdas and one in packages/ui
- **Comes:** one 22-line `RouterAnchor`, plus `onGo` on ContextTree.

**No guarantee is dropped (c):** modified and middle clicks still open a tab through `plainLeftClick`.

**LOC (d), measured with `git diff --no-index --numstat` after oxfmt:** +78/−149, net −71 across 13 files, the Voice fix included.

- packages/ui: +62/−94, net −32 (router-anchor +22, app-shell −23, palette −6, project-app-shell −4, context-path −11, context-tree −4, explorer −6).
- apps: +16/−55, net −39 (admin −14, dash −17, agents −8, notes −2, voice +2 net including the hang-up effect).

This matches the candidate's −66. Some of the app savings come from oxfmt collapsing imports.

**Evidence nit:** use-context-explorer is packages/ui, not an app, so it is two app lambdas plus one in packages/ui.

**Payoff is moderate.** It is UI plumbing rather than core platform, but it touches the shell every app uses.

## The context view uses the SDK's own types instead of structural copies, one of which has drifted and mislabels paused fan-out rows

- Sweep index: 62; risk: low; payoff: 4/10
- LOC: −68 net over 17 files, measured on a scratch copy (+129/−197). Product −81, tests +13. tsc passes and all 164 tests pass. (skeptic measured: git diff --cached --shortstat on a scratch copy of packages/ui after oxfmt with the repo's .oxfmtrc.json: 18 files, +129/−206, net −77. Product code: +89/−183, net −94. Tests: +40/−23, net +17. Biggest single edits: types.tsx −60/+5; context-view.tsx 38 lines changed, mostly deletions (ContextViewSource, OLDER_EXHAUSTED, comment). tsc passes for tsconfig.json and tsconfig.worker.json. vitest: 13 files, 166 tests pass. apps/dash, apps/admin and apps/agents typecheck against the scratch kit with 0 errors.)
- Concepts: 5 parallel UI types become 0.

### Evidence

The copy exists to keep the kit free of the SDK, per context-view.tsx:19-21 ('typed structurally here… so the UI kit stays free of the SDK'). But packages/ui already imports the SDK in use-context-explorer.ts:10-12, app-shell.tsx:25, posthog.tsx:3 and apps/server.ts:6-7.

Each local copy and the SDK type it shadows:

- types.tsx:6-23 ContextViewEvent ≈ StreamEvent
- types.tsx:66-78 ContextViewProcessor ≈ SubscriptionListEntry (api.ts:69-101). This one has drifted: it lacks `ordered`, `pending` and `paused`, so processors-panel.tsx:496-505 `statusOf` calls a paused fan-out row 'delivering'.
- types.tsx:81-95 ContextViewPresence and LiveStateView
- context-view.tsx:313-332 ContextViewSource, plus an OLDER_EXHAUSTED default

Every caller passes `useIterateContext(...)`. apps/agents keeps its own StreamEvent copy for the same reason (see the Agents-page row).

### Current shape

packages/ui keeps looser copies of the event, subscription row, presence, live state and hook-result types, even though it already imports the SDK elsewhere.

### Proposed shape

```ts
import type { StreamEvent } from "iterate/stream/processor";
export type EventRenderer = (event: StreamEvent) => ReactNode | null;
export type ContextViewSource = ReturnType<typeof useIterateContext>;
// panels import SubscriptionListEntry, IterateContextPresence, LiveStateResult
```

Delete the four copies and the OLDER_EXHAUSTED default. Test fixtures gain `path` and `source.origin`.

### What changes

- No runtime change beyond the dead default going.
- Types get stricter: fixture events need `path` and `source`, `payload` is a Record, and CONNECTING gains `rev: null`.
- Rows gain the fan-out fields. This change does not render them.

### Pinned by

Typecheck. The fixtures in folds.test.tsx, filters.test.tsx, event-inspector.test.tsx and event-inspector-log.test.ts change shape but keep their assertions.

### Skeptic's amended proposal

Title: [ui] The context view reads the SDK's own types instead of structural copies that have drifted.

**Delete from packages/ui/src/components/context-view:**

- ContextViewEvent, ContextViewProcessor, ContextViewPresence and LiveStateView (types.tsx:6-26 and 67-98);
- ContextViewSource and OLDER_EXHAUSTED (context-view.tsx:313-332);
- the stale "free of the SDK" comment (context-view.tsx:19-21).

**Use instead:**

```ts
// types.tsx
import type { StreamEvent } from "iterate/stream/processor";
export type EventRenderer = (event: StreamEvent) => ReactNode | null;
export type EventInspector = (event: StreamEvent) => ReactNode | null;
// context-view.tsx
import type { useIterateContext } from "iterate/react";
context: ReturnType<typeof useIterateContext>;
const { events, caughtUp, older, head, presence, liveState } = context;
// panels
import type { SubscriptionListEntry } from "iterate/api";
import type { IterateContextPresence, LiveStateResult } from "iterate/react";
const CONNECTING: LiveStateResult = { status: "connecting", value: undefined, rev: null };
```

**Tests:** the fixtures in folds.test.tsx, filters.test.tsx, event-inspector.test.tsx, event-inspector-log.test.ts and core-renderers.test.tsx gain `path: "/"` and `source: { origin: "/" }`. The `at()` helpers type `payload` as `Record<string, unknown>`. Assertions are unchanged.

**Optional, with no behaviour change:** `head` is now always a number, so these undefined branches are dead and can go: processors-panel.tsx:42/231/337 (`number | undefined`), :238 (`head !== undefined`), :349 (`"—"`), and context-view.tsx:179 (`head ?? 0`).

**Do not claim this fixes the paused-row label.** It only makes `paused` and `pending` visible to the compiler. Fixing the label is a separate one-line behaviour change in `statusOf`:

```ts
if (row.paused) return { label: `paused, ${row.pending ?? 0} waiting`, tone: "text-amber-700" };
```

**Numbers:** 5 kit-local types plus a dead default become 0. LOC is −77 net (product −94, tests +17). Risk is low: typecheck-only, and every caller passes the hook's result.

### Skeptic's verdict

The claim holds. I applied the change to a scratch copy of packages/ui from main (b3daf4846) and checked it. PR #3446 does not touch packages/ui.

(a) Semantics.

- **Runtime:** the only change is that `older = OLDER_EXHAUSTED` (context-view.tsx:109, 331-332) goes. All four ContextView callers pass `useIterateContext(...)` straight through: admin global.$.tsx:55, admin projects.$slug.$.tsx:56, agents projects.$slug.tsx:521 and dash context-activity.tsx:56. That result always carries `older` and a numeric `head`, so the default never runs.
- **Types get stricter:** fixture events need `path` and `source.origin`, `payload` must be a Record, and CONNECTING needs `rev: null` (processors-panel.tsx:514).
- **App renderers still compile:** the dash, agents and admin renderers use `record(e.payload)`, which accepts a Record. I typechecked all three apps against the scratch kit (tsc `paths` override, resolution confirmed) and got zero errors.
- **Tests:** `tsc` passes for both ui tsconfigs, and vitest passes 13 files and 166 tests. That is 166, not the 164 the candidate reported, because main has moved.
- **The drift is real but the change does not fix it.** `SubscriptionListEntry` has `ordered`, `pending` and `paused`, and apps/os fills them (subscription-delivery.ts:1887-1894 `fanOutView`). The local copy lacks them, so `statusOf` (processors-panel.tsx:496-505) shows a paused fan-out row as green "delivering". After this change that is still true: the fields merely become visible to the compiler. The title overclaims.

(b) Simpler: yes, it is not a lateral move.

- Five kit-local types (ContextViewEvent, ContextViewProcessor, ContextViewPresence, LiveStateView, ContextViewSource) and a dead default are deleted in favour of the SDK names every caller already produces.
- The reason given for the copies is out of date. The comment at context-view.tsx:19-21 says the types are structural "so the UI kit stays free of the SDK". In fact the kit declares `iterate: workspace:*` and imports it in six files.
- The other reason, that "any source of the same shape renders (a test's fixture, a recorded log)" (context-view.tsx:313-314), has no user. No test or app renders <ContextView> with anything but the hook's result.
- No rule in rules/ or packages/ui/AGENTS.md asks for the separation.

(c) Guarantees: none dropped. Only types change, and they get stricter.

(d) LOC after oxfmt with the repo config, over 18 files: +129/−206, net −77. Product code is −94 and tests are +17.

- The real deletions are types.tsx (−60/+5) and context-view.tsx (ContextViewSource, OLDER_EXHAUSTED and the stale comment). The rest is import renames.
- core-renderers.test.tsx also has to change, and the candidate's list of pinning tests leaves it out.

This is a modest types-only cleanup, not a big win. Still, it removes five parallel concepts from a component that four app pages use, and it removes one silent drift.

## The append composer's Examples menu goes; the `type:` completion is the one way to offer the types this context consumes

- Sweep index: 63; risk: low; payoff: 3/10
- LOC: About −115 to −120 net, measured.
- append-composer.tsx: 167 → 131
- append-events.ts: 91 → 56
- tests: about −49 (skeptic measured: Measured by applying the deletion to scratch copies and running wc -l and diff against origin/main b3daf4846:
- packages/ui/src/components/context-view/append-composer.tsx: 166 → 130 (+4 −40)
- packages/ui/src/components/context-view/append-events.ts: 91 → 56 (+1 −36)
- packages/ui/src/components/context-view/append-events.test.ts: 120 → 70 (+1 −51)

Net −121 (+6 −127). The candidate's '167 → 131' for the composer is off by one, and its 'about −49' for the tests is really −50.)

- Concepts: 2 mechanisms become 1.

### Evidence

Merged from the parallel and heavy hunts.

The Examples menu:

- packages/ui/src/components/context-view/append-composer.tsx:6-21 (imports), :54, :113-136.
- It is fed by append-events.ts:54-87 (exampleYaml, and exampleGroups: grouping by identical consumes sets, `name +N` labels, dedupe).

The completion, which offers the same list:

- append-completions.ts:14-33 `knownEventTypes` lists every consumed type first, under 'Consumed here', with the consumers named. Wired at append-composer.tsx:56-66 and :110.
- Both came in with #3144.

### Current shape

The composer offers the consumed types twice:

- a dropdown grouped by processor that replaces the draft with `type: T\npayload: {}`;
- completion after `type:`.

### Proposed shape

Delete exampleGroups, exampleYaml and the DropdownMenu. The footer keeps only status, Close and Append.

### What changes

- No one-click 'draft of type X'. A person picks X from the `type:` completion, which lists the same types first, each with its consumers.
- The 'name +N' grouping goes.

### Pinned by

- append-events.test.ts:77-120 (deleted).
- specs/dash/contexts.spec.ts:27-33 and specs/admin/admin.spec.ts:88 drive the composer by typing.
- append-completions.test.ts is unchanged.

### Skeptic's amended proposal

Delete `exampleYaml` and `exampleGroups` (append-events.ts:54-87) and drop `stringify` from its `yaml` import. In append-composer.tsx:

- Delete the DropdownMenu block (:112-135).
- Delete the `examples` useMemo (:53).
- Delete the dropdown-menu import (:13-20).
- Drop `SparklesIcon`, and drop `shortEventType` from the filters import.
- Rewrite the header comment (:5-6) to say the `type:` completion offers the types this context knows, consumed ones first.
- Change the `processors` prop doc (:45) to 'what they consume is offered first.'

Delete append-events.test.ts:77-120 and trim its import to `{ DEFAULT_APPEND_YAML, parseAppendYaml }`. The footer keeps the status line, Close and Append.

Concepts go from 2 affordances plus 1 grouping algorithm to 1 affordance. Before merging, ask Jonas whether the Examples button was a nicety he asked for by name (#3144 ported it from the old viewer). If he wants a visible entry point, the cheap alternative is to keep neither the menu nor the grouping and have the hint say 'type: then Tab lists the types consumed here'. That is not required for the deletion.

### Skeptic's verdict

The claim holds on origin/main (b3daf4846), and PR #3446 does not touch any append-* file.

**(a) What changes.** The Examples menu (append-composer.tsx:112-135, fed by append-events.ts:54-87) and the `type:` completion (append-completions.ts:13-32, wired at composer :56-65 and :109) are built from the same data: `processors[].consumes`, wildcards dropped. The completion already lists every consumed type first, under 'Consumed here', with the consumers named in its detail (for example 'notes, echo · 3 in the log'). It also lists the log's types. Four things change:

1. The one click that replaces the whole draft with `type: X\npayload: {}` goes. Instead a person puts the caret after `type:` in the default draft, clears the value, then types or presses Ctrl+Space and picks. The payload stays whatever the draft had (by default `text: Hello`), not `{}`.
2. Discoverability drops. The Examples button is visible whenever a processor consumes a named type. The completion is advertised only by the 'Tab completes' hint, which is hidden below the sm breakpoint.
3. The processor-first grouping goes, and with it the `name +N` merge of identical consumes sets and the rule that a type shows only in its first group. The completion shows the same relation turned around: each type with its consumers.
4. In a list draft, Examples wiped every item. The completion edits one item's type in place, which is arguably better.

No caller depends on the menu:

- `exampleGroups` and `exampleYaml` are used only by the composer and append-events.test.ts:77-120.
- No spec clicks 'Examples'. specs/dash/contexts.spec.ts:27-28 and specs/admin/admin.spec.ts:88-90 drive the composer by typing only.
- append-completions.test.ts is unchanged.

**(b) Simpler.** It is strictly simpler, not a lateral move:

- One of two affordances for the same list goes.
- The bespoke grouping and dedupe algorithm goes, with its 3 table tests.
- The composer loses 8 import lines, the `useMemo`, a lucide icon and the `yaml` `stringify` import.
- Nothing new is added.

**(c) Guarantees.** None is dropped. This is a convenience in the explorer's debug composer.

**(d) LOC.** I re-measured by applying the deletion to scratch copies: net −121 (+6 −127).

**Risk.** The risk is Jonas's taste, not the code. PR #3144's body lists 'examples grouped by processor' among 'the old viewer's niceties, back (ported from bd077e2e^)'. The old apps/os composer had an Examples mode (example-events-panel.tsx) and no type completion. #3144 ported that mode and also added the completion, which is how the duplicate appeared. If Jonas asked for that port by name, he may want the visible button. Against that, he deleted all contract examples before (#2180, −1,705). Payoff is modest because the composer is peripheral.

## The filter is the URL state's keys: drop ContextViewFilter, a renamed copy of the same five fields

- Sweep index: 64; risk: low; payoff: 3/10
- LOC: −43 net over 7 files, measured on a scratch copy (+45/−88). Product −25, tests −18. (skeptic measured: I applied the change to a scratch copy at /private/tmp/claude-501/-Users-jonastemplestein--herdr-worktrees-iterate-first-party-agents/8c90908e-f48e-4f3f-adc0-08a3364e1b4c/scratchpad/skeptic-filterkeys/packages/ui and ran oxfmt on it. git diff --numstat gives +47/−99, so −52 net over 7 files. Product code is +34/−62 (−28): context-view-search.ts 0/12, context-view.tsx 6/11, filter-row.tsx 12/13, filters.tsx 16/26. Tests are +13/−37 (−24): context-view-search.test.ts 1/12, filters.test.tsx 11/21, folds.test.tsx 1/4. Both tsc -p tsconfig.json and tsc -p tsconfig.worker.json are clean. vitest over context-view passes 119/119; baseline was 120, and the missing one is the deleted contextViewFilterOf test.)
- Concepts: 2 filter shapes plus a converter become 1.

### Evidence

- packages/ui/src/components/context-view/context-view-search.ts:10-29 defines the filter as URL state: q, types[], actor, from, to.
- filters.tsx:10-20 re-declares the same five fields as ContextViewFilter (query, a Set of types, actor, from, to).
- context-view-search.ts:34-43 `contextViewFilterOf` converts the URL state into that copy.
- context-view.tsx:113 rebuilds the copy on every state change, so filters.tsx:50-61 `sameFilter` has to deep-compare it.
- filter-row.tsx:21 and :33-37 read the copy and write patches back in the other vocabulary.
- The incremental-fold row deletes sameFilter and refilter. Land this row first, or merge the two.

### Current shape

The view's filter exists twice, in two vocabularies, with a converter between them and a deep-compare on the result.

### Proposed shape

```ts
export function filterEvents(events, filter: ContextViewState) { const query = (filter.q || '').trim().toLowerCase(); const types = new Set(filter.types); … }
export const narrows = (f: ContextViewState) => Boolean(f.q?.trim()) || Boolean(f.types?.length) || Boolean(f.actor) || f.from !== undefined || f.to !== undefined;
```

Delete ContextViewFilter and contextViewFilterOf.

### What changes

- Rows, counts and chips are identical.
- If refilter survives, a reordered but equal `types` list refilters from scratch.

### Pinned by

- filters.test.tsx
- folds.test.tsx
- context-view-search.test.ts (the contextViewFilterOf row is deleted)

### Skeptic's amended proposal

Pass the view's URL state straight through; ContextViewFilter and contextViewFilterOf go.

filters.tsx:

```ts
import type { ContextViewState } from "./context-view-search.ts";
export function filterEvents(events, filter: ContextViewState) {
  const query = (filter.q || "").trim().toLowerCase();
  const types = new Set(filter.types);
  … // body unchanged, using `types`
}
export const narrows = (f: ContextViewState) => Boolean(f.q?.trim()) || Boolean(f.types?.length) || Boolean(f.actor) || f.from !== undefined || f.to !== undefined;
function sameFilter(a: ContextViewState, b: ContextViewState) { // kept until the incremental-fold row deletes it
  return (a.q || "").trim() === (b.q || "").trim() && a.actor === b.actor && a.from === b.from && a.to === b.to && (a.types || []).join("\n") === (b.types || []).join("\n");
}
// Filtered.filter and refilter's parameter become ContextViewState.
export function typeChips(counts, ticked: readonly string[]) { … const absent = [...new Set(ticked)].filter(…).sort(); … }
```

context-view.tsx:

- delete `const filter = useMemo(() => contextViewFilterOf(state), [state])`;
- call `refilter(filteredRef.current, events, state)` with deps `[events, state]`;
- use `narrows(state)` and `state.actor`;
- render `<FilterRow state={state} …>`.

filter-row.tsx:

- use `const ticked = state.types || []`;
- `toggleType` uses `ticked.includes` and `ticked.filter`;
- the input shows `value={state.q || ""}` and Escape checks `state.q`;
- the offset inputs read `state.from` and `state.to`;
- the chips call `typeChips(counts, ticked)` and set `aria-pressed={ticked.includes(type)}`.

context-view-search.ts: drop the `import type { ContextViewFilter }` line (which breaks the import cycle) and contextViewFilterOf.

Tests:

- delete the contextViewFilterOf row;
- in filters.test.tsx, EMPTY_FILTER becomes `{}` and the fixtures become `{ q: "phone" }`, `{ types: [...] }` and `{ from: 2 }`;
- typeChips takes the array;
- the folds.test.tsx filter becomes `{ types: [...] }`.

Measured −52 (+47/−99): product −28, tests −24. Concepts go from 3 to 1: the URL keys, the ContextViewFilter shape and the converter become the URL keys alone. If the incremental-fold row lands first, sameFilter is gone and so is the order caveat. Otherwise land this first; the two edits touch neighbouring lines in filters.tsx but merge trivially. Risk is low. The change is pinned by filters.test.tsx (filterEvents, the offset ranges, refilter, typeChips) and by the folds.test.tsx refold/refilter/recount growth matrix.

### Skeptic's verdict

The claim holds on the real code. On origin/main (b3daf4846) the five filter keys exist twice.

- context-view-search.ts:10-29 holds the URL state, with q and types[].
- filters.tsx:9-19 holds ContextViewFilter, with query and a Set of types.
- The converter contextViewFilterOf sits at context-view-search.ts:35-43. Because context-view-search.ts imports that type back from filters.tsx, the two files depend on each other.
- context-view.tsx:113 memoises the converted copy on [state].
- filter-row.tsx reads the copy's names (filter.query, filter.types.has) but writes patches in the URL's names ({ q }, { types: [...] }). That is the "two vocabularies" smell, and it is real.
- Nothing outside packages/ui imports ContextViewFilter, contextViewFilterOf or filterEvents. The apps only import ContextViewState, and no docs mention the removed names.
- PR #3446 does not touch this directory.

(a) Semantics. Rows, counts, chips, "clear", the strip's count and the empty text are all the same. What changes:

1. If refilter survives, sameFilter compares `types` in order. A hand-edited URL that reorders the same set refilters from scratch. The rows are identical; only the performance differs. The UI's toggle always changes the set, so it never produces a reorder.
2. With a hand-edited URL that has duplicate types, adding a type keeps the duplicates in the URL. The rows, chips and pressed state are unchanged, because filterEvents builds a Set and typeChips must dedupe with `[...new Set(ticked)]`. Without that dedupe, a duplicated absent type would render two chips with the same React key.
3. filterEvents allocates one Set per call. That is one per append increment, which costs nothing.
4. FilterRow's prop is renamed from filter to state. It has one caller.

The only test that depends on the current shape is the contextViewFilterOf row in context-view-search.test.ts, which is deleted. filters.test.tsx and folds.test.tsx only change their fixtures: EMPTY_FILTER and every `new Set(...)` / `query: ""` become `{}`, `{ q }` or `{ types: [...] }`.

(b) It really is simpler. There were three concepts: the URL keys, the ContextViewFilter shape and the converter. Now there is one. The context-view.tsx memo goes, the import cycle goes, and the test fixtures lose their noise. This is not a lateral move.

(c) It drops no guarantee. The incremental refilter still skips work on a state change that leaves the filter alone, such as opening the inspector, because sameFilter is kept in the URL vocabulary.

(d) It is −52, not the candidate's −43.

This is small UI hygiene rather than heavy junk, so the payoff is low. It is still a genuine one-vocabulary, fewer-concepts win, and the result is proven green.

## The inspector's elapsedBetween is a copy of the feed's formatDelta

- Sweep index: 66; risk: low; payoff: 2/10
- LOC: −20 net, measured on a scratch copy (+10/−30). (skeptic measured: -18 net (+11/-29) across event-inspector-log.ts (-13), event-inspector.tsx (+8/-8) and event-inspector-log.test.ts (+3/-8). Measured with git diff --no-index on scratch copies in scratchpad/skeptic-delta/{a,b}. The two header comments that mention "the gap(s)" need a one-word trim each, which changes nothing in the count.)
- Concepts: 2 gap formatters become 1.

### Evidence

- context-view/event-row.tsx:32-40 defines `formatDelta` ('+950ms, +3.2s, +1m40s, +2h5m — the old feed's compact gap').
- event-inspector-log.ts:41-52 `elapsedBetween` has the same doc and the same thresholds and output. It adds a NaN guard and its own Date.parse.
- elapsedBetween is used only at event-inspector.tsx:130-131.
- formatDelta has no test; the copy has the table test.
- apps/agents keeps three more duration formatters with slightly different notation (formatAgentUiDuration, formatElapsedSeconds, and a second formatClockTime without hourCycle). Those are left alone here.

### Current shape

Two functions format the gap between two events in the same notation.

### Proposed shape

```ts
const gap = (from: ContextViewEvent, to: ContextViewEvent) =>
  formatDelta(Math.max(0, Date.parse(to.createdAt) - Date.parse(from.createdAt)));
```

Delete elapsedBetween and move its table test onto formatDelta.

### What changes

- Identical output for every real createdAt.
- An unparseable createdAt would now show `+NaNms`. Every committed event carries the platform's ISO stamp.

### Pinned by

event-inspector-log.test.ts: the ms table moves to formatDelta, and the NaN row is deleted.

### Skeptic's amended proposal

Delete `elapsedBetween` (event-inspector-log.ts:40-52). In event-inspector.tsx, import `formatDelta` from "./event-row.tsx" and add a local adapter at module scope:

```ts
/** The gap from one event's `createdAt` to a later one's, in the rows' notation. */
const gapBetween = (from: ContextViewEvent, to: ContextViewEvent) =>
  formatDelta(Math.max(0, Date.parse(to.createdAt) - Date.parse(from.createdAt)));
```

Lines 129-130 become `gapBetween(previous, event)` and `gapBetween(event, next)`.

In event-inspector-log.test.ts:

- Import `formatDelta` from "./event-row.tsx".
- The ms table calls `formatDelta(ms)` directly and keeps the rows 0, 950, 3_249, 5_000, 100_000 and 7_500_000.
- Drop the `-20` row: the clamp is the caller's job, and formatDelta(-20) is "+-20ms".
- Delete the "unparseable time" test.

Trim "the gap to each" from the header of event-inspector-log.ts and "the gaps between events" from the test header.

The one change in behaviour: an unparseable createdAt would show `+NaNhNaNm` in the inspector instead of nothing. The row for the same event already shows "Invalid Date +NaNhNaNm" today.

This goes from two formatters to one plus a 2-line adapter. Risk is trivial. Pinned by: the event-inspector-log.test.ts ms table (moves) and the NaN test (deleted).

### Skeptic's verdict

The claim holds, but the payoff is small. It is a real copy-paste duplicate, not a lateral move.

(a) Semantics.

- I ran both functions over 605,000 gaps: every ms from -5,000 to 200,000, every ms from 3.5M to 3.7M (the hour boundary), and 200k random gaps up to 1e11 ms. They matched every time, 0 diffs. The hours arithmetic floor(floor(s/60)/60) equals floor(s/3600), and minutes%60 equals floor((s%3600)/60). The extra Math.floor in elapsedBetween does nothing because Date.parse returns whole ms.
- The only change is an unparseable createdAt. The candidate mis-states this case: Math.max(0, NaN) is NaN, so the inspector would show `+NaNhNaNm`, not `+NaNms`. It shows today nothing for that case.
- The same event's feed row already has no guard: RowTimes calls formatClockTime(NaN), which gives "Invalid Date", and formatDelta(NaN), which gives "+NaNhNaNm". So the NaN guard protects one of two surfaces for a state the platform never produces. createdAt is always the platform's ISO stamp (types.tsx:9).
- No caller or test outside event-inspector-log.test.ts depends on the gap text. event-inspector.test.tsx never asserts it.

(b) The new shape is simpler. It deletes a 12-line exported function and its doc, leaving one formatter plus a 2-line local adapter in the inspector. It also collapses the import block. The dependency event-inspector.tsx → event-row.tsx creates no cycle: event-row imports only filters.tsx and types.tsx.

(c) It drops no guarantee. The clamp to zero stays at the call site, the same way RowTimes already does it at event-row.tsx:104.

(d) Re-measured at -18, not -20.

Two mis-specifications to fix:

1. The `[-20, "+0ms"]` row cannot move onto formatDelta, because formatDelta(-20) returns "+-20ms". The clamp lives in the caller, so drop that row.
2. The NaN output is `+NaNhNaNm`, as noted above.

PR #3446 does not touch any of these files.

## The processors sheet renders live state one way, as YAML, not through two stacked toggles and a hand-written CoreState reader

- Sweep index: 68; risk: low; payoff: 4/10
- LOC: About −285: pretty-state.tsx −240, live-state-value.tsx −12, the panel about −30, and code-block about −4. (skeptic measured: I applied the proposal to scratch copies and diffed them. The four files go from 1107 to 814 lines, −293 in all: pretty-state.tsx 240→0, live-state-value.tsx 36→21, processors-panel.tsx 550→520 (the tablist, `view` state and its threading, the header comment, and the `flex-row` wrapper in SheetHeader that only existed to sit the tablist beside the title), and code-block.client.tsx 281→273 (the `showToggle` prop, its default and the conditional). Nothing is added.)
- Concepts: About 7 concepts become 1.

### Evidence

- packages/ui/src/components/context-view/pretty-state.tsx:1-240 contains PrettyFields and CorePrettyState. CorePrettyState sniffs `"subscriptions" in state` and reads apps/os CoreState by hand ('Every read is defensive').
- live-state-value.tsx:9-36 has a `view` prop and a `core` flag that pick one of three renderers.
- processors-panel.tsx:49 and :84-106 are the panel's own Pretty/Raw tablist, plus the `view` threading.
- code-block.client.tsx:70-97: `showToggle` exists only to hide the block's own YAML/JSON toggle underneath the panel's toggle.
- No test or spec imports any of these files.

### Current shape

A Pretty/Raw switch sits on top. Pretty renders either a generic field list or a bespoke core summary. Raw renders the YAML block with that block's own toggle suppressed.

### Proposed shape

```tsx
export function LiveStateValue({ state }: { state: LiveStateView }) {
  if (state.status === "error")
    return (
      <p data-type="error" className="text-xs text-destructive">
        Live state unavailable: {state.error}
      </p>
    );
  if (state.value === undefined)
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner /> Connecting…
      </p>
    );
  return <SerializedObjectCodeBlock data={state.value} className="max-h-[28rem]" />;
}
```

Delete pretty-state.tsx, the tablist, `view`, and `showToggle`.

### What changes

- Every live state reads as YAML.
- Core rule targets show as parsed expressions.
- The one-line summaries go.
- No data is hidden or added, and the panel's sections are untouched.

### Pinned by

None.

### Skeptic's amended proposal

[ui] The processors sheet shows each live state one way: the shared YAML/JSON block. No Pretty/Raw layer sits on top of it.

Evidence:

- packages/ui/src/components/context-view/pretty-state.tsx:1-240. CorePrettyState at :105-184 sniffs `"subscriptions" in state` and hand-reads CoreState ("Every read is defensive", :5-6), which breaks rules/structure/validate-unknown-shapes.md. printExpression at :207 duplicates `print` from packages/iterate/src/expression.ts:233.
- live-state-value.tsx:9-36 picks one of three renderers from `view` and `core`.
- processors-panel.tsx:49 and :84-106 hold the tablist; `view` is threaded through :177, :217, :231, :236 and :307.
- code-block.client.tsx:70-97: `showToggle` has one caller, live-state-value.tsx:33.

New shape:

```tsx
export function LiveStateValue({ state }: { state: LiveStateView }) {
  if (state.status === "error")
    return (
      <p data-type="error" className="text-xs text-destructive">
        Live state unavailable: {state.error}
      </p>
    );
  if (state.value === undefined)
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner /> Connecting…
      </p>
    );
  return <SerializedObjectCodeBlock data={state.value} className="max-h-[28rem]" />;
}
```

Delete pretty-state.tsx, the tablist and its `useState`, the `view` prop on Subscriber, the `core` flag, and `showToggle`. SerializedObjectCodeBlock always shows its YAML/JSON switch. Flatten SheetHeader back to title and description; the `flex-row` wrapper only held the tablist. Drop the panel's header comment line 12.

Semantic delta, compared with today's default (Pretty):

- Every state opens as YAML, which loads the CodeMirror chunk when the sheet opens.
- Rule targets read as nested arrays instead of calls, and a denied rule reads `target: null`.
- The core YAML repeats the subscriptions table shown above it and adds `snapshotVersion` and the abort offsets.
- The amber paused line goes; the Vitals paused stat still shows it.
- Facet lists are no longer folded behind a count. An agent's whole conversation is stringified to YAML on every live update while the sheet is open.
- Gained: the JSON view and copy buttons on every state.

LOC, measured: −293 (1107 to 814): pretty-state −240, live-state-value −15, processors-panel −30, code-block.client −8.

Concepts: about 9 become 1.

Risk: low for correctness. Moderate for product: this removes a nicety ported in #3144 from the old viewer, so Jonas decides. Before merging, check sheet responsiveness on a preview with a long agent conversation while it is streaming.

Pinned by: no test or spec.

### Skeptic's verdict

The proposal is sound but mis-specified in places. The claim that no data is hidden or added is wrong when measured against today's default view (Pretty). Here is what checking the real code found.

(b) Simpler: yes, clearly.

- The change deletes about 9 concepts and keeps 1. Gone: the Pretty/Raw tablist and its state, `view` threaded through two components, the `core` flag, PrettyFields/PrettyField/PrettyFieldValue/PrettyScalar, Folded, CompactLines, CorePrettyState, CoreTable, printExpression, scalarText/compactJson, and `showToggle`. What stays is LiveStateValue rendering SerializedObjectCodeBlock.
- `showToggle` has exactly one caller, live-state-value.tsx:33. It exists only to hide one format toggle beneath another, so two mechanisms do one job.
- PrettyFields re-implements folding, truncation and counts, which the CodeMirror block already does with fold, search and copy.
- CorePrettyState hand-reads apps/os `CoreState` over an untyped wire: `"subscriptions" in state`, `record(...)`, `isRecord(state.paused)`, `typeof row.description`. That is exactly what rules/structure/validate-unknown-shapes.md, severity error, forbids. The rule dates from July, so this code slipped through when #3144 landed on 09-25.
- printExpression duplicates `print` in packages/iterate/src/expression.ts:233.

(a) Every behaviour that changes. No test or spec depends on any of them: grep finds no imports of pretty-state, live-state-value or processors-panel in tests or specs, and no spec clicks the "How state reads" tabs. PR #3446 touches no UI file.

1. Every live state opens as YAML by default. Opening the sheet now always loads the lazy code-block.client chunk behind a Suspense spinner. Pretty needed no chunk.
2. In the core state, rewrite-rule targets render as nested YAML arrays instead of `itx.builtins.get("x").run`, and a denied rule shows `target: null` instead of "denied". The match keys stay readable.
3. The core YAML now includes the whole subscriptions table, which repeats the Subscribers section right above it; Pretty only showed "N (listed above)". It also shows the `match` arrays, `snapshotVersion`, `contextAbortedOffset` and `wokenAfterContextAbortedOffset`, which Pretty left out.
4. The amber "Paused: reason" line under The context goes. The Vitals `paused` stat (amber, reason in its title) still shows it.
5. For a hosted facet's state, long lists are no longer folded behind "N items" and scalars are no longer cut at 200 characters. An agent's state holds the whole conversation (packages/agents/src/contract.ts stateSchema). By default it would now be stringified to YAML on every live-state update while the sheet is open, including each coalescing window of a streaming turn. CodeMirror's full-document replace also resets folds on every update. This path runs today behind Raw, but it becomes the default.
6. Gained: every state gets back the YAML/JSON switch and both copy buttons.
7. The "No schedules, fetch routes." line becomes `schedules: {}` and the like.

(c) No guarantee is dropped. This is a read-only debug sheet, and every datum stays visible.

Product risk: the Pretty view was deliberately ported four days ago in #3144 as one of "the old viewer's niceties, back". The old apps/os stream-state-panel had CorePrettyState and AgentPrettyState behind a Pretty/Raw button. So this deletes a feature that may have been asked for, not dead code, and it is Jonas's call. The PR should also be checked on a preview: open the sheet on an agent with a long conversation during a streaming turn. Payoff is moderate: about 290 lines out of a peripheral admin/debug surface, not core runtime.

## Remove the URL-only `pretty-raw` view mode

- Sweep index: 70; risk: low; payoff: 2/10
- LOC: About −4 lines. The point is fewer concepts, not fewer lines. (skeptic measured: - Proposal as written (rawLine flag): 21+ / 21−, net 0.
- Amended (members render mode "raw"): 17+ / 24−, net −7 across 7 files: context-view-search.ts 2, context-view.tsx 5, event-row.tsx 1, feed-list.tsx 11, folds.test.tsx 12, folds.tsx 4, types.tsx 6.
- Measured with git diff --stat on a scratch copy. tsc is clean and 116/116 context-view tests pass.)
- Concepts: 3 modes, one reachable only by URL, become 2 modes plus a row flag.

### Evidence

- packages/ui/src/components/context-view/context-view-search.ts:12 still accepts three modes.
- context-view.tsx:63-66 offers only two of them. Lines :8-9, and #3161's body, say pretty-raw 'still works from the URL'.
- types.tsx:25-30, feed-list.tsx:119 and :233, and event-row.tsx:208 carry the third mode.
- git grep finds no link or caller outside packages/ui.

### Current shape

There are three view modes, but only two are selectable. The third survives for old links, and as the way an opened fold's members ask for their raw line.

### Proposed shape

```ts
mode: z.enum(['pretty', 'raw']).optional().catch(undefined),
// event-row.tsx: rawLine?: boolean; feed-list member row: <EventRow mode='pretty' rawLine={!row.quiet} …/>
```

### What changes

- `?mode=pretty-raw` opens in Pretty. The key is dropped, with no error page.
- Opened folds still show each member's raw line.

### Pinned by

- folds.test.tsx:74-80
- folds.test.tsx:207

### Skeptic's amended proposal

Drop `pretty-raw` entirely, with no new row flag.

```ts
// context-view-search.ts
mode: z.enum(["pretty", "raw"]).optional().catch(undefined),
// types.tsx
export type ContextViewMode = "pretty" | "raw";
// feed-list.tsx estimateSize: every row is one line
return row.kind === "day" ? 36 : 26;   // deps [rows, top]
// feed-list.tsx member row
mode={row.quiet ? "pretty" : "raw"}
// event-row.tsx: delete line 208 (the pretty-raw second RawLine)
```

- Doc comments: in context-view.tsx:7-9, folds.tsx:4-5 and types.tsx:28-33, delete the pretty-raw sentences. Say instead that an opened repeat lists each member's raw line under the sentence they share.
- Tests: folds.test.tsx:74-80 becomes one "raw keeps every event" case, and :207 loops over ["pretty", "raw"].

Semantic delta:

- `?mode=pretty-raw` opens in Pretty.
- An opened repeat's members read as Raw rows (one line) instead of sentence plus raw line. Their sentence is identical by construction, because the fold is keyed on it, and it stays on the header.
- Housekeeping members are unchanged.

Net −7 LOC. The behaviour change needs Jonas to look at it once, since it changes how an opened repeat looks.

### Skeptic's verdict

The premise holds, but the proposed shape is a lateral move. I'm keeping it only in an amended form, and it is small.

Facts, checked on origin/main at b3daf4846:

- context-view-search.ts:12 accepts `pretty-raw`, but context-view.tsx:63-66 offers only Pretty and Raw.
- #3161's body says "`pretty-raw` still works from the URL; it is just not on the strip". That is backcompat for old links, which Jonas's taste drops.
- git grep finds no caller, spec or link outside packages/ui/src/components/context-view. `ContextViewMode` has no consumer outside it.
- Every app just spreads `ContextViewState` into validateSearch: admin, dash (three routes) and agents. `.catch(undefined)` turns `?mode=pretty-raw` into Pretty with no error page.
- PR #3446 does not touch context-view.

(b) The proposal as written (a `rawLine?: boolean` on EventRow) is not simpler:

- I applied it in a scratch copy and it measures 21 insertions and 21 deletions, so zero net lines, not the claimed −4.
- At the row it swaps a 3-valued enum for a 2-valued enum plus a boolean. That admits a meaningless combination, `mode="raw"` with `rawLine`, which draws two raw lines. So the type is looser than today's.

Amended shape, simpler and with no new prop. An opened repeat fold's members render in Raw.

- The fold is keyed on the sentence. context-view.tsx:133-144 builds `factOf` from type + `sentenceText`, falling back to the payload. RepeatRow (feed-rows.tsx:85) already shows that one sentence on the fold's header.
- So each member's own sentence is redundant. The raw line is the part that differs between members (timestamps, ids).

Measured: 7 files, 17 insertions and 24 deletions, net −7. `tsc --noEmit` for packages/ui is clean, and all 116 tests in the 9 context-view test files pass.

(a) What changes:

1. `?mode=pretty-raw` opens in Pretty. No caller or test depends on it.
2. An opened repeat's members show one raw row (type in the 26ch column plus payload JSON) instead of the sentence with a small 11px raw line under it. That is one line (26px) instead of two (42px). The sentence is still shown once, on the header.
3. Opened housekeeping members are unchanged: still pretty and quiet.

No test pins member-row rendering. folds.test.tsx:74-80 and :207 loop over "pretty-raw" and must drop it. The type narrowing forces that, and nothing is lost: foldEvents only branches on `mode === "pretty"`, so pretty-raw folds exactly like raw.

(c) No guarantee is dropped. It is UI only, with no data, security or delivery surface.

Concepts go from 3 modes (one reachable only by URL), 3 EventRow renderings and 4 size-estimate branches, to 2 modes, 2 renderings and 1 branch.

It is honestly small. It's not "heavy junk", just a leftover mode kept for old links, so the payoff is low.
