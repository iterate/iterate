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

1. On each agent's birth subscription event, it hands the wake over to the
   headless processor: configure the `agent-headless` subscription, remove the
   `agent` one (subscription names are contract selectors; the handover is
   reversible by appending the mirror pair). Note: facet subscriptions are
   documented as platform-internal, so this userland append is the
   experiment's shakiest joint — if a deployment rejects it, the opt-in needs
   a small platform door instead.
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
- First-turn race: an agent's first turn can start under the classic
  processor before the retarget lands — that one turn uses the fenced format,
  then self-heals (shared idempotency keys make the handover dedupe).
- Slash commands (`/example`, `/script`) are platform interpretation and are
  inert here.
- Web agents only: slack/telegram/email agent paths are excluded from the
  retarget and keep the classic fenced format.
