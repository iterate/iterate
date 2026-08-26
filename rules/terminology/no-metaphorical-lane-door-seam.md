---
id: terminology/no-metaphorical-lane-door-seam
severity: error
files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"]
suggestions: forbidden
---

# Ban lane, door, and seam as code metaphors

Do not use `lane`, `door`, or `seam` as a metaphor in identifiers, comments,
log or error text, or other source strings. Compound and inflected forms such
as `fastLane`, `creationDoor`, `testSeam`, and `lanes` count too.

Allow a use only when the source literally models a traffic lane, physical
door, or joined/material seam, or when an immediately preceding lint directive
gives a specific reason that the external or domain terminology must be kept:

```ts
// iterate-lint-disable-next-line terminology/no-metaphorical-lane-door-seam -- mirrors the upstream API's `lane` field
const lane = vendor.lane;
```

A generic comment that merely restates the metaphor is not an excuse.

Do not attach a suggested-change patch or propose a replacement identifier.
The metaphor often means the surrounding model or explanation is unclear, and
the right fix may rename several related concepts or rewrite a whole paragraph.
State what is unclear and leave the scope and wording of the fix to the author.
