import { acquireTypes as typmAcquireTypes } from "@iterate-com/typm";
import { createCachedFetch } from "@iterate-com/typm/cached-fetch";
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
  // Full lib FILENAMES, not short names: a dotted short name ("dom.iterable")
  // parses as a file with extension ".iterable" and env creation throws
  // TS6054. This is also the form tsconfig option conversion produces.
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
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

/**
 * Merge the whitelisted type-level options from the repo's tsconfig.json
 * over the defaults. Known limitation: `extends` is not followed — only the
 * file's own `compilerOptions` are read (chasing extends chains means
 * resolving npm-hosted configs, which is typm territory).
 */
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

// Diagnostics are NOT filtered here — the language service stays honest so a
// future whole-repo consumer (a Problems panel) sees everything. The editor's
// lint lane suppresses the noise-until-typm codes host-side, in
// `workerFacade.getLints` (repo-typescript.ts).
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

/**
 * typm: type acquisition for the repo's package.json dependencies — the
 * follow-up the seam comment above was written for. Acquired `.d.ts` trees
 * land under `/node_modules/...` in this vfs, where Bundler-mode resolution
 * finds them and the `declare module "*"` wildcard stops matching. Failures
 * degrade to exactly the wildcard-`any` behavior; nothing here can break the
 * editor.
 */
const TYPM_LIMITS = { maxPackages: 120, maxTotalBytes: 25 * 1024 * 1024 };

const typmFetch = createCachedFetch({
  fetch: (url) => fetch(url),
  cacheName: "typm-v1",
  // Flat listings and file contents are exact-versioned (immutable) URLs;
  // range-resolution answers change as packages publish, so never persist those.
  shouldCache: (url) => !url.includes("/package/resolve/"),
});

/** Dep maps of the last acquisition — package.json edits that don't change
 * dependencies (scripts, formatting) must not trigger anything. */
let lastAcquiredDependencies: string | null = null;

/** Every vfs path the last acquisition wrote — the delete baseline. Without
 * it, removing a dep would leave its phantom types resolving forever, and a
 * major bump would leave a mixed-version tree (old files v4 doesn't ship). */
let lastAcquiredFilePaths = new Set<string>();

/** Serializes acquisition runs: overlapping runs would interleave their vfs
 * writes, so a slow stale run (old dep ranges) could land its package
 * versions AFTER a newer run's and stick. Chaining keeps writes in request
 * order; the snapshot check happens inside the chain, so a queued duplicate
 * no-ops once its predecessor acquired the same deps. */
let acquireChain: Promise<unknown> = Promise.resolve();

function dependencySnapshot(packageJsonText: string): string | null {
  try {
    const parsed = JSON.parse(packageJsonText) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return JSON.stringify({
      dependencies: parsed.dependencies || {},
      devDependencies: parsed.devDependencies || {},
    });
  } catch {
    // A mid-edit package.json is unparseable more often than not; keep the
    // last acquired types until the JSON is whole again.
    return null;
  }
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
  /**
   * Run typm over the repo's package.json and write the acquired `.d.ts`
   * trees into the vfs. Returns whether anything new landed (the host
   * force-relints open buffers when it did) and whether the run FAILED
   * (nothing acquired for transient-looking reasons — the host then forgets
   * its request so a later reconcile retriggers). No-ops when the dependency
   * maps are unchanged or the JSON doesn't parse (mid-edit).
   */
  acquireTypes(input: {
    packageJsonText: string;
  }): Promise<{ acquired: boolean; failed: boolean }> {
    const run = acquireChain.then(async () => {
      const snapshot = dependencySnapshot(input.packageJsonText);
      if (!snapshot || snapshot === lastAcquiredDependencies || !worker.getEnv()) {
        return { acquired: false, failed: false };
      }
      lastAcquiredDependencies = snapshot;
      try {
        const result = await typmAcquireTypes({
          packageJson: input.packageJsonText,
          fetch: typmFetch,
          log: (message) => console.info(`[typm] ${message}`),
          limits: TYPM_LIMITS,
        });
        const nextPaths = new Set(Object.keys(result.files));
        // THROWN-fetch losses with NOTHING acquired means offline/CDN-down
        // (`result.failures` — the core degrades per-package, so a total
        // wipeout of throws is transient-shaped). Reset so a retry is
        // possible — retries stay cheap, they re-enter this dedupe — and
        // keep the previous acquisition's types rather than degrading
        // working buffers over a blip. Mere WARNINGS (resolve 404s,
        // unfetchable specifiers, no-types packages) are the registry's
        // honest answer: an empty result then falls through to the stale
        // diff below, evicting types the manifest no longer supports.
        if (nextPaths.size === 0 && result.failures > 0) {
          lastAcquiredDependencies = null;
          return { acquired: false, failed: true };
        }
        // Drop what the previous acquisition wrote and this one didn't:
        // removed deps must degrade back to the wildcard (not keep phantom
        // types), and version bumps must not leave a mixed-version tree.
        const stalePaths = [...lastAcquiredFilePaths].filter((path) => !nextPaths.has(path));
        const env = worker.getEnv();
        if (env) for (const path of stalePaths) env.deleteFile(path);
        for (const [path, content] of Object.entries(result.files)) {
          worker.updateFile({ path, code: nonEmpty(content) });
        }
        lastAcquiredFilePaths = nextPaths;
        // Deletions change effective types too — the host relints on either.
        return { acquired: nextPaths.size > 0 || stalePaths.length > 0, failed: false };
      } catch (error) {
        // Transient failure (offline, CDN hiccup): allow a later retrigger.
        lastAcquiredDependencies = null;
        console.error("[typm] type acquisition failed", error);
        return { acquired: false, failed: true };
      }
    });
    acquireChain = run.catch(() => {});
    return run;
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
