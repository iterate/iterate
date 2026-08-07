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
      "- `project/created` is the first userspace event. The root worker subscription\n" +
      "  is installed immediately before it in the same atomic append, so the seeded\n" +
      "  worker receives it after the platform creation saga has completed. This\n" +
      "  template uses it to create `/agents/onboarding`, install the template-local\n" +
      "  `ONBOARDING.md` prompt, trigger the agent's first turn, and navigate each\n" +
      "  connected `/clients/os-app/**` browser client that is still on the new\n" +
      "  project's landing page to its chat. A user who has already moved elsewhere\n" +
      "  is not interrupted by a delayed lifecycle delivery.\n" +
      "\n" +
      "`project/create-requested` remains platform-only: it precedes the userspace\n" +
      "worker subscription. The terminal `project/created` certificate includes the\n" +
      "birth configuration, including `config.configRepoTemplate` when the project\n" +
      "was created from a public template.\n" +
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
      "  tasks, tell the owner that their project is ready and summarize what you\n" +
      "  recorded. Onboarding completion is conversational; there is no platform\n" +
      "  onboarding state to update.\n" +
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
      "- `project/created` is the first userspace event. The root worker subscription\n" +
      "  is installed immediately before it in the same atomic append, so the seeded\n" +
      "  worker receives it after the platform creation saga has completed. This\n" +
      "  template uses it to create `/agents/onboarding`, install the template-local\n" +
      "  `ONBOARDING.md` prompt, trigger the agent's first turn, and navigate each\n" +
      "  connected `/clients/os-app/**` browser client that is still on the new\n" +
      "  project's landing page to its chat.\n" +
      "\n" +
      "`project/create-requested` remains platform-only: it precedes the userspace\n" +
      "worker subscription. The terminal `project/created` certificate includes the\n" +
      "birth configuration, including `config.configRepoTemplate` when the project\n" +
      "was created from a public template.\n" +
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
      "    if (agentPaths.length === 0) return;\n" +
      "    const itx = await this.itx;\n" +
      "    const file = await itx.repo.readFile({ path: \"AGENTS.md\" });\n" +
      "    const content =\n" +
      "      file === null\n" +
      "        ? \"(AGENTS.md was deleted from /repos/config — no standing project notes.)\"\n" +
      "        : `Project AGENTS.md (auto-injected from /repos/config/AGENTS.md — commit updates there to teach every agent):\\n\\n${file.content}`;\n" +
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
      "    if (failed !== undefined && failed.status === \"rejected\") throw failed.reason;\n" +
      "  }\n" +
      "\n" +
      "  // The base class delivers committed events on ANY stream here at least once and in\n" +
      "  // per-stream order.\n" +
      "  protected override async processEvent(event: StreamEvent): Promise<void> {\n" +
      "    switch (event.type) {\n" +
      "      case \"events.iterate.com/project/created\": {\n" +
      "        if (event.path !== \"/\") break;\n" +
      "        const itx = await this.itx;\n" +
      "        const instructions = await itx.repo.readFile({ path: \"ONBOARDING.md\" });\n" +
      "        if (instructions === null) {\n" +
      "          throw new Error(\"The default template enables onboarding but ONBOARDING.md is missing.\");\n" +
      "        }\n" +
      "\n" +
      "        const onboardingAgent = itx.agents.get(\"/agents/onboarding\");\n" +
      "        await onboardingAgent.create({ purpose: \"onboarding\", template: \"default\" });\n" +
      "        await onboardingAgent.append(\n" +
      "          {\n" +
      "            type: \"events.iterate.com/agents/context-added\",\n" +
      "            idempotencyKey: \"iterate/config/onboarding-instructions:v1\",\n" +
      "            payload: {\n" +
      "              role: \"system\",\n" +
      "              key: \"config/onboarding-instructions\",\n" +
      "              content: instructions.content,\n" +
      "              llmRequestPolicy: { behaviour: \"dont-trigger-request\" },\n" +
      "            },\n" +
      "          },\n" +
      "          {\n" +
      "            type: \"events.iterate.com/agents/context-added\",\n" +
      "            idempotencyKey: \"iterate/config/onboarding-start:v1\",\n" +
      "            payload: {\n" +
      "              role: \"developer\",\n" +
      "              key: \"config/onboarding-start\",\n" +
      "              content:\n" +
      "                \"Begin onboarding now. The project owner just created this project. Welcome them, then follow the onboarding instructions one question at a time.\",\n" +
      "              llmRequestPolicy: { behaviour: \"after-current-request\" },\n" +
      "            },\n" +
      "          },\n" +
      "        );\n" +
      "\n" +
      "        const [{ slug }, clients] = await Promise.all([itx.identity(), itx.clients.list()]);\n" +
      "        const projectHomePath = `/projects/${slug}`;\n" +
      "        const onboardingUrl = `/projects/${slug}/agents/streams/agents/onboarding`;\n" +
      "        await Promise.all(\n" +
      "          clients\n" +
      "            .filter((client) => client.connected && client.path.startsWith(\"/clients/os-app/\"))\n" +
      "            .map(async (client) => {\n" +
      "              const browserClient = itx.clients.get(client.path);\n" +
      "              const currentUrl = await browserClient.invokeCapability({\n" +
      "                path: [\"capabilities\", \"browser\", \"url\"],\n" +
      "              });\n" +
      "              if (\n" +
      "                typeof currentUrl !== \"string\" ||\n" +
      "                new URL(currentUrl).pathname.replace(/\\/$/, \"\") !== projectHomePath\n" +
      "              ) {\n" +
      "                return;\n" +
      "              }\n" +
      "              await browserClient.invokeCapability({\n" +
      "                path: [\"capabilities\", \"browser\", \"navigate\"],\n" +
      "                args: [onboardingUrl],\n" +
      "              });\n" +
      "            }),\n" +
      "        );\n" +
      "        break;\n" +
      "      }\n" +
      "      case \"events.iterate.com/agent/created\": {\n" +
      "        // The birth event on the agent's own stream (copies carry\n" +
      "        // source.copiedFrom and must not re-target the collection stream).\n" +
      "        if (event.source?.copiedFrom !== undefined) break;\n" +
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
      "        break;\n" +
      "      }\n" +
      "      default:\n" +
      "        break;\n" +
      "    }\n" +
      "\n" +
      "    await this.#aiLintApp.processEvent(event);\n" +
      "    await this.#guestbookApp.processEvent(event);\n" +
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
