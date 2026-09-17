# Agents

A page to talk to a project's agents — apps/os's agent UI at the size os-next can carry today, on
the notes app's shape: one TanStack Start worker on its own origin (https://dash.iterate2.com), OAuth
through the platform (the issuer, https://os.iterate2.com), `/api` proxied with the session's bearer,
capnweb from the browser.

- `/agents?project=<id>&agent=<path>` — the project's agents (the catalog `itx.agents.list()`), one
  selected: its FEED, rendered from the stream's own events — a person's words with their attachments,
  the assistant's prose (`agents/web-message-sent`, markdown), a script card per `script-run-requested`
  with its status label, code and settlement, the breakers' pauses — and a one-line LIVE STATE strip
  from the agent facet's live snapshot (thinking · running a script · paused · idle), pushed as it changes.
- The composer sends `itx.agents.get(path).message({ message, files })` — words and, if you attach one,
  an image the model sees.
- "New agent" births one: `itx.agents.get(path).create({ systemPrompt })`.
- `/sessions` — every OAuth grant the signed-in user holds (browsers, connected apps, personal access
  tokens), each endable on its own, and where a personal access token is minted (the `account` scope).

Dev: `pnpm dev` (talks to the platform at https://os.iterate2.com; a gitignored `.dev.vars` with
`ITERATE_ORIGIN=http://localhost:8788` points it at a local os-next). Deploy: `doppler run --project agents
--config prd -- pnpm run deploy --env prd` → https://dash.iterate2.com (`.depot/workflows/deploy-agents.yml`
runs it on every push to main that touches the app or os-next).
