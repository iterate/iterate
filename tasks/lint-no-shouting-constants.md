---
state: in-progress
priority: medium
size: small
tags: [lint, coding-style]
---

# Lint rule: `iterate/no-shouting-constants`

**Status:** rule and tests done, registered `"off"`. The sweep found 263
single-use hits in 144 files; enabling it means inlining all of them, so the
enable decision and the sweep are waiting on Misha (see the log).

## Why

Misha does not like module-level named literals:

```ts
const MAX_SETTLEMENT_BYTES = 1_000_000;
const OVERSIZED_SCRIPT = "...";
// ...
expect(returnedBytes).toBeLessThan(MAX_SETTLEMENT_BYTES);
```

He prefers the literal written where it is used:

```ts
expect(returnedBytes).toBeLessThan(1_000_000);
```

The name adds an indirection the reader has to chase, and the SCREAMING case
implies a shared config knob when it is really a one-off value. Same spirit as
`iterate/no-single-use-helpers` (inline the single-use thing so the reader can
see what is actually happening).

## Policy

Flag a `const` declaration when ALL of these hold:

- it sits at module scope (direct child of `Program`);
- the name is SCREAMING_SNAKE_CASE: `/^[A-Z][A-Z0-9_]*$/` with at least one
  letter after the first (so `A` alone or `_` prefixes are not matched);
- the initializer is a plain literal: number, string, template literal with no
  `${}` parts, or a unary minus in front of a number;
- it is read exactly once. `typeof X` in a type position counts as a read, so a
  const used both as a value and a type is left alone.

Never flag:

- exported consts (`export const`, or `export { X }` later) — public surface;
- objects, arrays, functions, regexes, calls, `as const`, typed annotations —
  not a plain literal (the rule only looks at the four literal shapes above);
- consts read two or more times. Threshold reasoning: with `--deny-warnings`
  every hit blocks CI, and inlining a value twice is a judgment call the rule
  should not make. Single-use is the unambiguous case and matches the sibling
  `no-single-use-helpers` rule. Lowering the threshold later is a one-line
  change once the single-use sweep has landed;
- consts with a JSDoc block comment (`/** ... */`) directly above. That is the
  same escape hatch `no-single-use-helpers` uses: a written rationale means
  the author thought about the name. Line comments do not count.

Message tells the reader to write the literal inline at its use site.

## Severity

Root `pnpm lint` runs `oxlint --deny-warnings`, so `"warn"` fails CI exactly
like `"error"`. Options: enable (and fix every hit in this PR) or register
`"off"` like the other incubating rules (`typed-no-floating-promises`,
`mechanical-class-impl`) and list the hotspots here. Decision recorded in the
log below once the sweep has run.

## Checklist

- [x] Rule `no-shouting-constants` in `lint/oxlint-plugin-iterate.ts`. _Sits next to `no-single-use-helpers` and reuses its scope walk + JSDoc escape hatch; `isPlainLiteral` is the literal filter._
- [x] Register in root `.oxlintrc.json`. _As `"off"` for now: root lint runs `--deny-warnings`, so anything else fails CI until the 263 hits are inlined._
- [x] Tests in `lint/oxlint-plugin-no-shouting-constants.test.ts`: flagged
      single-use number/string/template/negative consts; allowed exported,
      non-literal, multi-reference, JSDoc'd, non-module-scope consts. _Six
      tests against the real oxlint binary, same fixture as the
      logical-and-spread tests._
- [ ] Sweep the repo, record the count and hotspots, fix trivial inlines. _Count and breakdown recorded below; the inlining itself waits on the enable decision._
- [ ] `pnpm install && pnpm typecheck && pnpm format && pnpm lint && pnpm knip`
      green; lint workspace tests green (`pnpm --dir lint test`).
- [ ] Draft PR with risk map. _Held until Misha has seen the sweep results._

## Implementation log

### 2026-09-03 sweep

Flip the rule to `"error"` and run `pnpm lint` to regenerate. Result:
**263 hits in 144 files**, zero other diagnostics. Nothing needed the name
regex tightened: every hit is a real SCREAMING_SNAKE single-use literal.

Rough breakdown by what the literal is:

| kind                                                       | ~count | example                                                    |
| ---------------------------------------------------------- | ------ | ---------------------------------------------------------- |
| timeouts, intervals, limits, thresholds (numbers)          | 120    | `const INGEST_WAIT_TIMEOUT_MS = 15_000;` (three DOs)       |
| event type strings                                         | 40     | `agent-ui-reducer.ts` alone declares 24 of them            |
| URLs, paths, storage keys, cookie names                    | 40     | `const POSTHOG_HOST = "https://eu.i.posthog.com";`         |
| test fixture ids                                           | 20     | `const PROJECT_ID = "prj_test";`                           |
| long / multi-line strings (GraphQL, YAML, error messages)  | 17     | `waitrose-api.ts` queries, `use-my-computer.ts` `TYPES`    |
| wire-format / protocol numbers where the name IS the doc   | 10     | `TS_NAME_NEAR_MISS = 2552`, `FIELD_WIFI_PASSWORD = 2`      |
| misc                                                       | 15     | `SIDEBAR_KEYBOARD_SHORTCUT = "b"`                          |

Hotspot files: `packages/ui/src/components/events/agent-ui-reducer.ts` (24),
`cloudflare-sandbox-durable-object.ts` (7), `apps/kit/src/firmware/config-image.ts`
(6), `apps/os/src/rpc-targets.ts` (6), `infer-json-type.ts` (5),
`sdk/capnweb/react.tsx` (5), `packages/ui/src/components/sidebar.tsx` (5).

Two classes look like genuine false positives under the stated preference:

1. Multi-line literals. Inlining a 15-line GraphQL query or a YAML fixture into
   a call argument is not the one-liner style the rule is after. Proposed
   exemption: skip a literal whose source spans more than one line (about 8
   of the 17 long strings; the rest are one-liners the formatter wrapped).
2. Protocol numbers where the literal is opaque and the name is the only
   documentation (`2552`, exit code `124`, the WebSocket GUID, the kit
   config-image field tags). The JSDoc escape hatch already covers these if
   the author writes `/** */`; today they mostly carry a trailing `//`
   comment or nothing. Option: also honour a trailing line comment on the
   declaration line, or just require the JSDoc form when sweeping.

The `FIELD_*` tags in `config-image.ts` also show the single-use threshold
misfiring on enum-like groups: fields 1 and 5 are used twice and stay, fields
2/3/4/6/7 are used once and get flagged, so the file would end up half named,
half inlined.
