// The seeded project repo file map, generated from the REAL template folder at
// apps/os/config-repo-template (which typechecks as a worker project under
// apps/os). Edit the folder, then `pnpm lint --fix` regenerates this file;
// drift is a lint error. This file is oxfmt-ignored: the codegen preset owns
// its formatting.
// codegen:start {preset: custom, source: ./config-repo-template.codegen.cjs, export: projectRepoTemplateFiles}
export const PROJECT_REPO_INITIAL_FILES: Array<{ content: string; path: string }> = [
  {
    path: "AGENTS.md",
    content:
      "iterate project config repo — `worker.ts` is the project worker. It handles\n" +
      "HTTP and declares packaged apps such as `GithubAiLinter`, `GuestbookApp`, and\n" +
      "`TodoApp`; project-owned app source lives under `apps/`. The packaged linter\n" +
      "reads this project's editable policy from `rules/`.\n",
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
      "iterate project config repo — `worker.ts` is the project worker. It handles\n" +
      "HTTP and declares packaged apps such as `GithubAiLinter`, `GuestbookApp`, and\n" +
      "`TodoApp`; project-owned app source lives under `apps/`. The packaged linter\n" +
      "reads this project's editable policy from `rules/`.\n",
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
      "      glob: \"rules/**/*.md\",\n" +
      "      repoPath: \"/repos/config\",\n" +
      "    },\n" +
      "  });\n" +
      "  #guestbookApp = GuestbookApp.create(this.env);\n" +
      "  #todoApp = TodoApp.create(this.env);\n" +
      "\n" +
      "  // The base class delivers committed events on ANY stream here at least once and in\n" +
      "  // per-stream order.\n" +
      "  protected override async processEvent(event: StreamEvent): Promise<void> {\n" +
      "    await this.#aiLintApp.processEvent(event);\n" +
      "    await this.#guestbookApp.processEvent(event);\n" +
      "  }\n" +
      "\n" +
      "  async fetch(req: Request): Promise<Response> {\n" +
      "    const app = req.headers.get(\"x-iterate-app\");\n" +
      "    if (app === \"todo\") {\n" +
      "      using itx = await this.env.ITX.get();\n" +
      "      const authResponse = await itx.auth.get({ policy: \"project-member\" }).fetch(req);\n" +
      "      if (authResponse) return authResponse;\n" +
      "      return this.#todoApp.fetch(req);\n" +
      "    }\n" +
      "    if (app === \"guestbook\") {\n" +
      "      return this.#guestbookApp.fetch(req);\n" +
      "    }\n" +
      "    if (app === \"tasks\") {\n" +
      "      // Member-gated reverse proxy (pages, assets, WebSockets) to the hosted\n" +
      "      // tasks board (github.com/iterate/tasks), which authenticates each\n" +
      "      // visitor back to os.iterate.com. The kv knob targets a dev tunnel\n" +
      "      // while developing the tasks app itself.\n" +
      "      using itx = await this.env.ITX.get();\n" +
      "      const denied = await itx.auth.get({ policy: \"project-member\" }).fetch(req);\n" +
      "      if (denied) return denied;\n" +
      "      const tasksUrl = new URL(req.url);\n" +
      "      tasksUrl.protocol = \"https:\";\n" +
      "      const origin = await itx.kv.get(\"tasks-app-origin\");\n" +
      "      tasksUrl.host =\n" +
      "        typeof origin === \"string\" && origin !== \"\" ? origin : \"tasks.iterate.workers.dev\";\n" +
      "      return fetch(\n" +
      "        new Request(tasksUrl, {\n" +
      "          method: req.method,\n" +
      "          headers: req.headers,\n" +
      "          body: req.body,\n" +
      "          redirect: \"manual\",\n" +
      "        }),\n" +
      "      );\n" +
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
      "                <li><a href=\"${appUrl(\"tasks\")}\">tasks</a> (collaborative task board over tasks/, project members only)</li>\n" +
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
