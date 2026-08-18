# Pressure test + simplification log — 2026-08-18

Goal: pressure-test the voice lane on grok AND openai; reduce code and
complexity in client and server without giving back the measured
performance (ours ~80–120 ms p50, marginal ±provider-noise). Running log,
newest entries at the bottom.

## Baseline going in

Platform `5833df7ef` deployed on preview-3: ephemeral+durable batches
pipeline (cap 4), greeting single-flight, teardown gated on facet work,
all-filtered scan windows merge. Agent `voice-agent2.ts` with provider on
the birth certificate (grok/openai, 24 kHz resample at two doors). Last
clean grok run: ours p50 81 ms, uplink lateness p90 17 ms, marginal +21 ms.
OpenAI 8-round: ours p50 118 ms, marginal +121 ms (think-time dominated).

## Test matrix

1. Mixed soak (short / 27–37 s answers / mid-answer interjections / 8 s +
   30 s gaps) × 12 rounds on **openai** — first-ever openai soak; the barge
   rounds are the risk: our facet never cancels a response, and pressing
   during active generation may draw `conversation_already_has_active_response`.
2. Same × 12 on **grok** — the control, post-pipelining.
3. Machine-gun presses (settle 200 ms) — rapid consecutive turns.
4. Call-death boundary: second run on the same stream >60 s later; the
   press must bury the dead call and open a fresh one cleanly.

## Simplification candidates (audit as tests run)

- [ ] Rename the grok-named identifiers that outlived the provider
      abstraction: `grokBaseUrl`→`providerBaseUrl` (state + birth payload,
      version bump, clean break), `#grokSocket`/`#grokReady`, `GROK_SERVER_VAD`.
      Wire event names (`grok-event`, `mic-frame`…) stay — boards speak them.
