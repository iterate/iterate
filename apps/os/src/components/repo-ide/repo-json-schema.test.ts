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

test("well-known filenames map to schemastore URLs", () => {
  expect(resolveJson("package.json", "{}")).toBe("https://www.schemastore.org/package.json");
  expect(resolveJson("packages/foo/package.json", "{}")).toBe(
    "https://www.schemastore.org/package.json",
  );
  expect(resolveJson("tsconfig.json", "{}")).toBe("https://www.schemastore.org/tsconfig.json");
  expect(resolveJson("tsconfig.build.json", "{}")).toBe(
    "https://www.schemastore.org/tsconfig.json",
  );
  expect(resolveJson("jsconfig.json", "{}")).toBe("https://www.schemastore.org/jsconfig.json");
  expect(resolveYaml("pnpm-workspace.yaml", "")).toBe(
    "https://www.schemastore.org/pnpm-workspace.json",
  );
  expect(resolveYaml(".github/workflows/ci.yml", "")).toBe(
    "https://www.schemastore.org/github-workflow.json",
  );
  expect(resolveYaml("nested/.github/workflows/deploy.yaml", "")).toBe(
    "https://www.schemastore.org/github-workflow.json",
  );
});

test("files without a schema association resolve to null", () => {
  expect(resolveJson("data.json", "{}")).toBeNull();
  expect(resolveYaml("config.yaml", "key: value")).toBeNull();
  expect(resolveYaml("workflows/ci.yml", "")).toBeNull(); // not under .github/
});

test("a top-level $schema prop wins over the filename map", () => {
  const content = JSON.stringify({ $schema: "https://example.com/custom.json", name: "x" });
  expect(resolveJson("package.json", content)).toBe("https://example.com/custom.json");
});

test("$schema survives mid-edit invalid JSON via the regex fallback", () => {
  const content = '{\n  "$schema": "https://example.com/custom.json",\n  "name": '; // cut off mid-edit
  expect(resolveJson("data.json", content)).toBe("https://example.com/custom.json");
});

test("http $schema URLs are upgraded to https (mixed content)", () => {
  const content = JSON.stringify({ $schema: "http://json.schemastore.org/tsconfig.json" });
  expect(resolveJson("data.json", content)).toBe("https://json.schemastore.org/tsconfig.json");
});

test("relative $schema paths are ignored, falling back to the filename map", () => {
  const content = JSON.stringify({ $schema: "./local-schema.json" });
  expect(resolveJson("package.json", content)).toBe("https://www.schemastore.org/package.json");
  expect(resolveJson("data.json", content)).toBeNull();
});

test("nested $schema props do not count when the doc parses", () => {
  const content = JSON.stringify({ nested: { $schema: "https://example.com/custom.json" } });
  expect(resolveJson("data.json", content)).toBeNull();
});

test("yaml modeline comment wins over the filename map", () => {
  const content = "# yaml-language-server: $schema=https://example.com/custom.json\nkey: value\n";
  expect(resolveYaml("pnpm-workspace.yaml", content)).toBe("https://example.com/custom.json");
  expect(resolveYaml("anything.yaml", content)).toBe("https://example.com/custom.json");
});

test("json diagnostics: schema violations become red squigglies with positions", () => {
  const doc = '{\n  "name": 123\n}';
  const diagnostics = jsonDiagnostics(doc, FIXTURE_SCHEMA);
  expect(diagnostics).toMatchObject([
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

test("yaml diagnostics: schema violations become red squigglies with positions", () => {
  const doc = "name: 123\n";
  const diagnostics = yamlDiagnostics(doc, FIXTURE_SCHEMA);
  expect(diagnostics).toMatchObject([
    {
      severity: "error",
      message: expect.stringMatching(/string/),
      from: doc.indexOf("123"),
      to: doc.indexOf("123") + "123".length,
    },
  ]);
});

test("yaml diagnostics: a valid doc has none", () => {
  expect(yamlDiagnostics("name: iterate\n", FIXTURE_SCHEMA)).toEqual([]);
});

test("jsonc-by-convention paths open with the jsonc language; plain .json stays json", () => {
  expect(repoFileKind("tsconfig.json")).toEqual({ kind: "text", language: "jsonc" });
  expect(repoFileKind("packages/foo/tsconfig.build.json")).toEqual({
    kind: "text",
    language: "jsonc",
  });
  expect(repoFileKind("jsconfig.json")).toEqual({ kind: "text", language: "jsonc" });
  expect(repoFileKind("config/settings.jsonc")).toEqual({ kind: "text", language: "jsonc" });
  expect(repoFileKind(".vscode/settings.json")).toEqual({ kind: "text", language: "jsonc" });
  expect(repoFileKind("nested/.vscode/launch.json")).toEqual({ kind: "text", language: "jsonc" });
  expect(repoFileKind("package.json")).toEqual({ kind: "text", language: "json" });
  expect(repoFileKind("data.json")).toEqual({ kind: "text", language: "json" });
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

test("jsonc: schema violations still squiggle, positioned on the value (not the colon)", () => {
  const doc = '{\n  // a comment\n  "name": 123,\n}';
  expect(jsoncSchemaDiagnostics(doc, FIXTURE_SCHEMA)).toMatchObject([
    {
      severity: "error",
      message: expect.stringMatching(/string/),
      from: doc.indexOf("123"),
      to: doc.indexOf("123") + "123".length,
    },
  ]);
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

test("jsonc: $schema extraction works through comments and trailing commas", () => {
  const doc = '{\n  // pick a schema\n  "$schema": "https://example.com/custom.json",\n}';
  expect(resolveJsonc("anything.jsonc", doc)).toBe("https://example.com/custom.json");
});

test("jsonc: the well-known filename map applies to tsconfig-family files", () => {
  expect(resolveJsonc("tsconfig.json", "{\n  // hi\n}")).toBe(
    "https://www.schemastore.org/tsconfig.json",
  );
});

// --- helpers ---

/** A tiny inline schema so diagnostics tests need no network. */
const FIXTURE_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    name: { type: "string", description: "The name." },
  },
};

function resolveJson(path: string, content: string) {
  return repoFileSchemaUrl({ path, language: "json", content });
}

function resolveJsonc(path: string, content: string) {
  return repoFileSchemaUrl({ path, language: "jsonc", content });
}

function resolveYaml(path: string, content: string) {
  return repoFileSchemaUrl({ path, language: "yaml", content });
}

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
