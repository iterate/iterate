# Coding style

## Helpers and utilities

Limit complexity and optionality. If a function is only called once, do not add optional properties — make the used parameters required and drop the rest. That keeps call sites explicit.

If several parameters share the same type, use an options bag instead of a long positional list that can be flipped by mistake.

Avoid fallback values that paper over uncertain system states. Make invalid states unreachable instead of accommodating them in code.
