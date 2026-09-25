---
name: fix-stream
description: Turn a broken agent chat (an Agents app URL such as agents.iterate.com/projects/<slug>?agent=/agents/web/<moment>) into a red repro test seeded with the chat's real events, then a green fix, then a minimal fixture. Use when someone says "fix <agents url>", pastes an agent chat with a complaint, or reports an agent that went silent or wrong.
---

# fix-stream

An agent is a context whose log is its whole conversation. Dump that log, name the
complaint, seed the real events into a unit test, get it red for the right reason, fix, then
shrink the fixture.

## 1. Read the URL

| URL                                                                                | Deployment                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| `https://agents.iterate.com/projects/<slug>?agent=<path>`                          | prd (`agentsEnvs.prd` in `envs.ts`)             |
| `https://pr<n>-agents.iterate-dev-preview.workers.dev/projects/pr<n>?agent=<path>` | that PR's preview (its PR body lists the URLs)  |
| `http://localhost:<port>/projects/<slug>?agent=<path>`                             | `pnpm --dir apps/agents dev` against a local OS |

- `agent` is the context path, URL-encoded: `/agents/web/<moment>` for a chat started in
  the browser, `/agents/voice/<version>/<device>/<call>` for a voice call. With no `agent`,
  the page shows the first agent the project lists.
- `view=events` is the raw log and `event=<offset>` the inspected row. `llmRequest=<offset>`
  and `scriptExecution=<id>` open a trace sheet. Those offsets are where to look first.
- A Dash link (`dash.iterate.com/projects/<slug>`) names only the project. Ask for the
  Agents link, or list the agents (step 2) and match the time of the complaint.

## 2. Dump the log

