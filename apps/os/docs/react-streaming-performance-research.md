# React streaming-rendering research

Implementation and measured results: [streaming performance decision](./streaming-performance.md).

Status: research report, 2026-09-10. This assesses the live agent feed as it
exists on this branch; it is not an implementation decision. The target case
is a visible, continuously appended prose or code preview of at least 1 MiB.

## Finding

The branch's immutable `ChunkedText` plus `StreamingText` is the right
_rendering_ shape for live plain text. It preserves sealed block/group
references, makes the final 1 KiB block the only changing text subtree, and
limits the prose reveal to 64 spans. Keep it; do not replace the live path
with a generic streaming-markdown component.

The remaining work is to prove the complete path stays bounded: the text still
has to travel through the pager, reach a narrowly subscribed feed subtree,
lay out in the browser, be measured by the virtual feed, and maintain scroll
position. In particular, a visible 1 MiB `pre` can make a `scrollHeight` read
expensive even when React updates only one text node.

## Current branch assessment

### What is already good

[`chunked-text.ts`](../../../packages/shared/src/chunked-text.ts) cuts text
into 1,024 UTF-16-unit blocks and 32-block groups. An append shallow-copies
only the group containing the tail; a full group and all its blocks retain
identity. [`StreamingText`](../src/components/streaming-text.tsx) memoizes
both `TextGroup` and `TextBlock`, so React shallow comparison can retain
sealed groups and blocks. At 1 MiB, this means approximately 1,024 ordinary
inline spans/text nodes, plus at most 64 transient word spans in the changing
tail, rather than a span per word across the whole preview.

