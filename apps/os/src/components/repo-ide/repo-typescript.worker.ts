import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import { createWorker } from "@valtown/codemirror-ts/worker";
import * as Comlink from "comlink";
import ts from "typescript";
import { getAutocompletionWithDocs } from "../itx-repl-autocomplete-worker.ts";

/**
 * The repo IDE's TypeScript language service: a `@typescript/vfs` virtual
 * environment in a web worker, seeded with the repo's TypeScript-relevant
 * files so diagnostics/hover/completions see the WHOLE repo, not just the
 * open buffer. The multi-file sibling of `../itx-repl-typescript.worker.ts`
 * (single fixed file), driven by the host-side manager in
 * `./repo-typescript.ts`.
 *
 * The typm seam: `setFiles`/`deleteFiles` write arbitrary paths into the
 * same vfs, and module resolution is real (Bundler mode) with the
 * `declare module "*"` wildcard below as the lowest-priority fallback — so
 * the type-acquisition follow-up can drop `.d.ts` trees under
 * `/node_modules/...` and resolution starts finding them with no protocol
 * change here.
 */

const PRELUDE_PATH = "/__repo-ide-prelude.d.ts";

const prelude = `
/**
 * Bare-specifier imports are untyped (\`any\`) until type acquisition (typm)
 * seeds /node_modules in this vfs. TypeScript only consults wildcard ambient
 * modules for non-relative specifiers, and real resolved files always win —
 * so acquired types automatically shadow this fallback, while a broken
 * RELATIVE import still squigglies.
 */
declare module "*";

/**
 * Fallback JSX shapes: with \`jsx: react-jsx\` and no react types in the vfs,
 * TS falls back to the global JSX namespace — without one, every element is
 * a hard error under strict mode. Untyped-but-quiet until typm supplies real
 * react types, whose module-scoped JSX namespace then takes precedence.
 */
declare namespace JSX {
  interface IntrinsicElements {
    [element: string]: any;
  }
  type Element = any;
  interface ElementChildrenAttribute {
    children: {};
  }
}
`;

/**
 * Bundler-flavored defaults matching how project repos are actually built.
 * `moduleDetection: Force` keeps import-free files module-scoped so two
 * scratch files with the same top-level names don't cross-contaminate.
 */
const defaultCompilerOptions: ts.CompilerOptions = {
  allowImportingTsExtensions: true,
  allowJs: true,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  jsx: ts.JsxEmit.ReactJSX,
  lib: ["es2022", "dom", "dom.iterable"],
  module: ts.ModuleKind.ESNext,
  moduleDetection: ts.ModuleDetectionKind.Force,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  resolveJsonModule: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
};

/**
 * Type-level options the repo's own tsconfig.json may override. Resolution
 * and emit options stay pinned — the vfs only supports the Bundler layout,
 * and nothing here ever emits.
 */
const TSCONFIG_OPTION_WHITELIST = [
  "allowJs",
  "checkJs",
  "exactOptionalPropertyTypes",
  "jsx",
  "jsxImportSource",
  "lib",
  "noFallthroughCasesInSwitch",
  "noImplicitAny",
  "noImplicitOverride",
  "noImplicitReturns",
  "noUncheckedIndexedAccess",
  "noUnusedLocals",
  "noUnusedParameters",
  "strict",
  "strictNullChecks",
  "target",
  "verbatimModuleSyntax",
] as const;

function repoCompilerOptions(tsconfigText: string | null): ts.CompilerOptions {
  if (!tsconfigText) return defaultCompilerOptions;
  const parsed = ts.parseConfigFileTextToJson("/tsconfig.json", tsconfigText);
  const rawOptions: unknown = (parsed.config as { compilerOptions?: unknown } | undefined)
    ?.compilerOptions;
  if (typeof rawOptions !== "object" || rawOptions === null) return defaultCompilerOptions;
  const converted = ts.convertCompilerOptionsFromJson(rawOptions, "/", "tsconfig.json");
  const picked: ts.CompilerOptions = {};
  for (const key of TSCONFIG_OPTION_WHITELIST) {
    const value = converted.options[key];
    if (value !== undefined) (picked as Record<string, unknown>)[key] = value;
  }
  return { ...defaultCompilerOptions, ...picked };
}

