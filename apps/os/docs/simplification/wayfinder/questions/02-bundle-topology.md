# Q02 — Bundle topology: one bundle + role knob, or two distinct workers?

**Round 1. Status: open.**

## The question

Is the platform **one bundle** exporting both roles, selected by `APP_CONFIG.role:
"control-plane" | "runner" | "both"` (fable-minimalism, opus) — or **two genuinely distinct workers**
with a CI wall forbidding the control plane from importing project code (fable-migration, codex)?

## Why it matters

This decides R1's scope, the deploy story, and whether "collapsed" (one worker: dev/Pi) is a first-class
shape or an assembly of two. It's the most structural fork in the whole synthesis.

## Options

- **(A) One bundle, `role` knob.** Hosted deploys the same artifact twice (`control-plane`, `runner`);
  self-host/dev/Pi deploy once (`both`). R1 (byte-identical) true _by construction_. Smallest possible
  thing; "the split is a placement choice." _(fable-minimalism, opus-topology "collapsed/split/stretched")_
- **(B) Two distinct workers.** `apps/cp` (<2k LOC) + a runner worker; CI forbids cp↔project imports.
  Cleaner separation of authority; matches the eventual os reality (data gravity). R1 scoped to the
  _runner_ bundle only. _(fable-migration, codex-topology)_

## Recommendation: **(A) for the clean-room lab.** One bundle + `role` is the minimal elegant thing and

makes R1 self-evident. Keep the _option_ to compile two artifacts later for os (where the import-wall
earns its keep), but don't pay that structure in the lab.

## Correction to fold in

Drop R1's "identical bundle → free cold starts" justification — unsupported by CF docs; PR #2115 proved
warm-pinging a placebo. Keep R1 for **config-not-fork + one test matrix + provable parity**.
