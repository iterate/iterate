// Written for the LLM on the other end of the MCP connection: same tool-call
// stance as the agent system prompts (small data-first snippets), adapted for
// the request/response shape — here the return value IS the tool result.
export const EXEC_JS_DESCRIPTION = [
  "Execute JavaScript against an Iterate project. The code must be a single async arrow function: async (itx) => { ... }. Whatever it returns (JSON-serializable) is the tool result.",
  "",
  "Treat each call like a tool call, not a program: keep snippets small and single-purpose. Fetch data and RETURN it so you can look at it before deciding what to do next — do not pattern-match response shapes you have never seen, compose user-facing prose from unknown fields, or wrap calls in defensive try/catch (a thrown error comes back as the tool error, which is more useful than a hand-built { error } object). Return only what you need: pick fields, slice arrays.",
  "",
  "Use JavaScript for what separate calls cannot do: Promise.all to fan out independent requests concurrently, map/filter to trim big responses.",
  "",
  'Discovering the surface: `await itx.docs.search({ q: "several related words" })` finds e2e-tested example scripts, type declarations, and mounted capabilities (matching is dumb word overlap — more synonyms, better recall); `await itx.docs.get({ name })` fetches one — copy working example code instead of inventing calls. `await itx.__describe()` lists the project\'s capabilities (`children` is the member map) and works on every node, including provided capabilities. Web search is built in via Exa: `await itx.mcp.exa.web_search_exa({ query, numResults })`, page reading via `itx.mcp.exa.web_fetch_exa({ urls })`.',
  "",
  'Cloudflare platform bindings are under `itx.integrations.cf`: `cf.ai.toMarkdown({ name, blob })` for document-to-markdown conversion (`itx.ai.toMarkdown()` with no args lists supported formats), `itx.ai.run(model, input)` for Workers AI model calls (see examples `ai-generate-image`, `ai-generate-audio`, `ai-transcribe-audio`, `ai-generate-video`), `itx.browser.quickAction("markdown", { url })` or `itx.integrations.cf.browser.quickAction(...)` for Browser Run quick actions, `cf.images.transform(...)` for image transformations, and `cf.videos.transform(...)` for Media Transformations. Call child `__describe()` methods for first-party Cloudflare docs before using unfamiliar options.',
  "",
  'Repo edits without a sandbox: use `const repo = itx.repos.get(vars.repoPath ?? "/repos/config")`, inspect with `await repo.readFile({ path })`, then apply targeted changes with `await repo.edit({ path, message, oldString, newString })`. `oldString` must match exactly once unless `replaceAll: true`; use `commitFiles` for new files or batch/full-file writes. Reach for a sandbox (`itx.sandboxes.create({ name })` then `get(path)`) only when you need shell commands, tests, package managers, or servers.',
].join("\n");
