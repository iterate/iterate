---
id: comments/no-narrating-comments
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
engine: jev
select: comment
window: [0, 3] # lines before, after the unit
question:
  instructions: |
    Code review rule for comments. A comment tells the reader of today's code what the code does and why. How the team found something out (the incident, the soak test, the CI run that went red, the pull request that changed it) belongs in the commit message and the pull request, not in the comment.
    Judge only the comment on the lines marked ">".

    The comment violates the rule if it does any of these:
    - tells an incident story: what broke on which day, how many calls failed, who waited, which deploy landed during an outage;
    - cites the team's own CI, soak or Depot run ids, or its own pull request numbers, as provenance for a claim;
    - narrates history: what the code did until some date, what "we used to" do, what was changed because an old version failed.

    The comment does NOT violate the rule if it:
    - states a design invariant or security reasoning, at any length;
    - gives one line of evidence for a measured constant or bound, with the date it was measured;
    - describes a platform workaround, naming its repro test or repository and when to remove it;
    - links an upstream issue, a primary source or a tracked follow-up;
    - names where a test fixture's recorded data came from.
  "true": "The comment tells an incident story, cites the team's own run ids or pull request numbers as provenance, or narrates the code's history."
  "false": "The comment states what is true and why: behaviour, invariants, reasons, a dated measurement, a workaround with its repro, an upstream link or a fixture's data source."
flag: 0.65 # p >= flag: a diagnostic with `message`
pass: 0.25 # p < pass: nothing; between: the LLM judges the unit with this file's prose
message: "This comment tells how we found out (a story, our own run or PR ids, or history). Keep what is true and why; the story belongs in the commit or PR."
---

# Comments say what is true, not how we found out

A comment tells the reader of today's code what it does and why. How we found
out belongs in the commit message and the PR body, which `git blame` leads to.
That covers the incident, the soak, the run that went red and the PR that
changed it.

This rule works with the Chesterton's-fence rule in
[docs/jonasland-rules.md](../../docs/jonasland-rules.md), not against it. Keep
the reason for a fence, the primary source it rests on and what did not work.
Drop the story of the day the fence went up.

Flag it when a comment:

- tells an incident story: what broke on which day, how many calls failed, who
  waited, or which deploy landed mid-outage
- cites our own CI, soak or Depot run ids, or our own PR numbers, as provenance
  (`soak z6s6cfhk8k`, `ci-soak-0924`, `after #2888`)
- narrates history: "until 2026-09-24 this…", "we used to…", "changed
  because the old version…"

A comment that repeats an explanation another file already gives is
[comments/no-repeated-explanations](no-repeated-explanations.md).

Do not flag:

- design invariants and security reasoning, at whatever length they need
- one line of evidence for a measured constant or bound, with its date, since
  the date says when the number may be stale:

  ```ts
  /** p99 266 ms, slowest 1.25 s in prd (measured 2026-09-24): 3 s is never a healthy wait. */
  const READ_BOUND_MS = 3_000;
  ```

- a platform workaround that names its repro (a test, or a repro repository)
  and when to remove it, instead of retelling the defect
- a link to an upstream issue, a primary source, or a tracked follow-up
  ("remove once cloudflare/workerd#1234 ships")
- the source of recorded data in a test fixture ("Depot's GetRunMetrics for run
  pxt90nlfvh, cut to the fields the guard reads")

Bad: the reader gets a story and has to work out the rule from it.

```ts
// On 2026-09-24 the CONTROL_PLANE singleton was unreachable for 188 s; a deploy landed inside the
// outage, its fresh isolates had no memo, and every project host failed.
```

Good: the invariant, with the one fact that sizes it.

```ts
// A deploy's fresh isolates have no memo, so without a copy a control-plane outage fails every
// project host until it ends (188 s on 2026-09-24).
```

Say what the comment should drop, and leave the new wording to the author.
