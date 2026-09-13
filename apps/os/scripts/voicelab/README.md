# Voice lab

Tools for the GPT-Live voice agent, the shared device runtime, and their deployed
stream interface. The [voice package](../../../../packages/voice-agent/README.md)
owns the protocol and Agent delegation documentation. The
[firmware guide](../../../kit/firmware/README.md) covers adding boards, building,
flashing, and hardware proof.

`live-probe` connects directly to GPT-Live from this Mac. `duplex` and `ask`
exercise the deployed stream and ordinary Agent. `talk` runs the Mac firmware
client with continuous capture; `q` hangs up.

## Commands

Run from `apps/os`. Doppler selects the environment; commands that access a
project take `--project <slug>`.

```bash
# Direct provider timing and interruption, with captured output.
doppler run --config dev -- pnpm cli voicelab live-probe --save-wav out.wav
doppler run --config dev -- pnpm cli voicelab live-probe --barge-after-ms 4000 --say2 "Stop. What was the last number?"

# One controlled commentary passage through GPT-Live directly and through a
# stream. The report keeps local first-response timings separate from the
# facet's provider-receipt-to-stream-send timing; it never subtracts clocks
# across those boundaries.
doppler run --config preview_15 -- pnpm cli voicelab compare --project <slug>
# Add --setup only to install this checkout's voice source first.
# For every latency or stutter change, compare repeated direct/stream runs,
# then verify device underrun counters and a recorded call. A larger buffer
# alone is not evidence that relay latency improved.

# Full duplex through a deployed stream, with transcript and Agent commentary.
doppler run --config prd -- pnpm cli voicelab duplex --project <slug> --setup

# Speak a task and verify its resulting project state.
doppler run --config prd -- pnpm cli voicelab ask --project <slug> --setup \
  --requests '["Create notes/hello.md in my config repo containing hello world and commit it."]' \
  --verify 'return await itx.repo.readFile({ path: "notes/hello.md" })'

# A conversation using this Mac's microphone and speaker.
doppler run --config prd -- pnpm cli voicelab talk --project <slug>

# Read the durable spoken record; add --json for machine-readable rows.
doppler run --config prd -- pnpm cli voicelab transcript --project <slug> --path /agents/voice/<name>

# Read a connected board's health without starting a call.
doppler run --config prd -- pnpm cli voicelab device --project <slug> \
  --name home-assistant-voice-preview-edition --action health
```

`talk` installs this checkout's voice source into the selected project before
starting. `deploy` installs the published package instead. Both use the voice
package's installer. `--kit-dir` or `ITERATE_KIT_DIR` selects a different firmware
checkout explicitly; otherwise the Mac client builds from this worktree.

## Hardware proof

These commands start calls and produce audible output. Run them on idle boards.

```bash
# Reboot, wake, speak, and require actual speaker playback.
doppler run --config preview_3 -- pnpm cli voicelab reliability \
  --project <slug> --attempts 10

# Exercise the supported board set through air and read each board's health.
doppler run --config prd -- pnpm cli voicelab boards --project <slug>

# Sample one board's health during speech and interruption.
doppler run --config prd -- pnpm cli voicelab timeline --project <slug> \
  --name home-assistant-voice-preview-edition
```

Read `health()` at turn boundaries during manual diagnosis. It does not renew
the call's presence lease. Compare captured microphone frames, speaker writes,
queue depth, and underruns; a transcript alone does not prove what played.
The obsolete `chronology` reader has been removed; use `transcript` for recorded
speech and stream events for delegation and lifecycle details.
