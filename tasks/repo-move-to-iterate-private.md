---
status: in-progress
size: medium
---

# CI, the copies and the MCP guide survive the move to iterate/private

Misha decided on 2026-10-01: iterate/iterate becomes a public archive, and work moves to a new
private iterate/private, created as one fresh initial commit (no shared history; PR numbers
restart). These changes land on iterate/iterate first and behave the same there until the cutover.

Status: built; PR #3507 green before the Access commits. Done: Depot and GitHub calls name the
running repository, workflow YAML read with the job's token, release without tags, Copybara's
per-run origin and re-seed (tested against the real jar), the MCP examples in core, and ci-reports
behind Cloudflare Access in code. Left: creating the `ci-reports` Access application (needs Misha's
OK: it gates the live viewer at once), and at the cutover a GitHub token for private explainers.

Out of scope: package URLs (`tasks/package-urls-survive-repo-move.md`, in Misha's root checkout),
kit firmware (its own repo later).

## Decisions (my calls where Misha didn't say)

- **"This repository" is the running one, never a name.** `getRepo()` in `scripts/ci/github.ts`
  (and `githubRepository()`, its `owner/name` for Depot): `GITHUB_REPOSITORY` in CI (Depot sets it;
  the daily release's `getRepo()` proves it), else the checkout's `origin` (a laptop), as
  `core/os/scripts/build.ts` already names core's configs. Every Depot query and GitHub call that
  named iterate/iterate goes through it.
- **Workflow YAML is read through GitHub's API with the job's token**, not anonymous
  raw.githubusercontent.com (404 for a private repo). The telemetry sync needs files at dozens of
  commits its checkout doesn't have, so the API beats the checkout there; the trace uses the same
  helper rather than a second mechanism.
- **Release**: with no `v…` tag (the fresh repo), the changelog starts at the repo's root commit,
  not `HEAD~1` (which a one-commit repo doesn't have).
- **Copybara's origin is set per run**: `copy.bara.sky` has `ORIGIN` and `PULL_REQUESTS`
  constants, and `copybara.ts` runs a copy of it with them set (`configFor`). The origin is this
  repository on GitHub for a sync (the iterate App token now also lists it, found from the running
  repo, so nothing names iterate/private before it exists), and this checkout for a PR's check
  (`file://`, `--git-origin-fetch-depth=1`; no fetch, no token). Not Copybara's `"<url> <ref>"`
  source ref: tested, it replaces the url for that ref only, and the copy's last `GitOrigin-RevId`
  is still looked up at the config's url.
- **Re-seed**: before copying, `sync` reads each copy's last `GitOrigin-RevId` and asks GitHub
  whether this repository has that commit (422 = no). A copy that is empty, or whose last commit
  this repository lacks, is seeded with one SQUASH snapshot of the deployed commit
  (`--squash --force --last-rev <parent>`, `--init-history` for a root commit), carrying that
  commit's message. Tested locally against Copybara v20260928: ITERATIVE with `--last-rev <parent>`
  (today's empty-copy seed) copies nothing when the deployed commit touches no copied file; SQUASH
  writes the tree either way, and exits 4 (nothing to do) when the copy already holds that tree.
- **`(#N)` in copy titles** names the PR only while the source repository is public:
  `copybara.ts` asks GitHub for its visibility and sets `PULL_REQUESTS` (empty when private); from
  a private source the title drops the number.
- **One App token for the copies and the source**, `contents: write` on all three: git's credential
  store holds one per host. Copybara never pushes to its origin, and the job already holds the App's
  key, so a narrower token for the source would not narrow what the job can do.
- **ci-reports: Cloudflare Access** (Misha, 2026-10-01). The Worker refuses any request Access
  didn't authenticate (`ctx.access`, set by the runtime; no JWT code), so Access turned off closes
  the viewer. With that gate the `iterate/iterate` check goes, and iterate/private's reports are
  served alike. One worker-level Access application on the dev/preview account's existing Zero Trust
  (team `iterate-dev-preview`, Google Workspace for nustom.com and one-time PIN already set up),
  allowing `nustom.com`, as its Herdr app does. It is created once by hand, not by the deploy: the
  deploy's smoke checks `/` redirects to Access's sign-in. No service token yet: nothing reads
  the viewer from a script.
- **MCP examples** move to `core/os/examples/mcp-run-scripts.mjs` (ships in iterate/core), the
  instructions link it on iterate/core, and the MCP e2e runs every script in it, as
  `serve-localhost.mjs` is pinned.

## Checklist

- [x] `githubRepository()`; Depot queries in `scripts/ci/depot.ts`, `scripts/monitors/ttg.ts`,
      `scripts/ci/sync-ci-telemetry.ts`, `scripts/ci/tracing/cli.ts`; GitHub calls in
      `scripts/monitors/health.ts` and `tracing/cli.ts` publish _(`getRepo` reads `origin` off CI;
      `depot.test.ts` pins the listings to `GITHUB_REPOSITORY`)_
- [x] workflow YAML via the API (`sync-ci-telemetry.ts`, `tracing/cli.ts`); the trace step gets
      `GITHUB_TOKEN` _(`fileAtCommit`; checked against iterate/config, private, whose raw URL 404s)_
- [x] `release.yml` without tags _(`first_commit` output)_
- [x] Copybara: per-run origin, token lists the source, re-seed, `(#N)` by visibility, PR check
      from the checkout _(`configFor`, `copyHead`, `hasCommit`, `seedArgs`; `check` ran end to end
      locally)_
- [x] ci-reports: what Depot does with a private repo's artifacts; Access vs sign in with iterate,
      for Misha _(below)_
- [x] ci-reports behind Cloudflare Access _(Misha's choice; `src/worker.ts` gate and test, no repo
      check, deploy smoke, `vite dev` identity, docs)_
- [ ] create the `ci-reports` Access application (worker destination, allow `nustom.com`), with
      Misha's OK
- [ ] at the cutover: explainers read iterate/private with a GitHub token (`explainer.ts` reads
      iterate/iterate anonymously until then)
- [x] MCP example in `core/os/examples/`, link, e2e, `core/os/README.md` _(`mcp-run-scripts.mjs`)_
- [x] typecheck, lint, knip, format, tests _(locally; see notes for the two local-only failures)_
- [ ] CI green on the PR

## ci-reports after the move

**Depot and private repositories:** Depot's CI API is per organization and knows nothing of a
repository's visibility. The token ci-reports holds (`DEPOT_CI_TELEMETRY_TOKEN`) lists iterate/config's
runs (private) exactly as iterate/iterate's; an artifact's download URL is a 5-minute signed link
either way. `public-` is our naming convention, not Depot's. So nothing on Depot's side keeps
iterate/private's reports private: only the viewer's `source.repo !== "iterate/iterate"` check does,
which is why it stays until sign-in exists (reports 404 meanwhile, rather than leak). Not tested: an
actual artifact of a private repo (iterate/config's last 40 runs uploaded none).

**Explainers** read raw.githubusercontent.com anonymously, which 404s for a private repo: the Worker
needs a read-only GitHub credential (a fine-grained token, `contents: read` on iterate/private), and
that only after sign-in, or it serves private files publicly. Not the iterate App's key: the viewer
lives on the dev/preview account, and that key is prd's.

**Recommendation: Cloudflare Access** (chosen). Access is Cloudflare's login wall in front of a hostname.
Before a request reaches the Worker, Cloudflare checks for its own session cookie; without one the
visitor gets Cloudflare's sign-in page (GitHub, Google, or a one-time code by email), and a policy
says who gets in (members of the `iterate` GitHub org, or `@iterate.com` emails). It then forwards
the request with a signed header, `Cf-Access-Jwt-Assertion`, which the Worker can verify. It's part
of Cloudflare Zero Trust, free up to 50 users; on a workers.dev hostname it's a switch in the
Worker's settings (Domains & Routes), and scripts or agents get in with a service token's two
headers. Why it fits here better than sign in with iterate:

- The viewer serves whatever HTML and JavaScript CI uploaded (Playwright reports, explainers) on its
  own origin. Access leaves no iterate credential on that origin; an iterate session would.
- Who may see reports: with iterate, the only existing gate is the `admin` scope (the platform's
  admins), which puts an admin token behind a report viewer; anything narrower is new code.
- No code: no Durable Object for sessions, no OAuth flow; explainers sit behind the same wall.

Against it: a second sign-in (GitHub or Google, not iterate), and its setup lives in Cloudflare's
dashboard unless we script it. Sign in with iterate would follow `apps/admin` (`iterate/app-server`
`appAuth`, a `BrowserSession` Durable Object, the `admin` scope).

## For the cutover (not this PR)

- iterate/private: Depot CI connected, its secrets (`DOPPLER_TOKEN`), rulesets.
- Comments that say `depot ci dispatch --repo iterate/iterate` (`.depot/workflows/*.yml`).
- ci-reports: an authenticated explainer read of iterate/private (a fine-grained GitHub token,
  `contents: read`, in Doppler `_shared/preview`).
- Template references (`github:iterate/iterate#<sha>&path:configs/<name>`) and
  `app-build.tsx`'s commit links: done in iterate/iterate#3506, merged into this branch.

## Implementation notes

- 2026-10-01: Copybara v20260928 behaviour, tested against local repos (a synthetic archive, a fresh
  "private" history, bare destinations), each run with a fresh cache:
  - a plain sync from a fresh history fails, exit 2: the copy's `GitOrigin-RevId` "does not resolve
    in the origin";
  - `--squash --force --last-rev <parent>` writes the commit's whole tree with its message, even when
    the commit touches no copied file; exit 4 when the copy already holds that tree;
  - ITERATIVE `--force --last-rev <parent>` (the old empty-copy seed) exits 4 and leaves an empty copy
    empty when the commit touches no copied file;
  - `--init-history` seeds from a root commit; the next plain sync continues iteratively;
  - a `"<url> <ref>"` source ref still looks the last `GitOrigin-RevId` up at the config's url, and
    `partial_fetch` fetches the config's url too, hence `configFor`;
  - a depth-1 `file://` origin with `partial_fetch` sends git into a recursive lazy-fetch loop
    unless `--git-origin-fetch-depth=1`.
- `copybara.ts check` ran end to end on this checkout (copy, install, build, dry-run deploy, clean).
  `sync` was not run (it pushes); its pieces were run read-only: `copyHead` on the real iterate/core,
  `hasCommit` (iterate/iterate has the copy's last commit; iterate/config, standing in for
  iterate/private, answers 422), `seedArgs` on an ordinary and a root commit.
- The MCP e2e fails locally at its last step, the published site still serving the previous worker,
  with and without this change (the unchanged test fails the same way here), after every example
  script has run and the commit message matched. CI's preview is its real check.
- The scripts suite has 7 failures on macOS only (bash 3.2: `toolchain.test.ts`, the tracing shell
  hook rows), unrelated.
