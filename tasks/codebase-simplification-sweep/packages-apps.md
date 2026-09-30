# Sweep candidates: packages-apps

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## The CLI has one lend-until-Ctrl-C loop; `iterate tunnel` becomes `provide` plus a fetch route, not a line-for-line copy

- Sweep index: 59; risk: low; payoff: 4/10
- LOC: About −195 to −215 net over 5 files:
- Product: runTunnel 150 → about 55, runProvide about the same, handler helper about −15.
- Tests: tunnel.test.ts's two reconnect rows (233-397) collapse, about −55 to −100. (skeptic measured: Measured on origin/main b3daf4846. tunnel.ts is 317 lines and provide.ts 214. runTunnel with its constant is lines 168-317 (150). A sketch of the unified loop gives tunnel.ts 236 (−81) and provide.ts 240 (+26), about −55 product lines. Tests: about −40 to −60 by consolidating tunnel.test.ts:229-321 and provide.test.ts:136-187, then +10 for polls in the two tunnel.e2e rows. Net about −85 to −105. The candidate's −195 to −215 counted use-my-computer, the cli.ts helper and an optimistic test cut.)
- Concepts: 2 lend loops, 2 reconnect tables and 2 ways a tunnel's route ends become 1 loop, 1 table and 1 route lifetime.

### Evidence

This row merges the parallel and heavy hunts.

The duplicated loop:

