# Streaming state and rendering

Decision and local measurements, 10–11 September 2026. Research:
[Phoenix LiveView](./liveview-streaming-performance-research.md) and
[React streaming](./react-streaming-performance-research.md).

LiveView's useful lesson is to preserve unchanged subtrees across the entire
path. It does not have a magic append opcode for an arbitrary growing string.
We therefore represent in-progress text as immutable 1,024-unit blocks, grouped
32 at a time. Recorded responses remain complete strings. There is no duplicate
response-window array and no repeated full-prefix comparison.

## State transport

- Generic positional array patches preserve unchanged nested objects after
  JSON transport. Version 3 adds compact field addresses and bounded string
  appends. Already-open version 2 subscribers keep structural array patches;
  unversioned subscribers keep array replacements until they reconnect.
- Facets expose finite `readLiveState({ epoch, revision })` reads. One retained
  delta is sufficient for the serialized parent reader; a missed revision or
  new incarnation returns a snapshot. No facet callback keeps a DO awake.
- Hibernatable Pager sockets use the same snapshot/patch protocol. Each socket
  receives a seed before patches, including all survivors after host eviction.
  Legacy sockets keep their full-state frames. Invalid frames or revision gaps
  close the socket with a diagnostic so the subscription can re-establish.
- A subscriber holds at most one unacknowledged call. Later updates coalesce
  from its acknowledged baseline; a 10-second acknowledgement deadline drops a
  stalled sink with a warning. Dormant engines schedule no timers.
- The transient feed retains up to 1,048,576 UTF-16 units across response and
  thinking text, prioritizing the latest request. An exact, cached UTF-8 JSON
  size guard omits previews above 8 MiB. Both outcomes have visible notices.
  These budgets never truncate recorded events or published feed items.

`scripts/benchmarks/live-state.ts` exercises the actual engine and client store
through three JSON boundaries, including a dozen unchanged code steps, cached
JSON sizing, exact content verification, and sealed-group identity assertions.
Apple M4 Max, Node 26.5.0; 1 KiB appends, no network latency:

| Appended text | Encoded bytes per hop | Total CPU across three hops |
| ------------- | --------------------: | --------------------------: |
| 64 KiB        |               108,763 |                     4.38 ms |
| 1 MiB         |             1,380,148 |                    77.24 ms |
| 4 MiB         |             5,465,748 |                   379.50 ms |

The 4 MiB case tests the generic codec beyond the feed's preview budget. A
prototype using `startsWith(previous)` to infer string suffixes took roughly
3.8 seconds for 1 MiB and 63 seconds for 4 MiB; its prefix scans were rejected.
The prior simulated full-state path sent approximately 6.17 MB per hop for
64 KiB and 1.126 GB per hop for an uncapped 1 MiB stream. These simulations
explain the design choice; deployed proof must separately cover RPC and state.

### Compact wire protocol (11 September)

The 1 KiB benchmark above understates small-token overhead: version 2 sends the
whole changed block and repeats its field path on each update. Version 3 uses
`{s: [revision, state]}` snapshots and `{p: [from, to, patch]}` deltas. Within a
patch, an existing field's address is its position among the **sorted, defined
keys of the previous object**. New fields carry `+name`; arrays use indices and
send `#` only when their length changes. Primitives replace directly, `[value]`
replaces an object or array, `[]` removes a field, and `[previousLength, suffix]`
appends text. All addresses resolve against the original baseline before any
keys are added or deleted. A snapshot reconstructs everything needed to decode
future patches; there is no separately synchronized dictionary.

String-prefix comparisons are restricted to previous strings of 16–4,096 UTF-16
units. This includes immutable text blocks without scanning a whole response.
Edits and larger ordinary strings use replacement. Malformed addresses or an
incorrect append length fail before replacing the held state. The React hook
keeps the last valid value, reports the error, and permits two automatic resyncs;
receiving a valid delta or explicitly refreshing resets that recovery budget.

`scripts/benchmarks/live-state-wire.ts` sends 64 KiB of text through a real local
WebSocket using the production Cap'n Web serializer, with a flush per append.
These are complete, uncompressed RPC callback messages including the initial
snapshot and Cap'n Web's literal-array escaping; control messages are excluded:

