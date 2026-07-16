import { json, jsonParseLinter } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { jsonSchemaLinter, stateExtensions } from "codemirror-json-schema";
import { yamlSchemaLinter } from "codemirror-json-schema/yaml";
import { json5SchemaLinter } from "codemirror-json-schema/json5";
import { json5, json5ParseLinter } from "codemirror-json5";
import type { JSONSchema7 } from "json-schema";
import { expect, test } from "vitest";
import { repoFileKind } from "./repo-file-kinds.ts";
import { parseJsonDocumentColonFixed, repoFileSchemaUrl } from "./repo-json-schema.ts";

test.for([
  {
    name: "maps package.json to its schemastore URL",
    language: "json",
    path: "package.json",
    content: "{}",
    expected: "https://www.schemastore.org/package.json",
  },
  {
    name: "maps nested package.json files by basename",
    language: "json",
    path: "packages/foo/package.json",
    content: "{}",
    expected: "https://www.schemastore.org/package.json",
  },
  {
    name: "maps tsconfig.json to its schemastore URL",
    language: "json",
    path: "tsconfig.json",
    content: "{}",
    expected: "https://www.schemastore.org/tsconfig.json",
  },
  {
    name: "maps tsconfig-variant filenames to the tsconfig schema",
    language: "json",
    path: "tsconfig.build.json",
    content: "{}",
    expected: "https://www.schemastore.org/tsconfig.json",
  },
  {
    name: "maps jsconfig.json to its schemastore URL",
    language: "json",
    path: "jsconfig.json",
    content: "{}",
    expected: "https://www.schemastore.org/jsconfig.json",
  },
  {
    name: "maps pnpm-workspace.yaml to its schemastore URL",
    language: "yaml",
    path: "pnpm-workspace.yaml",
    content: "",
    expected: "https://www.schemastore.org/pnpm-workspace.json",
  },
  {
    name: "maps GitHub workflow files to the workflow schema",
    language: "yaml",
    path: ".github/workflows/ci.yml",
    content: "",
    expected: "https://www.schemastore.org/github-workflow.json",
  },
  {
    name: "maps nested GitHub workflow files to the workflow schema",
    language: "yaml",
    path: "nested/.github/workflows/deploy.yaml",
    content: "",
    expected: "https://www.schemastore.org/github-workflow.json",
  },
  {
    name: "resolves unassociated JSON files to null",
    language: "json",
    path: "data.json",
    content: "{}",
    expected: null,
  },
  {
    name: "resolves unassociated YAML files to null",
    language: "yaml",
    path: "config.yaml",
    content: "key: value",
    expected: null,
  },
  {
    name: "ignores workflow-shaped paths outside .github/",
    language: "yaml",
    path: "workflows/ci.yml",
    content: "",
    expected: null,
  },
  {
    name: "lets a top-level $schema prop win over the filename map",
    language: "json",
    path: "package.json",
    content: JSON.stringify({ $schema: "https://example.com/custom.json", name: "x" }),
    expected: "https://example.com/custom.json",
  },
  {
    // Cut off mid-edit so JSON.parse fails — the regex fallback still sees it.
    name: "keeps $schema through mid-edit invalid JSON via the regex fallback",
    language: "json",
    path: "data.json",
    content: '{\n  "$schema": "https://example.com/custom.json",\n  "name": ',
    expected: "https://example.com/custom.json",
  },
  {
    name: "upgrades http $schema URLs to https (mixed content)",
    language: "json",
    path: "data.json",
    content: JSON.stringify({ $schema: "http://json.schemastore.org/tsconfig.json" }),
    expected: "https://json.schemastore.org/tsconfig.json",
  },
  {
    name: "ignores relative $schema paths, falling back to the filename map",
    language: "json",
    path: "package.json",
    content: JSON.stringify({ $schema: "./local-schema.json" }),
    expected: "https://www.schemastore.org/package.json",
  },
  {
    name: "ignores relative $schema paths in unassociated files",
    language: "json",
    path: "data.json",
    content: JSON.stringify({ $schema: "./local-schema.json" }),
    expected: null,
  },
  {
    // A vendored-schema-collection shape, cut off mid-edit so JSON.parse fails.
    name: "regex fallback ignores deeply-indented (nested) $schema mid-edit",
    language: "json",
    path: "data.json",
    content: '{\n  "vendored": {\n      "$schema": "https://example.com/nested.json",\n  ',
    expected: null,
  },
  {
    name: "regex fallback still matches the minified top-level form",
    language: "json",
    path: "data.json",
    content: '{"$schema": "https://example.com/custom.json", "name": ',
    expected: "https://example.com/custom.json",
  },
  {
    name: "does not count nested $schema props when the doc parses",
    language: "json",
    path: "data.json",
    content: JSON.stringify({ nested: { $schema: "https://example.com/custom.json" } }),
    expected: null,
  },
  {
    name: "lets a yaml modeline comment win over the filename map",
    language: "yaml",
    path: "pnpm-workspace.yaml",
    content: "# yaml-language-server: $schema=https://example.com/custom.json\nkey: value\n",
    expected: "https://example.com/custom.json",
  },
  {
    name: "honors the yaml modeline in unassociated files",
    language: "yaml",
    path: "anything.yaml",
    content: "# yaml-language-server: $schema=https://example.com/custom.json\nkey: value\n",
    expected: "https://example.com/custom.json",
  },
  {
    name: "jsonc: $schema extraction works through comments and trailing commas",
    language: "jsonc",
    path: "anything.jsonc",
    content: '{\n  // pick a schema\n  "$schema": "https://example.com/custom.json",\n}',
    expected: "https://example.com/custom.json",
  },
  {
    name: "jsonc: the well-known filename map applies to tsconfig-family files",
    language: "jsonc",
    path: "tsconfig.json",
    content: "{\n  // hi\n}",
    expected: "https://www.schemastore.org/tsconfig.json",
  },
])("$name", ({ content, expected, language, path }) => {
  // Row strings widen; the (unexported) language union is re-stated here.
  expect(
    repoFileSchemaUrl({ path, language: language as "json" | "jsonc" | "yaml", content }),
  ).toBe(expected);
});

