import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { jsonLanguage, jsonParseLinter } from "@codemirror/lang-json";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { syntaxTree } from "@codemirror/language";
import { linter } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import { hoverTooltip } from "@codemirror/view";
import {
  handleRefresh,
  jsonCompletion,
  jsonSchemaHover,
  jsonSchemaLinter,
  parseJSONDocumentState,
  stateExtensions,
} from "codemirror-json-schema";
import { yamlCompletion, yamlSchemaHover, yamlSchemaLinter } from "codemirror-json-schema/yaml";
import { json5Completion, json5SchemaHover, json5SchemaLinter } from "codemirror-json-schema/json5";
import { json5Language, json5ParseLinter } from "codemirror-json5";
import JSON5 from "json5";
import type { JSONSchema7 } from "json-schema";
import type { SourceCodeBlockExtension } from "@iterate-com/ui/components/source-code-block";

/**
 * The languages the repo IDE runs json-schema validation for. "jsonc" is
 * JSON-with-comments-by-convention (*.jsonc, the tsconfig family, …) — see
 * repo-file-kinds.ts for the list — parsed with the json5 grammar.
 */
type JsonSchemaLanguage = "json" | "jsonc" | "yaml";

/**
 * Which json-schema (by URL) applies to a repo file, in priority order:
 *
 * 1. an explicit `"$schema"` top-level prop (JSON),
 * 2. a `# yaml-language-server: $schema=<url>` modeline (YAML),
 * 3. a small well-known filename map (package.json, tsconfig, …).
 *
 * Derived from the live buffer so adding a `$schema` line applies immediately,
 * before any commit. Returns null when no schema association exists.
 */
export function repoFileSchemaUrl(input: {
  path: string;
  language: JsonSchemaLanguage;
  content: string;
}): string | null {
  const explicit =
    input.language === "yaml"
      ? yamlModelineSchemaUrl(input.content)
      : // jsonc docs are usually invalid strict JSON (that's the point), so
        // the $schema prop is extracted with the comment-tolerant parser.
        jsonDollarSchemaUrl(input.content, input.language === "jsonc" ? JSON5.parse : JSON.parse);
  return explicit || wellKnownSchemaUrl(input.path);
}

function jsonDollarSchemaUrl(content: string, parse: (text: string) => unknown): string | null {
  // Runs per keystroke for every JSON buffer — skip the parse entirely for
  // the overwhelmingly common no-$schema case. Unquoted (JSON5 allows bare
  // keys in jsonc files), so both lanes hit the fast path correctly.
  if (!content.includes("$schema")) return null;
  try {
    const parsed: unknown = parse(content);
    const schema =
      parsed && typeof parsed === "object" && "$schema" in parsed ? parsed.$schema : undefined;
    return typeof schema === "string" ? httpsUrlOrNull(schema) : null;
  } catch {
    // Mid-edit the doc is usually invalid JSON; a cheap regex keeps the
    // schema association from flickering away while the user types. Anchored
    // to line start at shallow indent (plus the minified `{"$schema":` form)
    // to bias toward top-level props — nested `$schema`s (vendored schema
    // collections, openapi docs) sit deeper and shouldn't be grabbed.
    const match = content.match(/^(?:[ \t]{0,3}|\{[ \t]*)"\$schema"[ \t]*:[ \t]*"([^"]+)"/m);
    return match ? httpsUrlOrNull(match[1]) : null;
  }
}

