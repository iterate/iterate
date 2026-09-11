# celld `globalOutbound` beta/ref check

Bounded source-based follow-up to the V4/celld runtime check, including public
release/branch/tag metadata and the feature request. No runtime deployment was run.

## Result (checked 2026-09-07)

I found **no beta, nightly, release branch, or unreleased upstream commit** in the
configured `origin` that implements a non-null `globalOutbound` Fetcher broker.
`git ls-remote --heads --tags origin` advertises only `main`, pinned at
[`10cb1303dac710dcb3b557e318e08c855261f68b`](https://github.com/denoland/celld/tree/10cb1303dac710dcb3b557e318e08c855261f68b),
plus tags through `v0.4.1`; there is no advertised beta ref to inspect. The local
checkout's `main` and `origin/main` are that same commit.

GitHub's current [release metadata](https://api.github.com/repos/denoland/celld/releases?per_page=30)
lists eight published releases, all with `prerelease: false`, through v0.4.1.
Its [branches](https://api.github.com/repos/denoland/celld/branches?per_page=100)
list only `main`; its [tags](https://api.github.com/repos/denoland/celld/tags?per_page=100)
match those eight releases. There is no public beta release/ref in these results.

At that pin, this is a real implementation gap rather than a terminology issue:

- omitted `globalOutbound` inherits the parent's egress policy;
- `globalOutbound: null` denies ambient `fetch()`;
- **every non-null value, including a Fetcher, throws** `worker loader:
globalOutbound broker is not implemented yet`.

The source is direct: [`crates/celld/js.rs:8617-8628`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L8617-L8628). The
working `null`/deny path is separately implemented in
[`js.rs:9308-9316`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L9308-L9316); it is not a request/WebSocket/policy broker.

## History and scope

`git log --all -G globalOutbound` over the loader runtime and compatibility page
finds no unreleased change beyond the v0.4.1 pin. (It is not reliable evidence of
the feature's introduction release, because the relevant files have moved and
been substantially rewritten.) v0.4.1 retains the unsupported branch above and
describes its dynamic-worker scope as no Fetcher broker and no capability-stub `env`
([`docs/cloudflare-compat.md:165-175`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#L165-L175)).

This check therefore cannot rule out an unadvertised/private fork or a different
repository someone calls a beta. It does rule out a broker in the specified local
upstream checkout, its `origin`'s advertised refs, and v0.4.1/main at the stated
pin. No source evidence was found for partial broker support (HTTP-only, WebSocket,
or capability-env injection); current source rejects before such a distinction.

The directly relevant [feature request #177](https://github.com/denoland/celld/issues/177)
is still open, with no comments as checked on 2026-09-07. It specifically asks for
the Fetcher broker or capability stubs in loader `env`, reproducing their absence
on v0.4.0 with the experimental loader enabled. Current v0.4.1 source and the
[live compatibility page](https://celld.dev/docs/cloudflare-compat/) independently
confirm the missing broker. Issue/PR search returned no matching PR; direct PR
listing returned HTTP 404, so this is not an exhaustive proof about every possible
unpublished PR or fork.

The precise user-facing distinction is: experimental Dynamic Workers **do** exist,
and `globalOutbound: null` works; routing outbound requests through a supplied
Fetcher—the V4 requirement—does not exist in the checked public release/main.
