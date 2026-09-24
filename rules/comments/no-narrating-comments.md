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
  ]
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
- repeats an explanation that another file or doc already gives. Say it once,
  in the module that owns it or in a doc section, and link it from the others.

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
