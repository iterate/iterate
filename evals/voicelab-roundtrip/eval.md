# Voicelab roundtrip: ask by voice, colleague answers, memory survives a reconnect

A "true" voice eval: real synthesized speech in (macOS `say`), the real prod
voice pipeline, and assertions against the durable transcript of what the
voice actually said. No microphone, no speaker, nobody at the keyboard.

Historical failure this guards against (both streams are read-only evidence):

- https://os.iterate.com/projects/iterate/agents/streams/agents/voice/2608261526
- https://os.iterate.com/projects/iterate/agents/streams/agents/voice-notes/voice/2608261526

There, the colleague computed a correct answer, then followed the platform's
reply-routing label into `itx.agents.get("/agents/voice/…").message(…)`,
created a rogue agent on the live call stream when that failed, and delivered
the answer to it — while the human heard nothing. The call also idled out and
the reconnected session had no memory of the conversation.

## Setup

Use the project slug `voicelab-eval` (NOT a fresh default-template project —
this eval needs the voice agent, which `voicelab setup` installs, and a stable
slug keeps prod tidy; the project is created on first run). Everything runs
from `apps/os` inside `doppler run --config prd -- …`.

1. Mint a fresh two-word codeword for this run, e.g. pick two random common
   nouns ("walrus trumpet"). It must be words speech-to-text will round-trip,
   and it must not appear in any earlier run. Commit it to the eval project's
   config repo:

   ```
   doppler run --config prd -- pnpm cli itx run --context voicelab-eval -e \
     "return await itx.repo.commitFiles({ changes: [{ path: 'codeword.txt', content: 'walrus trumpet' }], message: 'voicelab eval codeword' })"
   ```

   (If the project does not exist yet, run
   `doppler run --config prd -- pnpm cli voicelab setup --project voicelab-eval`
   once first — it creates the project — then come back.)

2. Generate the utterances (16 kHz mono PCM16 WAVs) into a scratch dir:
   - `01-ask.wav`: "Hello. Please ask your notes assistant to read the file
     called codeword dot T X T in the project repo, and tell me the two word
     codeword it contains."
   - `02-nudge.wav`: "Any update on that codeword yet?"

   ```
   say -o 01-ask.wav --data-format=LEI16@16000 --channels=1 "<text>"
   ```

3. Phase A — the roundtrip. Run the conversation on the board firmware's Mac
   target: from `apps/kit`, `pnpm firmware:build:host` then
   `firmware/.build/host/iterate-kit-mac --config <image> --name <name>`, and
   speak each utterance with
   `apps/agents/scripts/voice-board.ts --device <name> --prompt "<text>"`.

   Speak the ask, then keep nudging, which both keeps the call alive across
   the colleague's thinking time and mirrors a real impatient human.

4. Phase B — the reconnect. Wait 90 seconds after the run ends (the idle
   deadline buries the call), then run one more short conversation on the
   SAME stream path with a single utterance: "What was that codeword again?"
   (`voice-board.ts --device <name> --prompt "What was that codeword again?"`).

## Success criteria (all four must hold)

Read the durable record with
`doppler run --config prd -- pnpm cli voicelab transcript --project voicelab-eval --path /agents/voice/eval-<stamp> --json`:

1. **Roundtrip**: some `assistant` transcript row from Phase A contains both
   codeword words (case-insensitive; allow punctuation between them). This
   proves voice → note_to_self → colleague tool use → chat reply → spoken
   answer, end to end.
2. **Reconnect memory**: some `assistant` row appended during Phase B repeats
   both codeword words. (Phase B is a fresh provider session; only the
   transcript recap can tell it the codeword.)
3. **One colleague, on its own stream**: the stream
   `/agents/voice-notes/voice/eval-<stamp>` has exactly one
   `events.iterate.com/agent/created`, and the voice stream
   `/agents/voice/eval-<stamp>` has **zero** — no rogue agent minted on the
   call.
4. **Clean run**: every Phase A `voice-board.ts` run exits 0; its verdict is
   the words the device said back.

Include the transcript output and both stream URLs in the result. Timing
note: the colleague's first turn takes 60–120 s in prod; keep nudging
through it. If Phase A fails only because the reply had not arrived before
the run ended, rerun Phase A once with more nudges before calling it a
failure.
