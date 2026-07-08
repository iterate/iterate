---
status: done
size: small
branch: repo-ide-jsonc
pr: https://github.com/iterate/iterate/pull/1774
---

# Repo IDE: jsonc/json5 lane for comment-tolerant JSON files

## Status summary

Done. Stacked on `repo-ide-json-schema` (#1770). jsonc-by-convention files (_.jsonc, tsconfig/jsconfig families, .vscode/_.json) now open with a json5-backed jsonc language: comments/trailing commas don't squiggle, schema validation + hover + autocomplete still work, plain .json stays strict. Unit-tested (7 new egress-free specs) and verified live in local dev via playwright with screenshots in PR #1774. Notable: the parent PR's colon-position fix is confirmed unnecessary for this lane (lezer-json5 has an explicit PropertyColon node upstream already skips).

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

- [x] packages/ui: `"jsonc"` in `SourceCodeLanguage` → `json5()` language support; add `codemirror-json5` dep — _switch arm in `sourceCodeLanguageExtension`, `source-code-block.client.tsx`_
- [x] apps/os `repo-file-kinds.ts`: jsonc-by-convention detection (`*.jsonc`, `tsconfig*.json`, `jsconfig*.json`, `.vscode/*.json`) with the list documented there — _`isJsoncByConvention` + the `jsonc` TEXT_LANGUAGES entry_
- [x] apps/os `repo-json-schema.ts`: `jsonc` lane — `json5ParseLinter` + `json5SchemaLinter` + `json5Completion` + `json5SchemaHover` + `stateExtensions`; `$schema` via `json5.parse`; no colon fix (documented why) — _`JsonSchemaLanguage` is now `"json" | "jsonc" | "yaml"`; `jsonDollarSchemaUrl` takes the parse fn explicitly_
- [x] apps/os `repo-editor-pane.tsx`: pass `"jsonc"` through to the schema hook — _language guard extended_
- [x] Unit tests (same egress-free file/patterns): valid commented+trailing-comma tsconfig → no diagnostics; schema violation in a commented tsconfig → squiggle positioned on the value (not the colon); comment in plain package.json → parse diagnostic; `$schema` extraction from commented jsonc — _7 new specs in `repo-json-schema.test.ts` (19 total), incl. `repoFileKind` mapping_
- [x] `pnpm typecheck && pnpm lint && pnpm format` + the touched unit specs — _all green at repo root; two custom lint rules (colocate-single-use-types, no-single-use-helpers) caught and fixed layout nits_
- [x] Live verification in local dev: commented tsconfig.json with no parse squigglies but a real schema violation squiggling; screenshot in the PR — _headless playwright over local dev, project `test`, repo `/` (ROOT); 3 screenshots in the PR body via gh-attach-assets_

## Implementation log

- Pre-spec research: `codemirror-json-schema/json5` needs `codemirror-json5` + `json5` (optionalDependencies upstream, so they must be direct deps where imported); lezer-json5 nodeNames include `PropertyColon`, and upstream's `getJsonPointers(MODES.JSON5)` skips it (`nextSibling.nextSibling`) — colon fix not needed for this lane.
- `codemirror-json5` ships a proper exports map (unlike codemirror-json-schema), so no new vitest `server.deps.inline` entry was needed — all 19 specs passed first run.
- `codemirror-json5@^1.0.3` resolves to a single pnpm instance shared with codemirror-json-schema's optional dep, so `json5Language.data.of({ autocomplete })` registers against the same language singleton the editor uses (same dedupe concern the parent PR handled for `jsonLanguage`).
- Zero-width parse diagnostics (strict `jsonParseLinter` at a comment) render as a `.cm-lintPoint-error` point marker, not a `.cm-lintRange-error` span — worth knowing when counting squigglies in browser verification.
- Live verification (local dev, project `test`, repo `/`): seeded `tsconfig.json` (comments + trailing comma + `"strict": 1`), commented `package.json`, and commented `.vscode/settings.json` via `itx.repos.get("/").commitFiles`. Confirmed: tsconfig shows exactly one squiggle on the `1` with schema hover docs and the `tsconfig.json` header note; package.json shows exactly one parse diagnostic at the comment; .vscode/settings.json shows zero diagnostics.
