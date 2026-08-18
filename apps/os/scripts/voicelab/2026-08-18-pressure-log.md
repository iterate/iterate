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
Results: THREE bare sockets and the ping socket sailed past 45 minutes;
the rpc and open legs cleared many multiples of the supposed ~30 s window
without a flicker. There is NO idle policy killing quiet sockets at any
layer — not the edge, not the worker, not the DO connection machinery, and
authenticated capnweb sessions are NOT torn down for being quiet.

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
