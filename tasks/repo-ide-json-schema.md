---
status: in-progress
size: medium
branch: repo-ide-json-schema
---

# Repo IDE: JSON/YAML json-schema support

## Status summary

In progress. Spec fleshed out and committed first; implementation not started yet.

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

- [ ] `repo-json-schema.ts`: schema URL resolution policy (`$schema` prop > YAML modeline > well-known filename map)
- [ ] `repo-json-schema.ts`: codemirror extension bundle (lint + hover + completion + state) for json and yaml
- [ ] `repo-json-schema.ts`: `useRepoFileJsonSchema` hook — tanstack query fetch, graceful failure
- [ ] Wire into `RepoEditorPane` (editable + staged views) with header indicator
- [ ] packages/ui: preserve selection across CodeMirror view rebuilds
- [ ] Unit tests, no egress: URL resolution policy + diagnostics produced from an inline fixture schema
- [ ] Live verification in local dev: package.json squiggly + hover, `$schema` file, screenshots in PR
- [ ] `pnpm typecheck && pnpm lint && pnpm format && pnpm test` (scoped sensibly)

## Implementation log

- (empty so far)
