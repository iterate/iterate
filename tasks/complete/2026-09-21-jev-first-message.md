status: complete
size: small

# First-message Jev documentation experiment

Complete: a new userland template handles only the first message, then restores
250ms. Live preview proves successful injection and the one-second deadline.
No core changes; the earlier experiment remains untouched.

## Request and decisions

- Base: `origin/main` at `a5937744d9`; branch `experiment/jev-first-message`.
- On agent creation, lower the existing 60-second birth debounce to one second.
- For the first incoming message only, select Iterate API docs/examples with
  Cloudflare `typesafe/jev`; inject timely results as ordinary context.
- Restore the ordinary 250ms debounce on success, failure or deadline. Later
  messages never wait for or rerun Jev. Ignore late results.
- Best effort: the first answering request can proceed without docs after one
  second. Include delivery/search/fetch overhead in that deadline where possible.
- Record selection status, sources and timing in project-owned stream events.
- Keep the earlier branch intact. Commit/push this worktree. Originally no PR;
  the user subsequently requested a draft PR on 21 September. Deploy and prove
  this implementation on a leased preview without the earlier core hook.

## Checklist

- [x] Create a fresh worktree and commit the specification. *Separate branch from current main; earlier implementation remains available for comparison.*
- [x] Write a failing behavioral test using the real agent processor and template. *`jev-first-message.test.ts` first failed with no answering request at 250ms; the template now injects context before releasing it.*
- [x] Implement first-message-only selection entirely in userland. *`configs/jev-docs/worker.ts` uses existing config/context events and durable project-owned markers; core files and contracts are unchanged.*
- [x] Prove timely context, timeout/error fallback, late-result discard and 250ms later turns. *Nine focused tests also cover malformed output, no matches, replay and existing-agent exclusion.*
- [x] Run typechecks/lint and live e2e on a preview without core changes. *OS/templates typecheck, scoped lint and live e2e pass; preview-6 runs main plus the generated template catalog.*
- [x] Record evidence, complete task, commit and push; return compare and demo links. *Final evidence and links below; draft PR subsequently requested.*

## References

- Earlier experiment: `experiment/jev-doc-context` (no commits imported).
- Model API: https://developers.cloudflare.com/ai/models/typesafe/jev/
- Existing birth configuration: `configs/default/worker.ts`.
- Codex session: `01a0c535-0786-7a02-bc8e-6db66b7fb41a`.

## Implementation log

2026-09-21: User narrowed selection to the first message, explicitly permitting a
one-second best-effort budget and restoring 250ms for later requests. This removes
the requirement that led the earlier experiment to add a core callback.


The template records `jev-docs/started` and `jev-docs/settled` in the agent
stream. Timely context and the 250ms configuration commit atomically. A timed-out
promise can no longer append; subsequent messages skip selection using the
settled marker. Only agents carrying this template's birth marker participate.

The first live run with 25 candidates hit the deadline. Reduced the batch to
12 summaries; Jev still picks at most three docs scoring >=1.5/2. This trades
candidate recall for latency without extending the one-second budget. Keyword
search and text-only input remain the POC's retrieval limits. Context append
latency can race the normal timer near the cutoff; this is best effort, as
requested. Event delivery itself can consume the budget. A broken project
worker retains the existing birth/delivery recovery behavior.

## Validation and preview evidence

- Real AgentProcessor + actual template: 9 focused tests pass, including a
  hanging selector, late completion, malformed data, failure, no matches, replay,
  existing-agent exclusion and exact 250ms subsequent-turn scheduling.
- The full agent directory passed 243 tests plus one pre-existing expected
  failure before the final existing-agent guard; all 9 focused tests were rerun
  after that guard. OS TypeScript, every template typecheck, scoped oxlint and
  formatting pass.
- `itx-jev-first-message.e2e.test.ts` runs against a live deployment through the
  public API. Jev is real; only the answering model is intercepted to inspect
  its exact request. It supports both valid deadline outcomes without retries.
