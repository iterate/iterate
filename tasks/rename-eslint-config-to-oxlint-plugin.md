---
status: in-progress
size: small
---

# Rename eslint.config.js to oxlint-plugin-iterate.js and flatten the plugin wrapper

## Status summary

Spec committed; implementation to follow in this branch. Small mechanical change: a file rename plus removing a now-unnecessary nesting wrapper.

## Background

`eslint.config.js` in the repo root is not an ESLint config anymore — it's an oxlint JS plugin loaded via `jsPlugins` in `.oxlintrc.json`. It kept its old name during the eslint → oxlint transition so git would treat the change as a rename+edit rather than delete+create (see the TODO comment at the top of the file). That transition PR merged long ago, so the name is now just misleading.

Similarly, the default export is wrapped in a pointless `plugin.one.two.three` nesting structure. The comment claims "oxlint jsPlugins requires a specific nesting structure for the default export" — that was true at the time but no longer is. The wrapper adds three levels of indentation to ~770 lines of rule code for no benefit.

## Checklist

- [ ] `git mv eslint.config.js oxlint-plugin-iterate.js` in its own commit so git records a clean 100% rename
- [ ] Flatten the `plugin.one.two.three` wrapper to a plain `const plugin = { meta, rules }` + `export default plugin`, de-indenting the body
- [ ] Update the `/** @type */` annotation to plain `import("eslint").ESLint.Plugin`
- [ ] Drop the stale TODO comment and the "oxlint jsPlugins requires a specific nesting structure" comment
- [ ] Update `jsPlugins` in `.oxlintrc.json` to point at `./oxlint-plugin-iterate.js`
- [ ] Update the self-referencing error message in the `contract-package-imports` rule (`...add a prefix ... in eslint.config.js`)
- [ ] Verify with `pnpm lint` (and `pnpm format` for the touched files)

## Notes / assumptions

- Filename `oxlint-plugin-iterate.js` is taken straight from the TODO comment in the file.
- The squash-merge to main will inevitably combine the rename with the re-indent, hurting rename detection there; the separate rename commit on the branch still makes review easier and the history on the branch accurate.