- packages/cli/src/tunnel.ts:168-317 (runTunnel) and provide.ts:104-214 (runProvide) contain the same loop.
- `diff <(sed -n 271,317p tunnel.ts) <(sed -n 160,214p provide.ts)` differs only in 4-5 message strings.
- Both files define RECONNECT_DELAYS_MS (tunnel.ts:171, provide.ts:107; provide's comment says 'as `iterate tunnel` does'), the signal wiring (:206-209, :130-133), the serve race (:256-263, :151-158) and messageOf (:315, :212).

The route delete:

- tunnel.ts:264-268 deletes the route by hand, although packages/iterate/src/api.ts:961-966 says a fetchRoute 'lives exactly as long as the lend … removed when it ends however it ends' (#3156).

Related copies:

- use-my-computer.ts:113-156 is a third, deliberately non-reconnecting copy.
- cli.ts:551-570 and :593-613 are two identical handler bodies.

### Current shape

runTunnel and runProvide each carry a full copy of the lend-until-Ctrl-C loop: the stop signal, the reconnect ladder, its table, and the reset after a served round. A tunnel also removes its route by hand before the platform removes it with the lend.

### Proposed shape

```ts
// provide.ts
export async function runProvide(input: {
  connection;
  reconnect;
  project: string;
  match: string;
  lend(
    project: ProjectHandle,
    first: boolean,
  ): Promise<{ target: RpcTarget; options?: Parameters<ProjectHandle["provide"]>[2] }>;
  reconnectDelaysMs?: readonly number[];
}) {
  /* today's loop, once */
}
// tunnel.ts
export const runTunnel = ({ port, tunnelName, hostname, public: pub, ...rest }) =>
  runProvide({
    ...rest,
    match: `itx.tunnels.${name}`,
    lend: async (project, first) => {
      /* conflict check, url, print */ return {
        target: new LocalPortRpcTarget(port, console.error),
        options: { fetchRoute: { fetchRouteName, requestMatcher, authRequirement } },
      };
    },
  });
```

Optional: use-my-computer passes `reconnectDelaysMs: []`, and cli.ts shares `withSelectedProject`.

### What changes

- On Ctrl-C, the route is removed by the lend ending (≤1 s on prd, per the #3156 census), not by an explicit delete first. In that window a request can get a 404 instead of 'no route'.
- The give-up and disconnect messages share one wording.
- Unchanged: the ladder, 'the first refusal is fatal', the reset after a served round, a re-lend on every connection, and stdout.

### Pinned by

- packages/cli/src/tunnel.test.ts:186, :229, :285
- provide.test.ts:136
- cli.test.ts:323
- apps/os/e2e/serve-localhost-example.e2e.test.ts

### Skeptic's amended proposal

One PR in packages/cli, with one loop.

In provide.ts, export `lendUntilStopped({ connection, reconnect, project, label, command, lend(project, first): Promise<{ lendEnded(); [Symbol.dispose]() }>, reconnectDelaysMs? })`. It holds today's loop, the signal wiring, RECONNECT_DELAYS_MS and messageOf, once. The loop owns `using project = await connection.session.projects.get(...)` and `using lend = await input.lend(project, first)`. The callback does its own `project.provide` and prints what it prints on first or reconnect. That keeps the URL on stdout printed only after the lend is live; the candidate's `{ target, options }` return would print it before the lend.

Both commands become thin callers:

- `runProvide({ ...input, file, name })` checks NAME, then calls `lendUntilStopped({ ...input, label: match, command: "provide", lend: async (project, first) => { const lend = await project.provide(match, rpcTargetOf(await input.file.provide({ itx: project })), description); print; return lend; } })`.
- `runTunnel({ ...input, port, tunnelName, hostname, public })` validates the hostname and builds the matcher, then calls `lendUntilStopped({ ...input, label: "The tunnel", command: "tunnel", lend: async (project, first) => { conflict check; url; const lend = await project.provide(target, new LocalPortRpcTarget(port, console.error), { fetchRoute }); print; return lend; } })`.

Remove the Ctrl-C `fetchRoutes.set(name, null)`, so the route has one lifetime: the lend's. Change apps/os/e2e/tunnel.e2e.test.ts:100-105 and :172-175 to poll `untilValue(() => itx.fetchRoutes.list(), r => r.length === 0)`, as the kill -9 row does. Name this delta in the PR: the route is no longer gone when the CLI exits, but a moment later. If Jonas wants to keep the fast path, the loop needs a `stopped?(project)` hook of about 6 lines, and the delete stays.

Consolidate tests: one loop row in provide.test.ts covering the schedule, the give-up message, the reset after a served round and lendEnded. Keep one tunnel.test.ts row asserting that a re-lend carries the route again.

Out of scope: use-my-computer.ts (a deliberately non-reconnecting loop that stops on stdin EOF and emits JSON) and the cli.ts handler helper (a nit).

Concepts go from 2 loops, 2 schedule tables and 2 route-removal paths to 1 of each.

### Skeptic's verdict

The main claim holds. #3437 merged provide.ts today, and runProvide's loop is a copy of runTunnel's. `diff <(sed -n 271,317p tunnel.ts) <(sed -n 160,214p provide.ts)` differs only in four message strings and two comments. The same is true of the constant (tunnel.ts:171 = provide.ts:107), the signal wiring (:206-209 = :130-133), the race (:256-263 = :151-158) and messageOf. PR #3446 does not touch packages/cli.

With one loop, the tunnel is just a lend with a LocalPortRpcTarget and a fetchRoute. That is one concept fewer and no lateral move. The "spell it twice" rule does not apply: it covers the sagas of separate domain entities, and this is one transport retry loop copied line for line.

The candidate is mis-specified in four places.

(1) The route delete. Dropping the explicit delete in tunnel.ts:264-268 is safe: disposing the handle closes the pager (iterate-context.ts:400), and the DO's detach census removes the rule and the route in the same turn (iterate-context-durable-object.ts:340-372). #3156 still kept the delete on purpose as a "fast path". Dropping it changes behaviour the candidate did not name:

- Today the route is gone once `iterate tunnel` exits 0. Afterwards it goes a moment later, when the pager close reaches the DO.
- apps/os/e2e/tunnel.e2e.test.ts:100-105 and :172-175 assert `fetchRoutes.list()` is `[]` right after exit, with no polling. They would race and must poll with `untilValue`, as the kill -9 row at :150-158 already does.
- The stderr line "Could not delete the fetch route" disappears.
- Ctrl-C on a half-open socket no longer waits for the delete to fail. That is an improvement.

The candidate lists serve-localhost-example.e2e as pinning this, but that test covers apps/os/examples/serve-localhost.mjs's own SIGINT delete, which this change does not touch. The candidate omits tunnel.e2e.test.ts, the test that actually pins it.

(2) use-my-computer should not be folded in. Its menu-bar mode stops on stdin EOF and emits NDJSON. It does not watch lendEnded, and it deliberately never reconnects. Passing `reconnectDelaysMs: []` would need extra hooks for stop and emit, so it is not simpler.

(3) The cli.ts handlers are not identical. provide imports the file before signing in. A shared helper saves about 8 lines. That is a nit, so drop it.

(4) The LOC figure is about twice the real one. I measured a sketch in scratchpad/skeptic-lend-loop:

- tunnel.ts goes from 317 to 236 lines (−81).
- provide.ts goes from 214 to 240 lines (+26).
- That is about −55 product lines.

The tests shrink by about 40 to 60 lines, not 55 to 100: the reconnect coverage in tunnel.test.ts:229-321 and provide.test.ts:136-187 should move into one loop row, not be deleted. The two e2e polls add about 10 lines back. The realistic total is about −85 to −105, not −195 to −215.

The message strings pinned by tunnel.test.ts:171/270-278 and provide.test.ts:178 stay verbatim if the loop takes a `label` ("The tunnel" or "itx.<name>") and a `command`. The only change is that "Could not serve the tunnel again: X" gets the shared wording, and nothing pins that line. The rest is unchanged:

- the reconnect schedule;
- the first refusal being fatal;
- the reset after a served round;
- the conflict check and a fresh LocalPortRpcTarget on every lend;
- stdout.

Risk is low.

## The voice relay's idle deadline reads an in-memory stamp on the dial, not a durable 5 s-stepped fold field mirrored back into memory

- Sweep index: 60; risk: low; payoff: 4/10
- LOC: About −30 in voice-agent.ts (1337 lines). A new idle-deadline test adds about +20. (skeptic measured: I applied the proposed shape to a scratch copy (scratchpad/idle-measure/new.ts) and diffed it against origin/main packages/voice/src/voice-agent.ts. The file goes from 1338 to 1304 lines: 17 insertions and 51 deletions, so net −34. No other file changes. An idle-deadline test is optional and would add about 15–20 lines to voice-agent.test.ts, whose harness needs a movable clock instead of `nowAtFacetMs: () => 0`.)
- Concepts: Before, 6:
- a durable stamp
- a step constant
- a mirror
- two clocks
- two write-only fields

After, 1: one dial stamp.

### Evidence

Merged from the parallel and heavy hunts.

In packages/voice/src/voice-agent.ts:

- :60-63: IDLE_STAMP_STEP_MS.
- :195-198: `call.lastDeviceInputAtStreamMs`.
- :505-523: the reduce arm, 'so the idle deadline outlives an eviction'.
- :484-486 and :581: `#lastDeviceInputAtStreamMsMirror`.
- :800-810: the idle tick mixes stream and facet clocks.

The eviction premise does not hold:

- :584-601 end any call without a live dial ('A provider session is volatile; its durable record cannot revive it').
- The tick only runs beside a live dial.

Write-only fields in the same family:

- `Dial.transcript` (:398-399, set at :720 and :1121).
- `payload.key` (:1124, contract :279/:289).

git grep lastDeviceInput finds no other reader.

### Current shape

The device's last-input time is folded into durable state in 5 s steps. It is mirrored into a field on every delivery. A 5 s tick then compares it against a facet-clock speaker stamp.

All of this exists to survive an eviction that already ends the call.

### Proposed shape

```ts
interface Dial { …; lastDeviceInputAtFacetMs: number }
case 'events.iterate.com/voice-agent/mic-frame': … dial.lastDeviceInputAtFacetMs = this.deps.nowAtFacetMs(); …
case 'events.iterate.com/voice-agent/keepalive': if (this.#dial) this.#dial.lastDeviceInputAtFacetMs = this.deps.nowAtFacetMs(); return;
// idleTick: Math.max(dial.lastDeviceInputAtFacetMs, dial.lastSpeakerFrameAtFacetMs)
```

Delete:

- the state field
- the reduce arm
- IDLE_STAMP_STEP_MS
- the mirror
- `Dial.transcript`
- the transcript payloads' `key`

### What changes

- The deadline is measured per frame on one clock, instead of in up-to-5 s steps across two clocks.
- The checkpoint no longer rewrites every 5 s during a call.
- An evicted incarnation still ends the owed call.
- Transcript events drop `key`, which nothing reads.
- Schemas are loose, and zod strips the stale field, so no version bump is needed.

### Pinned by

- packages/voice/src/voice-agent.test.ts:147 pins the eviction-ends-call premise.
- No test pins the idle deadline, so add one.
- apps/agents/e2e/voice-agent.e2e.test.ts
- call-client.test.ts

### Skeptic's amended proposal

Scope: packages/voice/src/voice-agent.ts only.

Delete:

- `IDLE_STAMP_STEP_MS` (:61-63).
- `call.lastDeviceInputAtStreamMs` and its doc comment (:196-198).
- The mic-frame/keepalive reduce arm, and `committedAtStreamMs` in `reduce` (:492, :505-523).
- `#lastDeviceInputAtStreamMsMirror` (:484-486) and its setter in `processEvent` (:581).
- `Dial.transcript` and the lines that set it (:398-399, freshDial `transcript: []`, :720, :1121).
- `transcriptKey` and the `key` field of both transcript payloads (:279, :289, :1124, :1130, :1135).

Add:

```ts
interface Dial { …; lastDeviceInputAtFacetMs: number; lastSpeakerFrameAtFacetMs: number; … }
const freshDial = (conversationId, activation, nowAtFacetMs: number): Dial => ({ …, lastDeviceInputAtFacetMs: nowAtFacetMs, … });
// #openProviderConnection
const dialStartedAtFacetMs = this.deps.nowAtFacetMs();
const dial = freshDial(conversationId, activation, dialStartedAtFacetMs);
// processEvent
case "events.iterate.com/voice-agent/keepalive":
  if (this.#dial) this.#dial.lastDeviceInputAtFacetMs = this.deps.nowAtFacetMs();
  return;
case "events.iterate.com/voice-agent/mic-frame": {
  const dial = this.#dial;
  if (!dial || dial.activation !== event.payload.activation) return;
  dial.lastDeviceInputAtFacetMs = this.deps.nowAtFacetMs(); // before the empty-frame return, as today
  const micB64 = event.payload.pcm;
  if (micB64 === "") return;
  …
}
// idleTick
const lastActivityAtFacetMs = Math.max(dial.lastDeviceInputAtFacetMs, dial.lastSpeakerFrameAtFacetMs);
```

Leave these as they are:

- The contract version: checkpoint state is `JSON.parse`d, so an old stale key is inert.
- `consumes`: mic-frame and keepalive are still needed by `processEvent`.

Optional test: give the voice-agent.test.ts harness a mutable `nowMs` that an `elapseMs` step advances. Then add a row showing that 60 s without mic-frame or keepalive ends the call with "no input from the device for 60s", and that a keepalive at 50 s defers it.

### Skeptic's verdict

The semantics claim holds, and the durability premise is even weaker than the candidate says.

**(1) Eviction already ends the call.** `processEvent` ends any caught-up `state.call` that has no live `#dial` (voice-agent.ts:583-590, "A provider session is volatile"). voice-agent.test.ts:147-164 pins this: a successor incarnation ends the call "the voice session was interrupted". The idle tick is armed only inside `#openProviderConnection` and exits when `this.#dial !== dial`. So the stamp only ever feeds a live dial in the incarnation that received `call-started`, and the mirror is its only reader. `git grep lastDeviceInput` finds nothing outside this file: not the live view, apps/voice, apps/agents or the firmware.

**(2) The stamp is not durable anyway.** mic-frame and keepalive are ephemeral. The engine says ephemerals "NEVER trigger a checkpoint write" and that "durable product truth must never derive from an ephemeral" (packages/iterate/src/stream/processor.ts:33-35 and 47-49). The persist gate is `sawDurable && advanced`, with `stateChanged` computed per batch (processor.ts:538-551). So the folded stamp reaches storage only when a durable event in the same batch also changes state. The comment "folding the newest is what makes the idle deadline outlive an eviction" is false twice over. The arm is machinery that contradicts the engine's own rule.

**(3) The write-only fields are confirmed.** `Dial.transcript` has had no reader since #3344 (ffb1bd543), which deleted `return [...dial.transcript, ...open]`. `payload.key` / `transcriptKey` has no reader in apps/, packages/, the firmware, the scripts or any test. call-client.ts, voice-call.ts, voice-board.ts and the e2e read only `text`.

**Corrections to the candidate:**

- **Initialise the new stamp when the dial is created.** The sketch omitted this. Left at 0, every call would end at the first 5 s tick. Use `freshDial(conversationId, activation, dialStartedAtFacetMs)`.
- **"The checkpoint no longer rewrites every 5 s" is wrong.** Ephemeral-only batches never write. The real change is only that a state-changing durable batch stops serialising the stamp.
- **"zod strips the stale field" is wrong.** Checkpoints load through `JSON.parse` with no schema parse (processor.ts:938). An old in-flight call's `lastDeviceInputAtStreamMs` rides along unread until `call-ended` nulls `call`. That is harmless, and no version bump is needed.

**Full semantics delta:**

- **Hang-up timing:** after the last device input, the hang-up lands at 60–65 s instead of 60–70 s. The 5 s stamp step goes; the 5 s tick stays.
- **Where the deadline starts:** at dial creation, on the facet clock, instead of at `call-started`'s commit stamp. That is the same delivery, milliseconds apart.
- **Other activations' frames:** a mic-frame for another activation no longer feeds the deadline. Contexts are one per press, so this cannot practically happen.
- **Transcript events:** they lose the optional `key`, which nothing reads.
- **No guarantee is lost.** Idle reaping still covers a dial whose socket never resolves, because the stamp and tick are armed at dial creation. Eviction still ends the call.

**Tests:** none pin the idle deadline. The restart test and the call-client keepalive test are unaffected. The unit harness's frozen facet clock (0) against createdAt = offset*1000 already makes the idle path unreachable, before and after.

**Simpler for real.** Before: a durable-looking fold field, a step constant, a reduce arm over ephemerals, an instance mirror, a two-clock comparison, and two dead fields. After: one Dial field, stamped where the frame is already handled, on one clock. The payoff is moderate: one package file, but it removes a misleading durability story and a violation of the engine's rule.
