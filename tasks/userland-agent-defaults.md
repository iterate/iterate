---
status: in-progress
size: large
base: codemode-tag-format (stacked on #2423)
---

# Userland-first agent defaults: birth batches as data, prompts out of platform code

## Context

When an agent is created on the iterate platform, the platform assembles its **birth batch** — an atomic set of events appended to the new agent's stream that define what the agent *is*: an existence marker, the system prompt, model configuration, standing context, and the subscriptions that attach its processors.

Today, almost everything in that batch is hardcoded in `apps/os/src/domains/agents/agent-defaults.ts`:

- A ~200-line `DEFAULT_AGENT_SYSTEM_PROMPT` string constant, plus separate prompt variants for Slack, Telegram, and email agents.
- Five manually-bumped revision constants (`DEFAULT_AGENT_SYSTEM_PROMPT_REVISION = "9"` etc.) that must be incremented whenever prompt content changes, or idempotency keys silently collide.
- Model selection, a boot-context blob, workspace instructions — all string constants.

Changing any of it requires a platform deploy. Meanwhile the platform *also* ships a default config-repo template (`configs/default/`, codegen'd into the OS worker as `PROJECT_REPO_INITIAL_FILES`) — so "what a default agent is" effectively lives in two places: once as code, once as data, and they must be kept in agreement by hand.

The codemode experiment (#2423) pushed against this: it needed a project to choose its agents' prompt, response format, and driving processor from userland. The mechanism that made that possible is a project-stream event (`project/agent-birth-defaults-configured`) that the agent-creation door reads and folds into every birth batch. But its current payload is a narrow, hand-picked set of fields — an agent config patch, a system prompt, a list of extra processor subscriptions — each with its own schema entry and its own special-cased plumbing in the birth-batch builder. Every *future* thing a project might want to default (a different boot context, a standing capability, another context item) would mean another field and another builder branch. That's the growth pattern this refactor kills.

**The principle: the event vocabulary is the platform; everything opinion-shaped is data a project owns.** The platform ships mechanism — processors, the capability host, event schemas, the creation door, safety rails. Prompts, model choices, formats, and which processor drives an agent are files in a config repo. The "default experience" is nothing more special than the default template. Precedence collapses to one sentence: *explicit call-site events > project birth events > embedded-template birth events*.

## The refactor

### 1. Birth defaults become "a list of birth events", not a field bag

Replace the current defaults payload with the general form:

```ts
// project/agent-birth-defaults-configured — appended by the project's config
// worker to the project root stream; latest occurrence wins per `matches` key
{
  matches?: { pathPrefix?: string },   // default: agents born through the generic door
  birthEvents: Array<{ type: string; payload: unknown }>,
}
```

A prompt is then just a keyed `agents/context-added`. A driver choice is just an `agent/configured`. A processor attachment is just a `stream/subscription-configured`. Nothing needs per-field plumbing, and the next defaultable thing needs zero platform changes.

Guard rails, since this is userland data reaching a platform-assembled batch:

- **Validated at fold time** in the project processor: every event must parse against the agent-consumed vocabulary (`AgentProcessorContract.parseConsumedInput`), except an allowlist of platform-lane items — `stream/subscription-configured` with a `facet-processor` receiver whose name is a registered agent-family slug. Malformed defaults fold to nothing plus a warning; agent creation is never breakable from userland.
- **Idempotency keys are platform-minted** (`agent/birth-defaults:<contentHash>:<index>:<projectId>:<agentPath>`): content rides the key — the established pattern for replay-safe supersession — so projects can't wedge creates with hand-rolled keys.
- **Stored as a fold, not a scan**: the project processor's contract gains the consumed event and a `state.agentBirthDefaults` slot; the creation door reads the processor snapshot. (The current implementation pages the raw stream for the latest event of the type — delete that.)

The codemode template is the only current producer; migrate its `#publishAgentBirthDefaults` to the list form in the same PR. No compatibility shim — the old shape is an unreleased experiment surface.

### 2. The default prompt gets ONE home: the template

Move the text of `DEFAULT_AGENT_SYSTEM_PROMPT` to **`configs/default/prompts/agent-system-prompt.md`**, and delete the constant plus its revision. Two consumers, one source:

- **Build-time fallback**: the platform reads the file out of `PROJECT_REPO_INITIAL_FILES` — the exact mechanism `ONBOARDING.md` already uses to feed the onboarding prompt (`agent-defaults.ts:292,409`). Occurrence identity becomes a content hash, retiring the manual revision constants.
- **Runtime publishing**: `configs/default/worker.ts` publishes the prompt as a birth event on `project/worker-updated`, the same way the codemode template does. Editing the prompt file in a live project's config repo therefore updates that project's future agents with a git commit and **zero platform involvement** — while fresh projects and the bootstrap window get identical text from the embedded fallback.

Channel prompts follow the same road: `configs/default/prompts/{slack,telegram,email}.md`, with `slackAgentSystemPrompt` and friends becoming thin interpolators (they inject per-connection facts into template text). Routers keep passing explicit `systemPromptPolicy`, so their precedence over project defaults is unchanged.

Two facts (verified) make this safe:

- The blocking project-create lane probes the config worker for readiness *before* committing `project/created`, and the first `project/worker-updated` lands in the same batch — so a project's own defaults exist one delivery-hop after creation. The embedded fallback covers that hop (the UI's fast path can drive the onboarding agent inside it).
- The turn loop already **holds turns until the canonical prompt slot exists** (`agent-turn-loop.ts:226-243`, indefinite). With a fallback prompt always present in the birth batch, that gate never holds in practice, and it needs no change.

The prompt-budget test moves to reading the template file — the ceiling still gates the default experience. Userland prompts instead get a best-effort publish-time token-count warning computed by the template worker on commit.

### Deliberately left alone

- **Boot context** stays platform-side: it's per-agent *facts* (paths, project id) requiring interpolation, not opinion. Splitting its embedded advice-strings out is a later refinement.
- **MCP/onboarding prompts**: already direct context appends sourcing template content; no change.
- Per-channel project overrides (`matches.channel`), `config-repo reset --template <ref>`, and retiring `systemPromptPolicy` from routers: follow-ups once this settles.

Sequencing: builds on #2423's defaults event and headless processor — a follow-up PR after #2423 merges (or stacked on it if review stalls).

## Critical files

- `apps/os/src/domains/agents/agent-defaults.ts` — schema swap, builder collapse, prompt-constant deletion, fallback-from-template
- `apps/os/src/domains/projects/project-processor-contract.ts` + `project-processor-implementation.ts` — the defaults fold
- `apps/os/src/rpc-targets.ts` — snapshot read replaces the raw-event scan
- `configs/default/prompts/*` (new) + `configs/default/worker.ts` — publish defaults; `configs/codemode-tag/worker.ts` — migrate to the list form
- `apps/os/src/domains/repos/config-repo-template.codegen.cjs` — no change (already walks `configs/default/`); regenerate the checked-in output
- `apps/os/src/domains/integrations/{slack,telegram}-processor-implementation.ts`, `apps/os/src/domains/email/email-processor-implementation.ts` — prompts become template-backed interpolators

## Verification

- Unit: birth-list folding, allowlist rejection, prompt supersession, and key determinism in `agent-defaults.test.ts`; defaults-fold specs on the project processor; the prompt-budget test against the template file.
- **Acceptance bar**: with no project defaults present, birth batches are byte-identical to today's — `agent-processor.test.ts` and `agent-headless-processor.test.ts` pass unmodified.
- Live on a preview slot: create a default-template project → first turn identical to today; edit the project's prompt file and commit → new agents carry it at birth, no deploy; re-run the codemode end-to-end smoke on the migrated list form.

## Risks

- The fold-time allowlist is the security-relevant surface (userland must not smuggle events outside the agent vocabulary into a platform-assembled batch); the parse + explicit subscription allowlist is the whole defense — test it directly.
- Deleting a project's prompt file degrades to the embedded fallback, never to promptless (the codemode template already implements this rule).
- The embedded fallback and a project's live file *can* drift — by design (projects fork on purpose); the codegen lint keeps the embedded copy itself honest.


## Checklist

- [ ] project processor: consume `project/agent-birth-defaults-configured` (list form), fold into `state.agentBirthDefaults` with parse/allowlist validation
- [ ] `agent-defaults.ts`: `AgentBirthDefaults` → birthEvents list; builder collapses to "append the validated list"; platform-minted content-hash keys
- [ ] `rpc-targets.ts`: read defaults from the project processor snapshot; delete the raw-event scan
- [ ] `configs/codemode-tag/worker.ts`: publish list-form defaults
- [ ] `configs/default/prompts/agent-system-prompt.md`: prompt text moves; `DEFAULT_AGENT_SYSTEM_PROMPT`/revision constants deleted; fallback reads `PROJECT_REPO_INITIAL_FILES`; hash identity
- [ ] `configs/default/worker.ts`: publish prompt birth default on worker-updated
- [ ] channel prompts → `configs/default/prompts/{slack,telegram,email}.md` + thin interpolators
- [ ] prompt-budget test reads the template file; template worker adds publish-time token warning
- [ ] acceptance: no-defaults birth batches byte-identical (`agent-processor.test.ts`, `agent-headless-processor.test.ts` unmodified)

## Implementation log

- (start) worktree `../worktrees/iterate/userland-agent-defaults`, stacked on codemode-tag-format @ 1baac37f5.
