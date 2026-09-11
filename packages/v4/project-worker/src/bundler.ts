// bundler.ts — an RPC-only, stateless compiler. It never sees a project, ITX, or a live worker.

import { WorkerEntrypoint } from "cloudflare:workers";
import { createWorker, hasDependencies, InMemoryFileSystem } from "@cloudflare/worker-bundler";
import * as ts from "typescript";
import { z } from "zod";
import { BundleInput, type BuildResult, type CheckDiagnostic, type CheckResult } from "./build.ts";
import type { NativeWorkerCode } from "./context/worker-loader.ts";
import { TYPE_DEFAULT_LIB_FILE, TYPE_FILES, TYPE_ROOTS } from "./generated/type-files.ts";
import { deploymentIdOf } from "./app-config.ts";

const TOOLCHAIN_ID = "iterate-v4-bundler/1 worker-bundler@0.2.1";

// Celld's cross-service RPC addresses a named entrypoint; Cloudflare keeps the default export.
export { Bundler };
const BuildFailure = z.object({ errors: z.array(z.object({ text: z.string() })).min(1) });
const StoredModule = z.union([
  z.string(),
  z.strictObject({
    js: z.string().optional(),
    cjs: z.string().optional(),
    text: z.string().optional(),
    data: z.string().optional(),
    json: z.json().optional(),
  }),
]);
const StoredCode = z.strictObject({
  compatibilityDate: z.string(),
  compatibilityFlags: z.array(z.string()),
  mainModule: z.string(),
  modules: z.record(z.string(), StoredModule),
});
type StoredCode = z.infer<typeof StoredCode>;

/**
 * A separate Worker keeps esbuild-wasm and its cache outside the context Worker. Its cache key
 * includes every accepted input plus the exact adapter/toolchain identity, never ITX or a loader
 * host (those are late-bound authority, not build identity).
 */
export default class Bundler extends WorkerEntrypoint<{
  BUILD_CACHE: KVNamespace;
  VERSION?: { id: string };
  DEPLOYMENT_ID?: string;
}> {
  async build(value: BundleInput): Promise<BuildResult> {
    const input = BundleInput.parse(value);
    if (!Object.hasOwn(input.files, input.options.entryPoint))
      return {
        status: "rejected",
        diagnostics: [`Entry point ${input.options.entryPoint} is not in these source bytes.`],
      };
    if (hasDependencies(new InMemoryFileSystem(input.files)))
      return {
        status: "rejected",
        diagnostics: [
          "Bundle inputs must contain resolved dependency bytes; registry installation is not enabled.",
        ],
      };

    const key = await digest({
      version: deploymentIdOf(this.env, this.env.VERSION?.id),
      toolchain: TOOLCHAIN_ID,
      input,
    });
    const cached = await this.env.BUILD_CACHE.get(key, "json");
    if (cached) {
      const code = restoreCode(StoredCode.parse(cached));
      return { status: "built", code, diagnostics: [], key, cache: "hit" };
    }

    let output: Awaited<ReturnType<typeof createWorker>>;
    try {
      output = await createWorker({
        files: input.files,
        ...input.options,
        // Source diagnostics are returned to the caller; they are not runtime compiler defects.
        __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
          {
            name: "structured-diagnostics",
            setup(build: { initialOptions: { logLevel?: string } }) {
              build.initialOptions.logLevel = "silent";
            },
          },
        ],
      });
    } catch (error) {
      const failure = BuildFailure.safeParse(error);
      if (!failure.success) throw error;
      return { status: "rejected", diagnostics: failure.data.errors.map((item) => item.text) };
    }
    if (output.warnings?.length) return { status: "rejected", diagnostics: [...output.warnings] };

    const code = restoreCode(
      StoredCode.parse({
        mainModule: output.mainModule,
        modules: storeModules(output.modules),
        compatibilityDate: output.wranglerConfig?.compatibilityDate ?? "2026-09-01",
        compatibilityFlags: output.wranglerConfig?.compatibilityFlags ?? ["no_nodejs_compat"],
      }),
    );
    await this.env.BUILD_CACHE.put(key, JSON.stringify(storeCode(code)), { expirationTtl: 86_400 });
    return { status: "built", code, diagnostics: [], key, cache: "miss" };
  }

  check(value: BundleInput): CheckResult {
    const input = BundleInput.parse(value);
    if (!Object.hasOwn(input.files, input.options.entryPoint))
      return {
        status: "rejected",
        diagnostics: [
          {
            code: 6053,
            message: `Entry point ${input.options.entryPoint} is not in these source bytes.`,
          },
        ],
      };

    const files = new Map(Object.entries(TYPE_FILES));
    for (const [path, text] of Object.entries(input.files)) files.set(`/project/${path}`, text);
    const host: ts.CompilerHost = {
      fileExists: (fileName) => files.has(fileName),
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => "/",
      getDefaultLibFileName: () => TYPE_DEFAULT_LIB_FILE,
      getNewLine: () => "\n",
      getSourceFile: (fileName, languageVersion) => {
        const text = files.get(fileName);
        return text === undefined
          ? undefined
          : ts.createSourceFile(fileName, text, languageVersion, true);
      },
      readFile: (fileName) => files.get(fileName),
      useCaseSensitiveFileNames: () => true,
      writeFile: () => {},
    };
    const program = ts.createProgram(
      [...TYPE_ROOTS, ...Object.keys(input.files).map((path) => `/project/${path}`)],
      {
        noEmit: true,
        // This matches v4's checked Worker compilation: application code is checked against the
        // real declaration graph, while third-party declaration implementation errors are owned by
        // their packages and remain covered by this repository's own typecheck gate.
        skipLibCheck: true,
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      host,
    );
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => diagnosticOf(diagnostic));
    return diagnostics.length
      ? { status: "rejected", diagnostics }
      : { status: "checked", diagnostics };
  }

  override fetch(): Response {
    return new Response("RPC only", { status: 404 });
  }
}

