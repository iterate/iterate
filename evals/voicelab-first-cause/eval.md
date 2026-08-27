# Voicelab first-cause: frontend knowledge, backend research, one conversation

A replay of a real conversation (prd, 2026-08-26 evening, stream
`/agents/voice/2608261852` on the `iterate` project — read-only evidence):
first a question the voice can answer from its own weights, then one that
needs the backend and the internet. The original run surfaced the ask()-lane
reply losses this eval now guards against: the backend's results arrived as
an unsolicited chat message and vanished, leaving the voice saying "the
status says results were delivered but I never received them".

## Setup

Same harness as `evals/voicelab-roundtrip` (read it first): project slug
`voicelab-eval`, everything from `apps/os` inside
`doppler run --config prd -- …`, utterances synthesized with
`say -o <file> --data-format=LEI16@16000 --channels=1 "<text>"`.

Utterances, in this order (the driver plays them sorted, cycling):

1. `01-first-cause.wav`: "Hi. Can you explain the first cause argument for
   God, briefly?"
2. `02-youtube.wav`: "Interesting. Now can you find me some recent YouTube
   debates about that argument?"
3. `03-nudge.wav`: "Any luck with those debates yet?"
4. `04-nudge.wav`: "Take your time. Anything new come in?"

Run on a fresh timestamped stream:

```
doppler run --config prd -- pnpm cli voicelab talk --project voicelab-eval \
  --stream-path /agents/voice/eval-cause-<stamp> --converse 5 \
  --utterance-dir <dir> --pretend-speaker <dir>/speaker.wav
```

## Success criteria (all must hold)

Read the stream's durable events (`pnpm cli voicelab transcript --json` for
the spoken record; `itx run` for `colleague-status` / `colleague-note`
events):

1. **Frontend handles knowledge itself**: an `answer-transcript` row after
   the first question explains the argument (mentions "cause"), and the
   FIRST `colleague-status` event on the stream comes at a higher offset
   than the `utterance-transcript` of the YouTube question — i.e. no note
   was sent for the knowledge question.
2. **Backend roundtrip**: at least one `colleague-note` event exists (the
   backend's chat messages now arrive as durable events — solicited or
   not), and an `answer-transcript` row after the first `colleague-note`
   relays research content (mentions "debate", case-insensitive).
3. **Statuses flowed**: the stream has a "picking up a note from the
   frontend" status and at least one lifecycle phase ("writing code" or
   "running code").
4. **Clean run**: `talk` exits 0, zero speaker sequence gaps, exactly one
   `agent/created` on the colleague stream
   (`/agents/voice-notes/voice/eval-cause-<stamp>`), zero on the voice
   stream.

Timing note: the backend's web research took ~2 minutes in the original
conversation; the 5-minute run with nudge utterances absorbs that. If the
run ends before any `colleague-note` arrives and the statuses show work
still mid-flight, rerun once with `--converse 7` before calling it a
failure.
