---
status: in-progress
size: medium
---

# Fail worker builds on unresolved imports instead of shipping "No such module"

## Status summary

Diagnosed; prod remediated (all 22 parked config-worker feeds fixed and
drained). Code fix in progress: make the build fail loudly when the bundle
contains an import that cannot resolve, instead of shipping an artifact that
dies at instantiation with a cryptic `No such module` and parks the config
feed.

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

- [ ] Extend `patches/@cloudflare__worker-bundler@0.2.1.patch`: in the
      esbuild virtual-fs plugin's bare-specifier `onResolve`, when
      `resolveModule` THROWS (installed package with an unmatched subpath,
      invalid package.json, unresolvable relative path), attach an esbuild
      warning `Failed to resolve '<specifier>' from <importer>: <reason>` to
      the external fallback instead of staying silent. Scheme'd specifiers
      (`cloudflare:*`, `node:*`) never reach the throw path; dynamic imports
      stay silent (a guarded `await import()` is a legitimate pattern).
      Also warn (`package not installed`) for static bare imports of packages
      that are simply absent from `node_modules` — schemes excluded.
- [ ] `build-backend.ts`: fail the build (`WorkerBuildFailedError`) on
      `Failed to resolve '...'` warnings — from the patched esbuild lane and
      the transform lane (`bundle: false`), which already emits them — and on
      `File not found:` warnings. Exempt bare node builtins (`fs`,
      `stream/web`, …) since nodejs_compat provides them at runtime; keep the
      exemption list in reviewable TS, not in the patch.
- [ ] Clear, actionable failure message: name each unresolved specifier and
      its importer, say the worker would fail at startup with
      `No such module`, and hint at the causes (package not declared in
      package.json; the installed package no longer provides that entry —
      update the import; node builtins may use the `node:` prefix).
- [ ] Tests: build-backend failure/exemption table (mocked bundler warnings);
      real worker-bundler run over in-memory files (prebuilt fake
      `node_modules`, no network) proving the patch emits the warning for a
      removed subpath and stays quiet for `node:*`/`cloudflare:*`/dynamic
      imports — if esbuild-wasm cooperates in vitest; otherwise the mocked
      table stands alone.

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