/** Stable JSON makes a cache identity independent of caller object insertion order. */
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Build cache input must be finite JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = z.record(z.string(), z.unknown()).parse(value);
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function storeModules(
  modules: Record<
    string,
    string | { js?: string; cjs?: string; text?: string; data?: ArrayBuffer; json?: object }
  >,
): StoredCode["modules"] {
  return Object.fromEntries(
    Object.entries(modules).map(([name, module]) => {
      if (typeof module === "string") return [name, module];
      return [
        name,
        {
          ...(module.js !== undefined && { js: module.js }),
          ...(module.cjs !== undefined && { cjs: module.cjs }),
          ...(module.text !== undefined && { text: module.text }),
          ...(module.data !== undefined && { data: base64(new Uint8Array(module.data)) }),
          ...(module.json !== undefined && { json: module.json }),
        },
      ];
    }),
  );
}

function storeCode(code: NativeWorkerCode): StoredCode {
  return StoredCode.parse({
    mainModule: code.mainModule,
    modules: storeModules(code.modules),
    compatibilityDate: code.compatibilityDate,
    compatibilityFlags: code.compatibilityFlags ?? [],
  });
}

function restoreCode(stored: StoredCode): NativeWorkerCode {
  const modules = Object.fromEntries(
    Object.entries(stored.modules).map(([name, module]) => {
      if (typeof module === "string") return [name, module];
      return [
        name,
        {
          ...(module.js !== undefined && { js: module.js }),
          ...(module.cjs !== undefined && { cjs: module.cjs }),
          ...(module.text !== undefined && { text: module.text }),
          ...(module.data !== undefined && { data: unbase64(module.data).buffer }),
          ...(module.json !== undefined && { json: module.json }),
        },
      ];
    }),
  );
  // StoredCode proves the loader-required fields; the ambient Worker Loader declaration is broader
  // because it also admits non-cacheable module types not produced by this source-bytes adapter.
  return { ...stored, modules } as NativeWorkerCode;
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function unbase64(value: string): Uint8Array {
  const text = atob(value);
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

function diagnosticOf(diagnostic: ts.Diagnostic): CheckDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) return { code: diagnostic.code, message };
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    file: diagnostic.file.fileName.startsWith("/project/")
      ? diagnostic.file.fileName.slice("/project/".length)
      : diagnostic.file.fileName,
    line: position.line + 1,
    column: position.character + 1,
    code: diagnostic.code,
    message,
  };
}
