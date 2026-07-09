# Workspaces

A workspace is an overlay filesystem in a Durable Object. The project's ROOT
workspace (`itx.workspaces.get("/")`) is a read-only fast cache of the project
repo's main branch, invalidated by the repo's head cursor (one cheap
`getHead()` per read; re-materialized only when main actually moved — and
freely ditchable via `reset()`, it's just a cache). Every other workspace is a
copy-on-write overlay over it: writes stay local, deletes leave whiteout rows,
missing reads fall through to latest main, and `git.commit({ message })`
publishes the merged view as one snapshot commit on the workspace's own branch
(`workspaces/<path>`) — never main. See `workspace-durable-object.ts` for the
full semantics.

## Agreed next steps (ALL landing on PR #1804, per Jonas)

1. **WorkspaceCore library split**: the overlay/cache semantics move into a
   host-agnostic class constructed with `{ storage, getParent, repos, branch }`
   (cloudflare/workspace's constructor shape); the DO becomes a thin host, so
   the same core can be hosted by the Agent DO (zero-hop spills) or Repo DO.
2. **Repo caches, generalized from the root**: one ditchable cache workspace
   per repo (the root is the `{"/", main}` instance), filled by shallow clone
   only when its recorded head lags the repo's cursor. Reserved DO paths under
   `/workspaces/.repo<repoPath>`; user paths there are rejected.
3. **Multi-repo overlays**: every agent workspace sees ALL config repos at
   their repo paths — copy-on-write, fall-through per subtree to that repo's
   cache. Repos live at arbitrary paths, so the router longest-prefix-matches
   an injected repo list (= project processor state's `repos`, served via `projectProcessorState(projectId)` — see rpc-targets.ts ~992); default route is the config repo at "/". Publish
   routes per mount: changes under a mounted repo commit to THAT repo's
   `workspaces/<path>` branch. Per-file git laziness is impossible
   (isomorphic-git has no partial clone) — laziness lives at the cache layer.

## Direction of travel (deliberately not built yet)

Researched 2026-07-09 against Cloudflare's own stack; these are the seams we
expect to grow along, kept here so the next change composes instead of
colliding:

- **Engine swap → `cloudflare/workspace` (dofs).** Cloudflare's successor to
  `@cloudflare/shell`'s Workspace is a library object (`new Workspace({
storage })`) hosted by any DO — not a DO class — over a content-addressed
  SQLite VFS (`@cloudflare/dofs`, zero deps, 512KiB chunks) with pluggable
  shell backends (just-bash dynamic worker / container FUSE via wsd) and git
  (isomorphic-git) as a client over the VFS. It is alpha and unpublished on
  npm; when it stabilizes (or we choose to vendor it), the swap should be
  contained to the storage engine — the overlay semantics in this domain are
  deliberately engine-agnostic.
- **Mounts as the composition surface.** Their model composes a workspace from
  content-source mounts at absolute, non-nesting roots (`{ "/skills":
R2Bucket(...), "/project": GitHubRepo(...) }`). Our parent fall-through is,
  in that vocabulary, an overlay mount at "/". The future picture we want:
  an agent workspace with all config repos mounted as overlay mounts
  (`/config`, `/website`, ...). Config-level change once mounts exist; do not
  build a second composition mechanism.
- **Sandbox mounting via git refs.** `cloudflare/artifact-fs` (a container-side
  FUSE daemon; lazily-hydrating blobless clones — a different layer, it can
  never run in a DO) mounts any git ref into a sandbox, with a proven
  sandbox-sdk integration. Our snapshot-publish branches are git refs, so "a
  published workspace branch is the mount seam" — keep publish-to-branch a
  first-class verb.
- **Overlay reconciliation.** artifact-fs pins a base snapshot generation and,
  when the base moves, keeps a dirty overlay entry iff its recorded
  `SourceOID` still matches the new base. We deliberately track NO per-file
  source oid: our overlays pin per-path by shadowing, our root has no local
  edits by definition, and "rebase a dirty overlay onto new main" — if ever
  needed — is a git merge at publish time, not per-file bookkeeping.
- **Workspace-per-branch caches.** The root-workspace pattern generalizes to a
  ditchable cache DO per `{repo, branch}` should anything need fast reads of
  non-main branches.

No stream processor here on purpose: workspaces are storage with a publish
verb, not event consumers; publishes already surface through the repos domain.
