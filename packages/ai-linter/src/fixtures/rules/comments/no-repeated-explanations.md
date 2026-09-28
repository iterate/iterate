---
id: comments/no-repeated-explanations
severity: error
files:
  [
    "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "**/*.{yml,yaml}",
    "**/*.sh",
    "!**/pnpm-lock.yaml",
    "!packages/ui/src/components/{alert-dialog,avatar,badge,breadcrumb,button,card,checkbox,command,dialog,dropdown-menu,empty,field,input,input-group,label,native-select,select,separator,sheet,sidebar,skeleton,sonner,spinner,table,tabs,textarea,tooltip}.tsx",
    "!packages/ui/src/hooks/use-mobile.ts",
    "!**/*.gen.ts",
  ]
engine: llm
select: comment # the LLM reads the comments the pull request adds or changes, not the diff
window: [3, 5] # lines before, after each comment
---

# Say an explanation once

A comment must not repeat an explanation that another file or doc already
gives. Say it once, in the module that owns it or in a doc section, and link
it from the others. Two copies drift apart, and the reader cannot tell which
one is current.

Flag an added comment that restates, at length, an explanation another file
or doc in the pull request also gives.

Do not flag:

- a one-line pointer to where the explanation lives
- a short statement of what the explanation means for the code beside it,
  with a link to the full reasoning
- an interface's docstring and its implementation's, each describing its own
  contract
