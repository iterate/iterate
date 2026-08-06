---
status: in-progress
size: small
branch: preamble-defensive-saves-audit
---

# Preamble follow-up: stop teaching defensive workspace saves

Third checklist item from `tasks/codemode-script-preamble-followups.md`. After
#2431 (scripts see a typed `results` array; large results get loaders), a
field-tested agent still did this:

```ts
const text = await response.text();
await itx.workspace.writeFile("sopranos-tvmaze-full.json", text);
return { status: response.status, bytes: text.length, body: JSON.parse(text) };
```

Neither the file nor the full-body return was needed. Audit what still teaches
save-then-read, fix the teaching.

## Assumptions (made while fleshing out, Misha AFK)

- The fix is teaching-only: prompt wording, example descriptions, tests. No
  runtime behavior changes.
- Prompt edits stay within the 4200-token ceiling budget
  (`agent-prompt-budgets.test.ts`); aim token-neutral by rewording the
  existing oversized-results bullet rather than adding one.
- The eval belongs to the sibling branch `preamble-results-eval` — none here.
- The workspace spill file keeps existing as a mechanism (a different
  follow-up item questions it); we only stop *teaching* it as the primary
  retention story.

## Audit findings

The proactive save wasn't taught by the settlement render (that text only
arrives AFTER an oversized result, and post-#2431 it already leads with
`results[0].load`). It was taught by three static surfaces that still tell a
file-centric retention story:

1. **`apps/os/src/domains/agents/agent-defaults.ts:208`** — the SHAPE OF WORK
   oversized-results bullet (pre-#2431 wording, not updated by that PR):
   "the FULL result is saved to a workspace file — the notice names the path;
   read it with `itx.workspace.readFile`". The system prompt itself teaches
   write-a-file-read-it-back as how big data survives turns, and never draws
   the implication of `results`: "so don't save copies". An agent expecting a
   big response mimics the platform: writes its own copy with a name it
   controls, and returns the full body in case the preview loses data.
   (#2431 rewrote only the fresh-scripts bullet at line 90 — which previously
   said "Carry state by returning it, messaging it, **or writing a file**".)
2. **`apps/os/src/itx/examples-source.ts` gmail example (~line 1511, 1522)** —
   docs corpus served by `itx.docs.search`: "an oversized return comes back as
   a typed preview **plus a spill file you read next turn**" — retrieval
   channel = file, loaders unmentioned.
3. **`apps/os/src/itx/examples-source.ts` files example (~line 1012)** — "Use
   it to save, keep, or persist data for later and remember state between
   runs" with no carve-out for script results: the top docs hit for
   save/keep/persist tells the agent saving is the way to keep data.

Also: nothing in the docs corpus mentions `results` at all — a docs.search
for how to reuse a previous result finds only file-based answers.

## Checklist

- [x] Audit the four suspect surfaces; write findings here with file:line refs
      _above — headline: the system prompt's own oversized-results bullet
      (agent-defaults.ts:208) still taught workspace-file+readFile as the
      retention mechanism and never said "don't save copies"_
- [ ] Reword the oversized-results bullet in `agent-defaults.ts` to lead with
      `results` retention + the no-defensive-copies implication; drop the
      readFile recipe; bump `DEFAULT_AGENT_SYSTEM_PROMPT_REVISION`
- [ ] Update the gmail example description + comment to name the loader, not
      the spill file
- [ ] Add the script-results carve-out to the files example description
- [ ] Teach the anti-pattern at the point of temptation: egress-fetch example
      description says return the data, never save a copy first
- [ ] Regenerate `examples.generated.ts` via `pnpm generate:itx-examples`
- [ ] Prompt-content test: default prompt teaches results retention and no
      longer contains the `itx.workspace.readFile` recipe
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test`

## Status summary

Audit complete (findings above); fixes not yet applied. Headline: the system
prompt itself (agent-defaults.ts:208) still taught the spill-file+readFile
retention story and never drew the "don't save copies" implication.

## Implementation log

- Worktree/branch `preamble-defensive-saves-audit` off origin/main
  (34c7de98a, the #2431 merge).
- Confirmed #2431 changed exactly one prompt line (the fresh-scripts bullet)
  and did NOT touch the oversized-results bullet — and did not bump
  `DEFAULT_AGENT_SYSTEM_PROMPT_REVISION` (stayed "9"); this branch bumps it
  to "10" alongside the wording change.
- Settlement render (`agent-processor-implementation.ts`
  renderScriptSettlement/renderOversizedJsonResult/rawTextSpillNotice) audited
  clean: post-#2431 it leads with the `results` recipe and mentions the spill
  path only parenthetically. No change needed there.
