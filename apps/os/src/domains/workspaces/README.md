# Workspaces

Event-sourced, mount-routed durable workspaces — each one a PRIVATE WORKING
COPY of the project's one path namespace, for agents and tooling.

## Shape

- **Identity + configuration are stream facts.** A workspace lives at a
  `/workspaces/**` path; that path is its Durable Object name AND its stream
  path. `workspace/created` is the existence marker; `workspace/configured`
  patches the OVERLAY table. `WorkspaceProcessor` is a pure reducer — reduce
  only, no side effects — hosted by the DO under the standard registry/runner
  machinery.
- **The mount table is DERIVED, not stored.** Every project repo is mounted at
  its own `/repos/**` stream path — mount path = repo path, verbatim — so
  `/repos/config` means the same thing in every workspace, and a freshly
  created repo just appears everywhere. The derivation reads the project
  stream's reduced repo list, cached per DO incarnation and refreshed on
  routing misses under `/repos/` (the "repo created moments ago" case) and at
  the top of enumerating/git operations. Stored config holds only
  DEVIATIONS: a complete overlay mounts a repo at an extra path; a partial
  one changes a derived mount's fields (e.g. `policy: "read-only"`); `null`
  clears an overlay. `"/"` is never a mount.
- **Birth is explicit.** `itx.workspaces.get(path)` only addresses a possibly
  nonexistent handle. `await handle.create({ mounts? })` appends one atomic
  batch: the existence marker, an optional initial overlay patch, and the
  Workspace processor subscription. Filesystem and configuration methods
  reject loudly before creation; no read, write, or first touch can birth a
  workspace. Agent creation explicitly creates the agent's own workspace
  before the agent handle is returned.
- **Private files live under the workspace's own path.** The workspace's
  stream path doubles as its scratch directory: writable, never committable,
  invisible to everyone else. RELATIVE paths resolve there. Writes anywhere
  outside the scratch directory and the mounted repos error loudly — a typo'd
  absolute path fails instead of silently becoming stray scratch. Reads try
  the private local layer (DO-SQLite via `@cloudflare/shell`, R2 spill past
  ~1.5MB under the `workspace-v2/` bucket prefix), then fall through to the
  longest-prefix-matching mount's repo at HEAD. Deletes leave whiteouts;
  nested mounts shadow.
- **Commits route per mount and never span mounts.**
  `git.commit({ message, scope? })` turns ONE mount's changes into one commit
  on THAT repo's main via its own `commitFiles` lane, honoring the mount's
  `policy` (`commit-to-main` | `read-only`), then clears just that subtree —
  other mounts' uncommitted work and the private scratch survive. `scope`
  is optional only when exactly one mount is dirty. `git.status()` groups
  changes by owning mount (clean mounts classify without a repo listing, so
  status stays cheap with every repo mounted); `git.log({ scope? })` reads
  one mount's repo history.

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
  next policy value; today big imported repos deviate to `read-only`.
- **`listAllFiles`/`glob` still enumerate every mount.** With many or huge
  repos mounted that is a full `listFiles` per repo; per-mount lazy listing
  is the follow-up if it hurts. Status and commit inference already skip
  clean mounts.
- **Small fs surface** (readFile/readFileBytes/writeFile/writeFileBytes/edit/
  deleteFile/exists/glob/listAllFiles/reset/revert). stat/readDir/cp/mv can
  return when something needs them.
- **Bases float at HEAD.** Reads always see each repo's latest main; per-mount
  pinned base oids (and an explicit `sync` with conflict reporting) come with
  the lazy read layer, where reads are keyed by commit oid anyway.
- **Derived-table transitions are unguarded.** `assertMountTransitionSafe`
  fences explicit configures, but a repo BORN under a path where a nested
  mount lands (e.g. `/repos/a/b` while `/repos/a` has dirty files beneath it)
  re-routes silently — accepted: strict writes make the reachable cases rare,
  and repo creation cannot consult every workspace's dirt.
