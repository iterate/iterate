---
status: done
size: small
---

# Rename eslint.config.js to oxlint-plugin-iterate.js and flatten the plugin wrapper

## Status summary

Done. The file is renamed, the `one.two.three` wrapper is flattened, `.oxlintrc.json` points at the new name, and `pnpm lint` passes (0 warnings/errors on 777 files with 68 rules — identical to before).

## Background

`eslint.config.js` in the repo root is not an ESLint config anymore — it's an oxlint JS plugin loaded via `jsPlugins` in `.oxlintrc.json`. It kept its old name during the eslint → oxlint transition so git would treat the change as a rename+edit rather than delete+create (see the TODO comment at the top of the file). That transition PR merged long ago, so the name is now just misleading.

Similarly, the default export is wrapped in a pointless `plugin.one.two.three` nesting structure. The comment claims "oxlint jsPlugins requires a specific nesting structure for the default export" — that was true at the time but no longer is. The wrapper adds three levels of indentation to ~770 lines of rule code for no benefit.

## Checklist

- [x] `git mv eslint.config.js oxlint-plugin-iterate.js` in its own commit so git records a clean 100% rename _(commit "Rename eslint.config.js to oxlint-plugin-iterate.js (pure rename)", recorded as a 100% rename)_
- [x] Flatten the `plugin.one.two.three` wrapper to a plain `const plugin = { meta, rules }` + `export default plugin`, de-indenting the body _(structural edit + `pnpm format` (oxfmt) for the re-indent)_
- [x] Update the `/** @type */` annotation to plain `import("eslint").ESLint.Plugin`
- [x] Drop the stale TODO comment and the "oxlint jsPlugins requires a specific nesting structure" comment
- [x] Update `jsPlugins` in `.oxlintrc.json` to point at `./oxlint-plugin-iterate.js`
- [x] Update the self-referencing error message in the `contract-package-imports` rule (`...add a prefix ... in eslint.config.js`)
- [x] Verify with `pnpm lint` (and `pnpm format` for the touched files) _(0 warnings and 0 errors, 777 files, 68 rules — same totals as before the change)_

## Notes / assumptions

- Filename `oxlint-plugin-iterate.js` is taken straight from the TODO comment in the file.
- The squash-merge to main will inevitably combine the rename with the re-indent, hurting rename detection there; the separate rename commit on the branch still makes review easier and the history on the branch accurate.
- `git diff -w` confirms the non-whitespace diff is only: the two stale comments removed, the wrapper opener/closers removed, the type annotation, the export statement, the `.oxlintrc.json` path, and the self-referencing rule message. oxfmt also collapsed a few expressions onto fewer lines now that they're 6 spaces shallower.
