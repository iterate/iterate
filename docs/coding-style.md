# Coding style

## Helpers and utilities

Limit complexity and optionality. If a function is only called once, do not add optional properties — make the used parameters required and drop the rest. That keeps call sites explicit.

If several parameters share the same type, use an options bag instead of a long positional list that can be flipped by mistake.

Avoid fallback values that paper over uncertain system states. Make invalid states unreachable instead of accommodating them in code.

## Durable Objects

Durable Objects should normally live behind tiny dedicated workers and be invoked from app workers through namespace bindings. That keeps app worker startup smaller and makes the DO deployment boundary explicit.

Prefer the mixins in `packages/shared/src/durable-object-utils` for new Durable Objects unless there is a clear reason not to.

See `.agents/skills/adding-a-new-durable-object-mixin/SKILL.md` when adding mixins.
