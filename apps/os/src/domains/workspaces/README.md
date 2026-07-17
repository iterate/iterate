# Workspaces

Event-sourced, mount-routed durable workspaces — the platform's private
filesystems for agents and tooling.

## Shape

- **Identity + configuration are stream facts.** A workspace lives at a
  `/workspaces/**` path; that path is its Durable Object name AND its stream
  path. `workspace/created` is the birth certificate (carrying the complete
  initial config); `workspace/configured` patches it. `WorkspaceProcessor` is
  a pure fold — reduce only, no side effects — hosted by the DO under the
  standard registry/runner machinery.
- **First touch births.** `itx.workspaces.get(path)` needs no create step:
  the first operation appends the birth certificate with the DEFAULT mount
  table — the config repo mounted at `"/"`, committable — which makes a fresh
  workspace behave exactly like the classic single-parent overlay. Existing
  agent workspaces heal onto this system the same way (their persisted
  `["workspaces", ["get", path]]` capability expressions keep working).
  `itx.workspaces.create({ path, mounts })` births with a custom table and is
  idempotent (re-creating converges the table via one `configured` patch).
- **The mount table routes everything.** `mounts` is a map of mount path →
  `{ repoPath, policy }`. Reads try the private local layer (DO-SQLite via
  `@cloudflare/shell`, R2 spill past ~1.5MB under the `workspace-v2/` bucket
  prefix), then fall through to the longest-prefix-matching mount's repo at
  HEAD (`RepoDurableObject.readFile`). Deletes leave whiteouts; paths under
  no mount are private scratch; nested mounts shadow (a deeper mount hides
  the outer repo's files under its point). Because `mounts` is a map,
  `configured` patches deep-merge per mount: unknown keys add mounts, partial
  values edit one mount's fields, `null` unmounts.
- **Commits route per mount and never span mounts.**
  `git.commit({ message, scope? })` turns ONE mount's changes into one commit
  on THAT repo's main via its own `commitFiles` lane, honoring the mount's
  `policy` (`commit-to-main` | `read-only`), then clears just that subtree —
  other mounts' uncommitted work and the unmounted scratch survive. `scope`
  is optional when exactly one mount is dirty. `git.status()` groups changes
  by owning mount; `git.log({ scope? })` reads one mount's repo history.

## Naming wart, deliberate

The DO class and binding are `WorkspaceV2DurableObject` / `WORKSPACE_V2`:
declarative Durable Object exports key namespaces by class name, and the
retired single-parent-overlay workspace occupied `WorkspaceDurableObject` —
reusing the name would inherit that namespace's storage. The old overlays
were disposable by contract (committed state lives on main), so the old
namespace is simply dropped; only the class/binding names carry the scar.

## Deliberately lightweight (the follow-ups)

- **Fall-through reads are clone-free** — every repo's Durable Object keeps a
  DURABLE head-tree cache (main materialized into its own SQLite, R2 spill,
  invalidated by the local head cursor), so mounted reads cost one RPC + one
  SQLite lookup in steady state, with the clone lane as loud fallback. For
  repos too large to materialize at all, the successor is lazy per-object
  reads against Cloudflare Artifacts' REST endpoints (`/blob/:hash`,
  `/tree/:hash`, `/file?ref=&path=`) with oid-keyed caches.
- **No branch mode.** `policy: "branch"` (workspace branch + auto-draft-PR on
  GitHub-linked repos, commit synthesis via GitHub's Git Database API) is the
  next policy value; today big external repos mount `read-only`.
- **Small fs surface** (readFile/readFileBytes/writeFile/writeFileBytes/edit/
  deleteFile/exists/glob/listAllFiles/reset/revert). stat/readDir/cp/mv can
  return when something needs them.
- **Bases float at HEAD.** Reads always see each repo's latest main; per-mount
  pinned base oids (and an explicit `sync` with conflict reporting) come with
  the lazy read layer, where reads are keyed by commit oid anyway.
