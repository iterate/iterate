# TypeScript Declarations As The Canonical Capability Description

Agents discover and program the itx surface, scripts get typechecked against
it, and humans read API docs for it — and until now each consumer had its own
description format (a 115KB generated type blob in every system prompt, JSON
Schema from MCP tools, free-prose `instructions`/`types` strings on mounts).
We decided that **TypeScript module source is the one canonical description
format for everything callable on itx**, regardless of origin (the Code Mode
pattern: non-TS descriptions — MCP JSON Schema, OpenAPI specs — convert to TS
declarations at the boundary where the capability enters the system).
TypeScript is the only format that models read well, feeds a typechecker
directly, and already has an acquisition/vfs toolchain in-house (typm, the
REPL and repo-IDE virtual filesystems).

Three consequences worth recording:

1. **The Itx Type Graph is the canonical artifact; the flat file is a
   projection.** The generator emits one record per exported declaration
   (`ItxApiDeclaration`: standalone source text with JSDoc, TSDoc summary,
   member summaries, referenced type names) and projects those records into
   `itx-api.generated.ts`. Ordinary top-level records remain verbatim;
   namespace members are individual graph records but are grouped into one
   namespace in the flat SDK. Discovery
   (`itx.docs`, `__describe`), docs rendering, and script checking consume
   the graph; the flat file survives only for consumers that need standalone
   import-free text (the published `iterate` package, internal client typing,
   vfs type environments). The `types-source.generated.ts` string-const copy
   and its generator are deleted. Declaration names are the stable identity —
   docs.iterate.com deep links and events.iterate.com cross-links key on
   them.

2. **Mount type declarations are TS module source with provide-time npm
   snapshotting.** A capability mount's `types` field is one grammar: plain
   TS declarations, bare names resolving against the ambient platform graph,
   and standard type-level `import("pkg")` references whose packages are
   declared in a `typesDependencies` semver map. npm-referenced declaration
   files are typm-resolved and snapshotted content-addressed **at provide
   time** (the `capability-provided` event records the resolved version and
   content hash); read-time resolution was rejected because it makes
   docs/checker output depend on a CDN being up and makes refolds
   nondeterministic. Staleness is a feature: the types describe what was
   mounted, and re-mounting is the upgrade gesture. Authored types are always
   plain — RPC stubification (promisified returns, pipelinable properties) is
   one canonical recursive transform (capnweb's) applied at the itx entry
   point by consumers, never spelled per capability.

3. **Runtime validation stays with runtime schemas.** TS-as-canon is for
   description and static checking only; zod (or a future schema library that
   can also emit runtime validators, e.g. TypeBox) remains the truth for
   runtime validation. Conversions into TS are deliberately lossy (JSON
   Schema constraints like `maxLength` do not survive) and never round-trip
   back.
