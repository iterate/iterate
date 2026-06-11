import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import { createWorker } from "@valtown/codemirror-ts/worker";
import * as Comlink from "comlink";
import ts from "typescript";
import { getAutocompletionWithDocs } from "./itx-repl-autocomplete-worker.ts";
import { ITX_TYPES_PATH, itxReplDeclaration, itxTypesDeclaration } from "./itx-repl-types.ts";

const REPL_SOURCE_PATH = "/repl.ts";
const REPL_TYPES_PATH = "/iterate-repl-globals.d.ts";

const compilerOptions: ts.CompilerOptions = {
  // The prelude imports the design-of-record module as "./itx-types.ts".
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

// REPL snippets are function BODIES at runtime (every runner wraps them in an
// async function, so a trailing `return` is the documented way to produce a
// result), but the language service sees them as a module — where TS1108
// ("A 'return' statement can only be used within a function body.") fires.
// Filter that one diagnostic instead of wrapping the file: wrapping would
// shift every position the sync/lint/hover/completion extensions exchange.
const IGNORED_DIAGNOSTIC_CODES = new Set([1108]);

const worker = createWorker(async () => {
  const fsMap = await createDefaultMapFromCDN(compilerOptions, ts.version, false, ts);
  fsMap.set(ITX_TYPES_PATH, itxTypesDeclaration);
  fsMap.set(REPL_TYPES_PATH, itxReplDeclaration);
  fsMap.set(REPL_SOURCE_PATH, "\n");
  const system = createSystem(fsMap);
  const env = createVirtualTypeScriptEnvironment(
    system,
    [ITX_TYPES_PATH, REPL_TYPES_PATH, REPL_SOURCE_PATH],
    ts,
    compilerOptions,
  );

  const languageService = env.languageService;
  const keepDiagnostic = (diagnostic: ts.Diagnostic) =>
    !IGNORED_DIAGNOSTIC_CODES.has(diagnostic.code);
  const getSemanticDiagnostics = languageService.getSemanticDiagnostics.bind(languageService);
  languageService.getSemanticDiagnostics = (fileName) =>
    getSemanticDiagnostics(fileName).filter(keepDiagnostic);
  const getSyntacticDiagnostics = languageService.getSyntacticDiagnostics.bind(languageService);
  languageService.getSyntacticDiagnostics = (fileName) =>
    getSyntacticDiagnostics(fileName).filter(keepDiagnostic);

  return env;
});

Comlink.expose({
  ...worker,
  getAutocompletionWithDocs(input: Omit<Parameters<typeof getAutocompletionWithDocs>[0], "env">) {
    const env = worker.getEnv();
    if (!env) return null;
    return getAutocompletionWithDocs({ ...input, env });
  },
});
