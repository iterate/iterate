# Build/runtime options for loader-native project code

Status: this is the source investigation behind the first adapter, not its
exact exported types. That adapter is now implemented; see
[the current build contract](typed-surface-and-builds.md) and
[network evidence](../evidence/builds.md). The initial request/result sketches
below include options/module types outside the deliberately smaller shipped
slice. Typechecking is still proposed.

## Decision

Keep the current `WorkerInput` door as the smallest execution primitive: it
accepts already-loader-ready JavaScript modules and calls the native Worker
Loader. Add repository source as a **separate, pinned bundling adapter**, not
as a dependency on `apps/os` and not as a second runtime inside `project-core`.
The adapter returns inert bundle output; `project-core` alone turns that output
into a `WorkerInput` with its context's `ITX` and confined `globalOutbound`.

That is the narrowest honest path from a pinned repo entry point to dynamic
execution:

```ts
type BuildRequest = {
  files: Record<string, string>; // resolved immutable repository snapshot
  entryPoint?: string;
  bundle?: boolean;
  // small, serializable createWorker options only
};
type BundleResult = {
  mainModule: string;
  modules: Record<
    string,
    string | { js?: string; cjs?: string; text?: string; data?: ArrayBuffer; json?: object }
  >;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  warnings: string[];
};
```

The build service should call `createWorker(request)`, reject a failed build
and any policy-defined fatal warning, and return `BundleResult`. The host then
uses the bundle result as:

```ts
scope.load({
  compatibilityDate: bundle.compatibilityDate ?? platformDate,
  compatibilityFlags: bundle.compatibilityFlags ?? platformFlags,
  mainModule: bundle.mainModule,
  modules: bundle.modules,
});
```

`Scope.load()` continues to inject/overwrite `env.ITX` and `globalOutbound`.
It must never accept either as a cached build authority. This preserves the
existing one-gate confinement, and it means a bundle result is portable while
a `WorkerStub` is not.

## Why this fits the native boundary

