# Agent-owned Cloudflare Computers — architecture spike

Status: executable spike, not a production migration (2026-08-03).

Source reviewed: `cloudflare/computer` at
`~/src/github.com/cloudflare/computer` (`63d363632e558f7e077794988d36ed75017c2a62`).
The OS package is exact-pinned to `@cloudflare/computer@0.1.1`, the release at
that source revision. It is explicitly exempted from the repository's package-age
gate because evaluating that same-day release is the purpose of this spike.

## Decision explored

An agent, not a workspace, is the durable unit a human creates and talks to.
Every agent owns exactly one Computer:

```text
/agents/research                         agent stream + Agent DO
    |
    +-- capability: itx.computer
    v
/computers/agents/research               computer stream + Computer DO
    |
    +-- Cloudflare Computer Workspace    durable filesystem
    +-- WorkerShellBackend               bounded fast shell/runtime
    +-- ComputerProcessor                birth/config/execution audit
```

`agent.create()` births both identities and does not return until both
processors have reduced their birth certificates. The Computer birth
certificate records its owning agent and initial runtime policy. Addressing
`itx.computers.get(path)` alone does not create anything.

The name `Workspace` remains inside the Cloudflare library API. It does not
escape the OS domain boundary. In OS vocabulary this is a **Computer**: its
filesystem is the agent's durable disk, not WorkspaceV2's project-wide,
copy-on-write view of repository heads.

## What the spike implements

- A new `ComputerDurableObject`, namespace, binding, and worker export.
- A pure `ComputerProcessor` on the Computer's own stream.
- `computer/created` and `computer/configured` lifecycle events.
- Serialized `computer/execution-requested` plus exactly one observable
  completed, failed, or abandoned terminal classification.
- A five-minute hard timeout ceiling and a 30-second command default recorded
  in the birth certificate.
- Cloudflare Computer's Worker shell backend and durable filesystem.
- A trusted `itx.computers.get("/computers/agents/...")` catalog at every
  project scope plus the owning Computer mounted as `itx.computer`.
- The complete Cloudflare `WorkspaceStub` API on either handle: `fs`,
  `runtime`, `git`, `assets`, `artifacts`, and `useThink`.
- Additive OS controls on the same object: `create`, `kill`, `whoami`,
  `getConfig`, `configure`, `processor`, and its `state` alias. Existing
  audited convenience methods remain during the spike.
- Agent birth still creates WorkspaceV2 as an explicitly labelled migration
  bridge; this spike does not strand existing uncommitted work or break the
  current apps.

If the Durable Object restarts after recording a request but before recording
its outcome, the next execution first appends `computer/execution-abandoned`.
It never silently clears the active command.

The agent-facing interface is deliberately not a restricted facade. The caller
is trusted and can be pointed directly at Cloudflare Computer's API. For example:

```ts
await itx.computer.fs.writeFile("/workspace/hello.txt", "hello\n");
const execution = await itx.computer.runtime.exec("wc -c /workspace/hello.txt", {
  encoding: "utf8",
});
const result = await execution.result();
const lifecycle = await itx.computer.state.snapshot();
await itx.computer.kill();
```

`state.snapshot()` is OS's event-sourced projection, not a filesystem snapshot:
it returns the Computer birth certificate, runtime configuration, current or
latest audited convenience execution, and processor coordinates. Cloudflare's
filesystem and detached runtime APIs remain under `fs` and `runtime`.

`useThink` is an upstream compatibility flag, not a reasoning or compute
control. Cloudflare Computer can add legacy, string-oriented filesystem methods
directly to its `Workspace` when that object is assigned to Cloudflare's
separate Think package. OS leaves the flag `false`; agents use the complete
`fs` facade instead.

## Target product model

Creating a jam session around a task board should create an **agent** with jam
facts in its agent birth certificate. The Computer follows automatically:

```ts
const jam = itx.agents.get("/agents/jams/launch");
await jam.create({ kind: "jam", app: { type: "tasks", root: "/workspace/tasks" } });
await jam.message("Help us plan this launch.");
```

The app URL should identify the agent (or a stable opaque checkout whose birth
certificate identifies the agent), not accept a caller-selected workspace:

```ts
await itx.worker.tasks.link({ agent: "/agents/jams/launch", task: "plan.md" });
await itx.worker.docs.link({ agent: "/agents/jams/launch", path: "docs/brief.md" });
```

The app resolves the agent's one Computer internally. That removes an entire
class of invalid states: a board cannot accidentally point at another agent's
workspace, and a user can always discuss the board or document with the agent
that owns its Computer.

## Why Docs and Tasks cannot switch by renaming a parameter

Both apps currently consume more than file reads and writes from WorkspaceV2:

- live collaborative sessions, presence, redlines, and batched reads;
- mount-relative repository paths;
- WorkspaceV2's per-mount commit/revert/status operations.

Cloudflare Computer supplies a durable filesystem and execution backends. It
does not supply those OS product semantics. The migration boundary should be
an app-facing `AgentFiles` capability resolved from an agent, with two explicit
implementations during migration:

1. `WorkspaceAgentFiles` delegates to WorkspaceV2 today.
2. `ComputerAgentFiles` delegates file bytes to the Computer and hosts the
   existing collaboration protocol over those bytes.

For Computer-native task files under `/workspace/tasks`, “commit” disappears:
the durable Computer copy is already authoritative. A project-owned task file
under `/repos/**` remains an explicit repo operation; it is not made to look
like Computer-local state. This separation is simpler than rebuilding
WorkspaceV2's implicit mount namespace inside the new Computer.

The existing `CollabHost` should first be generalized from `WorkspaceCore` to
the narrow filesystem interface it actually needs. Then Docs and Tasks can
move behind `AgentFiles` without changing their collaboration protocol or UI.

## Linux backend follow-up

The spike enables `WorkerShellBackend`, which is fast and works without a container
fleet. It proves identity, durability, events, capability routing, and app
ownership. It is not a full Linux computer.

Adding Cloudflare Computer's container backend should extend the same
`ComputerDurableObject`; it must not create another identity. Production work
needed before enabling it:

- add the computerd container image and one bounded container class;
- route outbound traffic through the project's egress/secret boundary;
- implement Cloudflare Computer's durable pending-sync scheduler on the DO
  alarm, including bounded retries and an exhausted terminal event;
- choose idle/sleep policy and account-wide instance caps;
- prove filesystem convergence across sleep, eviction, failed pulls, and a
  preview deployment before making Linux the default backend.

## Migration sequence

1. **Dual birth (this spike):** new agents get Computer + WorkspaceV2; only
   `itx.computer` uses the Computer.
2. **Agent-addressed apps:** change Docs/Tasks links and checkout birth facts
   from `workspace` to `agent`; retain `WorkspaceAgentFiles` underneath.
3. **Computer-native collaboration:** introduce `ComputerAgentFiles`; move
   scratch docs and task boards to `/workspace` while repo-backed flows remain
   explicit repo operations.
4. **Agent runtime:** move attachments, script-result files, prompt guidance,
   and skills from `itx.workspace` to `itx.computer`.
5. **Stop WorkspaceV2 birth:** remove the `workspace` capability and the
   migration create from `AgentRpcTarget.create` only after deployed app and
   agent telemetry shows no WorkspaceV2 callers.
6. **Retire storage deliberately:** inventory uncommitted WorkspaceV2 overlays,
   provide an export path, then tombstone the old class in a later deployment.

The key architectural result is that removing WorkspaceV2 does **not** mean
putting repositories back inside a magical workspace abstraction. It means an
agent owns a real durable Computer, while project repositories remain explicit
shared domain objects.