- [ ] Delete superseded probes `ptt-latency.ts` + `ptt-baseline.ts`
      (ptt-marginal's header says it replaced both; only index.ts references).
- [ ] Dedupe `resamplePcm16` (agent) vs `resampleFrame` (probe) — probe can
      import the agent's, as the test file already imports constants.

## Findings

**F1 (openai, mixed soak round 2):** the long prompt ("count slowly to
forty") drew a 0.6 s answer with NOEND — no `response.output_audio.done`
observed. Short rounds healthy (ours 114–212 ms, think ~270–300 ms).
Hypotheses: gpt-realtime declines the long count, the response errored
mid-stream, or GA ends long answers with a different event. Await full soak

- grok-event lane inspection before concluding.

**F2 (test-infra):** running the ENTIRE voicelab dir in one vitest
invocation times out "sends at the rate the audio plays" (45 s budget) under
16-file parallelism; the same test passes in isolation in ~2 s. Contention
flake, not a code defect — the suite has always been run per-file here.

**S1 (simplification, committed):** the grok-named identifiers that
outlived the provider abstraction are gone — fold fields
`providerBaseUrl`/`instructions` (contract 4.0.0, clean break),
`#providerSocket`/`#providerReady`/`#lastProviderDeltaSeq`, wire field
`fromProviderDeltaSeq`, `SERVER_VAD`, test fake `FakeProvider`. Wire EVENT
names stay (`grok-event` et al) — boards and instruments speak them.
Superseded probes `ptt-latency.ts` + `ptt-baseline.ts` deleted (−454
lines); the probe's resampler now imports the agent's (−13). 375 voicelab
tests green.

**F3 (probe, second occurrence — FIXED):** the openai soak hung forever at
round 3: the itx WebSocket dropped, the barge press's awaited `ptt-start`
append never resolved, the call died at its 60 s idle deadline, and a
buffered stray press later leaked into a zombie call. The probe's awaited
appends now carry a 5 s deadline and a failed round no longer kills the run
— it prints FAILED and the loop carries on. The zombie-press leak is worth
knowing about: a reconnecting capnweb session can replay a stale press into
a stream (server handled it correctly — opened, idled, buried).

**F4 (tooling):** importing anything from `config-repo/` into a Node script
breaks EVERY CLI command with `ERR_UNSUPPORTED_ESM_URL_SCHEME
('cloudflare:')` — config-repo is worker code. The resample dedupe is
reverted with a comment naming the boundary; thirteen duplicated lines are
the fee for two runtimes.

**F1+F5 resolved into two findings, one ours, one theirs.**
The "openai never answers" run (3 calls accepted then silent, warm-up
TIMEOUT, every round failed): the DIRECT half — laptop straight to
api.openai.com, none of our infrastructure — also drew silence in all 12
rounds. gpt-realtime had an outage window (~01:34–01:55Z); the same
cold-call held-turn path answered in 593 ms once it lifted. Server-side
handling gets a PASS: three accepted-then-dead calls were each idled at
their 60 s deadline and buried with clean obituaries, and the stream
recovered without intervention. F1's 0.6 s NOEND answer was the same
provider wobble.

**F5 (ours, the real defect):** a fully quiet client WebSocket dies at
~30 s (1006) and nothing reconnects — the grok soak ran five perfect rounds
(ours 75–94 ms, barge clear 115 ms, LONG marginal −375 ms on the renamed
4.0.0 agent) and died exactly across the cycle's 30 s silence gap.
Yesterday's identical gaps survived only because the (now deleted)
keepalive event was accidentally traffic. A push-to-talk client between
turns IS that silence. Fix: transport-level liveness in the client, not an
app event.

**S2 (contract diet, this commit):** `brief-current` deleted (its gate
restated what ordered delivery already guarantees — setup appends the birth
certificate before the warm-up token, so the echo proves the fold);
`speaker-flush` deleted (durable record with zero readers anywhere — the
numbered clear frame IS the flush); the two declared-but-never-read
mic-frame fields deleted. The contract is now 12 events, every one with a
reader.

**F6 (firmware sibling of F5, fixed):** the Mac C transport only ever
ANSWERED pings; the ESP transport originates one after a quiet period —
but the shared period was 120 s, four times the measured ~30 s edge
closure, protecting nothing. The Darwin adapter now runs the same
quiet-ping (same bounded control slot, one probe per quiet period) and
ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS is 15 s. 62/63 firmware tests green
(the odd one out is the pre-existing HAVPE XMOS assertion).

## Final gauntlet — both providers, everything at once

12 mixed rounds each (short / 38–50 s answers / interjections / 8 s + 30 s
gaps), dieted agent, no app-level keepalive anywhere, WS pings carrying the
silences. 24/24 rounds clean, one conversation per run:

|             | openai            | grok             |
| ----------- | ----------------- | ---------------- |
| ours        | 91 ms p50, 97 p90 | 110 p50, 125 p90 |
| marginal    | +129 ms           | +78 ms (long 0)  |
| interject   | clear 150 ms      | clear 284 ms     |
| degradation | 87→94 ms          | 110→110 ms       |

The verdict the goal asked for: performance held (ours within 10 ms of the
pre-diet figures on both providers, tails tighter than ever), while the
processor lost its vestigial event machinery, the client lost two probe
files and gained transport-owned liveness, and every remaining contract
event has a reader.

**F7 (course correction on F5, per Jonas):** the protocol pings are
REVERTED — both the Node itx client's and the firmware keepalive retune.
They were the wrong shape: artificial traffic pinning a stateless worker
socket open to dodge a reconnect, the exact pinning the platform avoids.
Capnweb stays vanilla (verified: the built package contains zero ping
logic — the protocol supports pings; nothing sends them; browsers cannot).
The replacement is the honest mechanism: a quiet session is ALLOWED to die,
and the next press buries it, redials, and presses again — with the redial
cost reported (measured ~1.2–1.35 s, dominated by connect+openConnection).
That number is the actual product question: what the first press after a
long pause costs. Options if 1.2 s is too dear: redial eagerly on press-down
(the handshake hides under the utterance, exactly like the provider dial),
or a hibernatable client channel — a platform conversation, not a ping.

**F8 (environment, open):** during the redial soak, sessions died within
SECONDS with traffic actively flowing (an answer cut at 1.4 s mid-delivery,
a release batch timing out 4 s after a fresh redial) — a different failure
from the clean ~30 s idle closes of last night, on the same code that ran
24/24 forty minutes earlier. Preview-3's /api path was actively unstable in
this hour; the redial machinery carried the run regardless. Whether the
probe's 5 s append deadline is too tight for a degraded hour, and who
exactly closes idle sockets (edge policy vs worker isolate eviction),
remain open — needs worker logs during a quiet window.

**F9 (socket lifetime, measured — F5's "~30 s idle kill" was misread):**
`socket-lifetime.ts` opens one socket per mode and lets the close event
speak: `silent` (bare WS to /api), `ping` (protocol pings), `rpc`
(authenticated capnweb session, one RPC, then true silence), `open` (rpc +
`openConnection` on a fresh stream + one durable append delivered back —
the DO retaining a callback into a socket that then goes fully quiet).
Final results: SEVEN of eight sockets survived their full 3600 s ceiling —
three bare-silent, the rpc-silent bare socket, and (completing later) the
authenticated rpc leg and the open leg, the last with a DO-retained
callback and one append, quiet the whole hour THROUGH two worker deploys.
The PING socket died at 3460 s (1006) — the only death in the battery was
the one generating traffic. The open leg took a fresh at-head delivery
frame at 649 s of silence (the DO can still call the retained callback ten
minutes into quiet); in-flight WebSockets finish on the old isolate, so
even a deploy is not an instant kill. There is NO idle
policy killing quiet sockets at any layer — not the edge, not the worker,
not the DO connection machinery — and authenticated capnweb sessions are
NOT torn down for being quiet. Death is isolate reaping, uncorrelated with
activity; pings buy nothing, which is F7's verdict measured.

Re-reading the soak logs with that in hand: each "death by silence" run
contained exactly ONE socket close (grok round 6, openai round 5 — every
later `FAILED: 1006` was the pre-redial probe reusing the corpse), both in
one overnight window, and `wrangler deployments list` shows no deploy
within hours of either (last: 21:44Z; deaths ~01:15Z, ~02:20Z). So the
true rate is: two 1006s across ~50 soak rounds — routine isolate churn.
A stateless worker's WebSocket has no lifetime guarantee; Cloudflare may
recycle the isolate at will (a deploy always does). No ping can prevent
that, which is the final nail for F7's verdict: redial-on-press is the
correct posture, not a workaround. The append-stall failures (5 s
unacknowledged on a FRESH socket) are a separate server-side wobble —
F8 stays open, but it is not a socket-lifetime problem.

**F10 (found while reading the error logs for F8/F9): two bricked
scheduler streams, crashlooping since 2026-08-17 ~12–18Z at ~950
errors/hour.** Both are `/scheduler/primary` of DELETED projects
(`deleted-worker-bedc58ba`, `deleted-worker-303fa221`); a sweep of all
519 preview-3 projects found no others, and prd is clean over 24 h. The
chain, each link proven:

1. The logged error (`failed to replay core event … offset 377/415, type
subscription-delivery-halted, state version 31`) hid its zod cause —
   `console.error`, RPC serialization and the observability pipeline all
   drop `error.cause`. Fixed: the cause now rides in the message, and the
   fold logs the exact stored row before throwing (boot failure gates
   every RPC behind `blockConcurrencyWhile`, so the failing fold is the
   ONLY window onto the bytes).
2. The confessed row: a halted event written 2026-08-12T23:02Z whose
   payload carries an extra `workerVersion` key. No committed code in the
   entire history ever wrote that field — it came from an experimental
   worktree deploy of that evening (preview-3 deploy 22:24Z). Today's
   `z.strictObject` rejects the unknown key on replay.
3. The event folded fine when appended (that build's schema knew the
   field) and sat behind the checkpoint for five days. The brick only
   detonates when a boot takes the full-replay lane and re-parses history
   with today's schema — strict replay makes every payload-schema
   tightening a delayed time bomb for any stream that predates it.
4. A local repro through the real DO harness confirms today's write +
   full-log rebuild round-trips cleanly — the current code is
   self-consistent; only foreign history breaks it.
5. `kill()` is boot-gated too: an unreplayable stream cannot even be
   killed. There is NO repair verb that reaches a stream that cannot
   boot. And the deleted projects' scheduler DOs still alarm forever —
   deletion never tears down their heartbeat, which is what keeps the
   crashloop burning.

Decisions this leaves open (platform, for Jonas): whether replay of
delivery-lifecycle bookkeeping events should be tolerant (they carry no
product state; worst case a halted flag is lost and delivery re-halts),
whether kill/quarantine must work pre-boot, and whether project deletion
should tombstone the scheduler. The preview-3 zombies themselves are
harmless noise until then.

**F11 (doctrine correction on F7, per Jonas): THE CLIENT'S JOB IS TO BE
CONNECTED.** "Redial on the next press" was the wrong posture — a client's
one standing job is to remain connected to /api, `connect`, and stay
available, because the socket is how the SERVER reaches the device
(server-triggered conversations, pushes). Only the voice provider is dialed
on demand. F9's measurements slot straight into this frame: nothing kills a
quiet socket on purpose, churn kills any socket eventually, so
always-connected means reconnect-the-moment-it-dies rather than
lazily-at-next-use. What changed:

- The firmware already LIVES the doctrine mechanically — the ESP/Darwin
  network task redials whenever the socket is down and the retry gate is
  ready (backoff as a timestamp, never a sleep), the 120 s quiet-hop probe
  detects half-open sockets, and the mount watchdog remounts after long
  quiet. Only the words were wrong: the keepalive constant's comment
  preached "a quiet session is allowed to die; redial on next use" and now
  states the always-connected doctrine.
- The itx node client stays vanilla capnweb but gains a passive
  `onWebSocketClose` observer hook — the moment an always-connected caller
  reconnects from. No pings, no retries, no reconnection inside the
  library; the consumer owns the loop.
- ptt-marginal now models the real client: the close hook triggers an
  immediate single-flight background reconnect (generation-guarded against
  late closes from buried sockets), the 5 s append deadline remains as the
  half-open fallback, and the summary line is renamed `session reconnect`.
  A press during the gap pays only what remains of a reconnect that is
  already running.

The hook is deliberately NOT on `VoicelabConnectOptions` — command option
types become CLI flags, and the first draft leaked a nonsense
`--on-web-socket-close [json]` flag onto every voicelab command; it rides
a separate programmatic-extras parameter instead.

**F12 (the mount invariant, built and proven live): mount loss now
arrives as a close, never as silence.** The connected-but-unreachable
state F11 described — the platform's half of a live capability mount dies
(pager closed by DO reset/deploy/eviction) while the client's /api socket
stays healthy — was reproduced in the code before it was reproduced live:
the relay's pager-close handler retired every mount SILENTLY and left the
session up. Per Jonas: maximum teardown, deliberately — when the Pager
dies from the far side with live mounts riding it, the session owner
closes the client's whole socket (4901) and the client's one
always-connected reconnect loop re-dials and re-runs its idempotent
`connect`. (The alternative — quietly re-dialing the pager under the
live session — is documented at the teardown site as the future option;
rejected for now because it forks recovery into a rarely-exercised
second path, and the client must own reconnect-and-re-mount anyway.)

Pieces: the relay gains `onPagerLost` (its existing null-before-close
ordering already excludes every self-initiated close — two new tests pin
far-side-fires-once and own-close-never-fires); worker.ts inlines
capnweb's WebSocket response so it can register a session-transport
closer keyed on the request's ExecutionContext (`session-transport.ts`,
the one seam between transport and target tree); the capability-host
wiring closes 4901 on loss, a no-op for HTTP-batch and DO-side itx.

**F13 (reported by Jonas from a real attended session; the barge only
did half its job):** "count slowly to one hundred", space pressed
mid-count, several seconds of speech — and it kept counting. The run's
own wavs settle the client's side (mic.wav holds the 3.1 s interjection,
so the press registered and captured; speaker.wav shows the count playing
unbroken to the end), and the facet's code settles the server's: a
`ptt-start` mid-answer emptied the speaker queue and sent the numbered
clear frame — but NOTHING TOLD THE PROVIDER TO STOP GENERATING, and
arriving deltas of the un-cancelled response re-filled the queue. Every
earlier barge test passed because grok (and often gpt-realtime) bursts
the whole answer up front, so the queue-drop killed everything; measured
today, the same count prompt generated 90.8 s of audio over 16.6 s on one
round and in 1.06 s on the next — whether a barge lands during generation
is a coin toss, and Jonas's landed during it.

The fix: `ptt-start` while a response is actively generating (tracked
`response.created` → `response.output_audio.done`) now sends
`response.cancel` and discards the cancelled answer's residue — its
deltas AND its end marker — until the next `response.created`. Proven
three ways: two FakeProvider tests (cancel-plus-deafness; no cancel when
idle — 58/58); audibly, three probe runs where the barged count collapsed
to 2.3–3.4 s answers with clears at 97–147 ms; and by the provider
itself — the verbatim lane shows `response.done` with status
`cancelled` for the 150 ms barge that landed mid-generation. The host
CLI also stops voiding `mark_turn` failures (a silently lost ptt-start
IS a lost barge-in; now it logs), and talk2 ensures the xai base secret
whatever the provider (the either/or only worked on projects that
already had both).

Operational bycatch, worth its own eyebrow: pushing to this branch now
triggers CI preview deploys that ERASE preview-3's data — mid-afternoon
the slot dropped from 519 projects to 2, taking voice-test (recreated:
prj_68295b19…), every soak stream, and — by bulldozer — F10's two zombie
scheduler crashloops. Preview evidence has a push-bounded shelf life;
durable claims belong in this log, committed.

Proven on preview-3 with socket-lifetime's new `mount` mode (a fake
device: `projects.connect` + live `ping()` capability, then silence):
capability answered end-to-end ("alive at 14.3s", stamped inside the
device process), then `streams.get(scope).kill()` — and the device's
socket closed within ~3 s: `code=4901 reason=live capability mounts
lost; reconnect and connect() again`. This is the gate F11 named: with
the invariant live, the firmware's 3-minute mount-watchdog flap, the
120 s quiet-ping, and the 420 s no-pong restart lose their reason to
exist. Open sibling: the kill() RPC's own reply errored client-side
(capnweb evaluate on a response from a dying DO) — the kill worked;
the reply's death rattle is a separate, pre-existing wrinkle. And the
original four-boards-at-11-minutes mount loss remains un-root-caused;
the invariant converts it from silent outage to a visible blip.

