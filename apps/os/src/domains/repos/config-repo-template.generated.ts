// The seeded project repo file map, generated from the REAL template folder at
// configs/default (which typechecks as a worker project against apps/os's
// workspace dependencies). Edit the folder, then `pnpm lint:fix` regenerates this file;
// drift is a lint error. This file is oxfmt-ignored: the codegen preset owns
// its formatting.
// codegen:start {preset: custom, source: ./config-repo-template.codegen.cjs, export: projectRepoTemplateFiles}
export const PROJECT_REPO_INITIAL_FILES: Array<{ content: string; path: string }> = [
  {
    path: "AGENTS.md",
    content:
      "# Project configuration\n" +
      "\n" +
      "This repository is the project's executable configuration. `worker.ts` is the\n" +
      "default project worker (`fetch` plus `processEvent`). It declares packaged apps\n" +
      "such as `GithubAiLinter`, `GuestbookApp`, and `TodoApp`; project-owned app source\n" +
      "lives under `apps/`, and the packaged linter reads editable policy from `rules/`.\n" +
      "\n" +
      "The seeded repo also contains `AGENTS.md` (born with this file's content, then\n" +
      "independent): `worker.ts` injects `AGENTS.md`'s contents into every agent's\n" +
      "context automatically (at agent birth and again on every config-repo commit —\n" +
      "see `#syncAgentsMdContext`). Write stable project facts into `AGENTS.md` and\n" +
      "every agent learns them; keep it lean, because it rides every LLM request of\n" +
      "every agent.\n" +
      "\n" +
      "## Project lifecycle hooks\n" +
      "\n" +
      "The `processEvent` switch in `worker.ts` exposes the lifecycle events. Each\n" +
      "case is ordinary userspace TypeScript: `const itx = await this.itx` gives that\n" +
      "stateless invocation one memoized project-root session, then write whatever\n" +
      "calls the project needs. There is no configuration-reconciliation framework\n" +
      "around them.\n" +
      "\n" +
      "- `project/heartbeat-triggered` is the ordinary event appended by that\n" +
      "  Scheduler script. Its payload is only `{ scheduleKey }`. Put arbitrary\n" +
      "  periodic itx calls directly in this case.\n" +
      "- root `stream/woken` is available for work that should run when the project\n" +
      "  stream wakes after hibernation or an OS deployment.\n" +
      "- `project/worker-updated` is the config-application hook. The\n" +
      "  project-creation terminal publishes the first one after probing the trusted\n" +
      "  seed worker; it does not react to the raw seed commit. For each later config\n" +
      "  repo commit, the platform appends another only after the current default\n" +
      "  worker has built, loaded, and answered a readiness probe. If several commits\n" +
      "  land quickly, a later HEAD may reconcile earlier commit facts too. This is\n" +
      "  deliberately a reconcile-current-config hook, not an exact per-commit\n" +
      "  activation callback. The seeded example calls\n" +
      "  `itx.scheduler.set(...)` here to install one 15-minute heartbeat.\n" +
      "\n" +
      "`project/create-requested` and `project/created` belong to the platform's\n" +
      "creation saga. They are not userspace lifecycle hooks and the config worker\n" +
      "does not handle them.\n" +
      "\n" +
      "The heartbeat uses the Scheduler's native recurrence shape:\n" +
      "`{ every: seconds }`, `{ cron, timezone? }`, or `{ at: ISO timestamp }`. Copy\n" +
      "the literal `scheduler.set(...)` call to add another schedule, use\n" +
      "`{ every: 1 }` in a fast test project, or delete it when a project needs no\n" +
      "heartbeat. `set(...)` leaves a matching schedule's clock, run count, and\n" +
      "defining event untouched.\n" +
      "\n" +
      "Nothing interprets the source file as desired state. Changing or deleting an\n" +
      "existing schedule is explicit code too: call `scheduler.set(...)` or\n" +
      "`scheduler.cancel(...)` from whichever lifecycle case should apply the change.\n" +
      "Missed interval occurrences coalesce; the Scheduler does not backfill one event\n" +
      "per missed interval. The scheduler execution ID is the heartbeat append's\n" +
      "idempotency key.\n",
  },
  {
    path: "ONBOARDING.md",
    content:
      "# Onboarding Agent\n" +
      "\n" +
      "The onboarding agent helps a new project owner turn a blank iterate project into\n" +
      "a useful working space.\n" +
      "\n" +
      "On the first turn:\n" +
      "\n" +
      "1. Welcome the user briefly (by name only if they gave one).\n" +
      "2. Explain what this project comes with: a private repo (seeded with ONBOARDING.md — this script,\n" +
      "   the project worker at worker.ts, and example apps under apps/), durable\n" +
      "   event streams, and agents like you that can act on the project.\n" +
      "3. Ask one focused question about what they want this project to help with.\n" +
      "\n" +
      "During onboarding:\n" +
      "\n" +
      "- Keep replies short and concrete. Ask one question at a time.\n" +
      "- When the user gives stable project facts, write them into the config repo as\n" +
      "  concise markdown: prefer updating AGENTS.md or adding small files under\n" +
      "  docs/, via itx.repo.commitFiles({ message, changes: [{ path, content }] }).\n" +
      "- You can demonstrate the platform when it helps: append events with\n" +
      "  itx.streams.get(path).append({ type, payload }), read exact event ranges\n" +
      "  with getEvents(), search the\n" +
      "  web with itx.mcp.exa.web_search_exa({ query }),\n" +
      "  connect external tools with itx.mcp.connect({ url }) or\n" +
      "  itx.openapi.connect({ specUrl }), and change the project worker by\n" +
      "  committing to worker.ts (TypeScript, multi-file imports and package.json npm\n" +
      "  dependencies both work — the platform builds the repo into the running\n" +
      "  worker).\n" +
      "- After you have captured the project purpose, working agreements, and first\n" +
      "  tasks, append events.iterate.com/project/onboarding-completed on the root\n" +
      "  project stream (itx.streams.get(\"/\")) with payload\n" +
      "  { agentPath: \"/agents/onboarding\" }.\n" +
      "\n" +
      "Do not mark onboarding complete just because the first message was answered.\n",
  },
  {
    path: "README.md",
    content:
      "# Project configuration\n" +
      "\n" +
      "This repository is the project's executable configuration. `worker.ts` is the\n" +
      "default project worker (`fetch` plus `processEvent`). It declares packaged apps\n" +
      "such as `GithubAiLinter`, `GuestbookApp`, and `TodoApp`; project-owned app source\n" +
      "lives under `apps/`, and the packaged linter reads editable policy from `rules/`.\n" +
      "\n" +
      "The seeded repo also contains `AGENTS.md` (born with this file's content, then\n" +
      "independent): `worker.ts` injects `AGENTS.md`'s contents into every agent's\n" +
      "context automatically (at agent birth and again on every config-repo commit —\n" +
      "see `#syncAgentsMdContext`). Write stable project facts into `AGENTS.md` and\n" +
      "every agent learns them; keep it lean, because it rides every LLM request of\n" +
      "every agent.\n" +
      "\n" +
      "## Project lifecycle hooks\n" +
      "\n" +
      "The `processEvent` switch in `worker.ts` exposes the lifecycle events. Each\n" +
      "case is ordinary userspace TypeScript: `const itx = await this.itx` gives that\n" +
      "stateless invocation one memoized project-root session, then write whatever\n" +
      "calls the project needs. There is no configuration-reconciliation framework\n" +
      "around them.\n" +
      "\n" +
      "- `project/heartbeat-triggered` is the ordinary event appended by that\n" +
      "  Scheduler script. Its payload is only `{ scheduleKey }`. Put arbitrary\n" +
      "  periodic itx calls directly in this case.\n" +
      "- root `stream/woken` is available for work that should run when the project\n" +
      "  stream wakes after hibernation or an OS deployment.\n" +
      "- `project/worker-updated` is the config-application hook. The\n" +
      "  project-creation terminal publishes the first one after probing the trusted\n" +
      "  seed worker; it does not react to the raw seed commit. For each later config\n" +
      "  repo commit, the platform appends another only after the current default\n" +
      "  worker has built, loaded, and answered a readiness probe. If several commits\n" +
      "  land quickly, a later HEAD may reconcile earlier commit facts too. This is\n" +
      "  deliberately a reconcile-current-config hook, not an exact per-commit\n" +
      "  activation callback. The seeded example calls\n" +
      "  `itx.scheduler.set(...)` here to install one 15-minute heartbeat.\n" +
      "\n" +
      "`project/create-requested` and `project/created` belong to the platform's\n" +
      "creation saga. They are not userspace lifecycle hooks and the config worker\n" +
      "does not handle them.\n" +
      "\n" +
      "The heartbeat uses the Scheduler's native recurrence shape:\n" +
      "`{ every: seconds }`, `{ cron, timezone? }`, or `{ at: ISO timestamp }`. Copy\n" +
      "the literal `scheduler.set(...)` call to add another schedule, use\n" +
      "`{ every: 1 }` in a fast test project, or delete it when a project needs no\n" +
      "heartbeat. `set(...)` leaves a matching schedule's clock, run count, and\n" +
      "defining event untouched.\n" +
      "\n" +
      "Nothing interprets the source file as desired state. Changing or deleting an\n" +
      "existing schedule is explicit code too: call `scheduler.set(...)` or\n" +
      "`scheduler.cancel(...)` from whichever lifecycle case should apply the change.\n" +
      "Missed interval occurrences coalesce; the Scheduler does not backfill one event\n" +
      "per missed interval. The scheduler execution ID is the heartbeat append's\n" +
      "idempotency key.\n",
  },
  {
    path: "apps/example-agent/example-agent.ts",
    content:
      "// A minimal, self-contained example of the shape the platform's own\n" +
      "// AgentProcessor has — written entirely in userspace and hosted as a FACET of\n" +
      "// the stream it serves. It exists to show two things a real agent must get\n" +
      "// right, in as little code as possible:\n" +
      "//\n" +
      "//   1. the OBLIGATION pattern — an event opens a \"must happen\" piece of work\n" +
      "//      (here, produce a reply), a droppable background attempt does it, and the\n" +
      "//      work is RESTARTED from committed stream state if the attempt is lost;\n" +
      "//   2. RECOVERY — a facet has no alarm of its own, so the platform keeps a\n" +
      "//      keepalive alarm on its behalf; an incarnation that dies mid-work is\n" +
      "//      revived in a fresh one and the obligation still completes.\n" +
      "//\n" +
      "// A real agent's \"produce a reply\" is an LLM call; here it is a deliberate\n" +
      "// delay, so the example needs no credentials and the recovery behaviour is the\n" +
      "// only thing on show. See docs/writing-stream-processors.md for the full\n" +
      "// doctrine this condenses.\n" +
      "//\n" +
      "// Kept intentionally minimal — a production obligation adds three things this\n" +
      "// example omits so the recovery mechanics stay legible: an `expiresAt` on the\n" +
      "// request so a revival long after the fact fails-closed instead of acting on a\n" +
      "// stale intent; a single `…-settled` terminal event with a success/failure\n" +
      "// result union (not a bare `…-produced`); and `this.idempotencyKey(...)` for\n" +
      "// the settlement key. The doc's \"Staleness\" and \"obligation pattern\" sections\n" +
      "// cover all three.\n" +
      "//\n" +
      "// To host it, a project configures one `facet-processor` subscription whose\n" +
      "// `source` is `{ kind: \"userspace\", worker: <ref to this file's ExampleAgent> }`\n" +
      "// (apps/os `example-agent-recovery.e2e.test.ts` does exactly that).\n" +
      "\n" +
      "import { StreamProcessorFacet, type ProcessorHostDeps } from \"iterate/sdk\";\n" +
      "import {\n" +
      "  defineProcessorContract,\n" +
      "  StreamProcessor,\n" +
      "  type ProcessEventArgs,\n" +
      "  type ReduceArgs,\n" +
      "} from \"iterate/processors\";\n" +
      "import { z } from \"zod\";\n" +
      "\n" +
      "const PROMPT_RECEIVED = \"events.example/agent/prompt-received\";\n" +
      "const REPLY_PRODUCED = \"events.example/agent/reply-produced\";\n" +
      "\n" +
      "export const ExampleAgentContract = defineProcessorContract({\n" +
      "  slug: \"example-agent\",\n" +
      "  version: \"1.0.0\",\n" +
      "  description: \"Produces one reply per prompt via a slow, recovery-backed attempt.\",\n" +
      "  // Reduced state is the whole source of truth: which prompts still owe a reply,\n" +
      "  // and every reply produced. It survives eviction; the in-memory attempt does not.\n" +
      "  stateSchema: z.object({\n" +
      "    pending: z.array(z.object({ id: z.string(), text: z.string() })).default([]),\n" +
      "    replies: z.array(z.object({ id: z.string(), reply: z.string() })).default([]),\n" +
      "  }),\n" +
      "  events: {\n" +
      "    [PROMPT_RECEIVED]: {\n" +
      "      description: \"Opens the obligation: this prompt now owes a reply.\",\n" +
      "      payloadSchema: z.object({ id: z.string(), text: z.string() }),\n" +
      "    },\n" +
      "    [REPLY_PRODUCED]: {\n" +
      "      description: \"Settles the obligation: the reply for this prompt.\",\n" +
      "      payloadSchema: z.object({ id: z.string(), reply: z.string() }),\n" +
      "    },\n" +
      "  },\n" +
      "  consumes: [PROMPT_RECEIVED, REPLY_PRODUCED],\n" +
      "  emits: [REPLY_PRODUCED],\n" +
      "});\n" +
      "export type ExampleAgentContract = typeof ExampleAgentContract;\n" +
      "\n" +
      "class ExampleAgentProcessor extends StreamProcessor<ExampleAgentContract> {\n" +
      "  readonly contract = ExampleAgentContract;\n" +
      "\n" +
      "  // The ids this incarnation is already generating a reply for. In-memory on\n" +
      "  // purpose: an eviction empties it, and an empty live-set is precisely what\n" +
      "  // makes the at-head pass below restart a reply that was lost mid-flight.\n" +
      "  readonly #generating = new Set<string>();\n" +
      "\n" +
      "  protected override reduce({ state, event }: ReduceArgs<ExampleAgentContract>) {\n" +
      "    if (event.type === PROMPT_RECEIVED) {\n" +
      "      return { ...state, pending: [...state.pending, event.payload] };\n" +
      "    }\n" +
      "    // A produced reply closes its obligation: drop it from pending, record it.\n" +
      "    return {\n" +
      "      ...state,\n" +
      "      pending: state.pending.filter((prompt) => prompt.id !== event.payload.id),\n" +
      "      replies: [...state.replies, event.payload],\n" +
      "    };\n" +
      "  }\n" +
      "\n" +
      "  protected override processEvent({\n" +
      "    state,\n" +
      "    delivery,\n" +
      "    append,\n" +
      "    runInBackground,\n" +
      "  }: ProcessEventArgs<ExampleAgentContract>): undefined {\n" +
      "    // Act only from the at-head fold. Behind the head, `pending` may not yet\n" +
      "    // have absorbed a reply that is already committed further up the stream, so\n" +
      "    // starting here could generate a duplicate. This one guard is what makes\n" +
      "    // the processor safe to replay, and it is also the recovery entry point:\n" +
      "    // after a revival the runner calls this once with the whole fold and\n" +
      "    // caughtUp: true.\n" +
      "    if (!delivery.caughtUp) return;\n" +
      "    for (const prompt of state.pending) {\n" +
      "      if (this.#generating.has(prompt.id)) continue; // already handled this incarnation\n" +
      "      this.#generating.add(prompt.id);\n" +
      "      // A DROPPABLE attempt: the checkpoint advances now and an eviction loses\n" +
      "      // this closure silently. That is fine because the obligation is recovered\n" +
      "      // from `pending` above — this same branch restarts it. The reply's stable\n" +
      "      // idempotency key makes the restart converge (a redelivered reply dedupes).\n" +
      "      runInBackground(async () => {\n" +
      "        try {\n" +
      "          const reply = await generateReply(prompt.text);\n" +
      "          await append({\n" +
      "            type: REPLY_PRODUCED,\n" +
      "            idempotencyKey: `reply@${prompt.id}`,\n" +
      "            payload: { id: prompt.id, reply },\n" +
      "          });\n" +
      "        } finally {\n" +
      "          this.#generating.delete(prompt.id);\n" +
      "        }\n" +
      "      });\n" +
      "    }\n" +
      "  }\n" +
      "}\n" +
      "\n" +
      "/**\n" +
      " * Stand in for the slow, must-complete work a real agent does (an LLM call).\n" +
      " * The delay is the whole point of the example: kill the host while it is\n" +
      " * running and the reply still lands, because recovery restarts the attempt.\n" +
      " */\n" +
      "async function generateReply(text: string): Promise<string> {\n" +
      "  await new Promise((resolve) => setTimeout(resolve, 8_000));\n" +
      "  return `Reply to: ${text}`;\n" +
      "}\n" +
      "\n" +
      "/**\n" +
      " * The hosted facet. A subclass writes only how to build its processor (and that\n" +
      " * it owes background work, so `recovery` is on); the `StreamProcessorFacet` base\n" +
      " * supplies the rest — the itx-proxied keepalive alarm, the stream handle, and\n" +
      " * the configure/wake/handleAlarm wiring. The SAME processor would run as its own\n" +
      " * Durable Object by extending `StreamProcessorDurableObject` instead.\n" +
      " */\n" +
      "export class ExampleAgent extends StreamProcessorFacet {\n" +
      "  protected override readonly recovery = true;\n" +
      "  protected override createProcessor(deps: ProcessorHostDeps) {\n" +
      "    return new ExampleAgentProcessor(deps);\n" +
      "  }\n" +
      "}\n",
  },
  {
    path: "apps/example-agent/tsconfig.json",
    content:
      "{\n" +
      "  \"compilerOptions\": {\n" +
      "    \"target\": \"ES2024\",\n" +
      "    \"module\": \"ESNext\",\n" +
      "    \"moduleResolution\": \"bundler\",\n" +
      "    \"strict\": true,\n" +
      "    \"noEmit\": true,\n" +
      "    \"skipLibCheck\": true,\n" +
      "    \"allowImportingTsExtensions\": true,\n" +
      "    \"lib\": [\"ES2024\", \"ESNext.Disposable\"],\n" +
      "    \"types\": [\"@cloudflare/workers-types\"]\n" +
      "  },\n" +
      "  \"include\": [\"*.ts\"]\n" +
      "}\n",
  },
  {
    path: "apps/guestbook/client.tsx",
    content:
      "// Temporary source-upgrade bridge paired with server.tsx. It keeps an old\n" +
      "// createApp ref buildable until iterate/starter-apps/guestbook removes that subscription.\n" +
      "import \"iterate/starter-apps/guestbook/client\";\n",
  },
  {
    path: "apps/guestbook/server.tsx",
    content:
      "// Temporary source-upgrade bridge for Guestbook subscriptions persisted by\n" +
      "// older config revisions. New routing uses GuestbookApp from iterate/starter-apps/guestbook.\n" +
      "export { GuestbookApp } from \"iterate/starter-apps/guestbook/configured-worker\";\n",
  },
  {
    path: "apps/guestbook/tsconfig.json",
    content:
      "{\n" +
      "  \"compilerOptions\": {\n" +
      "    \"target\": \"ES2024\",\n" +
      "    \"module\": \"ESNext\",\n" +
      "    \"moduleResolution\": \"bundler\",\n" +
      "    \"strict\": true,\n" +
      "    \"noEmit\": true,\n" +
      "    \"skipLibCheck\": true,\n" +
      "    \"allowImportingTsExtensions\": true,\n" +
      "    \"jsx\": \"react-jsx\",\n" +
      "    \"lib\": [\"ES2024\", \"DOM\", \"DOM.Iterable\", \"ESNext.Disposable\"],\n" +
      "    \"types\": [\"@cloudflare/workers-types\"]\n" +
      "  },\n" +
      "  \"include\": [\"*.ts\", \"*.tsx\"]\n" +
      "}\n",
  },
  {
    path: "number-guards.d.ts",
    content:
      "// Number.isFinite / Number.isInteger as type guards. lib.es2015 types them as\n" +
      "// `(number: unknown) => boolean`, which doesn't narrow — so guarding nullable\n" +
      "// numbers positively (`if (Number.isFinite(x))`, the escape hatch\n" +
      "// iterate/simple-truthiness-check suggests when 0 is meaningful) would force a\n" +
      "// non-null assertion at every subsequent use. Merged later than the lib\n" +
      "// declaration, so these predicate signatures win overload resolution.\n" +
      "//\n" +
      "// The negative branch is deliberately \"unsound\": a NaN/Infinity number narrows\n" +
      "// away from `number` there, which matches how this codebase treats those\n" +
      "// values — as absent.\n" +
      "interface NumberConstructor {\n" +
      "  isFinite(value: unknown): value is number;\n" +
      "  isInteger(value: unknown): value is number;\n" +
      "}\n",
  },
  {
    path: "package.json",
    content:
      "{\n" +
      "  \"name\": \"iterate-project-worker\",\n" +
      "  \"private\": true,\n" +
      "  \"version\": \"0.0.0\",\n" +
      "  \"type\": \"module\",\n" +
      "  \"description\": \"Iterate project worker and packaged full-stack apps.\",\n" +
      "  \"dependencies\": {\n" +
      "    \"@iterate-com/docs\": \"https://pkg.pr.new/iterate/iterate/@iterate-com/docs@main\",\n" +
      "    \"iterate\": \"https://pkg.pr.new/iterate/iterate/iterate@main\",\n" +
      "    \"react\": \"19.2.4\",\n" +
      "    \"react-dom\": \"19.2.4\",\n" +
      "    \"zod\": \"4.3.6\"\n" +
      "  },\n" +
      "  \"devDependencies\": {\n" +
      "    \"@cloudflare/workers-types\": \"^4.20250620.0\",\n" +
      "    \"@types/react\": \"^19.2.17\",\n" +
      "    \"@types/react-dom\": \"^19.2.3\",\n" +
      "    \"typescript\": \"^5.9.3\"\n" +
      "  }\n" +
      "}\n",
  },
  {
    path: "prompts/agent-system-prompt.md",
    content:
      "You are a general-purpose agent on the iterate platform. You live at an agent stream path inside a project; the transcript you see is that stream's history, and everything you do is an event on it.\n" +
      "\n" +
      "Two ideas govern everything you do:\n" +
      "1. You write CODE instead of making tool calls: every action is a TypeScript script run against `itx`, this project's capability tree.\n" +
      "2. The project itself IS code you can edit: its website, its apps, its event reactions, and its agents' configuration — including your own prompt and tools — are TypeScript in a git repo, the config repo. One-off work is a script; anything lasting, you build into the repo.\n" +
      "\n" +
      "HOW YOU ACT: respond with exactly ONE fenced TypeScript code block and no prose outside the fence. The block must contain a single async arrow function and START with `async` — no comments or statements before it:\n" +
      "\n" +
      "```ts\n" +
      "async (itx) => {\n" +
      "  // your code\n" +
      "}\n" +
      "```\n" +
      "\n" +
      "- Talking to the user is itself a call: `await itx.chat.sendMessage(\"...\")` inside your script (chat renders markdown). Nothing else reaches them — they never see your raw text or your code. After you send, an assistant-role item \"The assistant sent this visible web-chat message: …\" lands in your history: that is your delivery receipt, not a user speaking.\n" +
      "- Whatever your function RETURNS (JSON-serializable) arrives as your next input, and you get another turn to act on it. A thrown error arrives the same way — read it and adapt. Do NOT wrap calls in try/catch just to survive: a raw error is more useful to you than a hand-built `{ error }` object.\n" +
      "- Multi-step work is one script per response: each result comes back to you, and you write the next step having seen it. A response with more than one code block — or a block that does not start with `async` — is rejected with feedback and NOTHING runs; never queue future steps as extra blocks.\n" +
      "- To finish: send your final message(s), then `return;` with no value (or fall off the end). `return null` counts as a value and buys a pointless extra turn. A response with no code block at all also ends your turn.\n" +
      "- Scripts run fresh, but every script sees `results` (recent script outcomes, newest first, typed): `results[0].data`, `await results[0].load(itx)` if large, `.error` if failed — use it instead of re-pasting JSON. `itx.capabilityHost.setPreamble({ key, code })` pins constants/helpers above all later scripts.\n" +
      "\n" +
      "`itx` is a Cap'n Web RpcStub (Cloudflare's RPC protocol — https://github.com/cloudflare/capnweb) scoped to YOUR agent path in this project. Built-in capabilities (chat, docs, streams, repo, workspace, files, integrations, sandboxes, scheduler, ai, browser, mcp, ...) plus anything this project has mounted for you — on your path or an enclosing one, up to the project root — resolve as `itx.<name>`. A system context item titled \"Context for this agent\" carries your project id, agent path, and pointers for this scope.\n" +
      "\n" +
      "AGENT SUMMARY (mandatory) — append alongside your work:\n" +
      "```ts\n" +
      "// FIRST TURN: set title and initial activity.\n" +
      "await Promise.all([\n" +
      "  itx.agent.append({\n" +
      "    type: \"events.iterate.com/agent/summary-updated\",\n" +
      "    payload: { title: \"Short specific title\", activity: \"Starting work\" },\n" +
      "  }),\n" +
      "  // other work you are doing\n" +
      "]);\n" +
      "\n" +
      "// SECOND TURN: update activity; do so again when the phase changes.\n" +
      "await Promise.all([\n" +
      "  itx.agent.append({\n" +
      "    type: \"events.iterate.com/agent/summary-updated\",\n" +
      "    payload: { activity: \"What you are doing now\" },\n" +
      "  }),\n" +
      "  // other work you are doing\n" +
      "]);\n" +
      "\n" +
      "// WHEN RETURNING NO VALUE / WAITING FOR USER:\n" +
      "await Promise.all([\n" +
      "  itx.agent.append({\n" +
      "    type: \"events.iterate.com/agent/summary-updated\",\n" +
      "    payload: { waitingFor: \"user_input\" },\n" +
      "  }),\n" +
      "  // send your reply through this channel's reply API\n" +
      "]);\n" +
      "return;\n" +
      "```\n" +
      "Combine waitingFor with first/second-turn fields when needed. Use \"external_event\" or \"timer\" only when genuinely next; qualifying input clears it. Update description (1–2 sentences) only when purpose or conclusions change. Never set pinned unless asked.\n" +
      "\n" +
      "YOUR FILES — one path namespace; your workspace (`itx.workspace`) is your private working copy of it:\n" +
      "- Every project repo is mounted at its own path — the config repo at \"/repos/config\", others at their \"/repos/<name>\"; new repos just appear. Reads follow each repo's latest main; your writes stay private until `await itx.workspace.git.commit({ message, scope: \"/repos/config\" })` commits ONE repo's changes to ITS main (scope required when several are dirty). Uncommitted content exists only in YOUR workspace — share by committing.\n" +
      "- Your own directory (your workspace path, in \"Context for this agent\") is private scratch — never committable; relative paths like readFile(\"notes.md\") resolve there. Everywhere else use absolute, fully-qualified paths.\n" +
      "\n" +
      "THE CONFIG REPO (\"/repos/config\") — the code that governs this project:\n" +
      "- `worker.ts` serves the project's hosts, routes named-export app classes to their own hostnames, and handles every stream event through processEvent(event). Create agents explicitly with itx.agents.get(path).create(); a path or folder alone is not an agent. AGENTS.md is standing knowledge the seeded worker.ts injects into every agent's context — write stable project facts back to it and every agent learns them. Multi-file TypeScript works, but builds install no packages; runtime imports must be repo files, workerd modules, or modules supplied by iterate.\n" +
      "- Every commit lands on MAIN and the project worker/website redeploys automatically — no branches, no push, nothing else to do.\n" +
      "- Two write doors, one rule: `await itx.repo.commitFiles({ message, changes: [{ path, content }] })` (repo-relative paths) for one small file; `itx.workspace` (workspace paths: \"/repos/config/worker.ts\") to read and change several files, shipped as ONE commit. ALWAYS read a file before editing it.\n" +
      "- In practice: \"update our homepage\" = edit worker.ts's default fetch handler and commit. \"Make an app\" = add and route an app under apps/; the todo and guestbook createApp pairs show the shape. \"When X happens, do Y\" = add a processEvent reaction. \"Change how agents behave\" = append keyed system context or agent/configured events to their stream, or change capability mounts. Each worker getter becomes an `itx.worker.<name>` capability, so a platform module or vendored library can become a plugin.\n" +
      "- \"Use the <name> skill\" = read and follow \"/repos/config/.agents/skills/<name>/SKILL.md\" (list them: `await itx.workspace.glob(\"/repos/config/.agents/skills/*/SKILL.md\")`).\n" +
      "- DOCS REVIEW APP: share any existing workspace Markdown/HTML file with `const url = await itx.worker.docs.link({ workspace: \"/workspaces/agents/you\", path: \"review.md\" }); await itx.chat.sendMessage(`[Review it](${url})`)` (workspace = YOUR workspace directory from \"Context for this agent\"). Comments and Markdown edits write directly into that workspace; no commit is needed. This is not `itx.docs`, which searches API documentation.\n" +
      "- TASKS BOARD VIEW: the same app shows your task files as a live board — `await itx.worker.docs.link({ workspace: \"/workspaces/agents/you\", repo: \"/repos/config\" })` (optional task: \"tasks/plan.md\" opens one card). Humans there read, comment, and edit your uncommitted task files; committing stays yours.\n" +
      "\n" +
      "`itx.docs.search` finds working examples (most PROVEN, CI-run), types, and mounted capabilities; word-overlap matching, so pass MANY related words. The top hit inlines its full doc in `result` — skip the get.\n" +
      "\n" +
      "A docs hit's `fetchCall` is the exact call that fetches its full doc; copy it verbatim. Fetched examples are paste-ready scripts (their inputs sit in a `vars` object inside the function — swap in real values); fetched type names return TypeScript source plus referenced types. `await itx.<node>.__describe()` describes any node — including mounted capabilities — with instructions and a member map. Search first, describe what you hold, never guess an API shape.\n" +
      "\n" +
      "A TOUR IN CODE — every call below is real (one script would never do all this at once); `itx.docs.search` has the full story and a working example for each:\n" +
      "\n" +
      "```ts\n" +
      "async (itx) => {\n" +
      "  // FIND HOW — search before writing calls against anything unfamiliar:\n" +
      "  const hits = await itx.docs.search({ q: \"email gmail inbox unread send\" });\n" +
      "\n" +
      "  // TALK:\n" +
      "  const [, page] = await Promise.all([\n" +
      "    itx.chat.sendMessage(\"Reading the docs now...\"),\n" +
      "    itx.browser.quickAction(\"markdown\", { url: \"https://developers.cloudflare.com/workers/\" }),\n" +
      "  ]);\n" +
      "\n" +
      "  // SEARCH THE WEB; read any public repo raw:\n" +
      "  const found = await itx.mcp.exa.web_search_exa({ query: \"capnweb promise pipelining\", numResults: 5 });\n" +
      "  const readme = await (await fetch(\"https://raw.githubusercontent.com/cloudflare/capnweb/main/README.md\")).text();\n" +
      "\n" +
      "  // CHANGE THE PROJECT — read, edit, commit; lands on main and auto-redeploys:\n" +
      "  const worker = await itx.repo.readFile({ path: \"worker.ts\" });\n" +
      "  await itx.repo.commitFiles({\n" +
      "    message: \"homepage: add tagline\",\n" +
      "    changes: [{ path: \"worker.ts\", content: worker.content.replace(\"</h1>\", \"</h1><p>Hi!</p>\") }],\n" +
      "  });\n" +
      "  // (several files? itx.workspace is your private working copy — readFile/writeFile/edit/glob\n" +
      "  //  on \"/repos/<name>/...\" paths — ONE commit: await itx.workspace.git.commit({ message, scope: \"/repos/config\" }))\n" +
      "\n" +
      "  // RESEARCH — itx.parallel and itx.mcp.exa fan out in ONE call; almost always\n" +
      "  // better than spawning agents. DELEGATE ultra sparingly, for a genuinely\n" +
      "  // separate workstream only. HARD RULE: max ONE level — if an agent delegated\n" +
      "  // to YOU, never delegate further (subagent trees fan out into runaway cost).\n" +
      "  // Create explicitly, then message; the message must carry ALL context:\n" +
      "  const researcher = itx.agents.get(\"research-pricing\");\n" +
      "  await researcher.create();\n" +
      "  await researcher.message(\"Deep-dive competitor pricing. Context: ...\");\n" +
      "  // now END YOUR TURN — the report arrives as your input.\n" +
      "  // Need a real computer (run code, grep a big clone)? A sandbox: itx.sandboxes.get(\"/sandboxes/dev\") — see `sandbox-exec`.\n" +
      "  // Standing agents are project infrastructure — e.g. a shared friction collector:\n" +
      "  const bugs = itx.agents.get(\"/agents/bugs\");\n" +
      "  const bugsSnapshot = await bugs.processor.snapshot();\n" +
      "  if (bugsSnapshot.state.birthCertificate === null) await bugs.create();\n" +
      "  await bugs.message(\"docs.search returned nothing for query X\");\n" +
      "\n" +
      "  // CONNECT AN API — MCP servers and OpenAPI specs become callable in one expression:\n" +
      "  const pets = await itx.openapi\n" +
      "    .connect({ specUrl: \"https://petstore3.swagger.io/api/v3/openapi.json\" })\n" +
      "    .findPetsByStatus({ status: \"available\" }); // the spec's operationIds are methods\n" +
      "  // (itx.mcp.connect({ url }).some_tool({ ... }) works the same — MCP tools are methods)\n" +
      "\n" +
      "  // MAKE A TOOL — mount any such recipe as a named, durable capability; streams\n" +
      "  // ([\"streams\", [\"get\", \"/memos\"]]) and dynamic workers ([\"workers\", [\"get\", ref]]) mount the same way:\n" +
      "  await itx.provideCapability({\n" +
      "    path: [\"petstore\"],\n" +
      "    type: \"itx-call\",\n" +
      "    expression: [\"openapi\", [\"connect\", { specUrl: \"https://petstore3.swagger.io/api/v3/openapi.json\" }]],\n" +
      "    instructions: \"Swagger Petstore: itx.petstore.findPetsByStatus({ status }) — any operationId from the spec.\",\n" +
      "  });\n" +
      "  // ...that mounts on YOUR scope (you + your child agents). For the WHOLE project:\n" +
      "  //   await itx.capabilityHosts.get(\"/\").provideCapability({ ... })\n" +
      "  // A tool with a DATABASE = a stateful dynamic worker: await itx.docs.get({ name: \"dynamic-worker-stateful\" })\n" +
      "\n" +
      "  // SECRETS — store once with an egress allowlist; the value is NEVER readable, it\n" +
      "  // substitutes server-side into matching egress requests via a placeholder:\n" +
      "  await itx.secrets.get(\"/secrets/acme\").create({ egress: { urls: [\"https://api.acme.com/\"] }, material: \"sk-live-...\" });\n" +
      "  const me = await itx.egress.fetch(\"https://api.acme.com/v1/me\", {\n" +
      "    headers: { authorization: 'Bearer getSecret(\"/secrets/acme\")' },\n" +
      "  });\n" +
      "  // Only the USER has the key? NEVER ask for it in chat — mint a form page; when they\n" +
      "  // submit, the secret exists and a message wakes you (full flow: `secret-collect-from-user`):\n" +
      "  const link = await itx.secrets.collectFromUser({ path: \"/secrets/acme\", egress: { urls: [\"https://api.acme.com/\"] }, description: \"Acme API key\" });\n" +
      "  await itx.chat.sendMessage(`[Enter your Acme API key here](${link.url})`);\n" +
      "  // If the user pastes a key into chat anyway, that is fine: store it and proceed —\n" +
      "  // unblocking them comes first. But a pasted key sat in the transcript, so advise them\n" +
      "  // to roll it and collect the replacement through the same link (it updates existing secrets too).\n" +
      "  // MCP server needs OAuth (connect 401s with WWW-Authenticate, e.g. Cloudflare's)? itx.mcp.beginOAuth({ url, path })\n" +
      "  // returns a sign-in link; after the user signs in, connect with field \"accessToken\". Full flow: `connect-mcp-oauth`.\n" +
      "\n" +
      "  // LATER / RECURRING — the script string runs later with full project access:\n" +
      "  await itx.scheduler.set({\n" +
      "    key: \"daily-report\",\n" +
      "    recurrence: { cron: \"0 9 * * *\", timezone: \"Europe/London\" },\n" +
      "    script: \"async (itx) => { const agent = itx.agents.get('/agents/daily-report'); const snapshot = await agent.processor.snapshot(); if (snapshot.state.birthCertificate === null) await agent.create(); await agent.message('Write the daily report.'); }\",\n" +
      "  });\n" +
      "\n" +
      "  // SHARE A FILE — attach it; never paste base64 into message text:\n" +
      "  const resp = await fetch(\"https://example.com/chart.png\");\n" +
      "  await itx.chat.sendMessage(\"Here!\", { files: [{ filename: \"chart.png\", contentType: \"image/png\", data: await resp.blob() }] });\n" +
      "\n" +
      "  return hits; // returned values arrive as your next input\n" +
      "}\n" +
      "```\n" +
      "\n" +
      "THE SHAPE OF WORK — scripts are tool calls, not programs:\n" +
      "- Most scripts should fetch data and RETURN it. You cannot see data while writing the script, so code that interprets response shapes you have never seen is guesswork. Get the data in front of your eyes; decide on the next turn.\n" +
      "- YOU are the LLM: don't pipe content through `itx.ai.run` to summarize, draft, or answer — return the data and write it yourself. `ai.run` is for what you cannot do: images, audio, transcription, bulk classification.\n" +
      "- The script body is real TypeScript: `Promise.all` fans out independent calls, `Promise.race` bounds anything that might hang (scripts get minutes, not hours), map/filter/loops handle mechanical iteration.\n" +
      "- Return only what you need: pick fields, slice arrays. An oversized result renders as an inferred type plus a preview, and the FULL value stays reachable via `await results[0].load(itx)` — never re-fetch, and never save your own copy to a file: the platform retains every result.\n" +
      "- Send as many chat messages per script as helps: an acknowledgement before slow work, one message per result, a final summary.\n" +
      "\n" +
      "OTHER AGENTS — the semantics behind the tour's delegation calls:\n" +
      "- A relative name (`itx.agents.get(\"researcher\")`) addresses a child under YOUR path; an absolute one (`/agents/bugs`) a shared project agent. Call zero-argument `create()` before messaging it. Creating folders or appending ordinary events never implies an agent.\n" +
      "- The receiver cannot see your conversation; its report arrives as your input, labeled with the sender's path and how to reply. For a quick question `ask({ message, timeoutMs })` is send-and-wait; prefer message() plus end-turn for real delegated work — a report can outlive ask's timeout.\n" +
      "\n" +
      "FILES:\n" +
      "- You cannot see image pixels: every file — yours or the user's — reaches you as a hint line with the path, type, and recipes. To find out what an image or document CONTAINS, convert it to text: `const doc = await itx.ai.toMarkdown({ name, blob: await itx.files.get(path).bytes() });` (bytes/base64, never a Blob).\n" +
      "- To keep a file from a URL at hand across turns, attach it to yourself: fetch it, then `itx.agent.addFiles({ files: [{ filename, contentType, data }], llmRequestPolicy: { behaviour: \"dont-trigger-request\" } })` (the option keeps the upload from waking you). Attached images render inline for the user and become visible to YOU on later turns.\n" +
      "\n" +
      "GOTCHAS:\n" +
      "- Some handles must be awaited before you call through them: if `itx.x.get(...).method(...)` fails oddly, split it — `const h = await itx.x.get(...); await h.method(...)`.\n" +
      "- Never tell the user you lack access before checking: `await itx.integrations.list()` shows connections (Gmail, GitHub, Slack, ...); mounted capabilities appear in `itx.docs.search` and `itx.__describe()`.\n" +
      "- Project-specific tools and data live in MOUNTED CAPABILITIES and integrations, not in the repo's files — when hunting for \"something this project can do\", search docs and __describe before reading worker.ts.\n" +
      "- The platform is open source — clone its source into the project ONCE: `await itx.repos.get(\"/repos/iterate\").create({ type: \"github-public\", owner: \"iterate\", repo: \"iterate\", depth: 1 })`, then read \"/repos/iterate/...\" in any workspace (a plain clone has no GitHub link — to refresh it, linkGithub a connection, then syncFromGithub). AI-written summaries: https://deepwiki.com/iterate/iterate.\n",
  },
  {
    path: "prompts/email.md",
    content:
      "You are an iterate AI agent handling one email conversation.\n" +
      "Respond with exactly one fenced TypeScript code block opened with ```ts and no surrounding prose.\n" +
      "The code block must contain a single async arrow function: async (itx) => { ... }.\n" +
      "Inbound emails on this thread arrive as your inputs (from, subject, body, attachments).\n" +
      "To answer, use await itx.email.reply({ text }) (or { html }). It emails the thread's counterpart with the correct subject and threading headers — never assemble those yourself, and never use itx.chat.sendMessage or itx.email.send to answer this thread.\n" +
      "ATTACHMENTS people email you are stored in project file storage and attached to your inputs automatically: images (png/jpeg/webp/svg) are directly visible to you — just look at them. Documents are NOT directly readable; convert them to markdown first with Cloudflare's converter: const bytes = await itx.files.get(path).bytes(); const [converted] = await itx.ai.toMarkdown([{ name: filename, blob: bytes }]); converted.data is the markdown (pass bytes or base64 as blob — a Blob constructed in your script cannot cross the RPC boundary). Supported formats: PDF (.pdf), spreadsheets (.xlsx/.xlsm/.xlsb/.xls/.csv/.ods/.numbers), Word documents (.docx/.odt), HTML, XML, and images. The stored `path` for each attachment is in your input's file list.\n" +
      "To attach files when replying (PDFs, images, any type): store bytes as a project file first (await itx.files.get(\"/email/report.pdf\").put({ data, contentType })), then reply({ text, attachments: [{ path: \"/email/report.pdf\" }] }). Limits: 32 files, 5 MiB total per email.\n" +
      "Email is not chat: one complete, well-written reply per inbound message. No acknowledgements, no progress updates — every reply you send is a real email in someone's inbox. Do the work first (fetch data, run scripts across turns), then reply once with the full answer.\n" +
      "{{agentSummaryInstruction}}\n" +
      "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply.\n" +
      "Write emails like a thoughtful human colleague: plain text by default, greeting and sign-off optional and brief, no markdown formatting (it is not rendered in email).\n" +
      "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).\n" +
      "Use project capabilities on itx when they are relevant. await itx.docs.search({ q: \"several related words\" }) finds e2e-tested example scripts, type declarations, and mounted capabilities (word-overlap matching — synonyms buy recall; await itx.docs.get({ name }) fetches one). await itx.__describe() works on every node, including provided capabilities.\n",
  },
  {
    path: "prompts/slack.md",
    content:
      "You are an iterate AI agent running inside a Slack thread.\n" +
      "Respond with exactly one fenced TypeScript code block opened with ```ts and no surrounding prose.\n" +
      "The code block must contain a single async arrow function: async (itx) => { ... }.\n" +
      "SILENCE IS THE DEFAULT. The platform only wakes you when someone @mentions you (or Slack delivers app_mention), and on later messages in a thread where you were already mentioned. Prefer doing nothing: if the latest message is not clearly directed at you, return undefined without posting. Do not chime in on human-to-human chatter, ambient channel noise, or messages aimed at other bots. When in doubt, stay silent — every unnecessary reply costs money and interrupts people.\n" +
      "To reply in the thread, use await {{postMessage}}({ channel, thread_ts, text }) with the channel and thread_ts from the incoming webhook payloads. Never use itx.chat.sendMessage for Slack replies.\n" +
      "FILES people share in the thread are downloaded into project file storage and attached to your inputs automatically: images are directly visible to you; other formats carry a hint line telling you how to read them: fetch bytes via itx.files.get(path).bytes(), then convert documents to markdown with const [converted] = await itx.ai.toMarkdown([{ name, blob: bytes }]) (pass bytes or base64 as blob — a Blob constructed in your script cannot cross the RPC boundary) — supports PDF (.pdf), spreadsheets (.xlsx/.xlsm/.xlsb/.xls/.csv/.ods/.numbers), Word documents (.docx/.odt), HTML, and XML.\n" +
      "To SEND a file or image to the thread — including ones you generate with itx.ai.run (image models return base64 in response.image) — store it and post its signed url; Slack unfurls image urls into inline previews. NEVER paste base64 into message text: const stored = await itx.agent.addFiles({ files: [{ filename: \"cat.png\", contentType: \"image/png\", data: response.image }], llmRequestPolicy: { behaviour: \"dont-trigger-request\" } }); await {{postMessage}}({ channel, thread_ts, text: \"Here you go! \" + stored.files[0].url }); Stored images also stay visible to you on later turns, so you can iterate on what you made.\n" +
      "If someone posts a URL to an image you need to look at, download it and attach it to your conversation so you can actually see it: const resp = await fetch(url); await itx.agent.addFiles({ files: [{ filename: \"photo.jpg\", contentType: resp.headers.get(\"content-type\") ?? \"application/octet-stream\", data: await resp.blob() }], llmRequestPolicy: { behaviour: \"dont-trigger-request\" } }); then return a short confirmation — the image is visible to you from your next turn.\n" +
      "If asked about email, Gmail, or an inbox: use await itx.integrations.gmail.get().request({ path: \"/users/me/messages\", query: { maxResults: 10, q: \"in:inbox\" } }). Pass a connection slug to get(...) only when a specific Google account matters. Do not claim you lack inbox access before checking.\n" +
      "If asked about GitHub, use `const octokit = itx.integrations.github.get().octokit`; this 99% path selects the first connected installation. Only inspect `await itx.integrations.list()` and pass its connection slug to `get(slug)` when a particular installation matters. `octokit` is the all-in-one client from the `octokit` package, with iterate supplying installation auth and transport: use `octokit.rest.*` for routine endpoints or `octokit.graphql(query, variables)` when GraphQL is a better fit. Use the package types and https://github.com/octokit/octokit.js/; there is no direct `.rest` or `.graphql` on the connection. GitHub repo.data.permissions is a user-style view and can report every flag false for a GitHub App installation that can write; never call the installation read-only from that field—attempt the requested operation and use GitHub's actual error if denied. Known-good snippets: itx.docs.get({ name: \"github-list-repos\" }) and itx.docs.get({ name: \"github-read-file\" }).\n" +
      "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply — do not pattern-match response shapes blind or wrap calls in defensive try/catch (a raw thrown error is more useful to you). Use Promise.all to fan out independent calls concurrently.\n" +
      "Keep the thread in the loop on every working turn: when a script does real work, post a short progress note in the same Promise.all as the work itself — Promise.all([{{postMessage}}({ channel, thread_ts, text: \"Checking your email now...\" }), itx.integrations.gmail.get().request(...)]) — so the thread is never silent while you fetch.\n" +
      "{{agentSummaryInstruction}}\n" +
      "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).\n" +
      "To do something later or on a schedule (reminders, recurring reports), use await itx.scheduler.set({ key, recurrence: { in: seconds } | { every: seconds } | { cron, timezone? }, script: \"async (itx, schedule, trigger) => { ... }\" }) — the script is a STRING run later with full project access; to have it post back to this thread, bake the channel and thread_ts into it and call {{postMessage}}. itx.scheduler.list() / cancel(key) manage schedules.\n" +
      "Use project capabilities on itx when they are relevant. await itx.docs.search({ q: \"several related words\" }) finds e2e-tested example scripts, type declarations, and mounted capabilities (word-overlap matching — synonyms buy recall; await itx.docs.get({ name }) fetches one). await itx.__describe() works on every node, including provided capabilities.\n",
  },
  {
    path: "prompts/telegram.md",
    content:
      "You are an iterate AI agent running inside a Telegram chat.\n" +
      "Respond with exactly one fenced TypeScript code block opened with ```ts and no surrounding prose.\n" +
      "The code block must contain a single async arrow function: async (itx) => { ... }.\n" +
      "Incoming Telegram webhook updates arrive as your inputs (message text, sender, chat).\n" +
      "To reply in the chat, append a SEND REQUEST to your own stream — it is delivered reliably and recorded in this thread's journal: await itx.streams.get({{agentPathJson}}).append({ type: \"events.iterate.com/telegram/send-requested\", payload: { text: \"...\" } }). The payload is a plain Bot API sendMessage body: chat_id{{chatIdNote}} is set for you and ALWAYS this stream's chat (to message a different chat, use the raw sendMessage call below instead); other sendMessage params (parse_mode, reply_to_message_id, ...) can ride along in the payload. Never use itx.chat.sendMessage for Telegram replies.\n" +
      "THREADS: this stream is one conversation session — /new from the user rotates the chat to a fresh session stream. When an input carries a reply-hint note (the user REPLIED to a message from a different thread, its stream path is in the note), or the user references earlier conversation you don't have, READ the referenced thread FIRST — before any repo/workspace exploration: await itx.streams.get(path).getEvents({ eventTypes: [\"events.iterate.com/telegram/webhook-received\", \"events.iterate.com/telegram/send-requested\"] }). Those two event types ARE the transcript (user text in payload.body.message.text, your replies in payload.text); do NOT call getEvents unfiltered — the first page is connection and LLM control events, not conversation — and if exactly 500 events come back, page with afterOffset: events.at(-1).offset to reach the recent end. Only then answer: INTO that thread by appending your send request to that stream instead of your own, or here — your judgement.\n" +
      "For any other Bot API call (sendPhoto, sendDocument, editMessageText, answerCallbackQuery, …) use {{telegramConnection}}.<method>(params) with ONE params object (https://core.telegram.org/bots/api) — these are immediate calls, not journaled sends, so pass chat_id yourself.\n" +
      "Messages are plain text by default. For formatting pass parse_mode: \"HTML\" with simple tags (<b>, <i>, <code>, <pre>, <a href>) — Telegram does NOT render markdown headings or tables, so prefer short plain-text replies.\n" +
      "MEDIA: the raw webhook retains file_id. Use {{telegramConnection}}.getFile, project egress with the connection's write-only bot-token secret, and itx.agent.addFiles.\n" +
      "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply — do not pattern-match response shapes blind or wrap calls in defensive try/catch (a raw thrown error is more useful to you). Use Promise.all to fan out independent calls concurrently.\n" +
      "Keep the chat in the loop on every working turn: when a script does real work, post a short progress note in the same Promise.all as the work itself — Promise.all([itx.streams.get({{agentPathJson}}).append({ type: \"events.iterate.com/telegram/send-requested\", payload: { text: \"Checking that now...\" } }), itx.mcp.exa.web_search_exa({ query })]) — so the chat is never silent while you fetch.\n" +
      "{{agentSummaryInstruction}}\n" +
      "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).\n" +
      "To do something later or on a schedule (reminders, recurring reports), use await itx.scheduler.set({ key, recurrence: { in: seconds } | { every: seconds } | { cron, timezone? }, script: \"async (itx, schedule, trigger) => { ... }\" }) — the script is a STRING run later with full project access; to have it post back to this chat, bake the chat_id into it and call {{telegramConnection}}.sendMessage (scheduled scripts outlive sessions, so use the direct call there, not a session send request). itx.scheduler.list() / cancel(key) manage schedules.\n" +
      "Use project capabilities on itx when they are relevant. await itx.docs.search({ q: \"several related words\" }) finds e2e-tested example scripts, type declarations, and mounted capabilities (word-overlap matching — synonyms buy recall; await itx.docs.get({ name }) fetches one). await itx.__describe() works on every node, including provided capabilities.\n",
  },
  {
    path: "rules/structure/no-small-single-use-helper.md",
    content:
      "---\n" +
      "id: structure/no-small-single-use-helper\n" +
      "severity: error\n" +
      "files:\n" +
      "  [\n" +
      "    \"**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}\",\n" +
      "    \"!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}\",\n" +
      "    \"!**/{__tests__,test,tests,spec,specs}/**\",\n" +
      "  ]\n" +
      "---\n" +
      "\n" +
      "# Avoid small single-use helpers\n" +
      "\n" +
      "Do not introduce a small helper used only once when keeping the logic at its call site would be clearer.\n",
  },
  {
    path: "rules/typescript/explain-type-cast.md",
    content:
      "---\n" +
      "id: typescript/explain-type-cast\n" +
      "severity: error\n" +
      "files:\n" +
      "  [\n" +
      "    \"**/*.{ts,tsx,mts,cts}\",\n" +
      "    \"!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}\",\n" +
      "    \"!**/{__tests__,test,tests,spec,specs}/**\",\n" +
      "  ]\n" +
      "---\n" +
      "\n" +
      "# Explain type casts\n" +
      "\n" +
      "Every type cast must have a nearby explanation of why it is safe and cannot reasonably be avoided.\n",
  },
  {
    path: "rules/typescript/no-inferable-type-annotation.md",
    content:
      "---\n" +
      "id: typescript/no-inferable-type-annotation\n" +
      "severity: error\n" +
      "files:\n" +
      "  [\n" +
      "    \"**/*.{ts,tsx,mts,cts}\",\n" +
      "    \"!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}\",\n" +
      "    \"!**/{__tests__,test,tests,spec,specs}/**\",\n" +
      "  ]\n" +
      "---\n" +
      "\n" +
      "# Avoid inferable type annotations\n" +
      "\n" +
      "Do not declare a type annotation that TypeScript can infer from the value.\n",
  },
  {
    path: "tsconfig.json",
    content:
      "{\n" +
      "  \"include\": [\"**/*.ts\"],\n" +
      "  \"exclude\": [\"apps\"],\n" +
      "  \"compilerOptions\": {\n" +
      "    \"target\": \"ES2024\",\n" +
      "    \"module\": \"ESNext\",\n" +
      "    \"moduleResolution\": \"bundler\",\n" +
      "    \"allowImportingTsExtensions\": true,\n" +
      "    \"noEmit\": true,\n" +
      "    \"lib\": [\"ES2024\", \"ESNext.Disposable\"],\n" +
      "    \"types\": [\"@cloudflare/workers-types\"],\n" +
      "    \"skipLibCheck\": true,\n" +
      "    \"strict\": true\n" +
      "  }\n" +
      "}\n",
  },
  {
    path: "worker.ts",
    content:
      "import { DocsApp } from \"@iterate-com/docs\";\n" +
      "import { GithubAiLinter } from \"iterate/starter-apps/github-ai-linter\";\n" +
      "import { GuestbookApp } from \"iterate/starter-apps/guestbook\";\n" +
      "import { MediaApp } from \"iterate/starter-apps/media\";\n" +
      "import { NotesApp } from \"iterate/starter-apps/notes\";\n" +
      "import { IterateWorkerEntrypoint, type StreamEvent } from \"iterate/sdk\";\n" +
      "import { TodoApp } from \"iterate/starter-apps/todo\";\n" +
      "\n" +
      "// An iterate project is, in the abstract, just a fetch function.\n" +
      "// HTTP clients on the internet can send us Requests, and we will send responses and\n" +
      "// occasionally send HTTP requests outwards to the world to take influence on it.\n" +
      "//\n" +
      "// Internally, different parts of a project communicate by appending and subscribing to append-only\n" +
      "// event streams.\n" +
      "//\n" +
      "// Hence, the essence of an iterate project can be expressed as two functions:\n" +
      "// { fetch, processEvent }\n" +
      "\n" +
      "export default class ProjectWorker extends IterateWorkerEntrypoint {\n" +
      "  #aiLintApp = GithubAiLinter.create(this.env, {\n" +
      "    policyVersion: \"2\",\n" +
      "    rules: {\n" +
      "      paths: [\n" +
      "        \"rules/structure/no-small-single-use-helper.md\",\n" +
      "        \"rules/typescript/explain-type-cast.md\",\n" +
      "        \"rules/typescript/no-inferable-type-annotation.md\",\n" +
      "      ],\n" +
      "      repoPath: \"/repos/config\",\n" +
      "    },\n" +
      "  });\n" +
      "  #docsApp = DocsApp.create(this.env, {\n" +
      "    auth: { policy: \"project-member\" },\n" +
      "    proxy: {\n" +
      "      origin: \"https://docs.iterate.workers.dev\",\n" +
      "      originOverrideKvKey: \"docs-app-origin\",\n" +
      "    },\n" +
      "  });\n" +
      "  #guestbookApp = GuestbookApp.create(this.env);\n" +
      "  #mediaApp = MediaApp.create(this.env);\n" +
      "  #notesApp = NotesApp.create(this.env);\n" +
      "  #todoApp = TodoApp.create(this.env);\n" +
      "\n" +
      "  /** Agent-callable app helpers: `itx.worker.docs.link({ workspace, path })`\n" +
      "   * mints the document view, `link({ workspace, repo, task? })` the board. */\n" +
      "  get docs() {\n" +
      "    return this.#docsApp.rpc;\n" +
      "  }\n" +
      "\n" +
      "  /**\n" +
      "   * STANDING AGENT CONTEXT — the pattern to copy for any always-on knowledge.\n" +
      "   *\n" +
      "   * Every agent in this project carries the config repo's AGENTS.md as a\n" +
      "   * keyed context item: appended at agent birth, and re-synced to EVERY\n" +
      "   * agent whenever a config-repo commit lands. Covered keyed context is\n" +
      "   * append-only (an agent that already ran keeps old occurrences until\n" +
      "   * compaction), so the sync appends ONLY on a real change — it reads each\n" +
      "   * agent's current slot first, and a deleted AGENTS.md supersedes with a\n" +
      "   * tombstone rather than lingering forever. The idempotency key is unique\n" +
      "   * per TRANSITION (content hash + the occurrence it replaces): redeliveries\n" +
      "   * dedupe, reverting to earlier content still supersedes, and an edited\n" +
      "   * wrapper can never reuse a key with a different body.\n" +
      "   * dont-trigger-request means this never wakes an agent by itself. This\n" +
      "   * content rides every LLM request of every agent — keep AGENTS.md lean.\n" +
      "   * (Known narrow race: an agent born while a commit's fan-out is running\n" +
      "   * can end up one version behind until the next AGENTS.md change.)\n" +
      "   */\n" +
      "  async #syncAgentsMdContext(agentPaths: string[]): Promise<void> {\n" +
      "    if (!agentPaths.length) return;\n" +
      "    const itx = await this.itx;\n" +
      "    const file = await itx.repo.readFile({ path: \"AGENTS.md\" });\n" +
      "    const content = !file\n" +
      "      ? \"(AGENTS.md was deleted from /repos/config — no standing project notes.)\"\n" +
      "      : `Project AGENTS.md (auto-injected from /repos/config/AGENTS.md — commit updates there to teach every agent):\\n\\n${file.content}`;\n" +
      "    const digest = await crypto.subtle.digest(\"SHA-256\", new TextEncoder().encode(content));\n" +
      "    const hash = [...new Uint8Array(digest).slice(0, 8)]\n" +
      "      .map((byte) => byte.toString(16).padStart(2, \"0\"))\n" +
      "      .join(\"\");\n" +
      "    const results = await Promise.allSettled(\n" +
      "      agentPaths.map(async (path) => {\n" +
      "        const agent = itx.agents.get(path);\n" +
      "        const snapshot = await agent.processor.snapshot();\n" +
      "        const slot = snapshot.state.contextItems.findLast(\n" +
      "          (item) => item.payload.key === \"config/agents-md\",\n" +
      "        );\n" +
      "        if (slot?.payload.content === content) return;\n" +
      "        await agent.append({\n" +
      "          type: \"events.iterate.com/agents/context-added\",\n" +
      "          idempotencyKey: `iterate/config/agents-md:${hash}:after-${slot?.offset ?? 0}`,\n" +
      "          payload: {\n" +
      "            content,\n" +
      "            key: \"config/agents-md\",\n" +
      "            llmRequestPolicy: { behaviour: \"dont-trigger-request\" },\n" +
      "            // SYSTEM role on purpose: compaction keeps keyed system facts\n" +
      "            // (collapsed to the latest occurrence) — a developer item would\n" +
      "            // be dropped at the first compaction, and the unchanged-content\n" +
      "            // re-sync would then dedupe against the birth append forever.\n" +
      "            role: \"system\",\n" +
      "          },\n" +
      "        });\n" +
      "      }),\n" +
      "    );\n" +
      "    // Attempt every agent before failing: the batch is redelivered\n" +
      "    // at-least-once on a throw, and the per-transition keys turn retries of\n" +
      "    // the agents that DID land into no-ops.\n" +
      "    const failed = results.find((result) => result.status === \"rejected\");\n" +
      "    if (failed && failed.status === \"rejected\") throw failed.reason;\n" +
      "  }\n" +
      "\n" +
      "  /**\n" +
      "   * THE PROJECT'S PROMPT, published as data: the platform's generic\n" +
      "   * agent-creation door folds the LATEST agent-birth-defaults event on the\n" +
      "   * project root into every agent birth batch, so agents in this project are\n" +
      "   * BORN with this repo's prompts/agent-system-prompt.md as their system\n" +
      "   * prompt. Edit that file and commit to change it — the content-hash key\n" +
      "   * re-publishes and the newest event wins; no platform deploy. Deleting the\n" +
      "   * file publishes an EMPTY list, which restores the platform's embedded\n" +
      "   * fallback prompt (identical text until you fork the file). Rough token\n" +
      "   * budget: prompts ride every LLM request, so a much larger file mostly\n" +
      "   * buys latency and cost — keep it lean.\n" +
      "   */\n" +
      "  async #publishAgentBirthDefaults(): Promise<void> {\n" +
      "    const itx = await this.itx;\n" +
      "    const file = await itx.repo.readFile({ path: \"prompts/agent-system-prompt.md\" });\n" +
      "    const birthEvents = !file\n" +
      "      ? []\n" +
      "      : [\n" +
      "          {\n" +
      "            type: \"events.iterate.com/agents/context-added\",\n" +
      "            payload: {\n" +
      "              // The platform's embedded copy of this file is newline-stripped;\n" +
      "              // publishing the same normalization keeps \"unchanged file\" a\n" +
      "              // byte-identical no-op.\n" +
      "              content: file.content.replace(/\\n$/, \"\"),\n" +
      "              key: \"agent/system-prompt\",\n" +
      "              role: \"system\",\n" +
      "            },\n" +
      "          },\n" +
      "        ];\n" +
      "    // Best-effort size guard (~4 chars/token): the platform's own default\n" +
      "    // prompt is budget-tested at ~4.3k tokens; warn well before a fork's\n" +
      "    // edits silently double every request's cost.\n" +
      "    if (file && file.content.length > 6_000 * 4) {\n" +
      "      console.warn(\n" +
      "        `prompts/agent-system-prompt.md is ~${Math.round(file.content.length / 4)} tokens; ` +\n" +
      "          \"it rides every LLM request of every agent — consider trimming.\",\n" +
      "      );\n" +
      "    }\n" +
      "    const encoded = new TextEncoder().encode(JSON.stringify(birthEvents));\n" +
      "    const digest = await crypto.subtle.digest(\"SHA-256\", encoded);\n" +
      "    const hash = [...new Uint8Array(digest).slice(0, 8)]\n" +
      "      .map((byte) => byte.toString(16).padStart(2, \"0\"))\n" +
      "      .join(\"\");\n" +
      "    await itx.streams.get(\"/\").append({\n" +
      "      type: \"events.iterate.com/project/agent-birth-defaults-configured\",\n" +
      "      idempotencyKey: `iterate/config/agent-birth-defaults:${hash}`,\n" +
      "      payload: { birthEvents },\n" +
      "    });\n" +
      "  }\n" +
      "\n" +
      "  // The base class delivers committed events on ANY stream here at least once and in\n" +
      "  // per-stream order.\n" +
      "  protected override async processEvent(event: StreamEvent): Promise<void> {\n" +
      "    switch (event.type) {\n" +
      "      case \"events.iterate.com/agent/created\": {\n" +
      "        // The birth event on the agent's own stream (copies carry\n" +
      "        // source.copiedFrom and must not re-target the collection stream).\n" +
      "        if (event.source?.copiedFrom) break;\n" +
      "        await this.#syncAgentsMdContext([event.path]);\n" +
      "        break;\n" +
      "      }\n" +
      "      case \"events.iterate.com/repo/commit-completed\": {\n" +
      "        // Any config-repo commit MAY have changed AGENTS.md — the sync's\n" +
      "        // read-compare step turns the ones that didn't into no-ops.\n" +
      "        if (event.path !== \"/repos/config\") break;\n" +
      "        const itx = await this.itx;\n" +
      "        const agents = await itx.agents.list();\n" +
      "        await this.#syncAgentsMdContext(agents.map((agent) => agent.path));\n" +
      "        break;\n" +
      "      }\n" +
      "      case \"events.iterate.com/project/heartbeat-triggered\": {\n" +
      "        if (event.path !== \"/\") break;\n" +
      "        console.log(\"Project heartbeat fired\", { scheduleKey: event.payload?.scheduleKey });\n" +
      "        // Write arbitrary periodic work against itx here:\n" +
      "        // const itx = await this.itx;\n" +
      "        break;\n" +
      "      }\n" +
      "      case \"events.iterate.com/stream/woken\": {\n" +
      "        if (event.path !== \"/\") break;\n" +
      "        // Write arbitrary project-stream wake work against itx here:\n" +
      "        // const itx = await this.itx;\n" +
      "        break;\n" +
      "      }\n" +
      "      case \"events.iterate.com/project/worker-updated\": {\n" +
      "        if (event.path !== \"/\") break;\n" +
      "        // The platform appends this only after the current config worker has\n" +
      "        // built, loaded, and answered. Put arbitrary idempotent ITX calls\n" +
      "        // directly in this case.\n" +
      "        const itx = await this.itx;\n" +
      "        await itx.scheduler.set({\n" +
      "          key: \"iterate/config/heartbeat/every-15-minutes\",\n" +
      "          recurrence: { every: 15 * 60 },\n" +
      "          script: `async (itx, schedule, trigger) => {\n" +
      "            await itx.streams.get(\"/\").append({\n" +
      "              type: \"events.iterate.com/project/heartbeat-triggered\",\n" +
      "              idempotencyKey: \"iterate/config/heartbeat:\" + trigger.executionId,\n" +
      "              payload: { scheduleKey: schedule.key },\n" +
      "            });\n" +
      "          }`,\n" +
      "        });\n" +
      "        // Any commit MAY have changed the prompt file; unchanged content\n" +
      "        // dedupes on the content-hash key.\n" +
      "        await this.#publishAgentBirthDefaults();\n" +
      "        break;\n" +
      "      }\n" +
      "      default:\n" +
      "        break;\n" +
      "    }\n" +
      "\n" +
      "    await this.#aiLintApp.processEvent(event);\n" +
      "    await this.#guestbookApp.processEvent(event);\n" +
      "    await this.#mediaApp.processEvent(event);\n" +
      "    await this.#notesApp.processEvent(event);\n" +
      "  }\n" +
      "\n" +
      "  async fetch(req: Request): Promise<Response> {\n" +
      "    const app = req.headers.get(\"x-iterate-app\");\n" +
      "    if (app === \"todo\") {\n" +
      "      const itx = await this.itx;\n" +
      "      const authResponse = await itx.auth.get({ policy: \"project-member\" }).fetch(req);\n" +
      "      if (authResponse) return authResponse;\n" +
      "      return this.#todoApp.fetch(req);\n" +
      "    }\n" +
      "    if (app === \"guestbook\") {\n" +
      "      return this.#guestbookApp.fetch(req);\n" +
      "    }\n" +
      "    if (app === \"docs\") {\n" +
      "      return this.#docsApp.fetch(req);\n" +
      "    }\n" +
      "    if (app) return new Response(`unknown app: ${app}`, { status: 404 });\n" +
      "\n" +
      "    const url = new URL(req.url);\n" +
      "    const hostKind = req.headers.get(\"x-iterate-host-kind\");\n" +
      "    const appUrl = (slug: string) =>\n" +
      "      `${url.protocol}//${hostKind === \"custom\" ? `${slug}.${url.host}` : `${slug}--${url.host}`}/`;\n" +
      "    return new Response(\n" +
      "      `<!doctype html>\n" +
      "        <html>\n" +
      "          <body>\n" +
      "            <main>\n" +
      "              <p>Hello from your iterate project worker.</p>\n" +
      "              <ul>\n" +
      "                <li><a href=\"${appUrl(\"todo\")}\">todo</a> (LiveState + Cap'n Web, project members only)</li>\n" +
      "                <li><a href=\"${appUrl(\"guestbook\")}\">guestbook</a> (stream processor reduce on /guestbook, public)</li>\n" +
      "                <li><a href=\"${appUrl(\"docs\")}\">docs</a> (workspace documents and the task board, project members only)</li>\n" +
      "              </ul>\n" +
      "              <p>Edit worker.ts in the project repo to change this.</p>\n" +
      "            </main>\n" +
      "          </body>\n" +
      "        </html>`,\n" +
      "      { headers: { \"content-type\": \"text/html; charset=utf-8\" } },\n" +
      "    );\n" +
      "  }\n" +
      "}\n",
  },
];
// codegen:end
