---
status: complete
size: medium
---

# Fail worker builds on unresolved imports instead of shipping "No such module"

## Status summary

Done, pending review (PR #2292). Prod remediated (all 22 parked config-worker
feeds fixed and drained). The build now fails loudly when the bundle contains
an import that cannot resolve, instead of shipping an artifact that dies at
instantiation with a cryptic `No such module` and parks the config feed.
Verified end-to-end against the real bundler in workerd (new e2e tests).

## Incident (2nd "Config worker stalled", 2026-07-23)

`misha-kaletsky-s-organization` (and, it turned out, 21 other prod projects)
showed the red "Config worker stalled" warning. Thanks to the previous task
([2026-07-23-config-worker-stalled](complete/2026-07-23-config-worker-stalled.md)),
the sheet now showed the recorded error:

```
No such module "iterate/live-state".
 imported from "bundle.js"
```

## Root cause chain

1. Seeded config-repo `worker.ts` (old template) imports
   `iterate/live-state`.
2. The project's `package.json` floats on
   `iterate: https://pkg.pr.new/iterate/iterate/iterate@main`.
3. iterate#2167 (2026-07-21) moved LiveState to `iterate/sdk/capnweb` and
   removed the old entry points, deliberately without compatibility aliases.
4. On the next rebuild, worker-bundler's esbuild resolver hit the removed
   subpath: `resolveExports` throws, the plugin's `catch {}` **silently marks
   the import external**, and the build "succeeds" with a warning-free
   artifact whose `bundle.js` still says `import ... from "iterate/live-state"`.
5. Worker Loader injects nothing beyond the artifact's own modules, so
   instantiation fails with `No such module`; every push delivery to
   `processEventBatch` fails; three skip-verdicts later the subscription
   parks. Red sidebar until a human intervenes.

## Prod remediation (done, 2026-07-23)

- One-line fix per affected repo (`repo.edit`): `iterate/live-state` →
  `iterate/sdk/capnweb` (both symbols exist there), where the repo still had
  the old import; then `subscription-resumed` on `/` for every parked
  `project-worker` feed across all prod projects.
- All 22 drained to lag 0. The only remaining park is `parked-proof-26600`
  with recorded error "intentional poison: parked-warning prd proof" — a
  deliberate UI-proof project, left as is.

## The platform fix

The build boundary must refuse artifacts that cannot instantiate. Design:

- [x] Extend `patches/@cloudflare__worker-bundler@0.2.1.patch`: the esbuild
      virtual-fs plugin's bare-specifier `onResolve` now attaches a
      `Failed to resolve '<specifier>' from <importer>: <reason>` warning to
      the external fallback — distinguishing "the installed '<pkg>' package
      does not provide this entry" (the incident shape) from "package '<pkg>'
      is not installed" — and the relative-path fallthrough warns
      "file does not exist". Scheme'd specifiers (`cloudflare:*`, `node:*`)
      and dynamic imports stay silent (a guarded `await import()` is
      legitimate). _Regenerated via `pnpm patch`/`patch-commit`; installer
      hunks preserved._
- [x] `build-backend.ts`: `unresolvedImportFailures` fails the build
      (`WorkerBuildFailedError`) on those warnings — from the patched esbuild
      lane and the stock transform lane (`bundle: false`) — and on
      `File not found:` warnings. Bare node builtins (`fs`, `stream/web`, …)
      exempt via `NODE_BUILTIN_BASE_NAMES` in reviewable TS.
- [x] Clear, actionable failure message: names each unresolved specifier and
      importer, says the worker would fail at startup with `No such module`,
      and hints at the fixes (declare the dependency; update the import;
      `node:` prefix for builtins).
- [x] Tests: build-backend failure/exemption tables (mocked warnings), plus
      two new e2e tests in `worker-build.e2e.test.ts` running the REAL
      patched bundler in workerd: an unresolved bare import fails the build
      with the specifier named, and bare `path` + `node:buffer` +
      `cloudflare:workers` keep building and running. _worker-bundler cannot
      run under plain node (wasm module import), so the in-memory unit-test
      idea was replaced by the e2e lane; also re-ran the overlay and
      itx-workers e2e suites green as template regression cover._

## Explicitly out of scope

- Compatibility aliases for removed `iterate` entry points (#2167 chose not
  to have them; not relitigating here).
- Pinning projects' `iterate` spec at seed time instead of floating `@main` —
  bigger product question (floating keeps projects on the latest platform;
  pinning trades that for build reproducibility). Worth a separate task.
- Rebuild-and-verify sweeps that would proactively rebuild every project on
  SDK changes.

## Implementation log

- 2026-07-23: diagnosis + prod sweep (see above), via
  `doppler run --config prd -- pnpm cli itx run ...`.
