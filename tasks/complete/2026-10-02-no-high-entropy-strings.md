---
status: done
size: medium
---

# `no-high-entropy-strings`: nothing secret-shaped in the public folders

## Status

- Done: the check is a test in `lint/public-copies.test.ts`, and the tree passes it.
- The two real ids are gone (unused KV ids), the extension key moved to `envs.ts`, and test fixtures
  are obvious fakes. Four strings stay, each under an `allow-high-entropy-next-line` marker.
- Left: nothing.

## Why

What Copybara copies (`core/`, `packages/`, `configs/`, `copybara/{core,packages}/`, see
`copybara/copy.bara.sky`) is public at iterate/core and iterate/packages. A high-entropy string
there is at best a hard-coded id that belongs in iterate/private, at worst a leak. Outside those
folders we hard-code non-secret ids like the Cloudflare account id on purpose.

## Decisions (Misha, 2026-10-02)

- **A `lint/` vitest test, not an oxlint rule and no ESLint.** oxlint lints only JS and TS files
  (and `<script>` in vue, astro and svelte), a list hard-coded in oxc, with no custom parsers. The
  check has to read `.md`, `.json`, `.yaml` and the rest too. It's a new test in
  `lint/public-copies.test.ts`, which already defines what each copy holds (`publicCopies()`).
- **Exemptions:** `copybara/core/pnpm-lock.yaml` by path (package checksums, not our ids). Anything
  else gets a marker comment on the line above, in whatever comment syntax the file has:
  `allow-high-entropy-next-line: <why>`. A made-up `eslint-disable-next-line iterate/…` would fail
  oxlint's unused-directive check, so the marker is our own.
- **Obvious test data passes.** UUIDs, hex and digit runs are flagged only above an entropy floor
  and when they change character at more than half their positions, so
  `00000000-0000-4000-8000-000000000001`, `aaaaabbbbbccccc111112222233333aaaaabbbbb` and
  `1700000000` pass, and a real id (or a sequential fake like `0123456789abcdef…`) doesn't.
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
- [x] the check in `lint/public-copies.test.ts`, failing on today's tree _28 hits before the fixes_
- [x] `core/os/wrangler.base.jsonc`: delete the two unused KV namespace ids _wrangler takes a KV
      binding with no id (local `d1 migrations apply -c wrangler.base.jsonc` clean, no warning);
      the Workers suite's oauth and personal-access-tokens tests pass_
- [x] `packages/browser-extension/public/manifest.json` `key`: out of the public copy. _`envs.ts`
      `CHROME_EXTENSION_KEY`, `scripts/build.ts` adds it; built both ways, same key as before_ It moves to
      `envs.ts` `spaEnvs`, and the extension's build adds it to `dist/manifest.json` when
      `CHROME_EXTENSION_KEY` is set (the SPA deploy sets it). A fork's build has no key, so Chrome
      derives the id from the folder; sign-in still works, since the extension registers its
      redirect URI with the issuer at sign-in
- [x] `packages/voice/src/screen-font.ts`: the base64 on its own line under a marker _its own
      const, `pressStart2pAsciiWoff2`, above the CSS_
- [x] `core/os/src/repo/git-wire.test.ts`: input blob ids from `hashObject`, expected ids by their
      first 7 hex digits, a run of one letter where the value doesn't matter _`threeFiles()` at
      the bottom; `TIP` is 40 `d`s_
- [x] made-up ids in tests: obvious fakes the shape of the real thing _the session cookie must
      be UUID-shaped (`appSession`), so it's `00000000-0000-4000-8000-000000000001`; shas, account
      ids and the PostHog key are groups of 5 (`aaaaabbbbbccccc111112222233333…`) at the real
      length_
- [x] `core/lib/README.md`: drop the blob link to the deleted decision record, keep
      `iterate/iterate#3018` _names the doc's path in that PR_
- [x] base62 alphabet (`core/os/src/personal-access-token.ts`, its test): markers
- [x] long numbers: rewrite or mark _only `call-client.test.ts`'s `20260928101112` is flagged
      (marked); the round timestamps and `999…` pass the floor_
- [x] check the check: break a fixture back, see it fail _planted ids in a README: random hex,
      UUID, `phc_` key, base64 secret and 9-digit id flagged; zero UUID, 40 zeros,
      `1700000000`, a marked UUID and a URL passed_
- [x] `core/AGENTS.md`: one bullet pointing at the check

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

## Implementation notes

- First run flagged no long numbers: `/agents/voice/cli/20260928101112-` is a 33-char run the
  base64 check rejected (no capitals), and rejected matches still blocked later checks. Now only a
  reported string blocks later checks.
- New hits the sweep's scope missed: `patches/*.patch` `index <sha>..<sha>` lines (skipped: pnpm's
  ids of the npm files, the patched code is still read) and `phc_FAKE_replay_privacy_test` (a key
  shape, flagged whatever its entropy, so the fixture is shortened).
- How often a real random id slips under a floor (200k samples): 16 hex 0.15%, 32 hex and UUIDs 0%,
  9 digits 4.5%, 12 digits 0.6%, 32-char base64 0.6%, 40-char 0.003%.
- Checks run: `lint/` (75 tests), the changed files' own tests in core/lib, core/os, ai-linter,
  voice and ui, `pnpm typecheck`, oxlint on the changed files, `pnpm knip`, and the Workers suite's
  oauth and personal-access-tokens tests (after `pnpm os:build`).
- Fakes are hardcoded literals, not `.repeat()` calls (Misha, 2026-10-02): a run of one character
  has 0 bits of entropy, so a literal of 40 `a`s passes the check.
- Fakes come in groups of 5, cycling a b c 1 2 3: `aaaaabbbbbccccc111112222233333aaaaabbbbb`
  (Misha, 2026-10-02). Six characters scored exactly the 2.5-bit floor, so a UUID, hex or digit
  string now also has to change character at more than half its positions to count as random.
  Real ids are missed no more often than before (same 200k-sample rates); `0123456789abcdef…` is
  still flagged.
- A fake keeps the real value's shape and length (Misha, 2026-10-02), so `"blob-sha"`,
  `"acme-account-id"` and `"phc_FAKE"` became grouped fakes. A key shape like `phc_…` is now
  excused by the same runs test (no entropy floor); random `phc_`, `sk-ant-`, `ghp_` and `AKIA` keys
  and a PEM header are still flagged.
- `public/manifest.json` keeps a placeholder `key` (Misha's review), so a reader sees where the key
  comes from. Chrome refuses an invalid key, so `scripts/build.ts` always swaps it: iterate's key
  when `CHROME_EXTENSION_KEY` is set, none otherwise. Built both ways: the env build's manifest
  equals main's.
