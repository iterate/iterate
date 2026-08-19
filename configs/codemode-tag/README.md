# codemode-tag project configuration

The `<codemode>` response-format experiment, implemented entirely in this
repo. Web agents in a project born from this template respond with markdown
plus one embedded tag instead of a bare ```ts fence:

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

The platform's one agent processor does turn scheduling and the LLM call and
interprets nothing; every project's config worker authors its agents' births
and decides what responses mean. `worker.ts` here is both:

1. On each agent's birth (`agent/created`), it appends the platform's default
   birth events (`itx.agents.get(path).getDefaultBirthEvents({ kind })`),
   supersedes the prompt slot with `prompts/agent-system-prompt.md` for WEB
   agents, and appends `agent/birth-finalized` — the agent processor holds the
   agent's first turn until that finalize (with a ~10s platform deadline
   behind it).
2. It injects `AGENTS.md` as standing context and re-syncs it — and the
   codemode prompt — on every config-repo commit.
3. On web agents' assistant output events (stamped by the agent processor), it parses
   the tag (`codemode-format.ts`) and appends the consequences: the script
   request, the prose as a chat message (marked so it isn't mirrored back
   into history), the status as `agent/summary-updated`, or corrective
   feedback for malformed/multiple tags. This is the VENDORED-interpreter
   path — the platform's `interpretResponse` service is deliberately not
   consulted for web agents; pinning a format means owning its interpreter.
4. On web agents' script settlements, it renders the result back as
   developer context — which is what triggers the agent's next turn.
5. Integration agents (slack/telegram/email), MCP sessions, and onboarding
   keep the platform-default personalities and delegate to the platform
   interpreter (`itx.agents.get(path).interpretResponse(event)`) — the
   codemode grammar is a web experiment.

Everything is public stream events any project member could append; no
platform privileges are involved. **Iterating on the format — prompt, grammar,
rendering — is a commit to this repo. No platform deploy.**

## Known limits

- Slash commands (`/example`, `/script`) are platform interpretation and are
  inert on web agents here.
- Stream errors are not transcribed into web agents' model context (the
  platform interpreter does that for the delegated agents).
- Idempotency keys mirror the platform interpreter's (`agent/` namespace), so
  historical streams interpreted by both converge instead of double-executing.

## Switching an existing project to this template

There is no first-class "re-template" door yet (`configRepoTemplate` applies
at creation; `cli config-repo reset` targets only the default template). The
wholesale switch is a commit: overwrite `/repos/config` with this template's
files (one multi-file workspace commit — delete what the old config had,
write these). The commit auto-redeploys the project worker; existing agents
keep their current personalities until the next config-repo commit's prompt
sync supersedes their prompt slots, and new agents are born straight into
the codemode format.
