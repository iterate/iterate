---
status: ready
size: medium
---

# Render codemode-tag agent messages properly (mobile + web)

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
story)" — i.e. treat this as a possible architecture smell in how the
reducer classifies assistant output, not just a missing parser.

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

## Checklist

- [ ] Decide the classification seam: should the reducer
      (packages/ui agent-ui-reducer, shared by web + mobile via
      lib/feed.ts) parse `<codemode>` out of assistant context items, or
      should the platform split prose/tag into separate events upstream so
      renderers never see the tag? (Misha suspects current handling is
      wrong — consider the second.)
- [ ] Prose outside the tag → normal assistant bubble (markdown).
- [ ] Tag contents → the activity/code affordance, with the `status`
      attribute as the live activity label (replacing manual
      summary-updated appends).
- [ ] Prose-only responses (turn-ending) must render as plain bubbles —
      the current mis-render puts them in the activity card as code.
- [ ] Both renderers: web dashboard + mobile feed.
- [ ] Note: the format itself is project-configurable (worker.ts parses the
      tags per-project) — whatever the renderer does must degrade sanely
      for projects still on the old bare-script format.

## Session capture #2 — prompting failures (thread 2026-08-31t07-41-39-965z)

Mostly UNRELATED to rendering: these are prompt-shaping gaps in the
codemode-tag format itself, captured verbatim before preview-14 tears the
thread down. Conversation: prime-factorise 484828, then voice-note
follow-ups ("put two sevens at the end", "add one more seven", "send me a
voice note back").

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