Use a personal access token for the chat's project, as `ITERATE_BEARER_TOKEN`: the
person who reported the chat can mint one on the Dash's Sessions page, and if you are signed
in yourself, `pnpm exec iterate --config prd tokens create --name fix-stream --project <slug>`
prints one ([credentials](../../../apps/os/docs/credentials.md)). Keep it in the command's
environment and never print it. A key covers only projects its person belongs to. For a
project nobody at hand belongs to, use the deployment's operator bearer on `/api` instead:
`APP_CONFIG_ADMIN_API_SECRET` set to `secrets.adminBearer` from the `APP_CONFIG` of Doppler
`os/prd` (`os/preview` for any preview), in place of `ITERATE_BEARER_TOKEN` below
([acting as users and admins](../../../docs/dev-environments.md#acting-as-users-and-admins)).

Save this in your scratchpad as `dump-agent.js`, with the agent's path filled in:

```js
const agent = itx.cd("/agents/web/<moment>");
const events = [];
for (let after = 0; ;) {
  const page = await agent.readEvents(after, 500);
  events.push(...page.events);
  if (page.atHead || page.scannedThroughOffset <= after) break;
  after = page.scannedThroughOffset;
}
return JSON.stringify(events);
```

```sh
ITERATE_BEARER_TOKEN=itk_… \
  pnpm exec iterate --config prd itx run --project <slug> --file dump-agent.js > agent.json
```

For a preview, point a CLI config at it once
(`pnpm exec iterate config set --name pr<n> --os-base-url <preview os url>`) and use
`--config pr<n>`, with a key minted on that preview (or the `preview` Doppler config's operator
bearer). `--project` takes the slug or the `prj_` id.
To list the agents instead, run `--eval 'return await itx.agents.list()'`.

Run at the project root, which is the default `--context /`. Never pass
`--context <agent path>` for a dump. The run would be recorded in the agent's own log and
show up in its chat as a script run.

For a quick look with no JSON, use `apps/os/scripts/inspect-context.ts`. It prints one row per
event, with payloads cut to 200 characters, and then the subscription rows:

```sh
cd apps/os
WORKER_BASE_URL=https://os.iterate.com ITERATE_BEARER_TOKEN=itk_… \
  PROJECT=<slug> CTX_PATH=/agents/web/<moment> pnpm exec tsx scripts/inspect-context.ts
```

The dump holds durable events only. `agent/llm-response-frame` is ephemeral and is never
stored: the settled `agent/llm-request-settled` carries the text.

## 3. Name the complaint

Print the conversation with offsets and times before reading product code. Every type is
`events.iterate.com/…` (the contract is `apps/agents/runtime/contract.ts`):

- `agent/context-added`: the conversation. The `role` is `system`, `developer`, `user` or
  `assistant`. A user item's `actor.type` is `user`, `script` (a script's result) or `agent`.
  An assistant item carries `llmRequestOffset`.
- `agent/llm-request-requested` (`triggerOffset`) and `agent/llm-request-settled`
  (`requestOffset`, `result.status`): the model calls.
- `itx/run-requested` and `itx/run-settled`: the scripts the assistant's codemode ran.
  The UI renames them (`adaptContextRuns` in `apps/agents/src/lib/agent-events.ts`).
- `agent/web-message-sent`: what the person saw. `agent/paused` and `agent/resumed`: a breaker
  or an operator.
- `voice-agent/*`: a call's transcripts, delegations and commentary (`apps/agents/voice/`).
- Other `itx/*`: the context's own facts, such as wakes (`itx/woken`) and processor rows
  (`itx/subscription-configured`).

Find where the person lost: silence after their input, a wrong answer, an error leak, or a
chat that does not show what happened. Write the complaint down in the person's terms. A
provider error the loop recovered from is usually not the complaint.

## 4. Choose the layer and write the red test

Pick the narrowest layer that shows the complaint. Every layer here runs in node, with no
deployment and no real model.

| The complaint is about…                                               | Test next to                                                                                                           |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| what the chat shows (missing, duplicated or wrong rows)               | `apps/agents/src/lib/agent-events.test.ts`: `toAgentEvent` → `adaptContextRuns` → `reduceAgentFeed`, with real offsets |
| the reducer behind the agent UI                                       | `apps/agents/src/lib/events/agent-ui-reducer.test.ts`                                                                  |
| what the loop decides (a missing request, a stuck trigger, a breaker) | `apps/agents/runtime/processor.test.ts`: `reduceProcessor` rows                                                        |
| a voice call                                                          | `apps/agents/voice/*.test.ts` (see `agent.test.ts` and `screen-context-repro.json`)                                    |
| an effect: a model call, a script run, the birth or death sagas       | `apps/agents/e2e/agents.e2e.test.ts`, with a fake `itx.ai` lent by rule (commands in `apps/agents/README.md`)          |

- Save the dump as a JSON fixture beside the test, named for the complaint
  (`<complaint>.repro.json`, with the test in `<complaint>.repro.test.ts`). At dump time,
  drop only whole event types that no code under test reads, and note each one in the test.
- `reduceProcessor` numbers its inputs from 1, while the payloads name real offsets
  (`triggerOffset`, `requestOffset`, `llmRequestOffset`). Renumber consistently or cut to a
  window where the numbering matches. The feed layer keeps the real offsets.
- Assert the complaint in the person's terms, not the mechanism. For example: "the call's
  words show in the chat", not "`reduceAgentUi` handles `voice-agent/utterance-transcribed`".
  The mechanism is the fix.
- Fixtures from prd hold people's words. Commit only a chat its owner agreed to share, or
  replace the text with placeholders that still reproduce the problem.

## 5. Prove it is red for the right reason

`pnpm --dir apps/agents exec vitest run <file>` (or `packages/ui`'s). A failure only proves
something when its diff shows the prod symptom. To see everything, assert against a string,
for example `expect(items.map((i) => i.kind)).toEqual("SHOW ME")`, read the diff, then delete
that assertion. Commit the test and fixture, push, and open or update the PR as a draft so CI
shows the red. Put a before/after excerpt of the prod log in the PR body.

## 6. Fix, then shrink the fixture

1. Make the smallest product fix consistent with the design. Grep for an existing path first,
   because the gap is often routing, not missing machinery. Run the test green, then the
   package suite (`pnpm --dir apps/agents test`, or `packages/ui`'s). Push.
2. Shrink the fixture: revert the product file (`git checkout <red commit> -- <file>`), cut
   events, and confirm the test is still red. If it turns green, the cut removed the repro, so
   restore it. Keep the system item, the last complete turn before the bad part, and the bad
   events.
3. Commit the minimal red state, restore the fix, run it green, and commit.

End state: tens of events, not hundreds, in a test that reads top to bottom as seed, bad
event, assertion.

## Gotchas

- Reading an idle agent wakes its context, and the wake is logged as `itx/woken`. The chat
  shows every wake after the first as a "Stream durable object woke" row. Dump once and work
  from the file. Don't tell a wake that you caused apart from one in the complaint by guesswork:
  compare its timestamp with when you ran the dump.
- Keep idempotency keys in fixtures, because replay deduplicates on them.
- Seeded history can contain the event type you wait for, so scope assertions past the seed.
- Signed attachment URLs in a fixture expire. That is fine in node, where nothing fetches them.
