# Intermittent Project.create timeout on a settled preview

Status: captured, not fixed. A new project stalled before sandbox creation on a
Worker that had been serving unchanged code for almost eight minutes. Agent
smoke passed both before and after. This surfaced during the lease-cycling
experiment, but the affected slot had not been deleted or redeployed.

- [x] Capture the failing public operation and correlate logs/spans. *`Project.create`, call `log_55c9a4c3820f4649b7dea934fcc9e0bf`; 91.849s, with a 90s wait for offset 8.*
- [ ] Reproduce repeatedly through ordinary project creation and narrow which birth dependency stalls.
- [ ] Inspect project bootstrap wake/append behavior and fix with an appropriate regression test.

Source: main `97ffd6fd65` (#2712), os-preview-15 version
`693c79f1-7a8e-4fb7-ab7c-b74e8b194490`. The failed operation ran
2026-09-18 19:42:45.438–19:44:17.287 UTC (LHR). No code-update reset is
established by this evidence. Error: `waitUntilProcessed timed out after
90000ms waiting for offset 8`.

[Exact trace](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/d0fa526e8becab728d358700de575b62).
The correlated `itx_rpc` wide log records outcome=error. The matching custom
span also records itx.outcome=error, despite its presentation message ending
in OK. A general trace query hit the 2,000-event cap; a targeted
`create-timing.` query returned 98 custom spans, including 90s
wait-project-birth/wait-project-created and repeated birth-dependency appends.
The observations do not establish the underlying cause.

Start at `apps/os/src/domains/projects/project-processor-implementation.ts`
and its birth waits. The observed sandbox probe did not reach container startup,
so this is not evidence of broken container recreation.

Repro surface: `experiments/preview-lease-cycling/sandbox.ts` (first action is
normal `root.projects.get(uniqueSlug).create({})`), or the ordinary agent-smoke
script's identical project creation. Raw evidence is local-only under
`experiments/preview-lease-cycling/evidence.ignoreme/sept18/`, notably
`correlation.json`, `trace-custom.json`, and the preview-15 smoke logs.

Session: Codex `01a0b054-bdd8-7d52-9c01-30d9b92576c8`.
