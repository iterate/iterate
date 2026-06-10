import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import { createWorker } from "@valtown/codemirror-ts/worker";
import * as Comlink from "comlink";
import ts from "typescript";
import { getAutocompletionWithDocs } from "./itx-repl-autocomplete-worker.ts";
import { itxReplDeclaration } from "./itx-repl-types.ts";

const REPL_SOURCE_PATH = "/repl.ts";
const REPL_TYPES_PATH = "/iterate-repl-globals.d.ts";

const compilerOptions: ts.CompilerOptions = {
  allowSyntheticDefaultImports: true,
  lib: ["es2022", "dom"],
  module: ts.ModuleKind.ESNext,
  moduleDetection: ts.ModuleDetectionKind.Force,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
};

const worker = createWorker(async () => {
  const fsMap = await createDefaultMapFromCDN(compilerOptions, ts.version, false, ts);
  fsMap.set(REPL_TYPES_PATH, itxReplDeclaration);
  fsMap.set(REPL_SOURCE_PATH, "\n");
  const system = createSystem(fsMap);
  return createVirtualTypeScriptEnvironment(
    system,
    [REPL_TYPES_PATH, REPL_SOURCE_PATH],
    ts,
    compilerOptions,
  );
});

Comlink.expose({
  ...worker,
  getAutocompletionWithDocs(input: Omit<Parameters<typeof getAutocompletionWithDocs>[0], "env">) {
    const env = worker.getEnv();
    if (!env) return null;
    return getAutocompletionWithDocs({ ...input, env });
  },
});