- Successful 12-candidate run: project `jev-first-mubnri8r-6132907d`, run
  `os-vitest-run-20260921-204842`; preparation 703ms (68ms delivery, Jev 508ms).
  Docs at offset 43 preceded request 47, which began 739ms after the message.
  Selected `files-roundtrip`, `workspace-files-transfer`, `chat-message-with-files`;
  usage 3317 input / 174 output tokens. A second message made no new selection.
- Final guarded-template run: project `jev-first-mubnu3os-f06f2288`, run
  `os-vitest-run-20260921-205043`; Jev missed the deadline and no docs were added.
  The request began after 1004ms. Both turns succeeded and restored 250ms. Root,
  config-repo and agent streams had no error or halted-delivery events; final
  processor state had no pending/open request or failures.
- Real answering-model demo: preparation 802ms, including 98ms delivery and
  525ms Jev; selected file-storage examples. It replied correctly, then settled
  with no pending/open request, active scripts, failures or stream errors. Its
  project now has the final guarded template installed.

OS deployment: `7290e1c4-0ed7-4126-ba5a-2ca9c79146db`.
Auth deployment: `b88051ab-218f-44f9-bd0f-c28ac4dc4668`.
Dashboard, event docs, API, JWKS and auth RPC smoke checks passed.
The runtime agent implementation is unchanged from base `a5937744d9`.

Run from `apps/os`:

```sh
doppler run --project os --config preview_6 -- pnpm e2e run e2e/vitest/itx-jev-first-message.e2e.test.ts
```

Logs: `/tmp/jev-first-e2e-final.log` (successful selection),
`/tmp/jev-first-e2e-verified.log` (final deadline proof),
`/tmp/jev-first-demo-final.json`, `/tmp/jev-first-demo-state.json`.
Final e2e artifacts: `/var/folders/3f/w1drdpds7ls_09vcg6981cwm0000gn/T/os-e2e-WlkBdV`.

## Try and review

[Sign in to preview](https://auth.iterate-preview-6.com/test-login?email=jev-first%2Btest%40nustom.com&project=jev-first-message&return_to=https%3A%2F%2Fos.iterate-preview-6.com%2Fapi%2Fiterate-auth%2Flogin),
then [open the demo](https://os.iterate-preview-6.com/projects/jev-first-message/agents/streams/agents/first-message-demo).
Create a new agent in that project to try first-message selection yourself.

Template source: `github:iterate/iterate#experiment/jev-first-message&path:configs/jev-docs`.
The manual preview uses the existing main SDK package (no PR package publication)
and installs the template through `repo.commitFiles`. Use the installed demo or
that explicit Git ref; the unpinned template picker assumes main, where this new
folder is not yet present.

[Compare branch](https://github.com/iterate/iterate/compare/main...experiment/jev-first-message).
The earlier branch `experiment/jev-doc-context` and preview-2 remain intact.

Preview-6 lease `47aac5a8-60eb-4006-a824-de9d2a404d26` expires
**22 September 2026, 02:44 BST** (01:44 UTC). To release early:

```sh
doppler run --project _shared --config prd -- pnpm preview release --slot 6 --lease-id 47aac5a8-60eb-4006-a824-de9d2a404d26
```

2026-09-21: User requested a draft PR with the preview sign-in/demo links and
instructions for triggering selection in a new agent. Full repository checks
are being run for opening; ongoing review/CI follow-up uses the global PR monitor.

Latency interpretation: TypeSafe documents parallel question evaluation. The
25-to-12 change reduced input size; these runs do not isolate question count as
the cause of the improvement. Recorded Jev timing includes the `itx.ai.run`
round trip, not just model inference.

PR-opening checks: repository-wide install, typecheck, lint, knip and format
passed. Full OS tests passed (3189 pass, 20 existing expected failures, 1
existing skip). The full recursive test command exited on one unhandled
`EnvironmentTeardownError: Closing rpc while "resolve" was pending` in the
unchanged os-next WebSocket test. That file passed all four tests in isolation;
OS was rerun separately to completion. This is disclosed in the draft body; no
test was skipped or timeout increased. Logs: `/tmp/jev-pr-test.log`,
`/tmp/jev-pr-os-test.log`, `/tmp/jev-pr-websocket-recheck.log`.