// One row per linter lane: the violation must squiggle the VALUE (not the
// colon), with real document positions.
test.for([
  {
    name: "json diagnostics: schema violations become red squigglies with positions",
    doc: '{\n  "name": 123\n}',
    lint: (doc: string) => jsonDiagnostics(doc, FIXTURE_SCHEMA),
  },
  {
    name: "yaml diagnostics: schema violations become red squigglies with positions",
    doc: "name: 123\n",
    lint: (doc: string) => yamlDiagnostics(doc, FIXTURE_SCHEMA),
  },
  {
    name: "jsonc: schema violations still squiggle, positioned on the value (not the colon)",
    doc: '{\n  // a comment\n  "name": 123,\n}',
    lint: (doc: string) => jsoncSchemaDiagnostics(doc, FIXTURE_SCHEMA),
  },
])("$name", ({ doc, lint }) => {
  expect(lint(doc)).toMatchObject([
    {
      severity: "error",
      message: expect.stringMatching(/string/),
      from: doc.indexOf("123"),
      to: doc.indexOf("123") + "123".length,
    },
  ]);
});

test("json diagnostics: a valid doc has none", () => {
  expect(jsonDiagnostics('{\n  "name": "iterate"\n}', FIXTURE_SCHEMA)).toEqual([]);
});

test("yaml diagnostics: a valid doc has none", () => {
  expect(yamlDiagnostics("name: iterate\n", FIXTURE_SCHEMA)).toEqual([]);
});

