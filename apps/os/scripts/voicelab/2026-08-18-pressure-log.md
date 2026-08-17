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
