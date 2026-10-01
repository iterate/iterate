# iterate's project templates

Templates that depend on packages outside core. Core's own, which depend on nothing outside it,
are in [core/configs](../core/configs/README.md), which also says how a template works.

- `voice/` — core's `default` plus the voice app. `voice.ts` re-exports the voice service and its
  relay class from the npm package `@iterate-com/voice`, and the init case of `worker.ts` calls
  `installVoice(itx)` as well as `installAgents(itx)`.

iterate's deploys, previews and test runs give the platform's build every folder here
(`scripts/os/config-templates.ts`, core/os's `scripts/build.ts` `--template`), each under its
GitHub reference at the checkout's commit in the repository its `origin` names
(`github:iterate/iterate#<sha>&path:configs/<name>`), with `@iterate-com/voice` pinned to this
checkout's own build (`scripts/os/published-package-commit.ts`). Any other template may list a
pkg.pr.new dependency at a branch (`…@main`): the seed writes it at the commit pkg.pr.new names for
it then, because the loader loads a pkg.pr.new package only at a full commit
(`pinPkgPrNewDependencies` in `core/lib/src/pkg-pr-new.ts`).

These are copied to [iterate/packages](https://github.com/iterate/packages) with the packages they
use, so a self-host can offer one with
`--template "github:iterate/packages#main&path:configs/voice"`.