test.for([
  {
    name: "tsconfig.json opens with the jsonc language",
    path: "tsconfig.json",
    expected: { kind: "text", language: "jsonc" },
  },
  {
    name: "nested tsconfig variants open with the jsonc language",
    path: "packages/foo/tsconfig.build.json",
    expected: { kind: "text", language: "jsonc" },
  },
  {
    name: "jsconfig.json opens with the jsonc language",
    path: "jsconfig.json",
    expected: { kind: "text", language: "jsonc" },
  },
  {
    name: ".jsonc files open with the jsonc language",
    path: "config/settings.jsonc",
    expected: { kind: "text", language: "jsonc" },
  },
  {
    name: ".vscode settings open with the jsonc language",
    path: ".vscode/settings.json",
    expected: { kind: "text", language: "jsonc" },
  },
  {
    name: "nested .vscode files open with the jsonc language",
    path: "nested/.vscode/launch.json",
    expected: { kind: "text", language: "jsonc" },
  },
  {
    name: "package.json stays plain json",
    path: "package.json",
    expected: { kind: "text", language: "json" },
  },
  {
    name: "ordinary .json files stay plain json",
    path: "data.json",
    expected: { kind: "text", language: "json" },
  },
])("repoFileKind: $name", ({ expected, path }) => {
  expect(repoFileKind(path)).toEqual(expected);
});

test("jsonc: a valid commented tsconfig with a trailing comma has no diagnostics", async () => {
  const doc = [
    "{",
    "  // strict mode is worth it",
    '  "compilerOptions": {',
    '    "strict": true, /* trailing comma below, too */',
    "  },",
    "}",
    "",
  ].join("\n");
  expect(await jsoncParseDiagnostics(doc)).toEqual([]);
  expect(jsoncSchemaDiagnostics(doc, TSCONFIG_LIKE_SCHEMA)).toEqual([]);
});

test("jsonc: real syntax errors still squiggle", async () => {
  const diagnostics = await jsoncParseDiagnostics('{\n  "name": ,\n}');
  expect(diagnostics).toMatchObject([{ severity: "error" }]);
});

test("json stays strict: a comment in plain package.json is a parse error", () => {
  const doc = '{\n  // comments are not allowed in plain json\n  "name": "x"\n}';
  const diagnostics = jsonParseLinter()(lintState(doc, [json()]));
  expect(diagnostics).toMatchObject([{ severity: "error", from: doc.indexOf("//") }]);
});

// --- helpers ---

/** A tiny inline schema so diagnostics tests need no network. */
const FIXTURE_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    name: { type: "string", description: "The name." },
  },
};

// The linters only read `view.state`, so a headless EditorState (with the
// language extension for position mapping) exercises the real diagnostics
// pipeline without a DOM. `ensureSyntaxTree` forces the full parse an editor
// view would otherwise drive.
function lintState(doc: string, extensions: Extension) {
  const state = EditorState.create({ doc, extensions });
  ensureSyntaxTree(state, doc.length, 5_000);
  return { state } as EditorView;
}

function jsonDiagnostics(doc: string, schema: JSONSchema7) {
  // Same parser wiring as jsonSchemaCodeMirrorExtensions (colon-position fix).
  return jsonSchemaLinter({ jsonParser: parseJsonDocumentColonFixed })(
    lintState(doc, [json(), stateExtensions(schema)]),
  );
}

function yamlDiagnostics(doc: string, schema: JSONSchema7) {
  return yamlSchemaLinter()(lintState(doc, [yaml(), stateExtensions(schema)]));
}

// The jsonc lane: json5 grammar + codemirror-json-schema's json5 mode. No
// parseJsonDocumentColonFixed equivalent on purpose — lezer-json5 has an
// explicit PropertyColon node upstream already skips (the position test
// above would catch a regression).
function jsoncSchemaDiagnostics(doc: string, schema: JSONSchema7) {
  return json5SchemaLinter()(lintState(doc, [json5(), stateExtensions(schema)]));
}

async function jsoncParseDiagnostics(doc: string) {
  return await json5ParseLinter()(lintState(doc, [json5()]));
}

/** A tsconfig-shaped inline schema for the commented-tsconfig spec. */
const TSCONFIG_LIKE_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    compilerOptions: {
      type: "object",
      properties: {
        strict: { type: "boolean" },
      },
    },
  },
};
