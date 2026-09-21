# vendor/opencode/

`@opencode/sdk@2.0.12`'s `./workerd` entry, bundled by esbuild into
`entry.js` plus code-split chunks (`build-opencode.mjs` next to this file is
the exact build), so the platform's dynamic-worker bundler only has to copy
files (the object's ref uses `bundle: false`) instead of installing
opencode's dependency tree (394 packages, 451MB) or running esbuild over it
inside its 128MB isolate.

Two things keep the artifact small, because the OS Durable Object isolate
that hands modules to Worker Loader is shared and memory-bound (13MB of
modules tipped it over on preview):

- packages opencode never reaches here — other providers' SDKs (AWS,
  Anthropic, Google auth, Venice, GitLab), the npm-install machinery for
  plugins, OpenTelemetry exporters, native-module shims — are replaced by a
  CommonJS Proxy stub, so named imports compile and only fail if called;
- code splitting keeps the eagerly loaded part to the entry's static graph.

Result: 8.6MB over ~210 files.

Reproduce (from any scratch directory):

```sh
npm init -y && npm i @opencode/sdk@2.0.12 esbuild
printf 'export { OpenCodeWorkerd } from "@opencode/sdk/workerd"\n' > entry.ts
node build-opencode.mjs opencode
```

Build details worth knowing (all in `build-opencode.mjs`):

- `mainFields: ["module", "main"]`: with `platform: "node"` esbuild would
  pick UMD `main` builds (jsonc-parser), whose `require` branch then fires.
- the banner: CommonJS dependencies inside an ESM bundle need a `require`;
  Worker Loader modules have no `import.meta.url`, so `createRequire` gets
  a literal path.

`entry.d.ts` is hand-written and covers only what
`apps/opencode/opencode.ts` uses.
