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
  itxReplDeclaration,
  itxTypesDeclaration,
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
  test("autocomplete on the itx handle offers the next-engine surface", async () => {
    const env = createReplTypeScriptEnv("itx.");
    const result = await getAutocompletionWithDocs({
      env,
      path: REPL_SOURCE_PATH,
      context: { explicit: true, pos: "itx.".length },
    });

    // The handle is Session & Itx (see the prelude): the Session catalog and
    // every project built-in must complete.
    const labels = new Set(result?.options.map((option) => option.label));
    for (const member of [
      "describe",
      "projects",
      "provideCapability",
      "repo",
      "runScript",
      "secrets",
      "streams",
      "whoami",
      "workers",
    ]) {
      expect(labels, `expected completion "${member}"`).toContain(member);
    }
  });

  test("the editor's type surface is the raw next-engine contract, verbatim", () => {
    // itx-repl-types.ts re-exports ~/next/types.ts?raw as the virtual
    // filesystem's /itx-types.ts, so completions can never drift from the
    // design of record. Sentinels prove it's the real file, not a copy of the
    // removed legacy surface.
    expect(itxTypesDeclaration).toContain("Public ITX capability contract");
    expect(itxTypesDeclaration).toContain("export interface Session");
    expect(itxTypesDeclaration).toContain("export interface Itx extends ItxCapabilityHost");
    expect(itxTypesDeclaration).not.toContain("ItxHandle");
  });

  test("REPL session globals from the prelude type-check in a snippet", () => {
    // Every global the REPL runtime injects (see ~/itx/browser-repl.ts) must
    // be declared by the prelude, with the design-of-record types attached.
    const code = [
      'const projectScoped: string = projectId ?? "global";',
      "const target: object = new RpcTarget();",
      "const read: (handle: Itx) => Promise<StreamEvent[]> = (handle) =>",
      '  handle.streams.get("/chat").getEvents();',
      "const recipe: ProvideCapabilityInput = {",
      '  expression: ["streams", ["get", "/x"]],',
      '  path: ["alias"],',
      '  type: "itx-expression",',
      "};",
      "const previous: unknown[] = [$_, _, vars.anything, recipe];",
      "[projectScoped, target, read, previous];",
    ].join("\n");
    const env = createReplTypeScriptEnv(code);

    const diagnostics = env.languageService
      .getSemanticDiagnostics(REPL_SOURCE_PATH)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });

  test("core next-engine calls type-check against the raw types file", () => {
    const code = [
      "const description = await itx.describe();",
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
    for (const member of ["append", "getEvents", "subscribe", "waitForEvent"]) {
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

function createReplTypeScriptEnv(code: string): VirtualTypeScriptEnvironment {
  const service = createReplLanguageService(code);
  return {
    getSourceFile: (path: string) => service.getProgram()?.getSourceFile(path),
    languageService: service,
  } as VirtualTypeScriptEnvironment;
}

function createReplLanguageService(code: string): ts.LanguageService {
  const files = new Map<string, string>([
    [ITX_TYPES_PATH, itxTypesDeclaration],
    [REPL_TYPES_PATH, itxReplDeclaration],
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
