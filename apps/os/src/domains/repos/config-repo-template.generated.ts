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
      "HTTP and declares packaged apps such as `GithubAiLinter`; project-owned app\n" +
      "source lives under `apps/`.\n",
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
      "HTTP and declares packaged apps such as `GithubAiLinter`; project-owned app\n" +
      "source lives under `apps/`.\n",
  },
  {
    path: "apps/guestbook/client.tsx",
    content:
      "/**\n" +
      " * Public guestbook UI. The provider owns the reconnectable Cap'n Web root;\n" +
      " * useLiveState consumes the nearest root.\n" +
      " */\n" +
      "import { newWebSocketRpcSession, type RpcStub } from \"iterate/sdk/capnweb\";\n" +
      "import React, { type FormEvent, useState } from \"react\";\n" +
      "import { createRoot } from \"react-dom/client\";\n" +
      "import { CapnWebProvider, useCapnWebRoot, useLiveState } from \"iterate/sdk/capnweb/react\";\n" +
      "import type { GuestbookApi } from \"./server.tsx\";\n" +
      "\n" +
      "function makeConnection() {\n" +
      "  const endpoint = new URL(\"/api\", window.location.href);\n" +
      "  endpoint.protocol = endpoint.protocol === \"https:\" ? \"wss:\" : \"ws:\";\n" +
      "  return newWebSocketRpcSession<GuestbookApi>(endpoint.toString());\n" +
      "}\n" +
      "\n" +
      "export function GuestbookClient() {\n" +
      "  const api = useCapnWebRoot<RpcStub<GuestbookApi>>();\n" +
      "  const { value: state, error: liveError } = useLiveState(\n" +
      "    (session: RpcStub<GuestbookApi>) => session.liveState,\n" +
      "    (s) => s,\n" +
      "  );\n" +
      "  const [name, setName] = useState(\"\");\n" +
      "  const [message, setMessage] = useState(\"\");\n" +
      "  const [signing, setSigning] = useState(false);\n" +
      "  const [signError, setSignError] = useState(\"\");\n" +
      "\n" +
      "  const error = liveError ?? (signError.length > 0 ? signError : undefined);\n" +
      "  const entries = state?.entries ?? [];\n" +
      "  // Only claim the configured title once reduced state has arrived — the\n" +
      "  // seeded-apps heading wait must not pass on the HTML shell alone.\n" +
      "  const title =\n" +
      "    state === undefined ? \"Loading…\" : (state.birthCertificate?.config.title ?? \"Guestbook\");\n" +
      "\n" +
      "  const sign = async (event: FormEvent) => {\n" +
      "    event.preventDefault();\n" +
      "    if (api == null) return;\n" +
      "    setSigning(true);\n" +
      "    setSignError(\"\");\n" +
      "    try {\n" +
      "      await api.sign(name, message);\n" +
      "      setMessage(\"\");\n" +
      "    } catch (cause) {\n" +
      "      setSignError(cause instanceof Error ? cause.message : String(cause));\n" +
      "    } finally {\n" +
      "      setSigning(false);\n" +
      "    }\n" +
      "  };\n" +
      "\n" +
      "  return (\n" +
      "    <>\n" +
      "      <h1>{title}</h1>\n" +
      "      <form onSubmit={sign}>\n" +
      "        <label htmlFor=\"name\">Name</label>\n" +
      "        <input\n" +
      "          id=\"name\"\n" +
      "          maxLength={80}\n" +
      "          onChange={(event) => setName(event.currentTarget.value)}\n" +
      "          required\n" +
      "          value={name}\n" +
      "        />\n" +
      "        <label htmlFor=\"message\">Message</label>\n" +
      "        <textarea\n" +
      "          id=\"message\"\n" +
      "          maxLength={500}\n" +
      "          onChange={(event) => setMessage(event.currentTarget.value)}\n" +
      "          required\n" +
      "          rows={4}\n" +
      "          value={message}\n" +
      "        />\n" +
      "        <button disabled={api == null || signing} type=\"submit\">\n" +
      "          Sign guestbook\n" +
      "        </button>\n" +
      "      </form>\n" +
      "      {error !== undefined && <p role=\"alert\">{error}</p>}\n" +
      "      {state === undefined ? (\n" +
      "        <p>Loading…</p>\n" +
      "      ) : entries.length === 0 ? (\n" +
      "        <p>No entries yet.</p>\n" +
      "      ) : (\n" +
      "        <section aria-label=\"Guestbook entries\">\n" +
      "          {/* Newest first; key on payload identity (not reversed index). */}\n" +
      "          {[...entries].reverse().map((entry) => (\n" +
      "            <article key={`${entry.signedAt}\\0${entry.name}\\0${entry.message}`}>\n" +
      "              <strong>{entry.name}</strong> <time dateTime={entry.signedAt}>{entry.signedAt}</time>\n" +
      "              <p>{entry.message}</p>\n" +
      "            </article>\n" +
      "          ))}\n" +
      "        </section>\n" +
      "      )}\n" +
      "    </>\n" +
      "  );\n" +
      "}\n" +
      "\n" +
      "const root = document.getElementById(\"root\");\n" +
      "if (root === null) throw new Error(\"missing #root\");\n" +
      "createRoot(root).render(\n" +
      "  <CapnWebProvider makeConnection={makeConnection}>\n" +
      "    <GuestbookClient />\n" +
      "  </CapnWebProvider>,\n" +
      ");\n",
  },
  {
    path: "apps/guestbook/processor.ts",
    content:
      "// The guestbook's stream processor: it folds the signatures on the project\n" +
      "// stream at /guestbook into a birth certificate plus an append-only list of\n" +
      "// entries. The reduce is the whole processor — pure fold, no side effects.\n" +
      "import { z } from \"zod\";\n" +
      "import { defineProcessorContract, StreamProcessor } from \"iterate/processors\";\n" +
      "import type { ProcessorState, ReduceArgs } from \"iterate/processors\";\n" +
      "\n" +
      "export const GuestbookProcessorContract = defineProcessorContract({\n" +
      "  slug: \"guestbook\",\n" +
      "  version: \"0.1.0\",\n" +
      "  description: \"Reduces guestbook signatures on /guestbook.\",\n" +
      "  stateSchema: z.object({\n" +
      "    birthCertificate: z\n" +
      "      .object({\n" +
      "        config: z.object({\n" +
      "          title: z.string().meta({ description: \"Display title shown on the public page.\" }),\n" +
      "        }),\n" +
      "      })\n" +
      "      .nullable()\n" +
      "      .default(null)\n" +
      "      .meta({\n" +
      "        description: \"Existence marker: null until guestbook/created reduces. Signing requires it.\",\n" +
      "      }),\n" +
      "    entries: z\n" +
      "      .array(\n" +
      "        z.object({\n" +
      "          name: z.string().meta({ description: \"Signer display name.\" }),\n" +
      "          message: z.string().meta({ description: \"Note left by the signer.\" }),\n" +
      "          signedAt: z\n" +
      "            .string()\n" +
      "            .meta({ description: \"ISO-8601 time from the stream event createdAt.\" }),\n" +
      "        }),\n" +
      "      )\n" +
      "      .default([])\n" +
      "      .meta({ description: \"Signatures in stream order (oldest first).\" }),\n" +
      "  }),\n" +
      "  events: {\n" +
      "    \"events.iterate.com/guestbook/created\": {\n" +
      "      description:\n" +
      "        \"The guestbook exists: its birth certificate, the first event in its domain history. \" +\n" +
      "        \"Appended (idempotency-keyed) by whoever signs first or opens the API.\",\n" +
      "      payloadSchema: z.object({\n" +
      "        config: z\n" +
      "          .object({\n" +
      "            title: z.string().meta({ description: \"Display title for the guestbook.\" }),\n" +
      "          })\n" +
      "          .meta({ description: \"Initial configuration.\" }),\n" +
      "      }),\n" +
      "      examples: [\n" +
      "        {\n" +
      "          description: \"A guestbook born with its display title.\",\n" +
      "          payload: { config: { title: \"Guestbook\" } },\n" +
      "        },\n" +
      "      ],\n" +
      "    },\n" +
      "    \"events.iterate.com/guestbook/entry-signed\": {\n" +
      "      description: \"Someone signed the guestbook: their name and message.\",\n" +
      "      payloadSchema: z.object({\n" +
      "        name: z.string().trim().min(1).meta({ description: \"Signer display name.\" }),\n" +
      "        message: z.string().trim().min(1).meta({ description: \"Note left by the signer.\" }),\n" +
      "      }),\n" +
      "      examples: [\n" +
      "        {\n" +
      "          description: \"A visitor left a note.\",\n" +
      "          payload: { name: \"Ada\", message: \"Lovely worker you have here.\" },\n" +
      "        },\n" +
      "      ],\n" +
      "    },\n" +
      "  },\n" +
      "  consumes: [\"events.iterate.com/guestbook/created\", \"events.iterate.com/guestbook/entry-signed\"],\n" +
      "  emits: [],\n" +
      "});\n" +
      "export type GuestbookProcessorContract = typeof GuestbookProcessorContract;\n" +
      "\n" +
      "export type GuestbookState = ProcessorState<GuestbookProcessorContract>;\n" +
      "\n" +
      "export class GuestbookProcessor extends StreamProcessor<GuestbookProcessorContract> {\n" +
      "  readonly contract = GuestbookProcessorContract;\n" +
      "\n" +
      "  protected override reduce({ event, state }: ReduceArgs<GuestbookProcessorContract>) {\n" +
      "    switch (event.type) {\n" +
      "      case \"events.iterate.com/guestbook/created\":\n" +
      "        // Idempotency-keyed at the source, but a duplicate that slips through\n" +
      "        // folds to a no-op rather than wedging the frame.\n" +
      "        if (state.birthCertificate !== null) return state;\n" +
      "        return { ...state, birthCertificate: event.payload };\n" +
      "      case \"events.iterate.com/guestbook/entry-signed\":\n" +
      "        return {\n" +
      "          ...state,\n" +
      "          entries: [...state.entries, { ...event.payload, signedAt: event.createdAt }],\n" +
      "        };\n" +
      "      default:\n" +
      "        return state;\n" +
      "    }\n" +
      "  }\n" +
      "}\n",
  },
  {
    path: "apps/guestbook/ref.ts",
    content:
      "// The guestbook's shared identity, dependency-free on purpose: worker.ts\n" +
      "// routes to this ref, and the wake subscription in the creation batch below\n" +
      "// persists the same ref — so ingress and the stream spine always dial the\n" +
      "// same Durable Object.\n" +
      "import type { StreamEventInput } from \"iterate/processors\";\n" +
      "import type { StatefulDynamicWorkerRef } from \"iterate/sdk\";\n" +
      "\n" +
      "export const guestbookStreamPath = \"/guestbook\";\n" +
      "\n" +
      "export const guestbookAppRef = {\n" +
      "  className: \"GuestbookApp\",\n" +
      "  // \"-stream\" keeps clear of a retired predecessor's durable identity.\n" +
      "  durableWorkerKey: \"app-guestbook-stream\",\n" +
      "  path: \"/\",\n" +
      "  source: {\n" +
      "    createApp: {\n" +
      "      client: \"apps/guestbook/client.tsx\",\n" +
      "      files: { type: \"repo\", repoPath: \"/repos/config\" },\n" +
      "      server: \"apps/guestbook/server.tsx\",\n" +
      "    },\n" +
      "  },\n" +
      "  type: \"stateful\",\n" +
      "} satisfies StatefulDynamicWorkerRef;\n" +
      "\n" +
      "/**\n" +
      " * The guestbook's creation batch: the birth certificate plus the durable WAKE\n" +
      " * subscription that puts GuestbookApp on the stream's delivery spine.\n" +
      " * Initialization is lazy and only matters when something consumes the fold:\n" +
      " * the `/api` socket every page opens offers this batch, and so does a direct\n" +
      " * `sign()`. (A bare GET of `/` serves only the static shell — its client then\n" +
      " * opens `/api`, which initializes; a GET that never opens the socket has\n" +
      " * nothing reading the subscription, so leaving it unconfigured is correct.)\n" +
      " * The idempotency keys collapse duplicate offers. Bump the subscription key's\n" +
      " * version whenever the persisted delivery expression changes.\n" +
      " */\n" +
      "export function guestbookCreationEvents(): StreamEventInput[] {\n" +
      "  return [\n" +
      "    {\n" +
      "      type: \"events.iterate.com/guestbook/created\",\n" +
      "      payload: { config: { title: \"Guestbook\" } },\n" +
      "      idempotencyKey: \"guestbook/created\",\n" +
      "    },\n" +
      "    {\n" +
      "      type: \"events.iterate.com/stream/subscription-configured\",\n" +
      "      payload: {\n" +
      "        subscriptionKey: \"app-guestbook#guestbook\",\n" +
      "        delivery: {\n" +
      "          mode: \"wake\",\n" +
      "          expression: [\"workers\", [\"get\", guestbookAppRef], \"processor\", \"wakeStreamSubscriber\"],\n" +
      "          // Must match GuestbookProcessorContract.slug (processor.ts); a\n" +
      "          // string literal because this module stays dependency-free.\n" +
      "          processorSlug: \"guestbook\",\n" +
      "        },\n" +
      "      },\n" +
      "      idempotencyKey: \"guestbook/subscription:v1\",\n" +
      "    },\n" +
      "  ];\n" +
      "}\n",
  },
  {
    path: "apps/guestbook/server.tsx",
    content:
      "import {\n" +
      "  LiveStateRpcTarget,\n" +
      "  RpcTarget,\n" +
      "  newWorkersWebSocketRpcResponse,\n" +
      "  type LiveStateRpc,\n" +
      "} from \"iterate/sdk/capnweb\";\n" +
      "import type { StreamProcessorRegistry } from \"iterate/processors/cloudflare\";\n" +
      "import { IterateDurableObject, createProcessorHost } from \"iterate/sdk\";\n" +
      "import { guestbookCreationEvents, guestbookStreamPath } from \"./ref.ts\";\n" +
      "import { GuestbookProcessor, type GuestbookState } from \"./processor.ts\";\n" +
      "\n" +
      "/** One createApp Durable Object owns the page, API, processor, and live value. */\n" +
      "export class GuestbookApp extends IterateDurableObject {\n" +
      "  #host = createProcessorHost<GuestbookState>({\n" +
      "    ctx: this.ctx,\n" +
      "    env: this.env,\n" +
      "    path: guestbookStreamPath,\n" +
      "    createProcessor: (deps) => new GuestbookProcessor(deps),\n" +
      "  });\n" +
      "\n" +
      "  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {\n" +
      "    await this.#host.handleAlarm(alarmInfo);\n" +
      "  }\n" +
      "\n" +
      "  /** The wake door the stream spine dials — the subscription's persisted\n" +
      "   * expression is `workers.get(ref).processor.wakeStreamSubscriber`. */\n" +
      "  get processor() {\n" +
      "    return this.#host.wakeSubscriber;\n" +
      "  }\n" +
      "\n" +
      "  /** Lazily initialize the stream: an empty fold means nobody has offered the\n" +
      "   * birth certificate + wake subscription yet. Called from the two paths that\n" +
      "   * actually consume the fold — the `/api` socket and `sign()` — never from a\n" +
      "   * bare GET, which only serves the static shell (whose client then opens\n" +
      "   * `/api`). The batch is idempotency-keyed, so every caller may offer it. */\n" +
      "  async #ensureInitialized(): Promise<StreamProcessorRegistry<GuestbookState>> {\n" +
      "    const registry = await this.#host.registry();\n" +
      "    await registry.catchUp(\"guestbook\");\n" +
      "    if ((await this.#host.snapshot()).state.birthCertificate === null) {\n" +
      "      using project = await this.env.ITX.get();\n" +
      "      await project.streams.get(guestbookStreamPath).append(...guestbookCreationEvents());\n" +
      "      await registry.catchUp(\"guestbook\");\n" +
      "    }\n" +
      "    return registry;\n" +
      "  }\n" +
      "\n" +
      "  async sign(name: string, message: string): Promise<void> {\n" +
      "    const trimmedName = name.trim().slice(0, 80);\n" +
      "    const trimmedMessage = message.trim().slice(0, 500);\n" +
      "    if (trimmedName.length === 0 || trimmedMessage.length === 0) {\n" +
      "      throw new TypeError(\"Name and message are required\");\n" +
      "    }\n" +
      "    const registry = await this.#ensureInitialized();\n" +
      "    using project = await this.env.ITX.get();\n" +
      "    await project.streams.get(guestbookStreamPath).append({\n" +
      "      type: \"events.iterate.com/guestbook/entry-signed\",\n" +
      "      payload: { message: trimmedMessage, name: trimmedName },\n" +
      "      idempotencyKey: `guestbook/entry:${crypto.randomUUID()}`,\n" +
      "    });\n" +
      "    await registry.catchUp(\"guestbook\");\n" +
      "    registry.refreshLive();\n" +
      "  }\n" +
      "\n" +
      "  async fetch(request: Request): Promise<Response> {\n" +
      "    const url = new URL(request.url);\n" +
      "    if (url.pathname === \"/api\") {\n" +
      "      const registry = await this.#ensureInitialized();\n" +
      "      await registry.loadAndRefreshLive();\n" +
      "      return newWorkersWebSocketRpcResponse(request, new GuestbookApi(this, registry));\n" +
      "    }\n" +
      "    if (request.method !== \"GET\" || url.pathname !== \"/\") {\n" +
      "      return new Response(\"not found\", { status: 404 });\n" +
      "    }\n" +
      "    return new Response(\n" +
      "      `<!doctype html>\n" +
      "<html lang=\"en\">\n" +
      "  <head>\n" +
      "    <meta charset=\"utf-8\">\n" +
      "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
      "    <title>Guestbook</title>\n" +
      "    <style>\n" +
      "      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }\n" +
      "      body { margin: 0; padding: 2rem; }\n" +
      "      main { margin: 0 auto; max-width: 38rem; }\n" +
      "      form { display: grid; gap: .75rem; }\n" +
      "      input, textarea, button { font: inherit; padding: .6rem; }\n" +
      "      article { border-block-start: 1px solid #8886; margin-block-start: 1.25rem; padding-block-start: 1rem; }\n" +
      "      time { opacity: .65; }\n" +
      "      [role=\"alert\"] { color: #c33; }\n" +
      "    </style>\n" +
      "  </head>\n" +
      "  <body>\n" +
      "    <main id=\"root\"><p>Loading…</p></main>\n" +
      "    <script type=\"module\" src=\"/apps/guestbook/client.js\"></script>\n" +
      "  </body>\n" +
      "</html>`,\n" +
      "      {\n" +
      "        headers: {\n" +
      "          \"content-type\": \"text/html; charset=utf-8\",\n" +
      "          \"x-content-type-options\": \"nosniff\",\n" +
      "        },\n" +
      "      },\n" +
      "    );\n" +
      "  }\n" +
      "}\n" +
      "\n" +
      "export class GuestbookApi extends RpcTarget {\n" +
      "  readonly #liveState: LiveStateRpcTarget<GuestbookState>;\n" +
      "\n" +
      "  constructor(\n" +
      "    private readonly app: GuestbookApp,\n" +
      "    registry: StreamProcessorRegistry<GuestbookState>,\n" +
      "  ) {\n" +
      "    super();\n" +
      "    this.#liveState = new LiveStateRpcTarget(registry);\n" +
      "  }\n" +
      "\n" +
      "  get liveState(): LiveStateRpc<GuestbookState> {\n" +
      "    return this.#liveState;\n" +
      "  }\n" +
      "\n" +
      "  async sign(name: string, message: string): Promise<void> {\n" +
      "    await this.app.sign(name, message);\n" +
      "  }\n" +
      "}\n",
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
    path: "apps/todo/client.tsx",
    content:
      "/**\n" +
      " * Todo UI — one reconnectable Cap'n Web provider, consumed by useLiveState.\n" +
      " */\n" +
      "import { newWebSocketRpcSession, type RpcStub } from \"iterate/sdk/capnweb\";\n" +
      "import React, { type FormEvent, useState } from \"react\";\n" +
      "import { createRoot } from \"react-dom/client\";\n" +
      "import { CapnWebProvider, useCapnWebRoot, useLiveState } from \"iterate/sdk/capnweb/react\";\n" +
      "import type { TodoApi } from \"./server.tsx\";\n" +
      "\n" +
      "function makeConnection() {\n" +
      "  const endpoint = new URL(\"/api\", window.location.href);\n" +
      "  endpoint.protocol = endpoint.protocol === \"https:\" ? \"wss:\" : \"ws:\";\n" +
      "  return newWebSocketRpcSession<TodoApi>(endpoint.toString());\n" +
      "}\n" +
      "\n" +
      "export function TodoClient() {\n" +
      "  const api = useCapnWebRoot<RpcStub<TodoApi>>();\n" +
      "  const { value: state, error: liveError } = useLiveState(\n" +
      "    (session: RpcStub<TodoApi>) => session.liveState,\n" +
      "    (s) => s,\n" +
      "  );\n" +
      "  const [title, setTitle] = useState(\"\");\n" +
      "  const [actionError, setActionError] = useState(\"\");\n" +
      "  const [pendingMutations, setPendingMutations] = useState(0);\n" +
      "  const mutating = pendingMutations > 0;\n" +
      "\n" +
      "  const error = liveError ?? (actionError.length > 0 ? actionError : undefined);\n" +
      "  const todos = state?.todos ?? [];\n" +
      "\n" +
      "  const run = async (action: () => Promise<void>) => {\n" +
      "    setActionError(\"\");\n" +
      "    setPendingMutations((current) => current + 1);\n" +
      "    try {\n" +
      "      await action();\n" +
      "    } catch (cause) {\n" +
      "      setActionError(cause instanceof Error ? cause.message : String(cause));\n" +
      "    } finally {\n" +
      "      setPendingMutations((current) => current - 1);\n" +
      "    }\n" +
      "  };\n" +
      "\n" +
      "  const add = async (event: FormEvent) => {\n" +
      "    event.preventDefault();\n" +
      "    if (api == null || title.trim().length === 0) return;\n" +
      "    const next = title;\n" +
      "    setTitle(\"\");\n" +
      "    await run(() => api.add(next));\n" +
      "  };\n" +
      "\n" +
      "  return (\n" +
      "    <>\n" +
      "      <h1>Todo</h1>\n" +
      "      <form onSubmit={add}>\n" +
      "        <input\n" +
      "          aria-label=\"New todo\"\n" +
      "          id=\"new-todo\"\n" +
      "          maxLength={200}\n" +
      "          onChange={(event) => setTitle(event.currentTarget.value)}\n" +
      "          placeholder=\"What needs doing?\"\n" +
      "          required\n" +
      "          type=\"text\"\n" +
      "          value={title}\n" +
      "        />\n" +
      "        <button disabled={api == null || mutating} type=\"submit\">\n" +
      "          Add\n" +
      "        </button>\n" +
      "      </form>\n" +
      "      {mutating && (\n" +
      "        <p aria-live=\"polite\" data-spinner=\"true\" role=\"status\">\n" +
      "          Saving…\n" +
      "        </p>\n" +
      "      )}\n" +
      "      {error !== undefined && <p role=\"alert\">{error}</p>}\n" +
      "      {state === undefined ? (\n" +
      "        <p>Loading…</p>\n" +
      "      ) : todos.length === 0 ? (\n" +
      "        <p>No todos yet.</p>\n" +
      "      ) : (\n" +
      "        <ul>\n" +
      "          {todos.map((todo) => (\n" +
      "            <li key={todo.id}>\n" +
      "              <input\n" +
      "                aria-label={`Mark ${todo.title} ${todo.done ? \"not done\" : \"done\"}`}\n" +
      "                checked={todo.done}\n" +
      "                disabled={mutating}\n" +
      "                onChange={(event) => {\n" +
      "                  const done = event.currentTarget.checked;\n" +
      "                  if (api == null) return;\n" +
      "                  void run(() => api.setDone(todo.id, done));\n" +
      "                }}\n" +
      "                type=\"checkbox\"\n" +
      "              />\n" +
      "              <span className={todo.done ? \"done\" : \"\"}>{todo.title}</span>\n" +
      "              <button\n" +
      "                disabled={mutating}\n" +
      "                onClick={() => {\n" +
      "                  if (api == null) return;\n" +
      "                  void run(() => api.remove(todo.id));\n" +
      "                }}\n" +
      "                type=\"button\"\n" +
      "              >\n" +
      "                Delete\n" +
      "              </button>\n" +
      "            </li>\n" +
      "          ))}\n" +
      "        </ul>\n" +
      "      )}\n" +
      "    </>\n" +
      "  );\n" +
      "}\n" +
      "\n" +
      "const root = document.getElementById(\"root\");\n" +
      "if (root === null) throw new Error(\"missing #root\");\n" +
      "createRoot(root).render(\n" +
      "  <CapnWebProvider makeConnection={makeConnection}>\n" +
      "    <TodoClient />\n" +
      "  </CapnWebProvider>,\n" +
      ");\n",
  },
  {
    path: "apps/todo/server.tsx",
    content:
      "import {\n" +
      "  LiveState,\n" +
      "  LiveStateRpcTarget,\n" +
      "  RpcTarget,\n" +
      "  newWorkersWebSocketRpcResponse,\n" +
      "  type LiveStateRpc,\n" +
      "} from \"iterate/sdk/capnweb\";\n" +
      "import { IterateDurableObject } from \"iterate/sdk\";\n" +
      "\n" +
      "export type Todo = {\n" +
      "  createdAt: string;\n" +
      "  done: boolean;\n" +
      "  id: string;\n" +
      "  title: string;\n" +
      "};\n" +
      "\n" +
      "type TodoListState = { todos: Todo[] };\n" +
      "\n" +
      "/** One createApp Durable Object owns the page, API, persistence, and live value. */\n" +
      "export class TodoApp extends IterateDurableObject {\n" +
      "  readonly #live: LiveState<TodoListState>;\n" +
      "\n" +
      "  constructor(...args: ConstructorParameters<typeof IterateDurableObject>) {\n" +
      "    super(...args);\n" +
      "    this.ctx.storage.sql.exec(`\n" +
      "      CREATE TABLE IF NOT EXISTS todos (\n" +
      "        id TEXT PRIMARY KEY,\n" +
      "        title TEXT NOT NULL,\n" +
      "        done INTEGER NOT NULL DEFAULT 0,\n" +
      "        created_at TEXT NOT NULL\n" +
      "      )\n" +
      "    `);\n" +
      "    this.#live = new LiveState<TodoListState>({ todos: this.#load() });\n" +
      "  }\n" +
      "\n" +
      "  #load(): Todo[] {\n" +
      "    return this.ctx.storage.sql\n" +
      "      .exec<{ created_at: string; done: number; id: string; title: string }>(\n" +
      "        \"SELECT id, title, done, created_at FROM todos ORDER BY created_at, id\",\n" +
      "      )\n" +
      "      .toArray()\n" +
      "      .map((row) => ({\n" +
      "        createdAt: row.created_at,\n" +
      "        done: row.done !== 0,\n" +
      "        id: row.id,\n" +
      "        title: row.title,\n" +
      "      }));\n" +
      "  }\n" +
      "\n" +
      "  #refresh(): void {\n" +
      "    this.#live.setState({ todos: this.#load() });\n" +
      "  }\n" +
      "\n" +
      "  add(title: string): void {\n" +
      "    const trimmed = title.trim().slice(0, 200);\n" +
      "    if (trimmed.length === 0) return;\n" +
      "    this.ctx.storage.sql.exec(\n" +
      "      \"INSERT INTO todos (id, title, done, created_at) VALUES (?, ?, 0, ?)\",\n" +
      "      crypto.randomUUID(),\n" +
      "      trimmed,\n" +
      "      new Date().toISOString(),\n" +
      "    );\n" +
      "    this.#refresh();\n" +
      "  }\n" +
      "\n" +
      "  setDone(id: string, done: boolean): void {\n" +
      "    this.ctx.storage.sql.exec(\"UPDATE todos SET done = ? WHERE id = ?\", done ? 1 : 0, id);\n" +
      "    this.#refresh();\n" +
      "  }\n" +
      "\n" +
      "  remove(id: string): void {\n" +
      "    this.ctx.storage.sql.exec(\"DELETE FROM todos WHERE id = ?\", id);\n" +
      "    this.#refresh();\n" +
      "  }\n" +
      "\n" +
      "  async fetch(request: Request): Promise<Response> {\n" +
      "    const url = new URL(request.url);\n" +
      "    if (url.pathname === \"/api\") {\n" +
      "      return newWorkersWebSocketRpcResponse(request, new TodoApi(this, this.#live));\n" +
      "    }\n" +
      "    if (request.method !== \"GET\" || url.pathname !== \"/\") {\n" +
      "      return new Response(\"not found\", { status: 404 });\n" +
      "    }\n" +
      "    return new Response(\n" +
      "      `<!doctype html>\n" +
      "<html lang=\"en\">\n" +
      "  <head>\n" +
      "    <meta charset=\"utf-8\">\n" +
      "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
      "    <title>Todo</title>\n" +
      "    <style>\n" +
      "      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }\n" +
      "      body { margin: 0; padding: 2rem; }\n" +
      "      main { margin: 0 auto; max-width: 38rem; }\n" +
      "      form, li { display: flex; gap: .75rem; margin-block: .75rem; }\n" +
      "      input[type=\"text\"] { flex: 1; padding: .6rem; }\n" +
      "      button { padding: .45rem .75rem; }\n" +
      "      .done { text-decoration: line-through; opacity: .65; }\n" +
      "      [role=\"alert\"] { color: #c33; }\n" +
      "    </style>\n" +
      "  </head>\n" +
      "  <body>\n" +
      "    <main id=\"root\"><p>Loading…</p></main>\n" +
      "    <script type=\"module\" src=\"/apps/todo/client.js\"></script>\n" +
      "  </body>\n" +
      "</html>`,\n" +
      "      {\n" +
      "        headers: {\n" +
      "          \"content-type\": \"text/html; charset=utf-8\",\n" +
      "          \"x-content-type-options\": \"nosniff\",\n" +
      "        },\n" +
      "      },\n" +
      "    );\n" +
      "  }\n" +
      "}\n" +
      "\n" +
      "export class TodoApi extends RpcTarget {\n" +
      "  readonly #liveState: LiveStateRpcTarget<TodoListState>;\n" +
      "\n" +
      "  constructor(\n" +
      "    private readonly app: TodoApp,\n" +
      "    live: LiveState<TodoListState>,\n" +
      "  ) {\n" +
      "    super();\n" +
      "    this.#liveState = new LiveStateRpcTarget(live);\n" +
      "  }\n" +
      "\n" +
      "  get liveState(): LiveStateRpc<TodoListState> {\n" +
      "    return this.#liveState;\n" +
      "  }\n" +
      "\n" +
      "  async add(title: string): Promise<void> {\n" +
      "    this.app.add(title);\n" +
      "  }\n" +
      "\n" +
      "  async setDone(id: string, done: boolean): Promise<void> {\n" +
      "    this.app.setDone(id, done);\n" +
      "  }\n" +
      "\n" +
      "  async remove(id: string): Promise<void> {\n" +
      "    this.app.remove(id);\n" +
      "  }\n" +
      "}\n",
  },
  {
    path: "apps/todo/tsconfig.json",
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
      "  \"description\": \"Iterate project worker and bundled full-stack apps.\",\n" +
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
      "import { GithubAiLinter } from \"iterate/github-ai-linter\";\n" +
      "import { IterateWorkerEntrypoint, type StreamEvent } from \"iterate/sdk\";\n" +
      "import { guestbookAppRef } from \"./apps/guestbook/ref.ts\";\n" +
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
      "  #aiLintApp = GithubAiLinter.create({\n" +
      "    policyVersion: \"2\",\n" +
      "    rules: {\n" +
      "      glob: \"rules/**/*.md\",\n" +
      "      repoPath: \"/repos/iterate\",\n" +
      "    },\n" +
      "  });\n" +
      "\n" +
      "  // The base class delivers committed events on ANY stream here at least once and in\n" +
      "  // per-stream order.\n" +
      "  protected override async processEvent(event: StreamEvent): Promise<void> {\n" +
      "    await this.#aiLintApp.processEvent(event, this.env);\n" +
      "  }\n" +
      "\n" +
      "  async fetch(req: Request): Promise<Response> {\n" +
      "    const app = req.headers.get(\"x-iterate-app\");\n" +
      "    if (app === \"todo\") {\n" +
      "      using itx = await this.env.ITX.get();\n" +
      "      const authResponse = await itx.auth.get({ policy: \"project-member\" }).fetch(req);\n" +
      "      if (authResponse) return authResponse;\n" +
      "      return this.fetchDynamicWorker(req, {\n" +
      "        type: \"stateful\",\n" +
      "        className: \"TodoApp\",\n" +
      "        // \"-live\" keeps clear of a retired predecessor's durable identity.\n" +
      "        durableWorkerKey: \"app-todo-live\",\n" +
      "        path: \"/\",\n" +
      "        source: {\n" +
      "          createApp: {\n" +
      "            client: \"apps/todo/client.tsx\",\n" +
      "            files: { type: \"repo\", repoPath: \"/repos/config\" },\n" +
      "            server: \"apps/todo/server.tsx\",\n" +
      "          },\n" +
      "        },\n" +
      "      });\n" +
      "    }\n" +
      "    if (app === \"guestbook\") {\n" +
      "      return this.fetchDynamicWorker(req, guestbookAppRef);\n" +
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
