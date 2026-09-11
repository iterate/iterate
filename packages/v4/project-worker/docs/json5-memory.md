# JSON5 bounded-token memory patch

## Scope

`json5@2.2.3` is patched locally through the workspace's `patchedDependencies` entry. The patch
is based on upstream JSON5 revision
[`b935d4a`](https://github.com/json5/json5/tree/b935d4a280eafa8835e6182551b63809e61243b0) and
changes only its [lexer](https://github.com/json5/json5/blob/b935d4a280eafa8835e6182551b63809e61243b0/lib/parse.js)
and [string printer](https://github.com/json5/json5/blob/b935d4a280eafa8835e6182551b63809e61243b0/lib/stringify.js)
buffering, plus their generated distribution artifacts. It does not add a source-size cap, a
grammar subset, or a fallback parser.

The original lexer accumulated strings, identifiers, and numbers with a repeated string append.
The original printer did the same while escaping strings. The patch accumulates up to a 4096
JavaScript-code-unit threshold in an array, flattens that into a chunk, and joins the chunks only
when emitting the completed token or string. An escape can make a chunk slightly exceed that
threshold. Escaped line continuations decode to an empty string and are skipped, so they add no
array entry. JSON5's accepted grammar, escapes, comments, quoting choice, and error locations
remain the library's own behavior.

This is a shared dependency patch: every workspace consumer of `json5@2.2.3` receives it locally.
Only the isolated v4 preview was deployed for this change; no other app was deployed.

## Reproduction and evidence

The public v4 expression seam is
`parse`/`print` in `src/context/expression.ts`. Its capped child-process regression creates the
legal 4.5 MiB hosted-facet source expression, parses it, prints it, reparses it, and checks the
round trip under `--max-old-space-size=128`:

```text
src/context/expression-memory.test.ts
src/context/expression-memory-scenario.ts
```

Before the patch, that test failed with V8 heap exhaustion while JSON5 lexed the source string.
After the parser and printer changes it passes. A direct `JSON5.stringify(JSON5.parse(...))` probe
of the same 4.5 MiB source also passes at the cap (`printedChars: 4718605`, peak RSS observed:
115696 KiB). Separate capped probes for a 4.5 MiB unquoted identifier and a 4.5 MiB number also
passed (observed peak RSS: 93216 KiB and 84480 KiB respectively).

A companion capped regression uses 2,359,296 escaped line continuations (4,718,594 input code
units), which decode to the empty string. It exposed that the initial chunk-array patch retained
one empty entry per continuation. The final patch skips those entries; the capped probe passes at
an observed peak RSS of 56768 KiB.

The upstream regression coverage adds long escaped strings, quoted output strings, identifiers,
and numeric literals. At Node 20.20.2, the complete upstream Tap suite passed: 182 tests. The
upstream runner's legacy `esm` integration is incompatible with the machine's Node 26, which is
why the full upstream suite was run with Node 20. Existing v4 expression/rewrite tests and the raw
facet admission E2E were also run locally against the patched dependency.

The original public 4.5 MiB facet-admission test also passes on the seventh isolated v4 deployment
(`9af4918d-14c6-43ea-9359-c2eb8c8db403`, 5 September 2026). It receives
`FACET_STARTUP_MEMO_TOO_LARGE`, `retryable: false`, finds no installed facet, and verifies that
neither submitted row landed. See the [versioned preview evidence](../../../../docs/preview-proof.md).

## Boundaries

These are concrete capped-path checks, not a claim that JSON5 is globally memory-safe under every
input shape, engine version, or surrounding application allocation pattern. The patch keeps
normal JSON5 semantics; it deliberately does not impose an arbitrary accepted-body limit.
