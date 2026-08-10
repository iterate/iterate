import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { tsFacetWorker } from "@valtown/codemirror-ts";
import type { VirtualTypeScriptEnvironment } from "@typescript/vfs";
import ts from "typescript";
import { describe, expect, test, vi } from "vitest";
import { itxReplAutocompleteWorker } from "./itx-repl-autocomplete.ts";
import { getAutocompletionWithDocs } from "./itx-repl-autocomplete-worker.ts";
import {
  ITX_TYPES_PATH,
  REPL_SCOPE_GLOBALS_PATH,
  REPL_SCOPE_PREAMBLE_PATH,
  itxReplDeclaration,
  itxTypesDeclaration,
  replScopeModules,
  type ItxReplTypeScriptWorker,
} from "./itx-repl-types.ts";

const REPL_SOURCE_PATH = "/repl.ts";
const REPL_TYPES_PATH = "/iterate-repl-globals.d.ts";

const compilerOptions: ts.CompilerOptions = {
  allowImportingTsExtensions: true,
  allowSyntheticDefaultImports: true,
  lib: ["es2022", "dom"],
  module: ts.ModuleKind.ESNext,
  moduleDetection: ts.ModuleDetectionKind.Force,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
};

describe("itx REPL TypeScript declarations", () => {
  test("autocomplete on the itx handle offers the itx surface", async () => {
    const env = createReplTypeScriptEnv("itx.");
    const result = await getAutocompletionWithDocs({
      env,
      path: REPL_SOURCE_PATH,
      context: { explicit: true, pos: "itx.".length },
    });

    // The handle is the Project surface (see the prelude — the REPL always
    // holds a project context now): every project built-in must complete.
    const labels = new Set(result?.options.map((option) => option.label));
    for (const member of [
      "__describe",
      "capabilityHost",
      "capabilityHosts",
      "provideCapability",
      "repo",
      "secrets",
      "streams",
      "workers",
    ]) {
      expect(labels, `expected completion "${member}"`).toContain(member);
    }
  });

  test("REPL globals from the prelude type-check in a snippet", () => {
    // Every global the script runtime injects (`itx`, `vars` — see the wrap
    // in itx-scope-repl-entries.ts) must be declared by the prelude, with the
    // design-of-record types attached.
    const code = [
      "const parameters: Record<string, any> = vars;",
      "const read: (handle: Project) => Promise<StreamEvent[]> = (handle) =>",
      '  handle.streams.get("/chat").getEvents();',
      "const recipe: ProvideCapabilityInput = {",
      '  expression: ["streams", ["get", "/x"]],',
      '  path: ["alias"],',
      '  type: "itx-call",',
      "};",
      "[parameters, read, recipe];",
    ].join("\n");
    const env = createReplTypeScriptEnv(code);

    const diagnostics = env.languageService
      .getSemanticDiagnostics(REPL_SOURCE_PATH)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });

  test("scope preamble modules give results its real types", () => {
    // What the platform assembles for a scope with one small settled result
    // (see capability-host-preamble.ts renderResultsArray).
    const preambleTs = [
      "// ── prior script results, newest first (assembled by the platform) ──",
      "const __resultRows = [",
      '  { offset: 12, executionId: "run-1", data: { count: 3 } },',
      "] as const;",
      "const results = Object.assign(__resultRows, {",
      "  byOffset: (offset: number) => {",
      "    const match = __resultRows.find((row) => row.offset === offset);",
      '    if (!match) throw new Error("no retained script result settled at offset " + offset);',
      "    return match;",
      "  },",
      "});",
    ].join("\n");
    const code = [
      "const count: number = results[0].data.count;",
      "const stable: number = results.byOffset(12).data.count;",
      "[count, stable];",
    ].join("\n");
    const env = createReplTypeScriptEnv(code, replScopeModules(preambleTs));

    const diagnostics = env.languageService
      .getSemanticDiagnostics(REPL_SOURCE_PATH)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });

  test("without settled results the results name does not exist", () => {
    const env = createReplTypeScriptEnv("results;", replScopeModules(null));
    const diagnostics = env.languageService
      .getSemanticDiagnostics(REPL_SOURCE_PATH)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(diagnostics).toEqual(["Cannot find name 'results'."]);
  });

  test("core itx calls type-check against the raw types file", () => {
    const code = [
      "const description = await itx.__describe();",
      'const events = await itx.streams.get("/x").append({ type: "demo", payload: { a: 1 } });',
      "const commit = await itx.repo.commitFiles({",
      '  changes: [{ content: "hi", path: "notes/hi.md" }],',
      '  message: "note",',
      "});",
      "[description.projectId, events[0]?.offset, commit.commitOid];",
    ].join("\n");
    const env = createReplTypeScriptEnv(code);

    const diagnostics = env.languageService
      .getSemanticDiagnostics(REPL_SOURCE_PATH)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });

  test("nested autocomplete resolves the Stream capability members", async () => {
    const code = 'itx.streams.get("/x").';
    const env = createReplTypeScriptEnv(code);
    const result = await getAutocompletionWithDocs({
      env,
      path: REPL_SOURCE_PATH,
      context: { explicit: true, pos: code.length },
    });

    const labels = new Set(result?.options.map((option) => option.label));
    for (const member of ["append", "getEvents", "openConnection", "waitForEvent"]) {
      expect(labels, `expected completion "${member}"`).toContain(member);
    }
  });

  test("CodeMirror completion source delegates to the REPL TypeScript worker", async () => {
    const result = {
      from: 4,
      options: [
        { label: "provideCapability", info: "Provide a capability on this handle's context." },
      ],
    };
    const worker = {
      getAutocompletionWithDocs: vi.fn().mockResolvedValue(result),
    } as unknown as ItxReplTypeScriptWorker;
    const state = EditorState.create({
      doc: "itx.",
      extensions: [tsFacetWorker.of({ path: REPL_SOURCE_PATH, worker })],
    });

    await expect(
      itxReplAutocompleteWorker(tsFacetWorker)(new CompletionContext(state, 4, true)),
    ).resolves.toBe(result);
    expect(worker.getAutocompletionWithDocs).toHaveBeenCalledWith({
      path: REPL_SOURCE_PATH,
      context: { explicit: true, pos: 4 },
    });
  });
});