This relies on the same rule React documents for `memo`: unchanged props must
have the same reference. `memo` only skips a component when its props compare
equal; a fresh object/array defeats it. [React `memo`
reference](https://react.dev/reference/react/memo#skipping-re-rendering-when-props-are-unchanged)
and [React `useMemo` reference](https://react.dev/reference/react/useMemo#skipping-re-rendering-of-components)
describe that contract. The reducer's immutable append implementation is
therefore an essential correctness requirement for the performance result,
not a cosmetic data-structure choice.

The feed already virtualizes immutable history rows and uses a stable "live"
key for the trailing activity. That is the appropriate virtualization
boundary: a whole message/activity row can be measured, anchored and restored
as one item. The active row remains mounted and dynamically measured, which
avoids virtualizer churn while it changes.

The source also already has two useful transport coalescers: 50 ms for the
DO-to-relay pager and 100 ms for the client `LiveState` engine. This is a
reasonable cadence to test first, rather than rendering provider tokens one
by one.

### What it does not solve

Block identity prevents React reconciliation of old blocks. It does **not**
make browser text layout free. A visible one-million-character paragraph or
`pre` still produces many line boxes, and a tail append can extend its height.
The supplied benchmark baseline for an ungrouped 1 MiB prose fixture was
about 150,000 elements, React p95 35 ms/update, and layout 352 ms/update.
The current block renderer should remove the element explosion and most React
work, but only a browser trace can establish its layout cost.

`StreamingText` still constructs one `TextGroup` element per group on each
live update. At the current preview ceiling this is about 32 elements for 1
MiB and is not the suspected bottleneck. Do not make block size smaller just
to reduce changing characters: that increases the persistent DOM and line
fragmentation. Measure 1, 4 and 8 KiB blocks if the trace points to the tail;
otherwise retain the simple 1 KiB boundary.

The code preview has a distinct risk. `StreamingCodeBlock` reads
`scrollHeight` and writes `scrollTop` in a layout effect on every update while
pinned. The outer feed's stick-to-bottom observer can also write its own
`scrollTop` after the row changes. A layout-dependent read after a DOM write
may force a synchronous layout; Chrome documents this failure mode and its
DevTools diagnostic. [Chrome DevTools: forced reflow
insight](https://developer.chrome.com/blog/devtools-insights-sidebar/#forced-reflow)
and [Chrome rendering-performance
tools](https://developer.chrome.com/docs/devtools/rendering/performance) are
the relevant verification tools. This is a measurement concern, not evidence
that the code pane should lose its correct pin/unpin behaviour.

`sliceText` deliberately materializes all blocks for copy and settled syntax
highlighting. That is right for a user-triggered copy and for once-only
settlement, but it must stay out of every live render path. The live code
component passes `ChunkedText` directly; preserve that property. Likewise,
do not add a live `join`, full-string prefix comparison, or full-text Markdown
parse as an animation helper.

## What upstream streaming React code actually does

### Publication cadence and external-store snapshots

Vercel AI SDK's `useChat` exposes an opt-in `throttle` for message/data UI
updates. It receives stream events independently, throttles the subscriber
callback before calling React, stores a cached message snapshot, and uses
`useSyncExternalStore`; its test verifies that several deltas become one
published UI state after 50 ms. The final terminal status publishes the latest
message snapshot before React sees `ready`.

- [AI SDK `useChat` options, cached snapshot and subscription (pinned source)](https://github.com/vercel/ai/blob/00968508b7f47e5b1e7faa0bf001c2288abb8098/packages/react/src/use-chat.ts#L44-L188)
- [AI SDK callback throttling (pinned source)](https://github.com/vercel/ai/blob/00968508b7f47e5b1e7faa0bf001c2288abb8098/packages/react/src/chat.react.ts#L111-L121)
- [AI SDK's 50 ms throttling test (pinned source)](https://github.com/vercel/ai/blob/00968508b7f47e5b1e7faa0bf001c2288abb8098/packages/react/src/use-chat.ui.test.tsx#L2306-L2440)

This supports coalescing _publication_ separately from receiving and storing
every transport delta. It does not establish a universal magic interval: keep
the current 50/100 ms pipeline unless a trace demonstrates a need to change
it. If the browser ever receives more than one usable update per frame, add a
view-only latest-value rAF coalescer at the final subscription boundary,
including an immediate final flush and cancellation on unmount. It must not
become a second source of truth or hide a transport backlog.

`useSyncExternalStore` is appropriate for this bridge only if `getSnapshot`
returns a cached immutable value. React explicitly warns that returning a new
object each call causes repeated rendering (and can loop); immutable store
data may be returned directly. [Official `useSyncExternalStore`
reference](https://react.dev/reference/react/useSyncExternalStore#im-getting-an-error-the-result-of-getsnapshot-should-be-cached).
Select `state.agent.live` as narrowly as the existing live-state hook permits,
and retain object identity for presence, runtime and settled rows. A selector
does not itself make the active tail cheap; it prevents unrelated page work.

### Markdown components are a different tradeoff

Vercel's Streamdown parses stream text into Markdown blocks, uses index-stable
keys (not content hashes) and memoizes each block, so complete semantic
Markdown blocks commonly retain their React subtree.

- [Streamdown preprocessing and whole-input block parse (pinned source)](https://github.com/vercel/streamdown/blob/fdf4e331920681d4a6eb22467973f46bdd4b177d/packages/streamdown/index.tsx#L574-L640)
- [Its indexed streaming block render (pinned source)](https://github.com/vercel/streamdown/blob/fdf4e331920681d4a6eb22467973f46bdd4b177d/packages/streamdown/index.tsx#L900-L983)
- [Its `Block` `memo` comparator (pinned source)](https://github.com/vercel/streamdown/blob/fdf4e331920681d4a6eb22467973f46bdd4b177d/packages/streamdown/index.tsx#L384-L490)

That is useful when live rich Markdown is a product requirement. It still
calls `parseMarkdownIntoBlocks(processedChildren)` over the complete growing
string each update, so it is not a solution for a large, high-rate plain-text
preview. assistant-ui says this directly: its Streamdown wrapper defers the
second parse/render to protect urgent work because Streamdown reparses the
whole accumulated text; its performance contract still expects one primitive
render per token update.

- [assistant-ui Streamdown wrapper and its full-reparse comment (pinned source)](https://github.com/assistant-ui/assistant-ui/blob/8530b17b8aee50413c5cbbe628832ad039a6d584/packages/react-streamdown/src/primitives/StreamdownText.tsx#L86-L126)
- [assistant-ui's per-token render contract (pinned source)](https://github.com/assistant-ui/assistant-ui/blob/8530b17b8aee50413c5cbbe628832ad039a6d584/packages/x-performance/contracts/streamdown-streaming.test.tsx#L71-L88)

For this feed, continue rendering active prose as `white-space: pre-wrap` and
active code as plain `pre`; render full Markdown/highlighting only once the
durable text is settled. This gives a better bound than a generic chat UI can
promise while preserving semantic rich rendering for history.

### Animation

assistant-ui's `useSmooth` separates authoritative target text from a
displayed prefix. A rAF loop drains that prefix; it can cap characters per
frame and independently set a minimum interval between commits, then always
flushes final text and honours reduced motion. [Source and options](https://github.com/assistant-ui/assistant-ui/blob/8530b17b8aee50413c5cbbe628832ad039a6d584/packages/react/src/utils/smooth/useSmooth.ts#L19-L123)
and [the final-flush/reduced-motion path](https://github.com/assistant-ui/assistant-ui/blob/8530b17b8aee50413c5cbbe628832ad039a6d584/packages/react/src/utils/smooth/useSmooth.ts#L133-L287)
show a sound view-only pattern.

The branch's smaller strategy is preferable for the agent feed: keep all
sealed text ordinary; animate only the latest append inside the final block;
hard-cap it at 64 spans; let an overly dense whitespace run use one span. Add
`prefers-reduced-motion` coverage before treating animation as done. Do not
animate code or syntax-highlighted output while it changes. Streamdown itself
also caps its animation backlog at 320 ms to avoid an unbounded invisible
animation queue. [Streamdown animation timeline](https://github.com/vercel/streamdown/blob/fdf4e331920681d4a6eb22467973f46bdd4b177d/packages/streamdown/lib/animate.ts#L10-L120).

React transitions and `useDeferredValue` can preserve input responsiveness by
allowing a lagging view to be interrupted. They do not make a changed active
tail parse or lay out faster. React recommends them when a slow subtree cannot
otherwise be optimized, and notes that deferred rendering still catches up.
[Official `useDeferredValue` reference](https://react.dev/reference/react/useDeferredValue#deferring-re-rendering-for-a-part-of-the-ui)
and [official `startTransition` reference](https://react.dev/reference/react/startTransition#marking-a-state-update-as-a-non-blocking-transition).
Use them only after structural work and coalescing have been measured; do not
put a controlled composer input in a transition.

### DOM retention, accessibility and copying

The browser cares about DOM size as well as React time. Chrome's guidance is
to minimize DOM nodes and use containment or `content-visibility` to isolate
offscreen subtrees. [DOM size and interaction](https://web.dev/articles/dom-size-and-interactivity)
and [`content-visibility`](https://web.dev/articles/content-visibility) explain
that `auto` skips offscreen layout/paint while retaining the accessibility
tree, subject to sizing and forced-layout caveats.

Do not apply `content-visibility` to the visible live tail: it cannot reduce
the required layout. The feed already does better for historical rows by not
mounting them outside its virtual window. Avoid virtualizing inside an active
message merely to hit a node count: it breaks native selection/copy of the
whole text, browser find, and screen-reader traversal unless a separate
complete-copy/download and accessible reading path are designed. A 1 MiB live
preview is an exceptional inspection surface; if tracing says line layout is
still too costly, give the _live preview_ an explicit bounded visible window
with a clear "preview shortened" state and retain the full durable response in
the request inspector.

Do not use an `aria-live` region for token text. Upstream copy components
announce completion/error rather than the whole transcript. [Streamdown copy
button](https://github.com/vercel/streamdown/blob/fdf4e331920681d4a6eb22467973f46bdd4b177d/packages/streamdown/lib/code-block/copy-button.tsx#L20-L93).
Native selection across the current block spans remains useful; the existing
explicit code Copy control should materialize text once on click, as it does.

### Scrolling

The current feed correctly treats bottom following as user intent, keeps the
live row inside the virtualizer's height model, and uses `ResizeObserver` for
actual growth. Do not replace it with `scrollIntoView` for every token.
assistant-ui reaches the same conclusion with explicit follow-bottom and
pending-scroll state, cancellable rAF scheduling, and resize-driven
re-pinning. [Its auto-scroll implementation](https://github.com/assistant-ui/assistant-ui/blob/8530b17b8aee50413c5cbbe628832ad039a6d584/packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts#L55-L240).

For the inner code pane, preserve the separate pin state: only follow while
within its tolerance of the bottom, release on a real user scroll upward, and
do not steal the outer feed's scroll. First profile the present layout-effect
read; if it is a long task, schedule at most one post-commit scroll operation
per animation frame or let a ResizeObserver trigger it after layout. Verify
that the final settled update flushes the scroll state.

## Measurement and acceptance plan

Run each fixture both at desktop and throttled mobile CPU. Produce a Chrome
Performance trace and React Profiler export rather than using wall-clock
averages alone. The browser Performance API can add marks/measures and observe
long tasks; [MDN's Performance API reference](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API)
documents both facilities.

| Fixture                                                  | Assertions                                                                                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 MiB prose, 1 KiB appends, active at feed bottom        | Element count is about block count plus bounded animation spans; sealed blocks do not render; React commit p95/p99 and Layout remain bounded; no long task or growing allocation trend. |
| Same prose while composer receives real keystrokes       | Input stays responsive; no unexpected page-wide commits; transition/defer is considered only if this fails after structural fixes.                                                      |
| 1 MiB code, inner pane pinned and then manually unpinned | No forced-reflow hot loop; pin follows while selected, never overrides manual inner scrolling; outer feed remains correctly pinned/released.                                            |
| Complete Markdown-like output after settlement           | Exactly one replacement from live plain text to settled Markdown/highlighted content; no intermediate full parse.                                                                       |
| Mid-stream reconnect and terminal flush                  | No duplicate/missing suffix; latest pending state paints promptly; animation/rAF final state is exact.                                                                                  |
| User selection/copy and reduced motion                   | Complete visible text copies; code's explicit control succeeds; no token-by-token live announcement; animation is disabled or non-disruptive under reduced motion.                      |

Chrome's Performance panel can expose forced reflow, long tasks, style/layout
time and paint flashing. Instrument source-to-paint cadence separately from
transport bytes: a low React commit count does not prove that the relay has
stopped serializing whole accumulated text. The companion LiveView report
addresses the append transport protocol and pager path.

## Recommendation

1. Keep `ChunkedText`, 32-block groups, memoized sealed blocks, plain active
   prose/code and the 64-span tail cap.
2. Keep the present transport coalescing while measuring it; only introduce a
   latest-value rAF view adapter if the final subscription can otherwise
   publish more than once per frame. It must final-flush and expose any
   backlog.
3. Profile the 1 MiB code scroll path before changing it. Address any forced
   synchronous layout with a single frame-scheduled or resize-triggered write,
   without weakening the user-intent scroll state machine.
4. Make the live feed subscription select the narrowest immutable slice and
   verify settled rows never render on live text changes.
5. Bound the _visible_ preview only if browser layout, rather than React or
   wire copying, remains the proven bottleneck. Keep complete durable output
   accessible through history/inspection and retain a deliberate copy path.

## Follow-up: mobile inline-layout failure (2026-09-10)

The first production-shaped browser result changes the priority of the final
recommendation. The current immutable blocks are doing their job in React:
desktop 1 MiB prose measured p95 React work at 0.3 ms and layout at 12.6 ms,
with no long tasks. At a 390 px viewport and 4x CDP CPU slowdown, 1 MiB prose
in 16 KiB appends measured p95 React at 1.3 ms but p95 layout at 121 ms, with
48 long tasks and a 250 ms maximum. Code measured p95 layout at 74 ms with 35
long tasks. The bottleneck is browser layout of one growing inline formatting
context, not React reconciliation or a per-token animation.

### What CSS can and cannot isolate

`contain: layout` / `contain: content` makes a _box_ an independent formatting
context. It is a good fit for an independent paragraph, list, code block or
feed row. The [CSS Containment specification](https://www.w3.org/TR/css-contain-1/)
and [MDN containment guide](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Using)
describe this isolation; `content-visibility: auto` adds skip-rendering for a
box outside the viewport while keeping it in the DOM, selection, find-in-page
and accessibility tree. [MDN's relevant-to-user rules](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Using#relevant_to_the_user)
matter here: selection/focus makes a skipped section relevant again.

It cannot independently contain several arbitrary `<span>` chunks while
preserving one continuous paragraph's line-breaking. The CSS Display
specification says forcing an independent formatting context is impossible/no
op for a non-replaced inline box; an `inline-block` is an _atomic_ inline box.
[CSS Display Level 4](https://www.w3.org/TR/css-display-4/#formatting-context)
and [CSS 2.2's inline-level box definition](https://www.w3.org/TR/CSS22/visuren.html#inline-level)
establish the constraint. Therefore:

- adding `contain` or `content-visibility` to today's inline text-group spans
  cannot isolate the giant parent inline formatting context;
- changing groups to block boxes or atomic inline boxes can isolate their
  contents, but creates artificial line/block boundaries and changes the
  rendered paragraph;
- `display: contents` preserves flow but produces no box on which containment
  can establish isolation.

Do not ship a character-count block boundary with block containment as a
performance "fix." It would silently alter paragraph wrapping and, for block
boxes, native selected-text copy semantics.

### Viable design now: semantic blocks, then an explicit pathological fallback

For normal output, split only at real semantic boundaries: paragraph breaks,
Markdown block boundaries, list items where their layout is independently
valid, fenced code blocks, and existing structured result fields. Keep each
settled semantic block immutable and render it as a block box with
`contain: content; content-visibility: auto; contain-intrinsic-size: auto
10rem` (with a measured fallback appropriate to the content). Its complete
text remains in the DOM and is normally
copyable/searchable/accessibly exposed; once it is above/below the viewport,
the browser can skip its internal layout and paint. This makes actual visible
paragraphs, rather than every preceding paragraph in the 1 MiB response, the
layout scope. `contain-intrinsic-size` is necessary to avoid a zero-height or
jumping skipped block before it has a remembered size. [MDN documents its
relationship to size containment](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/contain-intrinsic-size).

This needs a streaming semantic parser that seals only after a valid boundary.
Streamdown shows rich Markdown block memoization is feasible, but its
whole-input parser is unsuitable for the high-rate tail; maintain a small
incremental boundary scanner/parser and keep only its final semantic block
mutable. Plain text can seal on actual blank-line/newline boundaries without
inventing them. Its active final paragraph stays a regular flowing `<p>` so
wrap and native selection are exact.

A true single 1 MiB paragraph with no semantic boundary is the irreducible
case. No CSS containment arrangement has both independent layout and the
exact same continuous inline formatting. Do not hide it with a 64 KiB cap or
corrupt it with 32 KiB blocks. Make the exception explicit after a measured
threshold: switch that one field to a **complete-output viewer** with its own
scrolling viewport and an authoritative full-text copy/select-all control.
All text remains available, visible by scrolling, and copyable; it is a
presentation change rather than data loss. A native read-only `textarea` is a
candidate worth benchmarking because its editing engine owns scrolling and
selection, but it is not a recommendation without the same 390 px trace and
accessibility review. A styled plain `<pre>` with an inner scroller does not
by itself solve its internal line-layout cost.

If product requirements demand one continuously flowing, richly styled,
native-selectable 1 MiB paragraph at phone widths, the remaining route is a
purpose-built line virtualizer/renderer. It needs an explicit selection,
copy, find and accessibility design; it is not a CSS tweak. Avoid building it
until semantic blocks plus the exceptional viewer have been measured.

### Revised experiment matrix

1. Prototype semantic paragraphs with containment and run the same 390 px,
   4x CPU, 1 MiB/16 KiB fixture. Record visible-tail layout, total DOM nodes,
   long tasks, scroll anchor and full-document selection/copy.
2. Include realistic output with many paragraphs and the adversarial one-
   paragraph fixture. The former should improve substantially; the latter
   proves that the fallback criterion is honest.
3. Benchmark a read-only native complete-output viewer against the one-
   paragraph fixture. It must retain all 1 MiB, support keyboard selection and
   copy, announce sensible label/instructions, and avoid fighting outer-feed
   scrolling.
4. Verify resize/font-size changes. A semantic block can be relaid out when it
   enters view; its remembered intrinsic size may change, so the feed
   virtualizer/stick must preserve reader position.
