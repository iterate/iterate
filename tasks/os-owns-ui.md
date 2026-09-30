---
status: in-progress
size: medium
---

# apps/os owns its UI

UI PR 1, and the last pre-work before `mkdir core && mv apps/os core`: apps/os stops importing
`@iterate-com/ui` and `@iterate-com/shared`, so core imports nothing outside core but `configs/` and
two `scripts/lib` helpers (those come into `core/` with the move).

The 09/29 call's split: hooks and headless providers go in `iterate`; rendered components come from
a shadcn registry, and each app keeps its own copy (a `button.tsx` per repo is fine). The registry
itself (UI PR 2) and moving the other apps to copies come later; this PR only gives apps/os its own.

Status: not started.

## What apps/os takes today

| From                                                                                                                                     | What                                                | Becomes                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@iterate-com/ui/components/{button,input,field,label,checkbox,avatar,spinner,native-select}` (+ `separator`, field's)                   | vendored shadcn (base-nova), byte for byte upstream | `apps/os/src/components/ui/`, written by `shadcn add` with apps/os's own `components.json`, under the drift check |
| `@iterate-com/ui/components/{standalone-page,iterate-logo,environment-head-content}`, `lib/environment-favicon` (+ test, + the logo svg) | our own                                             | copied into `apps/os/src/components/` and `src/lib/`                                                              |
| `@iterate-com/ui/components/posthog` (`initPosthog`)                                                                                     | the browser SDK's init                              | copied, only what apps/os uses                                                                                    |
| `@iterate-com/shared/posthog` (`proxyPosthogRequest`)                                                                                    | the `/e/*` proxy to PostHog                         | into `apps/os/src/posthog.ts`, beside the error reporting                                                         |
| `@iterate-com/ui/globals.css`                                                                                                            | Tailwind, tw-animate, shadcn's layer, the tokens    | apps/os's own `src/styles.css`                                                                                    |

## Decisions

- Imports inside apps/os: `package.json` subpath imports, `#/*` → `./src/*`, as the shadcn CLI's
  aliases (`#/components/ui`, …). TypeScript, Vite and Node read them with no other config.
- The drift check (`scripts/ci/shadcn-drift.ts`) covers each vendoring folder: packages/ui's and
  apps/os's, each with its own item list; the lint, format and `rules/` exclusions follow
  (`shadcn-drift.test.ts` checks them).
- Dependencies the copies need that another package also has go in the catalog.
- packages/ui keeps everything: the other apps still import it.

## Checklist

- [ ] `components.json`, the vendored items and our own copies in apps/os
- [ ] apps/os imports nothing from `@iterate-com/ui` or `@iterate-com/shared`; both leave its
      `package.json`
- [ ] the drift check, lint/format/rules exclusions for apps/os's vendored files
- [ ] `build.test.ts`'s outside-imports test fails on a new `@iterate-com/*` import
- [ ] typecheck, lint, knip, format, apps/os's tests, and the sign-in and consent pages look the
      same (CI's Browser specs, and a screenshot of each against main's)

## Out of scope

- The registry (UI PR 2), the other apps' copies, `use-context-explorer` into `iterate/react`.

## Implementation notes