function createReplTypeScriptEnv(
  code: string,
  scopeModules?: { globals: string; preamble: string },
): VirtualTypeScriptEnvironment {
  const service = createReplLanguageService(code, scopeModules);
  return {
    getSourceFile: (path: string) => service.getProgram()?.getSourceFile(path),
    languageService: service,
  } as VirtualTypeScriptEnvironment;
}

function createReplLanguageService(
  code: string,
  scopeModules?: { globals: string; preamble: string },
): ts.LanguageService {
  const files = new Map<string, string>([
    [ITX_TYPES_PATH, itxTypesDeclaration],
    [REPL_TYPES_PATH, itxReplDeclaration],
    ...(scopeModules
      ? ([
          [REPL_SCOPE_PREAMBLE_PATH, scopeModules.preamble],
          [REPL_SCOPE_GLOBALS_PATH, scopeModules.globals],
        ] as const)
      : []),
    [REPL_SOURCE_PATH, code],
  ]);
  const host: ts.LanguageServiceHost = {
    directoryExists: ts.sys.directoryExists,
    fileExists: (fileName) => files.has(fileName) || ts.sys.fileExists(fileName),
    getCompilationSettings: () => compilerOptions,
    getCurrentDirectory: () => process.cwd(),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getDirectories: ts.sys.getDirectories,
    getScriptFileNames: () => [...files.keys()],
    getScriptSnapshot: (fileName) => {
      const content = files.get(fileName) ?? ts.sys.readFile(fileName);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getScriptVersion: () => "0",
    readDirectory: ts.sys.readDirectory,
    readFile: (fileName) => files.get(fileName) ?? ts.sys.readFile(fileName),
  };
  return ts.createLanguageService(host);
}