**F14 (reported by Jonas; the barge's third half — the model must KNOW it
was interrupted):** barged mid-count and asked "how far did you get?", the
model claimed the full count — its conversation still held everything it
GENERATED. The repair is provider-standard (`conversation.item.truncate`
with heard-ms; grok speaks the same dialect), but three measured surprises
shaped the implementation:

1. Truncate raced the cancelled response's finalization (ack and `done`
   shared a millisecond; the model still claimed the frontier) — the
   truncate now DEFERS until `response.done`.
2. Truncation deletes the item transcript WHOLESALE, and the model grounds
   "what did I say" in text, not its own audio: cleanly truncated, it swung
   to "I never even started". The facet now follows the truncate with a
   system note carrying the heard PREFIX of the provider's own transcript.
3. The transcript stream is unsynchronised with the audio stream in BOTH
   directions (28 chars against 17 s received on a lagging run; 62 numbers
   ahead on a brisk one), so the note's cut aligns windows explicitly:
   the note-time transcript spans the audio generated up to the cancel,
   and heard/received is a ratio of that same span.

Proof: `voicelab interject-recall` — the failing e2e Jonas asked for,
no hands (utterances synthesized with `say`, the reply judged from the
provider's own transcript on the verbatim lane, yardsticks from the wire:
the truncate ack's heard-ms, the note read back from the new client-event
flight recorder, and a 3-numbers-per-second clock ceiling). Journey,
each step measured live: "counted all the way to 100" (nothing) → "26/28"
(cancel only) → "I didn't get to any numbers" (truncate, no note) →
**"I got to 3 before you asked me to stop"** against a note that told it
exactly that (PASS). The `grok-event` lane now records client-sent
control events as `client.<type>` — the wire's flight recorder hears both
directions. 61 agent unit tests pin the mechanics.

