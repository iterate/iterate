/** Built-in descriptions before context configuration adds masks or live providers. */
export const BUILT_IN_ROOT_DESCRIPTIONS = {
  whoami: "who this context is: `itx.whoami()` → { projectId, path }",
  url: "this project's public URL over HTTP — the apex or a routing slug's host, at a path: `url({ routingSlug?, path? })`; composed from this deployment's configured public origin",
  kv: "key-value strings, the project's own: `kv.get(k)` · `kv.put(k, v)` · `kv.list(prefix)` · `kv.delete(k)`",
  secrets:
    'names only, never values: `secrets.list()`; `secrets.collectFromUser({ path, egress, description?, fields? })` returns an authenticated collection link (`description` is markdown with links; `fields: [{ name, label }]` asks for a secret of several parts, saved as one JSON secret); a `getSecret("/secrets/x")` placeholder in an outbound request is substituted at egress; `secrets.verifyHmac(path, { payload, signature })` checks a webhook\'s HMAC-SHA256 hex signature without revealing the secret; `secrets.verifyEquals(path, { value })` checks a static header token a caller sent against the secret, constant-time, without revealing it; `secrets.beginOAuth(path, { authorizationEndpoint, tokenEndpoint, clientId, clientSecret, scope? })` → { authorizationUrl } (send the human there), its `clientSecret` a `getSecret("/secrets/x", { field })` placeholder for a client secret collected into a secret pinned to the token endpoint\'s origin (`clientId` is the ID itself)',
  integrations:
    "connect a provider through this deployment's app: `integrations.connect(provider, { scopes? })` → { authorizationUrl, connection } (send the human there); a person connects one of their own accounts to a project with `integrations.connect(provider, { account })` from their own session; `integrations.requestFromUser(provider, { scopes? })` → a Dash link asking a person to connect their account (or another) to this project, which then uses it as `/secrets/<provider>-<connection>`; `integrations.disconnect(provider, connection)` removes one",
  fetchRoutes:
    "which itx expression a request on this project's hosts goes to: `fetchRoutes.set(name, { requestMatcher: { routingSlug?, url?, headers? }, target, authRequirement?, priority? } | null)` · `list()` · `match({ url, headers })`; the platform serves a match from `route.target`, before the config worker's fetch",
  ai: "Workers AI, verbatim: `ai.run(model, inputs)`",
  browser: 'browser rendering: `browser.quickAction("markdown", { url })`',
  r2: "the object store, verbatim (`files` is the friendlier surface)",
  cfArtifacts: "the Artifacts binding, project-scoped (`repos` is the friendlier surface)",
  email:
    "the project's mail at `<slug>@<email domain>`: `email.send({ to, subject, text?, html?, from?, attachments?: [{ path }] })`, or `{ inReplyToOffset, text }` to answer a message; mail in and out lands on `/integrations/email`, threaded by its `email` facet",
  append: "write events to this log: `itx.append({ type, payload })`",
  schedules:
    "durable future appends: `schedules.set({ key, when, events })` · `schedules.cancel(key)`",
  readEvents: "read this log: `(await itx.readEvents(afterOffset, limit)).events`",
  waitForEvent: "block until an event lands: `waitForEvent({ type, afterOffset, timeoutMs })`",
  cd: "any context of the project, with every verb: `itx.cd('/').waitForEvent(…)`, `itx.cd('./sandbox').append({ type, payload })`; a jail's bare null refuses what reaches in",
  fetch: "the internet through the project's egress: `itx.fetch(new Request(url))`",
  rpcStubs: "live values clients lent here: `rpcStubs.list()` · `rpcStubs.get(key)`",
  rewriteRules: "this table, described: `await rewriteRules.list()`",
  facets:
    "a durable facet hosted here: `facets.get(name)` · `facets.abort(name, reason?)` resets that one facet",
  abort:
    "reset this context: its log and storage stay, its in-memory state, facets and sockets go — `itx.abort(reason?)`; another: `itx.cd(path).abort()`",
  subscriptions: "the rows delivered each commit: `subscriptions.list()`",
  processors: "hosted processors: `processors.enable(name, spec)` · `list()` · `disable(name)`",
  workers: "load code as a stateless worker: `workers.get({ source }).run()`",
  webhooks:
    'an HTTP webhook as a fan-out row\'s target: `subscribe({ target: "itx.webhooks.get({ url, signingSecret? }).deliverEvent", ordered: false })` POSTs each event, signed with the secret when one is named',
  run: 'a fresh confined run of a script you write as text: `itx.run("async (itx) => …")`',
  connectToMcp:
    "a live MCP handle: `(await itx.connectToMcp(url)).listTools()`, one method per tool",
  connectToOpenApi:
    "a live OpenAPI handle: one method per operationId, `call(operationId, input)` too",
  connectToCapnweb: "a live capnweb handle: `itx.connectToCapnweb(url)`, dotted calls pipelined",
  repos:
    "git on Artifacts; `/repos/config` is the project's code: `repos.get(path).readFile(f)` · `commitFiles({ message, changes, parent? })` with whole files (edit the text in your script: `replace`, a regex) · `repos.list()`",
  workspaces:
    "a private overlay over the repos: `workspaces.get(path).writeFile(f, text)` · `gitCommit({ message, scope })`",
  files:
    "project files: `files.get(path).put({ contentType, data })` · `.bytes()` · `.url()` · `files.list(prefix)`",
} as const satisfies Record<string, string>;

export type BuiltInRootName = keyof typeof BUILT_IN_ROOT_DESCRIPTIONS;

// Object.keys reads only this literal's own keys, but its TypeScript signature cannot retain them.
export const BUILT_IN_ROOT_NAMES = Object.keys(BUILT_IN_ROOT_DESCRIPTIONS) as BuiltInRootName[];

/** Roots a child context gets without an explicit parent rule. */
export const CONTEXT_BUILT_IN_ROOT_NAMES = [
  "whoami",
  "url",
  "append",
  "schedules",
  "readEvents",
  "waitForEvent",
  "cd",
  "rpcStubs",
  "rewriteRules",
  "facets",
  "abort",
  "subscriptions",
  "processors",
  "workers",
  "webhooks",
  "run",
] as const satisfies readonly BuiltInRootName[];

/** Roots that keep running against the context that received the call after a parent rule. */
export const PORTABLE_BUILT_IN_ROOT_NAMES = [
  "kv",
  "ai",
  "browser",
  "r2",
  "cfArtifacts",
  "email",
  "fetch",
  "connectToMcp",
  "connectToOpenApi",
  "connectToCapnweb",
  "repos",
  "workspaces",
  "files",
] as const satisfies readonly BuiltInRootName[];
