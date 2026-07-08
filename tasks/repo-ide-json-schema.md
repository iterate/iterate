---
status: in-progress
size: medium
branch: repo-ide-json-schema
---

# Repo IDE: JSON/YAML json-schema support

## Status summary

Done. Implemented, unit-tested (12 egress-free specs), and verified live in local dev via playwright: squigglies + hover + schema autocomplete for package.json/tsconfig/$schema/yaml-modeline/workflow files, plus graceful "schema unavailable" degradation with schemastore blocked. Notable find: an upstream codemirror-json-schema bug (squigglies land on the `:` with @lezer/json 1.0.3) worked around with a wrapped parser. Known limitation: json-schema-library doesn't descend into the github-workflow schema's `oneOf` job definitions, so deep workflow errors don't surface (top-level ones do).

## Ask (verbatim, from Misha — spinoff 4 of the repos mini IDE task)

> **JSON and YAML json-schema support.** Support the `"$schema"` top-level prop, apply it to get red squigglies. Have certain well-known schemas like tsconfig.json and package.json.

## Design decisions (assumptions marked ⚠️)

- **Library**: `codemirror-json-schema` (modular API, not the bundled `jsonSchema()`/`yamlSchema()` helpers — those include `json()`/`yaml()` language extensions which `SourceCodeBlock` already provides). We wire `linter(jsonSchemaLinter())` + hover + completion + `stateExtensions(schema)` ourselves. Red squigglies via `@codemirror/lint` are the core deliverable; hover and autocomplete come free with the same wiring, so they're on. For JSON we also add `linter(jsonParseLinter())` (syntax errors), mirroring the upstream bundle.
- **Placement**: everything lives in `apps/os/src/components/repo-ide/` and flows into the editor via the existing `codeMirrorExtensions` prop on `SourceCodeBlock`. ⚠️ Deliberately _not_ a new packages/ui surface: `codeMirrorExtensions` already _is_ the opt-in extension surface (precedent: the itx repl's TypeScript worker extensions are wired exactly this way from apps/os), the filename→schema policy is repo-IDE product logic, and `codemirror-json-schema` drags in markdown-it/shiki which shouldn't ride along with `@iterate-com/ui` for every consumer. The repo IDE is already a lazy chunk, so the weight lands there.
- **Egress**: ⚠️ schemas are fetched client-side from `www.schemastore.org` (browser egress from the dashboard, not worker egress) via tanstack query with `staleTime: Infinity` and one retry. Verified: schemastore serves `access-control-allow-origin: *`. Vendoring is the wrong call — the tsconfig schema alone is 435KB. Fetch failure is graceful: no squigglies, no crash, a muted "schema unavailable" note in the file header.
- **Well-known map**: ⚠️ a small hardcoded filename→URL map rather than fetching schemastore's ~700-entry catalog and glob-matching it (more egress + more code for marginal benefit):
  - `package.json` → `https://www.schemastore.org/package.json`
  - `tsconfig*.json` → `https://www.schemastore.org/tsconfig.json`
  - `jsconfig*.json` → `https://www.schemastore.org/jsconfig.json`
  - `pnpm-workspace.yaml` → `https://www.schemastore.org/pnpm-workspace.json`
  - `.github/workflows/*.yml|yaml` → `https://www.schemastore.org/github-workflow.json`
- **`$schema` prop wins** over the filename map. Extracted from the _current buffer_ (so adding a `$schema` line applies immediately, pre-commit): `JSON.parse` when the doc parses, with a regex fallback so the association doesn't flicker away while the doc is mid-edit invalid. Only absolute `http(s)` URLs are honored — relative `$schema` paths (repo-local schemas) are out of scope.
- **YAML modeline**: the `# yaml-language-server: $schema=<url>` comment convention is supported (cheap regex), and wins over the filename map, matching vscode-yaml behavior.
- **Where it applies**: the editable text editor and the readonly staged (Index) view. ⚠️ Diagnostics also render inside diff mode since it's the same editor — acceptable, that's what vscode does too.
- **Indicator**: while a schema is active the file header shows a muted schema name (title attribute = URL); on fetch failure, muted "schema unavailable". Nothing for files with no schema association.
- **Editor recreation caveat**: ⚠️ `SourceCodeBlock` rebuilds the CodeMirror view when extensions change (schema arriving after fetch, or the `$schema` URL being edited). To keep that from being jarring, the rebuild now preserves the selection — a small, generally-useful fix in packages/ui (this also fixes cursor loss when toggling diff view).

## Checklist

- [x] `repo-json-schema.ts`: schema URL resolution policy (`$schema` prop > YAML modeline > well-known filename map) — _`repoFileSchemaUrl`; JSON.parse with regex fallback for mid-edit docs; http→https upgrade_
- [x] `repo-json-schema.ts`: codemirror extension bundle (lint + hover + completion + state) for json and yaml — _`jsonSchemaCodeMirrorExtensions`, modular codemirror-json-schema API so the language extension isn't duplicated_
- [x] `repo-json-schema.ts`: `useRepoFileJsonSchema` hook — tanstack query fetch, graceful failure — _`staleTime: Infinity`, retry 1, `status: "unavailable"` on failure_
- [x] Wire into `RepoEditorPane` (editable + staged views) with header indicator — _extensions appended to both text branches; muted schema-name note (title = URL) or "schema unavailable"_
- [x] packages/ui: preserve selection across CodeMirror view rebuilds — _selection + focus carried over when the doc is unchanged, in `source-code-block.client.tsx`_
- [x] Unit tests, no egress: URL resolution policy + diagnostics produced from an inline fixture schema — _`repo-json-schema.test.ts`, 12 specs; headless EditorState + `ensureSyntaxTree`, no DOM, no network_
- [x] Live verification in local dev: package.json squiggly + hover, `$schema` file, screenshots in PR — _playwright walkthrough over 5 files + live-edit, autocomplete, and blocked-egress passes; screenshots in the PR body_
- [x] `pnpm typecheck && pnpm lint && pnpm format && pnpm test` (scoped sensibly) — _all green at the repo root (unit lane: apps/os 590 passed)_

## Implementation log

- Verified schemastore egress before committing to the design: `www.schemastore.org` serves `access-control-allow-origin: *`; `json.schemastore.org` 301s there; the pnpm-workspace schema lives at `/pnpm-workspace.json` (the `.yaml` URL 404s).
- **Upstream bug found**: @lezer/json 1.0.3 (2024-12-29) added the `":"` token to the parse tree (1.0.2's nodeNames: `… Property PropertyName ] [ Array`; 1.0.3 adds `:`). codemirror-json-schema ≤0.8.1 takes `PropertyName.nextSibling` as the value node in JSON mode, so every diagnostic's from/to covered the colon, not the value. Worked around with `parseJsonDocumentColonFixed` — wraps their parser and shifts colon-shaped pointers one sibling over. YAML mode already skips the colon (they special-case it) and is unaffected. Worth an upstream issue/PR.
- codemirror-json-schema ships ESM with extensionless relative imports; vite handles it, Node's ESM resolver (vitest deps) doesn't — inlined via `server.deps.inline` in apps/os/vitest.config.ts.
- `@codemirror/lang-json`, `@codemirror/lang-yaml`, `@codemirror/language` added to apps/os (previously only in packages/ui; same semver ranges so pnpm dedupes to one instance — necessary for the `jsonLanguage.data.of(...)` singleton to match).
- Live verification (local dev, project `test`, repo `/repos/demo`): seeded schema-violating files via the itx CLI, then a playwright walkthrough. Verified: positioned squigglies + hover docs for package.json / tsconfig / `$schema` / yaml modeline / workflow `name:`; live edits re-lint without cursor loss; schema-driven autocomplete (`"no` → noEmit, noImplicitAny, …) inside tsconfig's compilerOptions; with `**schemastore.org**` requests aborted: zero squigglies, muted "schema unavailable" note, editor fully usable.
- **Known limitation**: json-schema-library (codemirror-json-schema's validator) doesn't produce positioned errors inside the github-workflow schema's `oneOf`-heavy `jobs` subtree (e.g. `runs-on: 123` is silent; `name: 123` and missing required top-level props do squiggle). Flat schemas (pnpm-workspace, package.json, tsconfig) validate deeply and precisely. Upstream validator quality issue, out of scope.

## Follow-ups deliberately left out

- File an upstream codemirror-json-schema issue/PR for the @lezer/json 1.0.3 colon regression (our `parseJsonDocumentColonFixed` can be deleted once fixed upstream).
- jsonc/json5 handling: `.jsonc` files (and comment-tolerant tsconfig.json) hit the strict JSON parse linter; codemirror-json-schema has a `/json5` mode that could back a `jsonc` language lane.
- Schema-aware validation inside the unified **diff** view baselines on the working doc and works, but the merge-view original side is unvalidated (fine — it's HEAD).
- Consider showing schema `description` hovers on property _names_ in non-error positions more prominently (works today via jsonSchemaHover, but the completion info panel renders raw markdown fences as plain text — upstream rendering nit).
