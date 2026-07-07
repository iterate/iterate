---
status: in-progress
size: medium
---

# fix-stream skill: turn a broken stream URL into a red test, then a green fix

## Status summary

Task fleshed out from a prompt; implementation not started yet. The diagnosis
of the trial-run stream is done (see log below). Main remaining pieces: write
the skill, write the failing repro test, fix, then the simplification pass.

## Goal

Make "fix <stream URL>" a repeatable workflow. Given e.g.
`https://os.iterate.com/projects/misha2/agents/streams/agents/1648`, an agent
should be able to:

1. Dump the stream's events (itx CLI, `--context <prj_id>`).
2. Use judgement to figure out the likely complaint (find where the
   conversation visibly went wrong for the user).
3. Seed the events into a test stream as a fixture, stopping just before the
   bad part.
4. Prime processor checkpoints so reduced state reflects the full seeded
   history but side effects only run for newly appended events (the
   "come into the chat halfway through" semantics — same as a DO restart with
   a checkpoint).
5. Append the bad event(s), drive the processors with a fake LLM transport
   that mimics the provider's real behaviour, and assert — appropriately
   broadly — that the turn does not go wrong (e.g. "the agent produces an
   assistant response").
6. Confirm the repro (test red), push, open a PR so CI shows red.
7. Fix, push, see it green.
8. Maintainability pass: revert the fix locally, simplify the seeded feed to
   the minimal prefix that still repros, confirm red again, push, unrevert,
   push.

Deliverables:

- [x] `.agents/skills/fix-stream/SKILL.md` — the skill, written caveman-style
      (mattpocock's caveman compression: terse, no filler, technical substance
      intact). _Committed; may still be updated after the trial run._
- [ ] Trial run of the skill against `/agents/1648` in project `misha2` (prd):
  - [x] Fixture: real events dumped from the stream (bulk payloads no
        processor consumes stripped at dump time; noted in the test).
        _`stream-repros/misha2-1648.events.json`, 338 events, 340K._
  - [x] Failing test committed + pushed (CI red) before the fix.
        _`stream-repros/misha2-1648-heic-image-silence.test.ts`; replay
        reproduces prod exactly, down to `llmRequestId: 3010` and the 400
        error chunk. Required extracting the in-memory harness from
        `agent-processors.test.ts` into `test-helpers.ts` (with a fix:
        MemoryStream.append now assigns `last offset + 1`, not `length + 1`,
        so gap-y seeded histories don't collide)._
  - [ ] Fix committed + pushed (CI green).
  - [ ] Simplification pass: revert fix locally → minimise feed → confirm
        still red → push → unrevert → push.

## Trial-run diagnosis (done during fleshing-out)

Stream `misha2 /agents/1648`, 3023 events. At offset 3008 the user sent
"Who's this" with an `image/heic` attachment (iPhone photo). The openai-ws
provider sent it to OpenAI as a native `input_image` part; OpenAI rejected the
whole request with a 400 ("The image data you provided does not represent a
valid image... supported: ['image/jpeg', 'image/png', 'image/gif',
'image/webp']"). The request completed with `status: "failure"` and the
conversation went silent — no retry, no user-visible error, nothing.

Root cause: `toResponsesInput` in
`apps/os/src/domains/agents/openai-ws-processor-implementation.ts` treats any
`image/*` attachment with an https URL as a native vision input. OpenAI only
supports jpeg/png/gif/webp. The codebase already has the intended fallback for
files a model can't ingest natively — `renderFileHintLine` ("never fail the
turn") — HEIC just isn't routed to it.

Planned fix: whitelist the OpenAI-supported image content types in
`toResponsesInput`; anything else falls through to the hint-line path.
(`cloudflare-ai-processor-implementation.ts` flattens all attachments to text
already, so no sibling fix needed.)

Broad assertion for the repro test: after the user's input lands, the agent
eventually appends `events.iterate.com/agent/output-added` (an assistant
response). Before the fix the LLM request fails and no output ever arrives.

## Assumptions made while fleshing out (user was AFK)

- "Appropriately broad" assertion = user-visible level ("agent responds"),
  not "no native input_image part in the request body" — the latter is the
  fix's mechanism, not the complaint.
- The failing-test repro lives in the unit lane
  (`apps/os/src/domains/agents/`), modeled on `agent-processors.test.ts`
  (MemoryStream + fake Responses WebSocket + checkpoint priming via
  `readState`), NOT the e2e lane — real LLMs are slow/expensive/flaky and the
  bug is deterministic at the transport boundary. The e2e harness needs no
  changes for this kind of test; the unit harness already supports
  come-in-halfway via checkpoint priming.
- Fixture shrink rules at dump time are fair game when the raw feed is huge
  (9.9MB here): drop event types no processor under test consumes
  (`llm-response-chunk`), strip bulky payload fields no reducer reads
  (`result.rawResponse`). Each shrink noted in the test file.
- The silent-failure gap itself (agent says nothing when an LLM request fails
  permanently) is a real product gap but a bigger design question
  (retry policy, poisoned-history loops); left out of scope — noted as
  follow-up.

## Implementation log

- 2026-07-07: dumped stream via
  `doppler run --project os --config prd -- pnpm --dir apps/os cli itx run
--context prj_e44b80bc88414d309a5aa5fb808fd962 --file dump-all.ts` (paged
  `getEvents` loop). Diagnosed HEIC/vision failure at offsets 3008–3014.