function yamlModelineSchemaUrl(content: string): string | null {
  // The vscode-yaml / yaml-language-server modeline convention.
  const match = content.match(/^#\s*yaml-language-server:\s*\$schema=(\S+)/m);
  return match ? httpsUrlOrNull(match[1]) : null;
}

/**
 * Only absolute http(s) URLs are honored — relative `$schema` paths point at
 * repo-local files we don't resolve. http:// is upgraded to https:// because
 * the dashboard is served over https and the browser would block the fetch as
 * mixed content anyway.
 */
function httpsUrlOrNull(url: string): string | null {
  if (url.startsWith("https://")) return url;
  if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`;
  return null;
}

/**
 * Filename → schemastore.org URL for a handful of well-known files. A small
 * hardcoded map on purpose: schemastore's full catalog is ~700 entries of
 * glob patterns and would need its own fetch just to find these.
 */
function wellKnownSchemaUrl(path: string): string | null {
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) {
    return "https://www.schemastore.org/github-workflow.json";
  }
  const basename = path.split("/").pop() || path;
  if (basename === "package.json") return "https://www.schemastore.org/package.json";
  if (basename === "pnpm-workspace.yaml") return "https://www.schemastore.org/pnpm-workspace.json";
  // schemastore's own fileMatch globs for these are tsconfig*.json / jsconfig*.json.
  if (/^tsconfig.*\.json$/.test(basename)) return "https://www.schemastore.org/tsconfig.json";
  if (/^jsconfig.*\.json$/.test(basename)) return "https://www.schemastore.org/jsconfig.json";
  return null;
}

/**
 * The codemirror-json-schema wiring for one schema: red squigglies
 * (@codemirror/lint), hover docs, and autocomplete. Deliberately the modular
 * API, not the package's bundled `jsonSchema()`/`yamlSchema()` helpers —
 * those include the `json()`/`yaml()` language extensions which
 * SourceCodeBlock already provides.
 */
function jsonSchemaCodeMirrorExtensions(input: {
  language: JsonSchemaLanguage;
  schema: JSONSchema7;
}): SourceCodeBlockExtension {
  if (input.language === "json") {
    return [
      linter(jsonParseLinter()),
      linter(jsonSchemaLinter({ jsonParser: parseJsonDocumentColonFixed }), {
        needsRefresh: handleRefresh,
      }),
      jsonLanguage.data.of({ autocomplete: jsonCompletion() }),
      hoverTooltip(jsonSchemaHover()),
      stateExtensions(input.schema),
    ];
  }
  if (input.language === "jsonc") {
    // The json5 lane needs no parseJsonDocumentColonFixed equivalent:
    // lezer-json5 has always had an explicit PropertyColon node and
    // codemirror-json-schema's JSON5 pointer walk already skips it (the
    // @lezer/json 1.0.3 regression the fix above works around is specific
    // to the strict-JSON grammar). Pinned by a position test.
    //
    // Known cosmetic edge: that walk is positional (nextSibling.nextSibling),
    // not node-name-aware, so a comment adjacent to the colon reabsorbs the
    // mispositioning — `{ "name": /* why */ 123 }` squiggles the comment
    // instead of `123` (right message, wrong span). Rare in real configs;
    // if it ever matters, a wrapper that skips Comment/PropertyColon
    // siblings (same shape as parseJsonDocumentColonFixed) is the fix.
    return [
      linter(json5ParseLinter()),
      linter(json5SchemaLinter(), { needsRefresh: handleRefresh }),
      json5Language.data.of({ autocomplete: json5Completion() }),
      hoverTooltip(json5SchemaHover()),
      stateExtensions(input.schema),
    ];
  }
  return [
    linter(yamlSchemaLinter(), { needsRefresh: handleRefresh }),
    yamlLanguage.data.of({ autocomplete: yamlCompletion({}) }),
    hoverTooltip(yamlSchemaHover()),
    stateExtensions(input.schema),
  ];
}

/**
 * Upstream bug workaround: @lezer/json 1.0.3 (Dec 2024) added the ":" token
 * to the parse tree, but codemirror-json-schema (<= 0.8.1) still assumes
 * `PropertyName.nextSibling` is the property's value node — so every
 * diagnostic's squiggly lands on the colon instead of the offending value.
 * This wraps the stock parser and shifts such pointers one sibling over.
 * (YAML mode is unaffected: its pointer walk already skips the ":" node.)
 */
export function parseJsonDocumentColonFixed(state: EditorState) {
  const parsed = parseJSONDocumentState(state);
  for (const [pointer, positions] of parsed.pointers) {
    if (!("valueFrom" in positions) || positions.valueFrom === undefined) continue;
    if (positions.valueTo === undefined) continue;
    // A real string value of ":" would slice as `":"` (with quotes), so a
    // bare colon can only be the structural token.
    if (state.sliceDoc(positions.valueFrom, positions.valueTo) !== ":") continue;
    const valueNode = syntaxTree(state).resolve(positions.valueFrom, 1).nextSibling;
    if (!valueNode) continue;
    parsed.pointers.set(pointer, {
      ...positions,
      valueFrom: valueNode.from,
      valueTo: valueNode.to,
    });
  }
  return parsed;
}

const NO_EXTENSIONS: SourceCodeBlockExtension = [];

/** Quiet period before a changed schema URL is allowed to hit the network. */
const SCHEMA_URL_SETTLE_MS = 500;

type RepoFileJsonSchema =
  | { status: "none"; extensions: SourceCodeBlockExtension }
  | { status: "loading"; url: string; extensions: SourceCodeBlockExtension }
  | { status: "unavailable"; url: string; extensions: SourceCodeBlockExtension }
  | { status: "active"; url: string; extensions: SourceCodeBlockExtension };

/**
 * Resolve and fetch the json-schema for a repo file buffer. The schema is
 * fetched by the browser (schemastore.org serves `access-control-allow-origin:
 * *`) and cached for the session; fetch failure degrades to no diagnostics —
 * `status: "unavailable"` — never an error surface.
 *
 * Egress model, out loud: a committed file's `$schema` (or modeline) makes any
 * *viewer's* browser GET that URL — https-only, credential-less, CORS-gated,
 * and the response is only ever parsed as a JSON schema. That's intentional
 * vscode/yaml-language-server parity for a user-controlled IDE surface.
 *
 * Pass `language: null` for files that aren't JSON/YAML; the hook is a no-op
 * (`status: "none"`) but must still be called so hook order is stable.
 */
export function useRepoFileJsonSchema(input: {
  path: string;
  language: JsonSchemaLanguage | null;
  content: string;
}): RepoFileJsonSchema {
  const { path, language, content } = input;
  const url = useMemo(
    () => (language === null ? null : repoFileSchemaUrl({ path, language, content })),
    [path, language, content],
  );

  // Trailing debounce so typing out a $schema URL doesn't fire a fetch per
  // keystroke to every garbage prefix host ("https://w", "https://ww", …).
  // Built on a query rather than useState/useEffect (repo convention): each
  // url change starts a new "settle" timer query; `keepPreviousData` holds
  // the last settled url until the new one has been quiet for the period, so
  // abandoned prefixes never reach the fetch query below.
  const settledUrlQuery = useQuery({
    queryKey: ["repo-ide-json-schema-url", url],
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 1000,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      await new Promise((resolve) => setTimeout(resolve, SCHEMA_URL_SETTLE_MS));
      // Wrapped: `url` itself may be null, which react-query would reject.
      return { url };
    },
  });
  const settledUrl = settledUrlQuery.data === undefined ? null : settledUrlQuery.data.url;

  // Errored entries don't poison the infinite-staleTime cache: staleTime
  // governs *data* freshness, and an errored query has none — react-query
  // refetches it when the file is next opened.
  const schemaQuery = useQuery({
    queryKey: ["repo-ide-json-schema", settledUrl],
    enabled: settledUrl !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60 * 60 * 1000,
    retry: 1,
    // Keep the prior schema's data (and thus the squigglies) applied while the
    // new URL's fetch is in flight, matching the settle step's own
    // keepPreviousData — switching `$schema` shouldn't blink diagnostics off.
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<JSONSchema7> => {
      if (settledUrl === null) throw new Error("unreachable: query disabled without a url");
      const response = await fetch(settledUrl);
      if (!response.ok) throw new Error(`Schema fetch failed: ${response.status} ${settledUrl}`);
      return (await response.json()) as JSONSchema7;
    },
  });

  const schema = schemaQuery.data;
  const extensions = useMemo(
    () =>
      language !== null && schema !== undefined
        ? jsonSchemaCodeMirrorExtensions({ language, schema })
        : NO_EXTENSIONS,
    [language, schema],
  );

  if (url === null) return { status: "none", extensions: NO_EXTENSIONS };
  // A failed fetch means no validation — check this BEFORE the active branch,
  // because keepPreviousData keeps an earlier schema in `schemaQuery.data` even
  // while the current URL's fetch is errored. Without this the stale schema
  // would keep linting and the failure would read as "active", masking it.
  if (schemaQuery.status === "error" && settledUrl !== null) {
    return { status: "unavailable", url: settledUrl, extensions: NO_EXTENSIONS };
  }
  // Mid-settle (url !== settledUrl) or mid-refetch, keepPreviousData keeps the
  // previous schema applying — the header note names what's actually validating.
  if (schema !== undefined && settledUrl !== null) {
    return { status: "active", url: settledUrl, extensions };
  }
  return { status: "loading", url, extensions };
}