**F15 (reported by Jonas; openai audibly worse than the OpenAI app —
the pipeline's one transcode was the defect): voice-agent2's
`resamplePcm16` was linear interpolation, per delta, with no
anti-aliasing filter.** Three compounding faults, all invisible on grok
because grok is 16 kHz native and the resampler was an identity there:
(1) decimating 24 → 16 kHz unfiltered folds the source's 8–12 kHz band
back into 4–8 kHz as inharmonic grit — the "substantially worse"; (2)
endpoint pinning (`index * (n-1) / (m-1)`) resampled every delta at a
slightly wrong, chunk-length-dependent rate; (3) each delta restarted
the conversion phase — a seam per provider flush. The provider offers no
escape hatch: GA formats are pcm16 at a fixed 24 kHz or G.711 at 8, so
the fix is doing our one transcode properly. `pcm.ts` now holds a
polyphase windowed-sinc resampler (64 taps, Blackman, per-phase DC
normalisation) whose conversion phase and input tail are CARRIED ACROSS
PUSHES — one continuous conversion per stream however the deltas chunk;
per-dial instances both directions, speaker side reset per answer.
Decision with Jonas: the fleet stays 16 kHz (no per-device native-rate
negotiation; the host CLI is the boards' instrument and the firmware's
byte budgets assume 32 bytes/ms), so the 24 kHz passthrough idea died
here. Proof is arithmetic, not opinion — 10 new unit tests: a 10 kHz
tone that would alias arrives 50 dB down instead of at full strength,
3 kHz passes at unity and at its true frequency (zero-crossing count),
byte-identical output under ragged rechunking, steady-state pushes at
the exact 2:3 ratio, DC flat across every polyphase arm.

F15 proof, live on preview-3 (stream `/agents/voice2/pcm-151440`): the
two-file config repo (voice-agent2.ts + pcm.ts) installs and builds —
warm in 1.7 s — and `interject-recall` PASSES through both directions of
the new filter on real gpt-realtime: 15.2 s of count delivered, barged,
truncate acked at 14,577 ms heard, note carried "1…12", the model
answered "I got to 17". Measured response of the shipped 24→16 kernel:
0 dB through 6.5 kHz, −1.4 dB at 7 kHz, and everything at or above
8 kHz — the entire band the linear version folded into audible range —
arrives at −80 dB or lower. (Two earlier probe FAILs on this change were
the 13:57:53Z preview deploy's DO-reset wave mid-run, not the code:
two `conversation-accepted` 32 s apart with "Durable Object reset
because its code was updated" across the tail. Preview evidence keeps
its shelf life.)

**F16 (the 16-agent review + tools): voice-agent2.ts reviewed from eight
lenses with adversarial verification; tools landed and live-proven.** The
full report — six confirmed bugs, a ~350-line simplification ledger, the
unused-provider-features dossier, the Gemini Live dossier — is
`2026-08-18-voice-agent2-review.md` beside this log. Tools shipped the
same day (contract 5.0.0, clean break): the birth certificate carries
`tools` as plain data, expressions are the platform's own persisted-
capability shape walked from a fresh `env.ITX.get()` session per call,
and hang_up is the expression-less base case — one atomic append of
conversation-end-requested settled at the pacer's drain point. Proven
live on preview-3 (`/agents/voice2/hangup-162055`, gpt-realtime-2.1):
4.7 s goodbye press → model speaks 3.35 s goodbye → `hang_up({})` →
function_call_output on the flight recorder → end-requested "the model
hung up" → ended. 69/69 unit tests.

**F17 (found by the live proofs after the greenlit refactor; grok cannot
repair a barged answer's memory AT ALL): both wire verbs are broken on
grok.** `conversation.item.truncate` is a silent no-op — no ack, no
error, even for a bogus item id (OpenAI errors). The fallback,
`conversation.item.delete`, is half-implemented: it acks for
client-created items (direct-dial probe) but answers "Item not found"
for the assistant's own response items — the only ones a barge needs
gone — twelve seconds after grok minted the id itself. So on grok the
heard-prefix note is the entire repair, the PROVIDERS table says so
(`truncates: false`), and `interject-recall` on grok is an EXPECTED
FAIL until xAI fixes either verb: asked "how far did you get", the
model re-counts from one, grounding on the untouchable full-count item.
Everything else on grok is healthy — instant clear at the press, clean
lane (zero provider errors), note delivered and acked. OpenAI passes
the same gauntlet on the final code ("The last number I said out loud
was 7", truncate acked at 11,287 ms heard).

**The greenlit refactor, landed and live-proven** (13 commits,
1b980cedc…f2bd30e2d): B1/B2/B6 + full append-lane discipline (zero
floating `void append`); the Dial/Answer state collapse (26 fields →
one object, #dialInFlight gone, fences strengthened, B5 dead by
construction); B3+B4 (open-mic barge repairs memory; a tentative onset
HOLDS the tail — retraction resumes it, confirmation discards it with
heard-ms frozen at the clear); the sweeps — warmup handshake deleted
for the platform's own `waitUntilProcessed` barrier (cold 1,251 ms,
warm 140 ms, live), turn-timing deleted wholesale, fromProviderDeltaSeq
deleted, dead spkBufferedMs read deleted, birth certificate split
(existence-only `created` + content-keyed `configured`, contract
6.0.0, dedupe live-proven), idle daemon → self-rescheduling tick chain,
provider pins (interrupt_response/create_response/silence_duration_ms
explicit + far_field on openai). Hot file 3,041 → ~2,900 lines with
three bug-fix subsystems ADDED; sweeps alone were net −223. Suite 67
green + 7 ptt-marginal + 10 pcm. Hang-up tool re-proven post-refactor.
