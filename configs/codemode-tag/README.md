# codemode-tag project configuration

The `<codemode>` response-format experiment, implemented entirely in this
repo. Agents in a project born from this template respond with markdown plus
one embedded tag instead of a bare ```ts fence:

```
Good question! Let me look into it.

<codemode status="Checking your files">
const foo = await itx.doWhatever()
return { abc: foo.bar }
</codemode>
```

- markdown outside the tag → delivered to chat as the agent's message
- `status="..."` → the live activity label while the code runs
- tag body → runs as an itx script; the return value drives the next turn

## How it works

The platform runs each agent under its **headless** processor — turn
scheduling and the LLM call, with no response interpretation. `worker.ts`
here is the interpreter:

1. On each agent's birth (and, after every config deploy, for every existing
   agent), it hands the stream to the headless processor. Hosted-processor
   subscriptions cannot be removed, so the handover is ADDITIVE: subscribe
   the `agent-headless` name, then flip the agent's `config.driver` knob —
   the platform guarantees exactly one of the two subscribed processors acts,
   selected by that knob. Reversible by flipping the knob back.
2. It supersedes each agent's keyed system-prompt slot with
   `prompts/agent-system-prompt.md`, and injects `AGENTS.md` as standing
   context, re-syncing both on every config-repo commit.
3. On assistant output events (stamped by the headless processor), it parses
   the tag (`codemode-format.ts`) and appends the consequences: the script
   request, the prose as a chat message (marked so it isn't mirrored back
   into history), the status as `agent/summary-updated`, or corrective
   feedback for malformed/multiple tags.
4. On script settlements, it renders the result back as developer context —
   which is what triggers the agent's next turn.

Everything is public stream events any project member could append; no
platform privileges are involved. **Iterating on the format — prompt, grammar,
rendering — is a commit to this repo. No platform deploy.**

## Known limits

- Delivery to the config worker is observation-grade: an event the handler
  fails on is skipped, not retried forever, so a dropped delivery quietly
  kills that turn (a new message starts fresh). If the experiment graduates,
  the promotion path is a real hosted stream processor (`createProcessorHost`)
  or platformizing the proven format.
- First-turn race, mitigated: a new chat's first message reliably beats the
  worker's birth handover, so the worker interrupts the racing classic turn
  and lets the interrupt re-run it under the headless driver — first replies
  arrive a beat slower but in the right format. The wider window is project
  birth itself: until the config worker's FIRST deploy finishes, deliveries
  to it are skipped (not retried), and the `project/worker-updated` sweep is
  what converts any agents created in that window.
- Slash commands (`/example`, `/script`) are platform interpretation and are
  inert here.
- Web agents only: slack/telegram/email agent paths are excluded from the
  retarget and keep the classic fenced format.

## Switching an existing project to this template

There is no first-class "re-template" door yet (`configRepoTemplate` applies
at creation; `cli config-repo reset` targets only the default template). The
wholesale switch is a commit: overwrite `/repos/config` with this template's
files (one multi-file workspace commit — delete what the old config had,
write these). The commit auto-redeploys the project worker, whose
`project/worker-updated` sweep then hands every existing agent to the
headless driver and syncs the prompt. The driver flip waits for each agent to
go idle (no open request, no running script, no pending trigger) and retries
on settle events, so in-flight fenced turns genuinely finish under the old
rules; the next turn speaks `<codemode>`. A message racing into the gap
between the idle check and the flip commit can still double-dial one turn —
accepted experiment caveat; a platform-side adopt guard would close it.
