---
status: in-progress
size: small
branch: middlewright-0.1.5
---

# middlewright 0.1.5 + lint rules

Status: in progress. Bump the middlewright dependency from a pkg.pr.new pin to
the just-released 0.1.5, and turn on the lint plugin's full rule set for specs.

## Context

- Root `package.json` pins `middlewright` to
  `https://pkg.pr.new/middlewright@71c68659...` — 3 commits behind v0.1.5.
- `patches/middlewright.patch` (spinner-waiter disappearance-goal fix) is NOT
  upstreamed in 0.1.5, so the patch stays. It's keyed version-agnostically in
  `pnpm-workspace.yaml` and the patched file was untouched upstream since the
  pin, so it should re-apply cleanly.
- `.oxlintrc.json` already loads `middlewright/lint-plugin` in `jsPlugins` and
  enables `middlewright/require-timeout-comment` on 4 mobile spec files only.
- 0.1.5 ships three rules: `prefer-locator-waits` (fixable),
  `prefer-positive-waits` (new in 0.1.5), `require-timeout-comment`.

## Checklist

- [ ] bump `middlewright` to `0.1.5` in root package.json, `pnpm install`,
      confirm the patch still applies
- [ ] enable all three `middlewright/*` rules for `specs/**` in `.oxlintrc.json`
      (drop the 4-file `require-timeout-comment` override in favour of the
      spec-wide one)
- [ ] fix resulting lint violations: autofix `prefer-locator-waits`, add
      explanatory comments (or restructure) for `prefer-positive-waits` /
      `require-timeout-comment` hits
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format` green
- [ ] run the specs lane (or at least a smoke subset) to confirm the bumped
      package + patch behave

## Assumptions (made while Misha is AFK)

- The rules apply to `specs/**` (the playwright/middlewright surface), not
  repo-wide — `prefer-locator-waits` would be wrong for vitest e2e files.
- Existing violations get fixed rather than the rules getting scoped down,
  unless a violation is genuinely contentious, in which case it gets an
  inline disable with a comment and a note here.

## Implementation notes

(log added as work happens)
