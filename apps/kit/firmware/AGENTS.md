# Iterate Kit firmware

This instruction applies to all C, C++, headers, and native firmware tests
under this directory.

## Reasoning comments are required

Before changing firmware code, read
[docs/reasoning-comments.md](docs/reasoning-comments.md).
Before probing or flashing a locally attached board, resolve it through
[docs/connected-device-inventory.md](docs/connected-device-inventory.md);
`/dev/cu.*` names are not device identities.
Before running or changing StackChan/HAVPE AEC qualification, follow
[the deterministic Mac fixture runbook](../docs/aec-release-qualification.md).

- Treat comments as part of the correctness proof. Non-obvious modules, public
  APIs, state machines, concurrency boundaries, resource budgets, and policy
  branches must explain the originating requirement, the mental model and
  invariant, relevant rejected alternatives, and the consequence of getting
  the decision wrong.
- Comment the reason, not the syntax. “Increment the counter” is noise;
  “saturate because diagnostics must remain monotonic during an unattended
  endurance run” records a design constraint.
- Test cases must explain the real failure mode they model, why a plausible
  implementation could get it wrong, and which production invariant the
  assertions protect.
- Keep reasoning comments synchronized with behavior. A change that invalidates
  the explanation is incomplete even if tests pass.
