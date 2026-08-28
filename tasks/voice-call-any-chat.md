---
status: in-progress
size: large
base: mobile-voice-client
---

# Call any chat: per-chat voice lines, spoken status, the conversation on a real stream

Builds on the mobile voice client (PR #2537) and the per-stream colleague
(PR #2536). Misha's brief, verbatim in spirit:

1. an *actual stream* for the frontend conversation
2. the frontend should read out the backend's status-whispers — with
   judgement, short, truthful, non-annoying; if the answer lands mid-status
   it just says the answer right after
3. a phone button on every chat in the mobile app — call any chat, in
   frontend-backend mode
4. the frontend should know both the *general* phase (writing code, running
   code, llm-requesting — the #2543 vocabulary) and the *specific*
   agent-set status (`summary-updated` activity), always concise

## Status summary

Implemented, unit-tested (88 facet + 191 mobile tests green), and
live-proven against prd: the e2e calls a chat on voicelab-eval (template
19.0.0), gets answered, and the conversation lands on the chat's stream as
`[voice call]` context items (21s round trip). Mid-flight, #2536 merged to
main carrying its own final 18.0.0 (colleagueStatus.failure on the fold,
follow-up race guards, note dedupe) — this branch was rebuilt on the
rebased base and the facet changes renumbered **19.0.0**. Templates
upgraded on voicelab-eval, misha, iterate. Remaining: the morning
on-device box below (pure-JS app change, OTA-able).

## Decisions (my calls, flagged where they're guesses)

- **"Actual stream" (ask 1) is delivered twice over, on the platform's
  grain**:
  - Calling a chat gives the call its own real stream per chat —
    `/agents/voice/chat/<chat suffix>` — instead of everything sharing the
    per-device line.
  - The frontend conversation is *forwarded onto the colleague's stream* as
    model-visible context: a copy-to-stream subscription on the voice
    stream transforms `utterance-transcript`/`answer-transcript` into
    `agents/context-added` (role `developer`, actor `{type: "agent", path:
    <voice stream>}`, `dont-trigger-request`). The backend can now *read*
    the call instead of being briefed second-hand, the chat thread keeps a
    durable record of what was said, and a later text conversation
    continues from the call. _Guess flagged: Misha may have meant only a
    live transcript UI; that is included too (the call sheet grows a
    scrollable live transcript fed by the durable events), so both readings
    are covered._
- **Phone button = chat header** (ask 3). One call at a time app-wide (a
  phone). The chat screen's header gets a call icon; the in-call sheet is
  the existing global overlay one. "Frontend-backend mode somehow" =
  certificate gains `colleaguePath` (facet 18.0.0): when set, the facet
  uses THAT agent as its colleague instead of minting
  `/agents/voice-notes/...`. The chat agent is briefed (idempotent, keyed
  context item) that a voice frontend exists and replies must be speakable.
- **The colleague link is established at call time, not first-note time**:
  `#ensureColleagueLink` runs when the call starts AND before the first
  note, so the transcript flows to the chat even if `note_to_self` is
  never called.
- **Spoken status (asks 2+4)**: the whisper becomes a *combined* line from
  the folded status — `[backend status: <phase> — <activity>]` — so the
  model always knows both the lifecycle phase and the agent's own words.
  On a *newsworthy* status (activity change or failure, never bare phase
  churn), when the floor is free and ≥15s since the last spoken status,
  the facet issues one `response.create` so the frontend can say a short
  line ("it's running the code now") without being asked.
  FAST_HALF_INSTRUCTIONS gains: status utterances are ONE short sentence,
  ground-truth only, and skip the commentary if there's nothing new.
- **Answer-after-status chaining (ask 2)**: a colleague note that lands
  while an answer is streaming used to wait for the person's next press;
  now it sets a pending flag and the facet issues `response.create` at
  `response.done`, so "it's running the code" is followed straight by the
  answer.
- **Per-chat path is NOT per-device** — the chat's one phone line; two
  devices calling the same chat share history (and can't call
  concurrently, same as one voice stream ever could).
- **Forwarded turns use role `developer`, not `user`**, deliberately:
  user-role context items participate in turn accounting (queued/working
  UI) and must not — a call transcript is testimony, not a prompt.

## Checklist

- [x] Facet 18.0.0: `colleaguePath` on the certificate (state, configured
      schema, SetupVoiceAgentOptions, fold) _voice-agent.ts; certificate wins over the derived `/agents/voice-notes/...` path_
- [x] Facet: extract `#ensureColleagueLink` (create + status subscription +
      brief + config), call it at call start and note dispatch _memoized promise, reset on failure; debounce config skipped for an existing chat_
- [x] Facet: transcript forwarding subscription (voice stream → colleague
      stream, `context-added`, dont-trigger-request) _moved to setupVoiceAgent's batch after a live incident: the facet-side append was refused (prd rejects `filter.condition` — schema drift) and the swallowed error also ate the brief; setup surfaces refusals_
- [x] Facet: combined phase+activity whisper from folded state _"[backend status: running code — Sweeping March refunds]"_
- [x] Facet: spoken-status `response.create` (newsworthy + floor-free +
      throttled) + instruction text for judgement/concision _15s gap, newsworthy = activity change or failure, never phase churn, `quiet` for the note-dispatch echo_
- [x] Facet: note-at-response.done chaining _`pendingNoteResponse` drained at the response.done arm_
- [x] Facet unit tests (voice-agent.test.ts fake-provider harness) _88 green, 3 new: spoken-status discipline, note chaining, colleaguePath link_
- [x] Mobile: `chatVoiceStreamPath` + per-chat setup config (marker hashes
      config incl. colleaguePath) _voice-setup.ts, marker v4_
- [x] Mobile: phone button in the chat header starting a call against the
      chat-derived stream _VoiceCallChatButton in chat.tsx headerRight; reopens the sheet while any call is live_
- [x] Mobile: call sheet transcript — live scrollable feed of
      utterance/answer transcripts + notes + statuses over the durable
      events _CallTranscript in voice-call-button.tsx over useLiveEvents; pure `transcriptItems` derivation_
- [x] Mobile unit tests (voice-setup, transcript feed derivation) _191 green across apps/mobile/src/lib_
- [x] Live e2e: extend voice-roundtrip to assert transcript context items
      land on the colleague stream _passed against prd voicelab-eval in 13s: answer audio + both speakers as `[voice call]` items on the chat_
- [x] Auto-install the voice template on first call (Misha's PR comment,
      live from his phone) _voice-setup.ts `ensureVoiceAgentInstalled` + lint-codegen-embedded template (voice-template.generated.ts); absent-only, never a downgrade; ring covers the install_
- [ ] Morning: on-device — call a chat from its header, watch the chat
      thread fill with the call, hear a status line mid-task

## Out of scope

Android; web dashboard call button; multiple simultaneous calls; ending the
colleague-brief context item when a chat "stops being" a voice backend;
migrating existing per-device streams to chat lines; barge-in tuning.

## Implementation log

- Stack refreshed first: main (with #2543) merged → voice-colleague-per-stream
  (12db13fba) → mobile-voice-client (19d742c4a); this branch starts there.
- Live incident during the e2e: the first cut installed the transcript
  subscription from the facet (processEvent → withProject → append to its
  own stream). prd refused the payload — `filter.condition` is not in the
  deployed subscription schema yet — and because the whole link ran in one
  swallowed-catch closure, the colleague brief silently died with it. Two
  fixes: the subscription moved into setupVoiceAgent's batch (a refusal is
  now a failed setup, loudly), and the `condition` was dropped (both
  transcript append sites already skip empty turns).
- prd templates upgraded (finally at 19.0.0): voicelab-eval (e2e home), misha,
  iterate — same routine as the 17.0.0 upgrades in #2537.
- The debounce-250 append observed on chats comes from the platform config
  worker's own done-configuring signal; the facet's gate (never rewrite an
  existing chat's config) is correct and unit-tested.
- Mid-implementation, #2536 merged to main; GitHub force-rebased
  mobile-voice-client and #2537 retargeted to main. Its final squash
  carried a competing 18.0.0 (failure on the fold, !followUpResponsePending
  guards, note-offset dedupe). Rebuilt this branch by cherry-picking onto
  the rebased base; the two 18.0.0s merged semantically (whisper now reads
  the FOLDED failure; the spoken-status gate adopts the race guard) and
  this work became 19.0.0. Force-with-lease push — the stacked-PR reapply
  playbook, nobody had built on this branch.
- Misha tested live from his phone mid-bedtime and asked (PR comment) for
  template auto-install instead of the "needs setup" dead-end — done via a
  codegen-embedded copy of configs/voice-agent committed on first call.
  Two parser-stack overflows found on the way: a 5600-term string `+`
  chain broke both esbuild and oxlint; the generated module now emits a
  flat array join.
