---
status: needs-grilling
size: small
---

# `no-high-entropy-strings`: nothing secret-shaped in the public folders

## Status

- Sweep done, no rule written yet. **A strict rule is viable:** outside the copied lockfile it has
  33 hits in 18 files, almost all test fixtures.
- Only real ids found: two KV namespace ids in `core/os/wrangler.base.jsonc`, and nothing uses them.
  No API keys, account ids or analytics keys anywhere in the public folders.
- Left: grill the exemptions (lockfile, `data:` URIs, test vectors), then write the rule.

## Why

`core/` and `packages/` (and `configs/`, which the packages copy also takes) are copied one-way to
the public iterate/core and iterate/packages (`copybara/copy.bara.sky`). Anything high-entropy in
them is at best an anti-pattern (a hard-coded id that belongs in iterate/private or config) and at
worst a leak. Outside those folders we hard-code non-secret ids like the Cloudflare account id on
purpose; that's what iterate/private is for.

The idea: a strict, deterministic, mechanical lint rule saying it is illegal to have any UUID,
account id, public analytics key, API key or credential under those folders. No allowlist by
"looks harmless": if it's high-entropy, it's out.

## Assumptions (made without asking)

- Branch is off `apps-into-packages` (iterate/iterate#3512) so the sweep sees the post-move layout:
  the apps in `packages/` are what'll be public.
- Scope is everything Copybara copies under `core/**`, `packages/**`, `configs/**`, plus
  `copybara/core/**` and `copybara/packages/**` (the copies' root files). Tracked files only: 886.
- "High-entropy" means, mechanically (first match claims the span):
  - PEM blocks, JWTs (`eyJ….….`)
  - token prefixes: `sk-`, `sk-ant-`, `gh[pousr]_`, `github_pat_`, `phc_`, `AKIA`, `xox[abpr]-`,
    `AIza`, `(sk|pk|rk)_(live|test)_`, `whsec_`, `re_`, `dp.(st|pt|sa).`
  - UUIDs (any version)
  - `sha(1|256|384|512)-<base64>` integrity strings
  - hex runs ≥ 24 chars (Cloudflare account/zone/KV ids are 32, git shas 40)
  - base64/base64url runs ≥ 32 chars with upper + lower + digit and Shannon entropy ≥ 4.2 bits/char
  - digit runs ≥ 9 (snowflake-style numeric ids)

## Checklist

- [x] sweep `core/`, `packages/`, `configs/`, `copybara/{core,packages}/` with a throwaway scanner
      _scratchpad `sweep.mjs`, detectors listed above; also ran on `apps/ scripts/ envs.ts test/
    docs/ lint/ .github/`, where it finds the real ids (Cloudflare account id and PostHog `phc_`
      key in `envs.ts`, UUIDs), so it does catch things_
- [x] bucket the hits _see Results_
- [x] write up whether a strict rule is viable and what it would need to exempt _see Verdict_
- [ ] grill the open questions below
- [ ] write the rule (lint workspace test, like `lint/event-types.test.ts`, or an oxlint plugin)

## Results

886 files, 892 hits. 859 of them are in one file, `copybara/core/pnpm-lock.yaml` (842
`sha512-…` integrity strings, 17 `patch_hash` / peer-suffix hex). The other 33 hits:

| Bucket                       | Hits | Where                                                                                                                                                                                                                                        | Verdict                                                                                                                                     |
| ---------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Real infra ids, unused**   | 2    | `core/os/wrangler.base.jsonc:119-120` (`ITX_KV`, `OAUTH_KV` namespace ids, since the os-next clean room)                                                                                                                                     | Delete. `generate-wrangler-config.ts:156` builds `kv_namespaces` from scratch, ids from `envs.ts` `resources` or none                       |
| **Public-by-design key**     | 1    | `packages/browser-extension/public/manifest.json:7` (`"key"`: RSA public key that pins the extension id)                                                                                                                                     | Inject at build time from private config, or exempt. Nothing references the pinned id (`chrome-extension://…`)                              |
| **Embedded binary**          | 1    | `packages/voice/src/screen-font.ts:9` (woff2 as a `data:` URL, deliberately inlined)                                                                                                                                                         | Exempt `data:…;base64,` or generate from the `.woff2` asset at build time                                                                   |
| **Git object test vectors**  | 10   | `core/os/src/repo/git-wire.test.ts` (real hashes `hashObject` must reproduce, incl. git's empty tree `4b825dc…`)                                                                                                                             | Known-answer tests. Compute with `git hash-object` in the test, or allow with a disable comment                                             |
| **Made-up fixture shas/ids** | 5    | `core/lib/src/pkg-pr-new.test.ts:4`, `core/os/src/context/module-resolution.test.ts:294`, `packages/ai-linter/src/run.test.ts:161,183`, `core/os/scripts/generate-wrangler-config.test.ts:51` (`0123456789abcdef…` as `cloudflareAccountId`) | Tests mint them (`randomBytes`) or use obvious low-entropy fakes (`"a".repeat(40)`)                                                         |
| **Fixture UUIDs**            | 3    | `core/lib/src/app-server.test.ts:222,249` (session cookie), `packages/ui/src/apps/server.test.ts:112` (`00000000-0000-4000-8000-000000000001`)                                                                                               | `crypto.randomUUID()`. The all-zeros one is low-entropy but UUID-shaped: decide whether the UUID detector checks entropy                    |
| **Pinned permalink**         | 1    | `core/lib/README.md:28` (iterate/iterate blob at a commit sha)                                                                                                                                                                               | Point at a path on `main`, or exempt `github.com/…/blob/<sha>/` URLs                                                                        |
| **False positives**          | 4    | URL paths (`core/lib/src/cli/oauth.ts:108`, `packages/voice/src/screen-context.md:93`), the base62 alphabet (`core/os/src/personal-access-token.ts:31` and its test)                                                                         | Tune: split base64 runs on `/`; an alphabet has max Shannon entropy, so treat ascending runs as low-entropy or allow with a disable comment |
| **Long digits**              | 6    | `1700000000` timestamps, `9999999999999999999`, `20260928101112`                                                                                                                                                                             | Noise. Drop the digit detector or only flag 17–19 digit snowflakes                                                                          |

### Verdict

Viable as a strict rule. To land it clean:

- exempt `copybara/core/pnpm-lock.yaml` by path (generated, content hashes, not ours)
- exempt `data:…;base64,…` payloads (mechanical)
- delete the two KV ids, move the manifest key out or exempt it
- ~20 test-fixture edits, or one disable-comment form for known-answer vectors
- tune the base64 detector (split on `/`, skip alphabet runs) and drop or narrow long digits

### What entropy can't catch

Low-entropy identifiers pass any entropy rule. In the public folders today:

- personal emails: `jonas.huckestein@gmail.com`, `jonas@nustom.com` (`core/os/src/name-suggestions.test.ts`)
- a Google Form id: `forms.gle/DwBoPRa3CWQ8ajFp7` (`core/os/public/setup-prompt.md:61`, 17 chars,
  under the 32 threshold; public on purpose)
- short numeric ids (GitHub App, installation, bot user ids): none found under the public folders.
  The bot user id `233973017` is in `scripts/ci/copybara.ts`, which isn't copied

None is a secret. If "nothing iterate-specific" is the goal, it's a different rule (email
domains, an allowlist of example domains).

## Questions to grill

- Lockfile: exempt by path (proposed), or is a lockfile in a public copy fine because it's not "ours"?
- Test fixtures: ban (tests mint ids at runtime) or exempt `*.test.ts`? Proposed: ban; the
  fixtures are few and minting is easy. Known-answer vectors get a disable comment.
- Manifest key: does the extension id need to stay pinned for public builds? If not, delete it.
- Disable comments at all? A strict rule with one greppable escape hatch
  (`// high-entropy-ok: <why>`) keeps the git test vectors honest without a path allowlist.
- Rule home: `lint/` workspace test (scans `git ls-files`, like `lint/event-types.test.ts`) fits
  better than an oxlint plugin, since the rule covers `.md`, `.json` and `.jsonc` too.
