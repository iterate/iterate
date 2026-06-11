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
  test("autocomplete options include itx JSDoc as CodeMirror completion info", async () => {
    const env = createReplTypeScriptEnv("itx.");
    const result = await getAutocompletionWithDocs({
      env,
      path: REPL_SOURCE_PATH,
      context: { explicit: true, pos: "itx.".length },
    });

    expect(result?.options.find((option) => option.label === "provideCapability")?.info).toContain(
      "Provide a capability",
    );
    expect(result?.options.find((option) => option.label === "describe")?.info).toContain(
      "Who/what am I holding?",
    );
    expect(result?.options.find((option) => option.label === "fetch")?.info).toContain(
      "explicit project egress",
    );
  });

  test("completion docs come verbatim from the design-of-record ~/itx/types.ts", async () => {
    const env = createReplTypeScriptEnv("itx.");
    const result = await getAutocompletionWithDocs({
      env,
      path: REPL_SOURCE_PATH,
      context: { explicit: true, pos: "itx.".length },
    });

    // These strings exist only in ~/itx/types.ts, never in the REPL prelude:
    // the provideCapability() doc's runSwiftOnMyMac example and
    // revokeCapability()'s shadow note.
    expect(result?.options.find((option) => option.label === "provideCapability")?.info).toContain(
      "runSwiftOnMyMac",
    );
    expect(result?.options.find((option) => option.label === "revokeCapability")?.info).toContain(
      "cannot be revoked, only",
    );
  });

  test("REPL session globals from the prelude type-check in a snippet", () => {
    // Every global the REPL runtime injects (see ~/itx/browser-repl.ts) must
    // be declared by the prelude, with the design-of-record types attached.
    const code = [
      'const projectScoped: string = projectId ?? "global";',
      "const target: object = new RpcTarget();",
      "const fn: ItxFn<StreamEvent[]> = (handle: ItxHandle) =>",
      '  handle.streams.get({ path: "/chat" }).read();',
      "const previous: unknown[] = [$_, _, vars.anything, env.anything];",
      "[projectScoped, target, fn, previous];",
    ].join("\n");
    const env = createReplTypeScriptEnv(code);

    const diagnostics = env.languageService
      .getSemanticDiagnostics(REPL_SOURCE_PATH)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });

  test("handles returned by itx.projects.get carry the capability fallthrough", async () => {
    const code = 'const project = await itx.projects.get("demo");\nproject.slack.chat.';
    const env = createReplTypeScriptEnv(code);
    const result = await getAutocompletionWithDocs({
      env,
      path: REPL_SOURCE_PATH,
      context: { explicit: true, pos: code.length },
    });

    // The fallthrough index signature offers no named completions, but the
    // access itself must type-check: no semantic errors on the snippet.
    expect(result).not.toBeNull();
    const diagnostics = env.languageService
      .getSemanticDiagnostics(REPL_SOURCE_PATH)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });

  test("nested autocomplete options include itx JSDoc as CodeMirror completion info", async () => {
    const code = 'const project = await itx.projects.get("demo");\nproject.';
    const env = createReplTypeScriptEnv(code);
    const result = await getAutocompletionWithDocs({
      env,
      path: REPL_SOURCE_PATH,
      context: { explicit: true, pos: code.length },
    });

    expect(result?.options.find((option) => option.label === "provideCapability")?.info).toContain(
      "Provide a capability",
    );
    expect(result?.options.find((option) => option.label === "shareUrl")?.info).toContain(
      "signed, expiring URL",
    );
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
