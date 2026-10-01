---
size: small
---

# npm: alias dependencies in the module loader

**Status:** done.

- Done: `npm:` aliases, aliases of platform packages, pkg.pr.new URL aliases, malformed aliases refused, lock prefix bumped, unit and e2e rows.
- Missing: nothing. `pinPkgPrNewVersion` for aliased URLs is out of scope (below).

A project's package.json can list an npm alias, and config code imports it by the listed name:

```json
{ "dependencies": { "foo": "npm:bar@1.2.3" } }
```

```ts
import x from "foo";
import y from "foo/sub";
```

## What we found (2026-10-01)

- `core/os/src/context/module-resolution.ts` `esmPackageBase(name, version)` builds `${ESM_ORIGIN}/${name}@${version}` from the key and the version as written: `https://esm.sh/foo@npm:bar@1.2.3`. esm.sh answers 404 when `foo` is not on npm (`iterate-2026-10-01@npm:iterate@0.4.0`).
- Worse: when the key IS a package on npm, esm.sh ignores the `npm:` part and serves the key's own package at its latest version. `https://esm.sh/react@npm:preact@10` is React 19. The loader locks that graph, so a project aliasing `react` keeps loading React.
- esm.sh spells a package's import of its own export bare when the package is external (`iterate@0.4.0/stream/processor` imports `iterate/lib`; `zod@3.25.76` imports `zod/v3/external`). Only the platform packages (`iterate`, `zod`) are external, so this happens exactly for an alias of a platform package, and the loader links those self-imports to the platform's build: half of each version.
- `pkgPrNewVersionOf(name, url)` returns nothing for a pkg.pr.new URL of another package (`"foo": "https://pkg.pr.new/o/r/bar@<sha>"`), so the loader refuses it and tells you to pin `https://pkg.pr.new/<owner>/<repo>/foo@<sha>`: a different package. npm and pnpm install a tarball URL under the listed name, so this is an alias too.

## Decisions

Assumptions, made AFK-style; flip any of them in review.

- An alias of a platform package loads at the aliased version, self-imports included. It is not refused. An alias names an exact package at a version, and linking part of it to the platform's build gives a mix neither version was tested as. The alias's imports of the OTHER platform package (iterate@0.4.0's `zod`), and the worker's own `iterate/*`, stay the platform's, like any library's.
- A pkg.pr.new URL of another package is an alias of that package, at a full commit only. A moving ref is refused naming the pin of the package the URL names.
- `npm:<package>` with no version asks esm.sh for `latest`, the version `npm install` picks.
- Refused, naming the form an alias takes: an alias of an alias (`npm:x@npm:y@1`), an alias of a URL (`npm:https://…`), and `npm:` alone. npm refuses the first two as well.
- The lock prefix moves to `module-lock-3`: the self-import rewrite is a rule change, and any lock stored for an alias may hold the wrong package. Every dependency set re-resolves once; a range may pick up a newer version then. That happened the last time the rules changed too.
- Out of scope: `pinPkgPrNewVersion` keeps pinning only URLs of the package they are listed under, so an aliased pkg.pr.new `@main` stays unpinned and the loader refuses it. Nothing the platform writes uses aliases.

## Checklist

- [x] `npm:<package>@<version>` loads `<package>` from esm.sh under the listed name, subpaths too _`esmPackageBase` in core/os/src/context/module-resolution.ts_
- [x] esm.sh is never asked for the listed name of an alias _the `react` → `@preact/compat` row asserts the exact fetch list_
- [x] an alias of a platform package imports its own subpaths at the aliased version _`npmSelfImportOf`, next to `prSelfImportOf`_
- [x] a pkg.pr.new URL of another package loads as an alias; a moving ref names the right pin _`pkgPrNewBuildOf` in core/lib/src/pkg-pr-new.ts_
- [x] malformed aliases refused by name _one table row each_
- [x] lock prefix bumped _`module-lock-3`_
- [x] an e2e row: a deployed loader runs an aliased platform package (`zod3` → `npm:zod@3`) beside the platform's zod _test/vitest/os/npm-packages.e2e.test.ts_

## Implementation log

- Live esm.sh (2026-10-01): with `iterate` in `external`, `iterate@0.4.0/stream/processor` imports `iterate/lib` bare, and `zod@3.25.76` imports `zod/v3/external` and `zod/v4/core`. Without it in `external` they are paths. The `/pr/` route spells them `iterate/iterate/iterate/…`, which `prSelfImportOf` already handles.
- Rewriting the bare self-import at the importer's version was chosen over dropping the alias target from `external` for its own requests. It needs no per-package query, and it also covers an alias of a platform package nested inside another library.
- Checked by running `resolveModules` with real `fetch` and importing the resolved graph in Node for `zod3`, `iterate-2026-10-01`, `react` → `@preact/compat`, and a pkg.pr.new alias of `iterate`.
