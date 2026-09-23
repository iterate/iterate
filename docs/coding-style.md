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
