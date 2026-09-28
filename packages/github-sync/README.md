# @iterate-com/github-sync

Keeps a project's config repo and its GitHub repository one history: the same commits on two
remotes. A push to the GitHub repository's `main` makes the repo pull it (which publishes the
project), and a commit to the repo (an agent's `commitFiles`, the Dash) is pushed to GitHub. Both
are the platform's fast-forward-only `pull()` / `push()`, so binary files come along too. When the
two mains have diverged, `github-sync/synced` records `not-fast-forward` and nothing moves until a
person chooses in the Dash (the project's Config repo: replace iterate's with GitHub's, or push
iterate's). Userspace: a project installs this package; the platform ships none of it.

## Install

The repo must be linked to its GitHub repository first (the Dash's Config repo sets its origin),
through a GitHub connection whose installation reaches it (Dash → Integrations → Connect GitHub).
Then a project installs the sync from a folder of its config repo:

```text
github-sync/package.json   { "main": "index.ts", "dependencies": { "@iterate-com/github-sync": "https://pkg.pr.new/iterate/iterate/@iterate-com/github-sync@<sha>" } }
github-sync/index.ts       export { GithubSyncDurableObject } from "@iterate-com/github-sync";
```

and a session mounts that folder. It writes rows that lend the connection's log the root's repos and
egress (a pull's git exchange), which only a person's or the operator's session may write, never a
config worker or an `itx run`.
From a clone of the config repo whose root `package.json` lists the package (so `npm install` gets
it):

```sh
iterate repl --project <slug>
itx> const { installGithubSync } = await import("@iterate-com/github-sync/install")
itx> await installGithubSync(itx, await itx.repos.get("/repos/config").modules({ dir: "github-sync" }))
```

`installGithubSync(itx, source, { repo, connection })`:

- `repo`: the repo to sync, `/repos/config` by default. Its origin names the GitHub repository.
- `connection`: the GitHub connection whose webhooks carry the pushes, by default the project's one
  connection to the origin's owner.

It enables the `github-sync` processor on `/integrations/github/<connection>` (pushes) and on `/`
(commits), and appends `github-sync/installed { repo }` to both: what came before is never synced.
To upgrade, pin a newer build and install again; the same source again changes nothing but the
markers.

| File                       | What                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `src/contract.ts`          | When it pulls and when it pushes, and its facts                       |
| `src/processor.ts`         | `GithubSyncProcessor`: a push to origin's main pulls, a commit pushes |
| `src/durable-object.ts`    | `GithubSyncDurableObject`, the class a project's folder re-exports    |
| `src/github-repository.ts` | Which GitHub repository an origin names                               |
| `src/install.ts`           | `githubSyncFolder` and `installGithubSync`: the folder and its mount  |
