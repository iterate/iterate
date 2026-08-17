---
status: ready
size: medium
---

# Typed script-result handles: `Results<"agent-output-400">`

Followup to `tasks/script-result-truncation.md` (which renders an inferred TS type for oversized script results). Bonus round: make that type *usable* in later scripts, not just readable.

Goal:

```ts
const data: Results<"agent-output-400"> = JSON.parse(
  await itx.workspace.readFile(".../script-results/agent-output-400.json"),
);
```

- [ ] register each spilled result's inferred type in the typecheck virtual project (`apps/os/src/domains/typecheck/virtual-project.ts`) under a `Results<Id>` lookup type, so `itx.docs.typecheck` validates drill-in scripts against the real shape
- [ ] decide lifetime/scope: types for results of the current agent stream only? persisted where? (probably regenerate on demand from the spill file rather than storing type text)
- [ ] surface it in the spill notice recipe once it actually typechecks
