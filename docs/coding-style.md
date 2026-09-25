# Coding style

## Helpers and utilities

Limit complexity and optionality. If a function is only called once, do not add optional properties — make the used parameters required and drop the rest. That keeps call sites explicit.

When a function clearly performs one intuitive operation on a single primitive
input, pass that primitive directly (`getSecret(path)`, not
`getSecret({ path })`). Add an options bag after the primary input when the
operation also has secondary settings. Use a single options bag when several
peer parameters share the same type or positional arguments would otherwise be
ambiguous and easy to flip.

Avoid fallback values that paper over uncertain system states. Make invalid states unreachable instead of accommodating them in code.

## Event types

Spell an event type as its full `events.iterate.com/<namespace>/<event>` string literal wherever
it is used: a contract's `events`, `consumes` and `emits`, its reduce, an append, a
`waitForEvent` filter and a test. Do not put a type behind a constant
(`const WOKEN = "events.iterate.com/itx/woken"`), an `eventTypes`-style object or a helper that
adds the prefix, even to avoid repeating the string inside one file. A search for the full type
then finds every producer and consumer.

A `Set` or array that lists several types for one check may stay, with literal members, and so
may a TypeScript union of types. A generic mechanism that serves several namespaces, like the
entity lifecycle's `<slug>/created`, builds the type from its parameter. The naming rules are in
[packages/iterate/README.md](../packages/iterate/README.md#event-types).
