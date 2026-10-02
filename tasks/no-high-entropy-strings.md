---
status: in-progress
size: medium
---

# `no-high-entropy-strings`: nothing secret-shaped in the public folders

## Status

- Swept (results below), decisions made (Misha, 2026-10-02). Implementing.
- Left: the check, then the fixes it asks for.

## Why

What Copybara copies (`core/`, `packages/`, `configs/`, `copybara/{core,packages}/`, see
`copybara/copy.bara.sky`) is public at iterate/core and iterate/packages. A high-entropy string
there is at best a hard-coded id that belongs in iterate/private, at worst a leak. Outside those
folders we hard-code non-secret ids like the Cloudflare account id on purpose.

## Decisions (Misha, 2026-10-02)

- **A `lint/` vitest test, not an oxlint rule and no ESLint.** oxlint lints only `js mjs cjs jsx ts
mts cts tsx` (and `<script>` in vue/astro/svelte), hard-coded in oxc, with no custom parsers. The
  check has to read `.md`, `.json`, `.yaml` and the rest too. It's a new test in
  `lint/public-copies.test.ts`, which already defines what each copy holds (`publicCopies()`).
- **Exemptions:** `copybara/core/pnpm-lock.yaml` by path (package checksums, not our ids). Anything
  else gets a marker comment on the line above, in whatever comment syntax the file has:
  `allow-high-entropy-next-line: <why>`. A made-up `eslint-disable-next-line iterate/…` would fail
  oxlint's unused-directive check, so the marker is our own.
- **Obvious test data passes.** UUIDs, hex and digit runs are flagged only above an entropy floor,
  so `00000000-0000-4000-8000-000000000001`, `"0".repeat(40)` and `1700000000` pass, and a real id
  (or a sequential fake like `0123456789abcdef…`) doesn't.
- **Keep the long-number check**, exempting the few that need to stay.

### What it flags

- PEM headers, JWTs, and known token prefixes (`sk-`, `gh[pousr]_`, `github_pat_`, `phc_`, `AKIA`,
  `xox?-`, `AIza`, `(sk|pk|rk)_(live|test)_`, `whsec_`, `re_`, `dp.(st|pt|sa).`): always
- `sha512-…` style integrity strings: always
- UUIDs: when their hex digits have ≥ 2.5 bits/char of entropy
- hex runs ≥ 16 chars (our `pat_` ids are 16, minted ids 32, Cloudflare ids 32, git shas 40): ≥ 2.5
  bits/char
- base64/base64url runs ≥ 32 chars with upper, lower and digits: ≥ 4.2 bits/char, with URLs blanked
  out first (hex, UUID and token checks still read URLs)
- digit runs ≥ 9: ≥ 2 bits/char

## Checklist

- [x] sweep the public folders _33 hits in 18 files outside the lockfile, see Results_
- [ ] the check in `lint/public-copies.test.ts`, failing on today's tree
- [ ] `core/os/wrangler.base.jsonc`: delete the two unused KV namespace ids
- [ ] `packages/browser-extension/public/manifest.json` `key`: out of the public copy. It moves to
      `envs.ts` `spaEnvs`, and the extension's build adds it to `dist/manifest.json` when
      `CHROME_EXTENSION_KEY` is set (the SPA deploy sets it). A fork's build has no key, so Chrome
      derives the id from the folder; sign-in still works, since the extension registers its
      redirect URI with the issuer at sign-in
- [ ] `packages/voice/src/screen-font.ts`: the base64 on its own line under a marker
- [ ] `core/os/src/repo/git-wire.test.ts`: input blob ids from `hashObject`, expected ids by their
      first 7 hex digits, `"x".repeat(40)` where the value doesn't matter
- [ ] made-up ids in tests: obvious fakes or short strings
- [ ] `core/lib/README.md`: drop the blob link to the deleted decision record, keep
      `iterate/iterate#3018`
- [ ] base62 alphabet (`core/os/src/personal-access-token.ts`, its test): markers
- [ ] long numbers: rewrite or mark
- [ ] check the check: break a fixture back, see it fail

## Results (sweep, on `apps-into-packages`, same on main after #3512)

886 files, 892 hits. 859 in `copybara/core/pnpm-lock.yaml` (842 `sha512-…`, 17 `patch_hash` and
peer-suffix hex). The other 33:

| Bucket                     | Hits | Where                                                                                                                                                                                         |
| -------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real infra ids, unused     | 2    | `core/os/wrangler.base.jsonc:119-120`: `generate-wrangler-config.ts` builds `kv_namespaces` itself                                                                                            |
| Public-by-design key       | 1    | `packages/browser-extension/public/manifest.json:7`: pins the extension id (`panel.js` redirect URI)                                                                                          |
| Embedded binary            | 1    | `packages/voice/src/screen-font.ts:9`: woff2 inlined as a `data:` URL                                                                                                                         |
| Git object test vectors    | 10   | `core/os/src/repo/git-wire.test.ts`                                                                                                                                                           |
| Made-up fixture shas/ids   | 5    | `core/lib/src/pkg-pr-new.test.ts:4`, `core/os/src/context/module-resolution.test.ts:294`, `packages/ai-linter/src/run.test.ts:161,183`, `core/os/scripts/generate-wrangler-config.test.ts:51` |
| Fixture UUIDs              | 3    | `core/lib/src/app-server.test.ts:222,249`, `packages/ui/src/apps/server.test.ts:112`                                                                                                          |
| Pinned permalink           | 1    | `core/lib/README.md:28`: the doc it links was deleted in iterate/iterate#3111                                                                                                                 |
| URLs                       | 2    | `core/lib/src/cli/oauth.ts:108`, `packages/voice/src/screen-context.md:93`                                                                                                                    |
| base62 alphabet            | 2    | `core/os/src/personal-access-token.ts:31`, `core/os/src/personal-access-token.test.ts:23`                                                                                                     |
| Long numbers (test clocks) | 6    | `core/lib/src/client/live-state.test.ts:103`, `core/os/src/repo/git-wire.test.ts:197`, `core/os/src/secrets.test.ts:334` (×2), `:423`, `packages/voice/src/call-client.test.ts:16`            |

Not caught by any entropy check, and not secret: personal emails in
`core/os/src/name-suggestions.test.ts`, the Google Form id in `core/os/public/setup-prompt.md`.
