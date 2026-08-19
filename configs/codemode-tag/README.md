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

The platform births every agent with default response parsing ON and a HIGH
debounce (10s) — that window exists exactly so a project's worker can shape
the agent before its first turn. `worker.ts` here is the interpreter:

1. On each agent's birth (`agent/created`), one atomic batch turns default
   parsing off (`config.interpretResponses: false`), supersedes the keyed
   system-prompt slot with `prompts/agent-system-prompt.md`, and lowers the
   debounce to the ordinary 250ms — the done-configuring signal, which
   releases a held first turn immediately.
2. It injects `AGENTS.md` as standing context, and re-syncs both it and the
   prompt on every config-repo commit.
3. On assistant output events (stamped by the agent processor), it parses
   the tag (`codemode-format.ts`) and appends the consequences: the script
   request, the prose as a chat message (marked so it isn't mirrored back
   into history), the status as `agent/summary-updated`, or corrective
   feedback for malformed/multiple tags. It interprets only agents whose
   parsing flag is off — with the flag on (a birth this worker was too slow
   for), the platform's own parser owns the turn.
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
- If this worker is down or slow past the 10s birth window, the agent
  answers with the platform's fenced-ts defaults — coherent, just not the
  codemode dialect — until the next deploy's `project/worker-updated` sweep
  converts it.
- Slash commands (`/example`, `/script`) are platform interpretation and are
  inert on converted agents.
- Web agents only: slack/telegram/email agent paths are excluded from the
  conversion and keep the classic fenced format.

## Switching an existing project to this template

There is no first-class "re-template" door yet (`configRepoTemplate` applies
at creation; `cli config-repo reset` targets only the default template). The
wholesale switch is a commit: overwrite `/repos/config` with this template's
files (one multi-file workspace commit — delete what the old config had,
write these). The commit auto-redeploys the project worker, whose
`project/worker-updated` sweep appends the parsing-off + debounce config to
every existing web agent and syncs the prompt behind it. A turn generated
under the fenced prompt but parsed by the codemode parser gets corrective
feedback and the loop recovers — accepted experiment caveat.
