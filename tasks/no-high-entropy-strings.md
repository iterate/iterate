---
status: needs-grilling
size: medium
---

# `no-high-entropy-strings`: nothing secret-shaped in the public folders

Status: sweep only, no rule written. Results below.

## Why

`core/` and `packages/` (and `configs/`, which the packages copy also takes) are copied one-way to
the public iterate/core and iterate/packages (`copybara/copy.bara.sky`). Anything high-entropy in
them is at best an anti-pattern (a hard-coded id that belongs in iterate/private or config) and at
worst a leak. Outside those folders we hard-code non-secret ids like the Cloudflare account id on
purpose; that's what iterate/private is for.

The idea: a strict, deterministic, mechanical lint rule saying it is illegal to have any UUID,
account id, public analytics key, API key or credential under those folders. No allowlist by
"looks harmless": if it's high-entropy, it's out.

## Assumptions (Misha AFK-style, made without asking)

- Branch is off `apps-into-packages` (iterate/iterate#3512) so the sweep sees the post-move layout:
  the apps in `packages/` are what'll be public.
- Scope is everything Copybara copies under `core/**`, `packages/**`, `configs/**`, plus
  `copybara/core/**` and `copybara/packages/**` (the copies' root files). Tracked files only.
- "High-entropy" means, mechanically:
  - UUIDs (any version)
  - known token shapes: `sk-…`, `ghp_…`, `phc_…`, `AKIA…`, `xox…`, JWTs, PEM blocks
  - long hex runs (≥ 24 hex chars: Cloudflare account/zone ids, KV ids, sha1/sha256)
  - long base64/base64url-ish runs (≥ 32 chars, mixed case + digits) with high Shannon entropy
- This task is the sweep. The rule itself, and what to do about each violation class, is for after
  grilling.

## Checklist

- [ ] sweep `core/`, `packages/`, `configs/`, `copybara/{core,packages}/` with a throwaway scanner
- [ ] bucket the hits: real ids vs test fixtures vs generated/lockfile hashes vs false positives
- [ ] write up whether a strict rule is viable and what it would need to exempt

## Questions to grill

- Lockfile integrity hashes (`sha512-…`) and git shas in generated files: exempt by file, or is a
  lockfile in a public copy fine because it's not "ours"?
- Test fixtures with made-up UUIDs/ids: ban (make tests generate them) or exempt `*.test.ts`?
- Public-by-design keys (PostHog `phc_…`, OAuth client ids): do they move to iterate/private
  config, or to env?