The current Worker Loader types accept a `WorkerLoaderWorkerCode` with a
compatibility date, optional flags, a main module, and modules; `env`,
`globalOutbound`, tails, and limits are separate late-bound fields. Workerd
also rejects string `.ts`, `.tsx`, and `.jsx` modules with the explicit advice
to bundle before loading. Its `load()` implementation copies source so a
returned stub can survive child-isolate eviction; that does **not** make the
stub a cache result. [Workerd types](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/types/generated-snapshot/index.d.ts#L4141-L4167), [native loader implementation](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-loader.c%2B%2B#L102-L123), and [TS rejection](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-loader.c%2B%2B#L267-L317) support that split.

Cloudflare documents the same handoff: TypeScript and npm source must be
transpiled/bundled before `load()` or `get()`, and `createWorker()` returns
`mainModule` plus `modules` ready for those calls. [`Dynamic Workers: getting
started`](https://developers.cloudflare.com/dynamic-workers/getting-started/)

## The smallest practical dependency

`@cloudflare/worker-bundler@0.2.1` is the exact pin already used by OS. Its
root export supplies `createWorker`, `createApp`, asset helpers, in-memory and
Durable Object file-system helpers, and dependency installation helpers; the
separate `/typescript` export supplies a TypeScript language service, not the
runtime bundler. For the first core adapter, use only `createWorker` with an
inert `Record<string, string>` file map. Its useful serializable options are
`entryPoint`, `bundle`, `externals`, `target`, `minify`, `sourcemap`,
`registry`, JSX settings, `define`, `loader`, `conditions`, and
`virtualModules`; exclude custom `FileSystem` and esbuild-plugin callbacks at
the RPC boundary. The 0.2.1 declaration is installed from the root lockfile;
the maintained upstream source is currently 0.2.3 and labels this package
experimental. [Package source](https://github.com/cloudflare/agents/blob/99e5e2ecfed8ffb94b5d8fab1a80e3a62d7d9ee9/packages/worker-bundler/src/index.ts#L24-L77), [option/result types](https://github.com/cloudflare/agents/blob/99e5e2ecfed8ffb94b5d8fab1a80e3a62d7d9ee9/packages/worker-bundler/src/types.ts#L43-L223), and [runtime requirement](https://github.com/cloudflare/agents/blob/99e5e2ecfed8ffb94b5d8fab1a80e3a62d7d9ee9/packages/worker-bundler/README.md#L7-L11).

The bundler runs only in Workerd (production or `wrangler dev`), because it
imports `esbuild-wasm` as a Workers `WebAssembly.Module`; it is not a Node test
dependency. Therefore deploy a tiny RPC-only bundler Worker/entrypoint with
the pinned package, rather than import it into the context Worker. This is the
same isolation shape as OS's `src/worker-bundler.ts`, but core should own a
much smaller adapter and a separate pin. Cloudflare's current playground
documents that exact runtime-bundling pattern. [Playground
documentation](https://developers.cloudflare.com/dynamic-workers/examples/dynamic-workers-playground/)

Do not use the `/typescript` language service or OS's `tswasm` checker as the
build path: type diagnostics and emitted JS do not resolve/package a Worker
module graph with the Loader's semantics. A future advisory typecheck may be
another isolated service; OS deliberately separates its `tswasm` compiler from
the esbuild-Wasm bundler because their combined compressed code exceeds the
Worker upload limit (`apps/os/src/domains/typecheck/typechecker-entrypoint.ts`).

## Cache identity and limits

Cache only a successful `BundleResult`, keyed by canonical bytes of **all**
build-affecting inputs:

1. resolved repository identity (immutable commit/content digest), selected
   entry point, and the exact post-resolution file map;
2. the complete serializable `createWorker` option object, including ordered
   conditions, virtual modules, registry, and package-resolution inputs;
3. the exact worker-bundler version and any local patch identity; and
4. the adapter's bundle-cache schema version and platform compatibility defaults.

If bare package ranges are allowed, their lockfile/resolved package bytes must
be in the key; otherwise reject them in the first slice. Do not key a shared
bundle result by branch name, owner, `ITX`, a `Fetcher`, or a `WorkerStub`.
Conversely, the Loader `get()` identity must include the host deployment and
context/owner plus bundle digest, because it captures those late-bound RPC
bindings. OS's build key and loader boundary demonstrate these two different
identities in [`build-key.ts`](../../../../apps/os/src/domains/workers/build-key.ts)
and [`worker-loader.ts`](../../../../apps/os/src/domains/workers/worker-loader.ts).

The bundle-result transport must preserve `ArrayBuffer` for `data` modules. Workerd
also accepts `py` and `wasm`, while worker-bundler's `Modules` output is a
smaller JS/CJS/text/data/JSON subset. A JSON/KV cache may intentionally reject
binary output, as OS does, but that is a cache-format limit—not a Loader limit.
`createApp` adds browser assets and host-side asset routing, so it is outside
the first repo-entrypoint-to-`WorkerInput` slice.

## Verification slice

Public-network proof needs one isolated repository revision containing a
TypeScript entrypoint and a pinned dependency: load it through the bundler
adapter, invoke its explicit RPC method and fetch through the gate, then
repeat with the same revision to observe a build-cache hit without reusing a
context's authority. Change either source bytes, a bundler option, or the
bundler pin and require a different bundle identity. Finally attempt direct
`.ts` `WorkerInput` and require native rejection; this guards against silently
confusing a typecheck/emit result with loader-ready code.

## Exact pinned typecheck API: an optional next layer

The `@cloudflare/worker-bundler@0.2.1` tag resolves to
`3e8963a78cbdf2d281562289c995d3fef2c41595`. Its `/typescript` export has one
constructor: `createTypescriptLanguageService({ fileSystem })`. It returns a
live TypeScript language service and wrapped filesystem, not a transportable
check result. The service selects TypeScript/declaration files as roots;
`tsconfig.json` supplies compiler options. These are pinned source findings,
not proof that the project-core API already checks submitted source.
[Pinned implementation](https://github.com/cloudflare/agents/blob/3e8963a78cbdf2d281562289c995d3fef2c41595/packages/worker-bundler/src/typescript.ts).

The adapter can use that real API as follows. `declarations` below must come
from emitting the actual public contract **and its declaration dependency
closure**, including native runtime types. It is not a hand-written, permissive
substitute for `Scope`. Reserved paths must be checked for collisions before
combining caller files with the compiler-owned declarations/configuration.

```ts
import { InMemoryFileSystem } from "@cloudflare/worker-bundler";
import { createTypescriptLanguageService } from "@cloudflare/worker-bundler/typescript";
import type { DiagnosticMessageChain } from "typescript";

declare const resolvedFiles: Record<string, string>;
declare const declarations: Record<string, string>;

const { languageService } = await createTypescriptLanguageService({
  fileSystem: new InMemoryFileSystem({
    ...resolvedFiles,
    ...declarations,
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
    }),
  }),
});
try {
  const program = languageService.getProgram();
  if (!program) throw new Error("TypeScript did not create a program");
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].map((d) => ({
    code: d.code,
    file: d.file?.fileName,
    start: d.start,
    length: d.length,
    message: diagnosticText(d.messageText),
  }));
  console.log(diagnostics); // serializable data, not TypeScript SourceFile objects
} finally {
  languageService.dispose();
}

function diagnosticText(value: string | DiagnosticMessageChain): string {
  return typeof value === "string"
    ? value
    : [value.messageText, ...(value.next ?? []).map(diagnosticText)].join("\n");
}
```

The checked bundle need not be executed, and checking need not bundle it.
For a concrete acceptance test, one source using the emitted `Scope` should
typecheck `scope.cd('/review').readEvents()`, reject
`scope.cd('/review').imaginary()`, and reject an incorrect event payload.
Replacing the declaration graph must invalidate the check cache even when
source and emitted JavaScript stay unchanged:

```ts
checkKey = digest({ resolvedFiles, compilerOptions, declarationDigest, checkerVersion });
```

This belongs in `build.check()` beside, not inside, `build.build()`. Type errors
are advisory data; neither a passing typecheck nor a caller's declaration
authorizes loading or widens the ITX supplied at runtime.

The pinned implementation fetches TypeScript 6.0.2 standard-library files each
time it creates a service; it has no source-level library cache. Caller package
declarations must also be supplied explicitly. Its generated browser compiler
adds code beyond the already deployed esbuild-Wasm Worker. Co-location is
plausible, but compressed upload size, startup and bounded CPU need a small
preview proof before selecting it over a separate checker. Do not assume a
pure deterministic/offline check cache while ignoring those fetched inputs.
[Library acquisition](https://github.com/cloudflare/agents/blob/3e8963a78cbdf2d281562289c995d3fef2c41595/packages/worker-bundler/src/typescript.ts#L238-L258).
