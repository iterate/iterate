---
id: terminology/no-metaphorical-lane-door-seam
severity: error
files:
  [
    "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "**/*.{md,mdx}",
    "**/*.{c,h,cpp,hpp}",
    "**/*.{yml,yaml,json,jsonc}",
    "**/CMakeLists.txt",
    "!**/pnpm-lock.yaml",
    "!packages/ui/src/components/{alert-dialog,avatar,badge,breadcrumb,button,card,checkbox,command,dialog,dropdown-menu,empty,field,input,input-group,label,native-select,select,separator,sheet,sidebar,skeleton,sonner,spinner,table,tabs,textarea,tooltip}.tsx",
    "!packages/ui/src/hooks/use-mobile.ts",
  ]
suggestions: forbidden
---

# Ban lane, door, and seam as code metaphors

Do not use `lane`, `door`, or `seam` as a metaphor in identifiers, comments,
docs, test names, log or error text, or other source strings. Compound and
inflected forms such as `fastLane`, `creationDoor`, `testSeam`, `lanes` and
`backdoor` count too.

Each word stands in for a concept that already has a plain name. `lane` is
usually a test suite, a CI job, a delivery mode, a stream or a code path.
`door` is usually an entry point, method, endpoint, route or call. `seam` is
usually an interface, boundary or hook. A reader has to translate the metaphor
back into one of these, and different authors translate it differently.

This is a judgment rule, not a text search. Read the sentence and decide what
the word refers to.

Flag it when:

- the word names something in our own code, tests, CI or docs that could be
  called by what it is, for example "the workers lane", "the append door" or
  "the codec seam"
- a test title, log message, error string or fixture name uses it the same way

Do not flag it when:

- the source literally models a traffic lane, a physical door, or a
  joined or material seam
- the word is part of a larger word with another meaning, such as `plane`,
  `planet`, `indoor` or `seamless`
- it quotes something we do not control: a third-party API field, an upstream
  error message, or recorded output kept as a test fixture
- an immediately preceding lint directive gives a specific reason that the
  name must stay, such as a persisted event type, a stored key or a deployed
  route:

```ts
// iterate-lint-disable-next-line terminology/no-metaphorical-lane-door-seam -- mirrors the upstream API's `lane` field
const lane = vendor.lane;
```

A generic comment that restates the metaphor is not a reason.

Do not attach a suggested-change patch or propose a replacement identifier.
The metaphor often means the surrounding model or explanation is unclear, and
the right fix may rename several related concepts or rewrite a whole paragraph.
State what is unclear without telling the author what to change. Leave the
scope and wording of the fix to the author.
