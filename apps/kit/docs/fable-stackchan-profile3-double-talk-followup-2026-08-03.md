# StackChan profile-3 double-talk follow-up — 2026-08-03

This is the durable output of a bounded, read-only Claude Fable/max review of
the current tree and retained profile-2/3/4 evidence. It is advisory: each
claim must be checked against the live code and evidence before implementation.

## 1. Classification

The profile-3 duck is primarily dios VOIP residual-suppressor policy, honestly
about -5.3 dB, plus real spectral shaping, with one open input-side aggravator.

- Profile 3 uses equal x8/x8 publication gains, so the measured 0.5407
  double-talk near gain is now the engine factor; the older 0.29 estimate mixed
  selector branch gains into the calculation.
- Near-repeat through the same always-processed path reached 0.9929 similarity
  and 0.9556 gain. That falsifies the selector's old “92–99% near-only removal”
  premise for the current analogue-divider reference.
- The 0.163 similarity loss from the repeat ceiling and 10.03 dB residual
  degradation show shaping rather than a pure broadband level reduction.
- Far similarity was 0.0068 and far-only residuals were -48.1 to -48.7 dBFS at
  exact cadence. Reference peak was 12,784/32,767.
- The remaining physical aggravator is near-input headroom: the profile-3 run
  reached 31,932 (-0.22 dBFS) during playback at volume 90 and 24 dB microphone
  gain. Analogue clipping of echo is uncancellable non-linearity concentrated
  in the exact double-talk windows.
- Profile 4's linear tap is not a viable in-family escape hatch. Its cost
  exceeded the 16 ms deadline, generated recreate/drop storms, and retained
  incomplete PCM. Its acoustics were never validly measured.
- Material impact on this precise build remains unproven: the mangled
  production barge-in transcript predates profile 3. The current double-talk
  failure is a deterministic rig-relative failure, not yet proof that Grok
  loses words at this operating point.

## 2. Two cheapest materially distinct experiments

### A. Zero-flash materiality replay — first

Replay the retained profile-3 uplink through the existing VAD/STT oracle. The
run directory already contains `pcm/microphone-uplink.pcm16le`,
`pcm/timeline.jsonl`, `phase-markers.json`, and `mac-near-source.wav`:

- near-only: 48,918–51,918 ms;
- near-repeat: 58,523–61,523 ms;
- double-talk: 68,137–71,140 ms.

Pass means the double-talk transcript accuracy is at least near-only accuracy
minus the declared tolerance and VAD opens on the double-talk window. Then the
duck is immaterial at this operating point: keep profile 3, take the justified
deletions below, and stop engine work. Failure means words are lost specifically
during overlap or VAD refuses the interval; proceed to experiment B. If B does
not move the result, use the offline real-pair falsifier rather than trying
another ESP-SR mode. This replay needs no Grok session.

### B. One-variable microphone-headroom flash — second

Once the exact StackChan can enter its loader, change only
`audio_options.microphone_gain_db` from 24 to 18. Do not co-move the processed
uplink multiplier: the deterministic gate compares phases within the same run.

Preconditions are far-phase near peak below 31,000 and zero deltas in all three
schema-11 clipped-sample counters. Pass means double-talk near gain at least
0.70 and similarity loss from repeat at most 0.10, with the far-only battery
unchanged. Then retain the 18 dB PGA and re-derive the static uplink constant
with the replay ladder. If approximately 0.54 gain and 0.16 loss remain, the
dios policy ceiling is declared and input-side duck work stops. MIC3 setup may
still be repaired as hardware hygiene, but not claimed as a duck fix.

## 3. Reject a post-AEC double-talk gain expander

This is a local-maximum workaround, not a principled correction:

- broadband gain cannot restore the measured correlation/spectral loss;
- it amplifies the protected far residual and noise floor during playback;
- far-activity-keyed gain recreates the selector's edge discontinuity directly
  upstream of VAD;
- it adds a compensator before the zero-flash materiality test has established
  that compensation is required.

A single static always-on gain derived from replay is legitimate. Any gain
keyed on far activity or signal level is not.

## 4. Deletions and simplifications justified by evidence

1. Delete profile 4 and its `aec_linear_process` branch. It cannot meet the
   realtime deadline on this silicon; retain only its evidence and verdict.
2. Delete profile 2. It is condemned by both the physical receipt and the lack
   of a double-talk detector. Collapse mode/NLP selection to the profile-3
   constants, remove the 512-sample maximum, and recover about 2 KiB across
   the four static DSP arrays.
3. If experiment A passes, delete profile 1 and the complete
   playback-switched publication policy. That includes its raw branch,
   hangover/activity plane, branch counters, and stale premise comments. The
   selector then reduces to fixed saturating gain and should be inlined.
4. `reference_gain_db` is currently a dead knob because the ES7210 MIC3 path is
   unmanaged. Either include MIC3 in the explicit BSP mask and re-verify the
   slot map, or delete the option and no-op gain write.
5. The previously dark clipping counters landed during the review as metrics
   schema 11. The receipt rig must gate all three deltas at zero.

The source review also suggested committing the tree for evidence identity.
That is intentionally not done here because the standing repository instruction
forbids commits unless Jonas asks.

## 5. Oracle findings requiring local verification

No threshold should be loosened. The measured quantity or scope should be
corrected where these findings reproduce:

1. The receipt pipeline lacks a per-profile cadence/DSP-budget gate. Profile 4
   reached more than 22 ms on a 16 ms frame without that gate firing. Use the
   declared `processingFrameSamples / 16` millisecond deadline and zero
   recreate/reserve-drop deltas.
2. The profile-3 overall failure appears to include an HAVPE/XMOS-specific
   “matched reference path” gate applied to CoreS3. Scope and label that pilot
   gate to the hardware that actually owns it. Do not alter the honest 0.163
   similarity-loss or 10.03 dB degradation failures.
3. Network invalidity came from router ICMP RTT excursions while every PCM and
   socket transport counter remained clean. Re-check the documented network
   validity policy rather than silently treating ICMP as either irrelevant or
   definitive.
4. A profile-4 artifact reports frame conservation true for 110 frames where
   at least 162 were required. That predicate proves contiguity, not expected
   duration, and should be renamed or combined with the duration gate.
5. Retained evidence contains reset/close-accounting inconsistencies,
   duplicated/skipped metric sequences, small byte-accounting discrepancies,
   and a peak schema allowing 32,768 even though positive int16 magnitude ends
   at 32,767. These are evidence-integrity defects, not reasons to relax audio
   gates.

## Reconciliation status

- Accepted: engine-policy classification, zero-flash replay first, single
  24→18 dB PGA experiment second, rejection of the gain expander, and deletion
  candidates for the already-failed profiles.
- Already implemented before review completion: schema-11 clipping counters,
  parser/serializer/simulator coverage, and hard failure on positive deltas in
  the StackChan physical assessment.
- Pending verification before edits: the claimed XMOS pilot mis-scoping,
  receipt cadence gate, network-classifier semantics, and evidence naming.
- Explicitly rejected as a next experiment: FD_HIGH_PERF, another linear tap,
  NLP knob changes in VOIP, and blind Grok retries.