| Append size | Version 2 mean message | Version 3 mean message | Traffic reduction |
| ----------- | ---------------------: | ---------------------: | ----------------: |
| 16 B        |                  842 B |                  142 B |               83% |
| 48 B        |                  874 B |                  173 B |               80% |
| 128 B       |                  897 B |                  252 B |               72% |
| 1 KiB       |                1,323 B |                1,123 B |               15% |

The separate three-JSON-boundary benchmark includes 12 unchanged 2 KB code
steps. For 48 B appends, bytes per hop drop from 1,187,465 to 278,618; synchronous
CPU across all three hops is about 77 ms for either codec. It checks exact text
and sealed-group identity at 64 KiB, 1 MiB and 4 MiB. CPU timings vary with host
load; neither benchmark includes internet latency or WebSocket compression.
The raw measurements are in `scripts/benchmarks/results/compact-live-state-*.json`.

## React and browser layout

Memoized groups and blocks retain DOM nodes and selection. Only the last block
animates, with at most 64 transient spans and reduced-motion support. Live code
uses plain text with scroll pinning; expensive formatting belongs to settled
output or an explicitly opened inspector.

Memoization alone was insufficient on slower devices: inline nodes still share
the paragraph's layout. With a 390 × 844 viewport and Chrome's 4× CPU slowdown,
rendering all 1 MiB took 121 ms at p95 and produced 48 long tasks. A native
textarea append experiment was worse (526 ms p95). Arbitrary block containment
would change line breaking, so it was rejected.

The live view now shows the last 32 blocks (about 32K characters). A labeled
**View full text** sheet captures all currently available preview text on
explicit open and supports copying. The snapshot remains still as streaming
continues; reopening captures newer text. Completed text and durable history
retain their complete contents. No complete string is materialized each frame.

The browser harness imports the actual `AgentLiveActivity` and app CSS, builds
React's production profiling renderer, appends once per animation frame, and
measures React commits, synchronous update plus forced layout, DOM count,
frame intervals, and long tasks. These are CPU/layout measurements, not an
end-to-end network-latency claim. Local results vary with hardware and load.

| Case                            | Before p95 update + layout | Final desktop p95 | Final 4× CPU mobile p95 |
| ------------------------------- | -------------------------: | ----------------: | ----------------------: |
| 64 KiB prose, 1 KiB appends     |                    23.3 ms |            1.2 ms |                  8.5 ms |
| 1 MiB prose, 16 KiB appends     |                   352.3 ms |            1.6 ms |                  9.7 ms |
| 1 MiB code, 16 KiB appends      |                          — |            1.9 ms |                  9.2 ms |
| 1 MiB prose, 1 KiB appends      |                          — |            1.2 ms |                  7.6 ms |
| 1 MiB collapsed, 16 KiB appends |                     0.5 ms |            0.3 ms |                       — |

The before 1 MiB case deliberately exceeds the old 64K preview cap: it measures
how the old renderer would behave if that cap were raised. The before expanded
prose DOM had 9,481 elements at 64 KiB and 149,961 at 1 MiB; final has 44. All
ten final desktop/mobile cases recorded zero long tasks. Final p95 React work
was at most 0.4 ms on desktop and 2.1 ms with mobile CPU throttling.

Raw results and reproduction instructions live in
[`scripts/benchmarks`](../scripts/benchmarks/README.md). DOM tests additionally
verify exact text, sealed-node selection, bounded animation, complete snapshot
copying, and snapshot stability/reopening while the source changes.

## React Doctor

React Doctor 0.9.13, uncached against `origin/main`, including untracked new
files: **zero new diagnostics, 12 fixed**. Its workspace aggregate remains
52/100 because it scores existing issues in the example app too; that is not
a score for this renderer. A separate scan of `streaming-text.tsx` and
`full-text-snapshot.tsx` scores **100/100** with zero diagnostics. We do not
disable workspace checks or refactor
unrelated modules merely to improve that aggregate number.
