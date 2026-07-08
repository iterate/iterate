---
status: in-progress
size: small
branch: repo-ide-jsonc
---

# Repo IDE: jsonc/json5 lane for comment-tolerant JSON files

## Status summary

Not started (spec committed first). Stacked on `repo-ide-json-schema` (#1770), which added json-schema squigglies/hover/autocomplete to the repo mini-IDE but runs every `.json`-family file through the strict JSON parse linter — so a perfectly valid commented tsconfig.json shows spurious parse errors.

## Ask (follow-up scoped out of #1770)

> jsonc/json5 handling: `.jsonc` files (and comment-tolerant tsconfig.json) hit the strict JSON parse linter; codemirror-json-schema has a `/json5` mode that could back a `jsonc` language lane.

Concretely:

- Files that are jsonc-by-convention get comment/trailing-comma-tolerant parsing + linting, while schema validation, hover, and autocomplete keep working.
- Plain `.json` stays strict — a comment in package.json SHOULD squiggle.

## Design decisions (assumptions marked ⚠️)

- **The jsonc-by-convention list** (documented in `repo-file-kinds.ts`, the one place that decides): `*.jsonc`, the tsconfig family (`tsconfig*.json`), the jsconfig family (`jsconfig*.json`), and `.vscode/*.json` (VS Code treats its own config dir as jsonc). ⚠️ Deliberately small and mirroring the parent PR's well-known-schema globs; other comment-tolerant files in the wild (`.babelrc`, `devcontainer.json`, …) can join the list later, it's one regex each.
- **Grammar/linter**: `codemirror-json5` (the language `codemirror-json-schema/json5` is built against). ⚠️ JSON5 is a superset of JSONC — unquoted keys or single-quoted strings won't squiggle in a jsonc file even though VS Code would flag them. Accepted: upstream ships json5, not a strict jsonc grammar, and TypeScript's own tsconfig parser is similarly forgiving. Comments and trailing commas — the actual point — parse cleanly, and real syntax errors still squiggle via `json5ParseLinter`.
- **New `"jsonc"` SourceCodeLanguage in packages/ui** mapping to `json5()` from `codemirror-json5` — the same pattern as every other language there. The schema wiring stays in apps/os (per the parent PR's placement rationale); packages/ui only gains the small grammar dependency.
- **Colon-fix parity, checked deliberately**: the parent PR's `parseJsonDocumentColonFixed` works around @lezer/json 1.0.3 adding a `":"` token that codemirror-json-schema's JSON mode trips over (`PropertyName.nextSibling`). The json5 lane does NOT need it: lezer-json5's grammar has always had an explicit `PropertyColon` node and upstream's JSON5 pointer walk already skips it (`nextSibling.nextSibling` in `getJsonPointers`). Covered by a position-asserting test so a regression would be caught.
- **`$schema` extraction for jsonc** uses `json5.parse` (tolerates the comments that made it jsonc in the first place, plus single-quoted values the regex fallback would miss), with the same regex fallback for mid-edit docs.
- **Schema URL policy unchanged**: the filename→schemastore map already matches tsconfig*/jsconfig* by basename; jsonc files hit the same map.

## Checklist

- [ ] packages/ui: `"jsonc"` in `SourceCodeLanguage` → `json5()` language support; add `codemirror-json5` dep
- [ ] apps/os `repo-file-kinds.ts`: jsonc-by-convention detection (`*.jsonc`, `tsconfig*.json`, `jsconfig*.json`, `.vscode/*.json`) with the list documented there
- [ ] apps/os `repo-json-schema.ts`: `jsonc` lane — `json5ParseLinter` + `json5SchemaLinter` + `json5Completion` + `json5SchemaHover` + `stateExtensions`; `$schema` via `json5.parse`; no colon fix (documented why)
- [ ] apps/os `repo-editor-pane.tsx`: pass `"jsonc"` through to the schema hook
- [ ] Unit tests (same egress-free file/patterns): valid commented+trailing-comma tsconfig → no diagnostics; schema violation in a commented tsconfig → squiggle positioned on the value (not the colon); comment in plain package.json → parse diagnostic; `$schema` extraction from commented jsonc
- [ ] `pnpm typecheck && pnpm lint && pnpm format` + the touched unit specs
- [ ] Live verification in local dev: commented tsconfig.json with no parse squigglies but a real schema violation squiggling; screenshot in the PR

## Implementation log

- Pre-spec research: `codemirror-json-schema/json5` needs `codemirror-json5` + `json5` (optionalDependencies upstream, so they must be direct deps where imported); lezer-json5 nodeNames include `PropertyColon`, and upstream's `getJsonPointers(MODES.JSON5)` skips it (`nextSibling.nextSibling`) — colon fix not needed for this lane.
- `codemirror-json5` ships a proper exports map (unlike codemirror-json-schema), so no new vitest `server.deps.inline` entry should be needed.