/**
 * `knownLibFilesForCompilerOptions` (inside createDefaultMapFromCDN) matches
 * lib entries by `lib.<name>` prefix, so tsconfig-converted full filenames
 * ("lib.es2022.d.ts") select nothing. Normalize back to short names — the
 * language service accepts either form.
 */
function withShortLibNames(options: ts.CompilerOptions): ts.CompilerOptions {
  const lib = options.lib?.map((name) =>
    name.replace(/^lib\./, "").replace(/\.d\.ts$/, ""),
  ) as ts.CompilerOptions["lib"];
  return lib === undefined ? options : { ...options, lib };
}

/**
 * `@typescript/vfs` treats empty-string content as a missing file (its
 * getScriptSnapshot does `if (contents && ...)`), so a just-created empty
 * buffer would vanish from the program. Keep every file at least one char.
 */
function nonEmpty(content: string): string {
  return content === "" ? "\n" : content;
}

let seed: { files: Record<string, string>; tsconfigText: string | null } | null = null;

const worker = createWorker(async () => {
  const input = seed ?? { files: {}, tsconfigText: null };
  const options = repoCompilerOptions(input.tsconfigText);
  const fsMap = await createDefaultMapFromCDN(withShortLibNames(options), ts.version, false, ts);
  fsMap.set(PRELUDE_PATH, prelude);
  for (const [path, content] of Object.entries(input.files)) fsMap.set(path, nonEmpty(content));
  const system = createSystem(fsMap);
  return createVirtualTypeScriptEnvironment(
    system,
    [PRELUDE_PATH, ...Object.keys(input.files)],
    ts,
    options,
  );
});

/**
 * The editor extensions can ask about a path the host's reconciliation has
 * not pushed yet (a file created milliseconds ago). Materialize a blank file
 * instead of letting the language service throw on the unknown path; the
 * pending sync then updates it in place.
 */
function ensurePathExists(path: string) {
  const env = worker.getEnv();
  if (env && !env.getSourceFile(path)) env.createFile(path, "\n");
}

const api = {
  ...worker,
  /** Provide the seed BEFORE `initialize()` builds the environment (the
   * stock `WorkerShape.initialize` takes no arguments). */
  async initializeRepo(input: { files: Record<string, string>; tsconfigText: string | null }) {
    seed = input;
    await worker.initialize();
  },
  updateFile(input: { path: string; code: string }) {
    worker.updateFile({ path: input.path, code: nonEmpty(input.code) });
  },
  setFiles(files: Record<string, string>) {
    for (const [path, code] of Object.entries(files)) {
      worker.updateFile({ path, code: nonEmpty(code) });
    }
  },
  deleteFiles(paths: string[]) {
    const env = worker.getEnv();
    if (!env) return;
    for (const path of paths) env.deleteFile(path);
  },
  getLints(input: { path: string; diagnosticCodesToIgnore: number[] }) {
    ensurePathExists(input.path);
    return worker.getLints(input);
  },
  getHover(input: { path: string; pos: number }) {
    ensurePathExists(input.path);
    return worker.getHover(input);
  },
  getAutocompletionWithDocs(input: Omit<Parameters<typeof getAutocompletionWithDocs>[0], "env">) {
    const env = worker.getEnv();
    if (!env) return null;
    ensurePathExists(input.path);
    return getAutocompletionWithDocs({ ...input, env });
  },
};

/** Host-side type for `Comlink.wrap` — a superset of `WorkerShape`. */
export type RepoTypeScriptWorkerApi = typeof api;

Comlink.expose(api);
