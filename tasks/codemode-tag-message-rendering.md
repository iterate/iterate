---
status: in-progress
size: large
branch: codemode-tag-rendering
---

# Render codemode-tag agent messages properly (mobile + web)

**Status summary (2026-09-02):** design settled via plannotator grill (16
decisions below, one implementation amendment — see "Amendment" under the
design section); PR 1 (kernel + derivation + web) is functionally complete on
branch `codemode-tag-rendering` with unit/harness coverage and an e2e spec;
PR 2 (media cutover) and follow-ups queued.

## Design of record (settled 2026-09-02, plannotator grill)

1. **HTML vocabulary for message parts** — `<img width height alt>`,
   `<audio data-duration data-transcript>`, `<video poster width height>`,
   `<a type data-size>`, `<a href="geo:…">`. This is the AUTHORING/WIRE format
   (LLM-visible, portable); derived facts are the render model.
2. **`src` hydrates at the edge, not in storage** — stored parts reference by
   `data-path`; export mints fresh signed URLs; `files[]` stays durable truth.
3. **One parser, one seam** — the seam is the PROJECT'S DERIVATION PROCESSOR:
   the same parse that executes `<codemode>` emits the render-facts. Renderers
   never parse formats.
4. **No backcompat — one-shot cutover** ("as aggressively anti-backcompat as we
   can possibly get away with, even if it means old threads being hideous").
   The processor parses the NEW vocabulary only; old xml parts
   (`<attachment-dimensions>`, `<voice-note>`, `<user-location>`) get no
   derivation and fall to decision 9's raw fallback — old threads render raw
   and ugly, accepted. Client-side parsers for old parts are deleted as each
   surface moves onto facts. No dual-vocabulary period anywhere.
5. **Classification = fact derivation in project-space processors** — events
   are facts; processors parse facts and emit more factual events; renderers
   consume facts. The kernel's only schema opinion is the derived RENDERING
   vocabulary + the `source` link semantics — never any format. New format →
   new processor, zero renderer changes. Symmetric for user messages.
6. **Live streaming = incremental derivation over ephemeral events** — the
   derivation processor consumes ephemeral `agent/llm-response-chunks`
   (~150ms batches, memory-only, `includeEphemeral` opt-in) and emits
   ephemeral derived deltas (prose-delta vs script-delta + live status).
   Line-buffered streaming parser (tags sit on their own lines): flush
   complete lines, hold back at most one partial line.
7. **Script|Result|Meta tabs event-ified as light index facts** —
   render-critical fields + `source` only; heavy payloads (script text,
   results, prompts) are NOT copied — tab bodies dereference the raw events.
   Facts describe; raw carries.
8. **Liquid/post-`</codemode>` templated messages: out of scope** — parked in
   [codemode-liquid-templated-messages](codemode-liquid-templated-messages.md).
9. **The render vocabulary IS the feed — nothing "replaces" anything.**
   `render/message-said` is *the* event for an assistant message; raw
   `context-added` was never a feed item — it's derivation input + tab
   dereference target. Renderers fold `render/*` only. Raw renders solely as
   FALLBACK: a raw context-added that no render fact `source`s (legacy chat,
   no processor, failed derivation) renders as-is — this is also where
   decision 4 sends old-format threads. `source: {offset}` is a TOP-LEVEL
   event field — kernel envelope, so the kernel owns the link semantics
   generically.
10. **Settled render facts are DURABLE; ephemeral covers only the live
    window.** Ephemeral events never reach late subscribers — a freshly-opened
    chat replays durable history. `message-said` copies its prose text (small;
    makes the render vocabulary self-sufficient — feed renderers never fetch
    raw); heavy payloads stay dereferenced. Computed read-time views
    (retroactive parser fixes) noted as a future primitive, not a blocker.
11. **Feed ordering: render facts sort by `(source.offset ?? own offset, own
    offset)`** — facts anchor where their raw input sits, so
    backfill/re-derivation of old history lands in place instead of at the
    feed's bottom; siblings keep emission order.
12. **Vocabulary shape: structured typed fields per fact, not html-ish
    payloads** — `message-said {text}`, `script-requested {status, language}`,
    etc. HTML stays the authoring/wire format only; html payloads in facts
    would put a parser back inside renderers (violates decision 3).
13. **`<codemode>` stays a custom element** — the dump-principle governs
    message parts, not action syntax; raw code showing as text on the fallback
    path is honest. No format churn / re-prompting.
14. **Web first — including attachment parity** ("make sure web catches up to
    mobile on attachment-related features that we added recently"). The
    shared fold (`packages/ui` agent-ui-reducer) speaks the render vocabulary
    once; the dashboard grows rendering for the mobile-era attachment
    features: media mosaic, inline audio player + transcript, video
    thumbnails/fullscreen, location cards, file rows — driven by the same
    attachment facts. Mobile follows reusing the fixtures.
15. **Split PRs, hard cutover in the second** — "one go" means no dual-parse
    period, not one PR. PR 1 (kernel + codemode rendering + web) is
    reviewable alone; PR 2 stacks the media cutover.
16. **Prompting fixes are a prompt-only follow-up — with a barebones eval**:
    replay the captured failure scenarios against the template prompt and
    assert the output parses (codemode block present when work is intended,
    `return` present, no LaTeX/head-math, no pasted signed URLs, non-empty
    message).

### Reference example

```yaml
# offset 41 — raw model output (derivation input, tab dereference target — not a feed item)
type: events.iterate.com/agent/context-added
payload:
  role: assistant
  content: |
    Let me compute that.
    <codemode status="factorizing">
    return primeFactors(484214)
    </codemode>

# offset 57 — THE feed event for the message
type: events.iterate.com/render/message-said
source: { offset: 41 }
payload:
  text: "Let me compute that."

# offset 58 — THE feed event for the script card
type: events.iterate.com/render/script-requested
source: { offset: 41 }
payload:
  status: factorizing
  language: ts   # body not copied — Script tab dereferences offset 41
```

### Amendment discovered during implementation (2026-09-02)

The durable half of the approved render vocabulary ALREADY EXISTS as platform
events: `agents/web-message-sent` is the assistant-message fact (push
notifications, the turn loop, mobile chat, and read receipts all key off it),
`capability-host/script-run-requested`/`-settled` are the script facts, and
`agent/summary-updated` the live label. Emitting `render/message-said` etc.
alongside them would double-append every message. So the implementation keeps
the platform vocabulary for durable facts and adds the `source: {offset}`
envelope link to them (decision 9's mechanics, existing names); the only NEW
event types are the ephemeral live-window deltas (`render/message-delta`,
`render/script-delta`). `source` also turned out to already exist as a
top-level envelope object (`{processor?, copiedFrom?}`) — `offset` joined it
as a third member. Decisions 7/9/12 are satisfied in spirit; their letter
("new render/* durable types") is amended.

## Checklist

### PR 1 — kernel + codemode rendering + web (this branch)

- [x] Kernel: top-level `source: {offset}` envelope field on events.
      _Third member of the existing source envelope (packages/iterate
      processors/schemas.ts); mirrored in packages/ui stream-event.ts._
- [x] ~~Render vocabulary types (`render/message-said`, …)~~ _amended: durable
      facts ride existing platform events + source.offset; only the ephemeral
      deltas are new types (iterate/processors render-events.ts)._
- [x] Derivation processor in the codemode-tag template: line-buffered
      streaming parse of assistant output; ephemeral deltas while live;
      durable facts at settlement.
      _configs/codemode-tag/codemode-interpreter.ts — a hosted facet
      processor (at-least-once + keepalive, receives ephemeral chunks),
      replacing worker.ts's observation-grade push-lane interpretation.
      Harness tests incl. full replay in apps/os codemode-interpreter.test.ts._
- [x] agent-ui-reducer folds `render/*` deltas + marks steps interpreted via
      source.offset, raw stays as fallback for unsourced turns.
      _liveProse/liveScript on the llm step (volatile overlay only);
      markStepInterpretedBySource covers script-only turns._
- [x] Web dashboard: derived live window streams prose as prose and script
      as code with its status label; interpreted raw text no longer renders
      in the round body (Full trace keeps it reachable); bubbles/cards keep
      coming from web-message-sent / script-run events (amendment).
      _agent-feed.tsx LiveStepStream, agent-activity-rounds.tsx LlmOnlyRound._
- [x] Prose-only turns render as plain bubbles (the motivating mis-render).
      _Interpreted steps hide raw text; the web-message-sent bubble is the
      story. Covered by the e2e spec._
- [x] Empty assistant messages tolerated/skipped (session capture #2 item 5).
      _The interpreter emits nothing for an empty `none` outcome._
- [x] Specs (playwright).
      _specs/agent-codemode-tag-rendering.spec.ts — seeds a codemode-tag
      project (create door now pins canonical template refs to the
      deployment SHA, so previews test THIS branch's template) and asserts
      derived rendering with no raw tags. Preview-only until merge._

### PR 2 — media cutover (stacked, branch `codemode-media-cutover`)

**Vocabulary mapping** (old xml part → html part; each part sits alone on its
own line after the message text, filenames key into the event's `files[]`,
never a `src` — decision 2):

| Old | New |
| --- | --- |
| `<attachment filename width height />` | `<img alt="IMG.png" width="1200" height="900">` |
| `<voice-note filename duration-seconds transcript />` | `<audio data-filename="note.m4a" data-duration="7" data-transcript="…"></audio>` |
| (video: attachment + client thumbnail) | `<video data-filename="clip.mov" width height poster="clip.thumb.jpg" data-duration="12"></video>` |
| `[Files attached: …]` note | `<a type="application/pdf" data-size="9800000">report.pdf</a>` |
| `<user-location latitude longitude accuracy-meters captured-at />` | `<a href="geo:51.5,-0.13" data-accuracy-m="15" data-captured-at="…">Shared location</a>` |

**Derivation**: the codemode interpreter (already consuming
`agents/context-added`) gains a user-role branch: parse the html parts →
emit ONE durable `render/user-message-described { text, attachments: [...] }`
fact, `source: {offset}` → the raw user event. `text` is the message with
part lines stripped; `attachments` is the typed metadata (kind, filename,
width/height, duration, transcript, poster, geo, size, contentType). This is
the one NEW durable render type (the amendment's rule: platform vocabulary
carries facts that already exist; nothing existed for user attachments).

**Fold**: the reducer re-emits the user item (same `user-<sourceOffset>` id —
the feed projector upserts by id, the same lane settled activities update
through) with the derived text + attachments. No processor → the raw item
stands, html parts showing as text (decision 4: hideous, accepted).

**Web parity**: mosaic layout math (`apps/mobile/src/lib/mosaic-layout.ts`)
and waveform helpers are pure TS — move to packages/ui for reuse; new web
components render `item.attachments` (media mosaic, audio row + transcript,
video poster + playback, location card, file rows) with urls from `files[]`.

**Mobile**: presentation moves onto the fold's attachments;
`parseAttachmentDimensions` / `parseVoiceNoteTranscripts` /
`parseUserLocations` / `stripAttachmentXmlParts` and the xml emitters are
deleted (decision 4: no dual-parse period).

- [ ] render-events: `render/user-message-described` durable definition.
- [ ] Mobile composer emits html vocabulary from composer-attachments.ts; old
      xml part emission deleted; unit tests updated.
- [ ] Interpreter derives user-message-described (new vocabulary only);
      harness tests.
- [ ] Reducer folds it (item upsert by id + attachments field + schema
      mirrors + feed schema version bump); tests.
- [ ] Web attachment parity: mosaic, audio player + transcript, video
      poster/fullscreen, location cards, file rows.
- [ ] Mobile presentation from the fold; old client-side xml parsers deleted.
- [ ] Export transform: mint fresh signed `src` at the edge (decision 2) —
      may split out if the PR grows.
- [ ] Spec: attachment-bearing message renders derived (web).

### Follow-ups

- [ ] Template prompting fixes + barebones eval (decision 16; failures
      documented in session capture #2 below).
- [ ] Liquid-templated messages — separate task, needs grilling.

## Context

An experiment on preview-14 switched an agent to a new response format:
markdown prose with AT MOST ONE embedded `<codemode status="…">…</codemode>`
block, replacing the current "assistant context item IS the script"
convention. Thread (preview-14, evaporates with the slot):
`https://os.iterate-preview-14.com/projects/pr2554/streams/agents/mobile/2026-08-31t06-56-09-669z`

The renderers don't understand it. Observed on the mobile feed
(2026-08-31 screenshots):

- A plain-prose assistant reply under the new format ("hello! the
  codemode-tag format is now active in this chat.", offset 913) rendered as
  a CODE BLOCK inside the "1 request" activity card instead of an assistant
  bubble.
- Mixed prose+tag responses presumably render the raw `<codemode>` tag text
  wherever they do land.

Misha's caveat, verbatim: "The codemode-tag messages don't render properly
(which suggests to me we're handling things wrong but that's another
story)" — confirmed by the grill: classification moves out of client
reducers into fact derivation (decision 5).

## The format (full system-prompt section, captured from offset 902)

> HOW YOU ACT: respond with markdown, and embed AT MOST ONE `<codemode>`
> block when you want to run code:
>
> Good question! Let me look into it.
>
> \<codemode status="Checking your files"\>
> const foo = await itx.doWhatever()
> return { abc: foo.bar }
> \</codemode\>
>
> - Markdown OUTSIDE the tag is delivered to the user as your chat message
>   (chat renders markdown) — that is how you talk. Text inside the tag is
>   TypeScript statements (top-level `await` and `return` allowed); the
>   opening `<codemode ...>` and closing `</codemode>` must each sit alone
>   on their own line.
> - The `status` attribute is a short present-tense label ("Checking your
>   files", "Writing the report") shown live while your code runs. It IS
>   your activity label — you never append `activity` summary updates by
>   hand.
> - Whatever your code RETURNS (JSON-serializable) arrives as your next
>   input, and you get another turn to act on it. A thrown error arrives
>   the same way.
> - Multi-step work is one tag per response. A response with more than one
>   `<codemode>` tag — or an unclosed one — is rejected with feedback and
>   NOTHING runs.
> - To finish: write your final message with NO tag — prose alone ends your
>   turn.
> - Each script runs fresh — no variable survives between scripts.
> - `itx.chat.sendMessage("...")` still works INSIDE a script for mid-run
>   updates. After any sendMessage, an assistant-role item "The assistant
>   sent this visible web-chat message: …" lands in history as the delivery
>   receipt.
> - YOUR RESPONSE FORMAT is project code: this project's worker.ts parses
>   your `<codemode>` tags, and this prompt section lives at
>   `/repos/config/prompts/agent-system-prompt.md` — both editable with a
>   commit.

Old-format contrast (offset 874 in the same thread): assistant content is a
bare ` ```ts async (itx) => {…} ``` ` fence — what the current reducer
expects and renders as activity/code.

## Session capture #2 — prompting failures (thread 2026-08-31t07-41-39-965z)

Mostly UNRELATED to rendering: these are prompt-shaping gaps in the
codemode-tag format itself, captured verbatim before preview-14 tears the
thread down. Conversation: prime-factorise 484828, then voice-note
follow-ups ("put two sevens at the end", "add one more seven", "send me a
voice note back"). Now scoped as the decision-16 follow-up (prompt fixes +
barebones eval).

1. **Head-math with broken LaTeX, twice wrong** (offset 46): the model
   answered arithmetic from its head with mangled LaTeX (`\(484828 = 2^2
   \times 121207\)`, a `\boxed{}` with a literal `?` in it) and wrong
   factors — then produced a DIFFERENT wrong answer (2²×7×17×1019) before
   code revealed the truth (2²×61×1987). Prompt gaps: (a) arithmetic should
   reach for a codemode tag immediately; (b) chat renders markdown, not
   LaTeX — the format prompt never says so.

2. **Intent-prose silently ends the turn** (offset 206): user asked for a
   voice note back; the model replied "I can do that—I'll create a short
   audio reply." with NO tag — which, per the format, ENDS the turn. Nothing
   happened until the user prodded ("Well?"). The format's "prose alone ends
   your turn" rule needs a guard: never announce an action without the tag
   that performs it.

3. **Missing return stalls the loop** (offset 237): `await Promise.all([…,
   itx.docs.search(…)]).then(([, results]) => results)` as a bare
   expression — no `return`, so no result came back and the agent sat
   there. The user had to teach it (offset 250: "lol you need to return a
   value from these scripts in order to continue working!"). It then
   verbalised the lesson (offset 259) and fixed it (280). The prompt says
   returns drive the loop, but the failure mode (bare expression looks like
   a return) needs an explicit example.

4. **State carried by copy-paste, not return** (offset 327): to attach the
   generated audio it pasted a ~500-char presigned URL literal into the
   next script instead of returning/threading it — works, but exactly what
   "carry state by returning it" was meant to prevent; fragile if the URL
   had quoting-hostile characters.

5. **Empty assistant message** (offset 341): the turn after the
   sendMessage receipt appended an assistant context item with content ""
   — renderers should tolerate/skip empty messages, and the format should
   probably not emit them.

What went RIGHT, for balance: `<voice-note transcript>` user messages
(offsets 129/168/201) were understood perfectly — the agent acted on
transcripts ("add one more seven") without any transcription turn — and
the multi-step search→generate→send TTS chain worked once returns flowed.

## HTML vocabulary details (from the original decision sketch)

Principle, as Misha put it: "you could dump this html in a normal webpage and
it would render sanely." The invented part vocabulary already converged on
HTML by accident (`<attachment width height>` is `<img width height>`, whose
whole ancient purpose is layout reservation before bytes arrive, i.e. our
no-reflow mosaic fix):

| Kind       | Element                                            | Metadata home                                  |
| ---------- | -------------------------------------------------- | ---------------------------------------------- |
| Voice note | `<audio>`                                          | `data-duration`, `data-transcript`             |
| Image      | `<img>`                                            | `width`/`height` (native), `alt` for filename  |
| Video      | `<video>`                                          | `width`/`height`, `poster` (the thumbnail!), `data-duration` |
| File       | `<a type="application/pdf" data-size>name.pdf</a>` | anchor text = filename; `type` is real         |
| Location   | `<a href="geo:51.5,-0.13" data-accuracy-m="15">`   | `geo:` is a real URI scheme — a plain page gets a clickable maps link |

LLMs parse this vocabulary natively, and markdown legally embeds inline
HTML, so it composes with the codemode-tag format.

**Sanitization**: the web dashboard must never innerHTML message text —
user-typed `<img onerror=…>` lives in the same field. The derivation
processor allowlist-parses the tiny vocabulary into structured facts
(decision 12); renderers never touch html.

## Implementation log

- 2026-09-02: design grilled + approved via plannotator (12 revisions).
  Worktree `codemode-tag-rendering` created off origin/main (post-Cloudflare
  fixes #2566/#2567). Liquid templating split to its own task file.
