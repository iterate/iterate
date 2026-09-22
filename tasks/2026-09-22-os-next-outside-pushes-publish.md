---
state: draft
priority: medium
size: medium
tags: [os-next, artifacts, queues, previews, repos]
---

# os-next: a `git push` from outside publishes the config repo too

Jonas, 2026-09-22: "What if I pushed to the artifact from my computer? What would it take to enable
that? Would this work with preview deployments?" — explored in a throwaway worker the same day;
record what was measured and the choice it leaves. Do not build until the choice is made.

## Today

Since #2777 a commit to `/repos/config` IS its publication: the repo facet lands
`repo/commit-completed` on the repo's path and cross-posts it to `/`, and the project processor
points the apex at that commit (`src/project/processor.ts`, the follower; `docs/project-creation.md`).
That fact exists only for commits made THROUGH the facet (`commitFiles`, `writeFile`, a workspace's
`gitCommit`). A push made straight to the Artifacts remote — a laptop with a token from
`itx.cfArtifacts.get(path).createToken("write", ttl)` and `remote()` — lands in git and nothing
else: the facet's memo sees the moved tip on its next read (repos e2e, the push-from-outside row),
no fact lands, the apex stays where it was until the next facet commit. Neither os-next nor apps/os
consumes Cloudflare's Artifacts events today (apps/os models the envelope in
`repo-push-events.ts` and synthesizes it on import; its real consumer was quarantined on 2026-07-21,
`tasks/quarantined-cloudflare-artifacts-event-delivery.md`).

## Measured 2026-09-22 (throwaway worker on the dev/preview account, deleted after)

- Cloudflare Artifacts publishes `cf.artifacts.repo.pushed` through Queues event subscriptions. A
  `git push` from a laptop was enqueued ~1 s after the push and consumed ~2–5 s later (batch
  window 2 s). Payload: `source.{namespace,repoName}`, `payload.{ref,before,after,commits[]}` with
  message, author and parents per commit. The token carries `?expires=…`, so it rides an
  `Authorization: Basic base64("x:" + token)` header, never the URL (as `git-wire.ts` does).
- Subscriptions are PER REPO and nothing else: the API (`POST
  /accounts/:id/event_subscriptions/subscriptions`, `source: { type: "artifacts.repo", namespace,
  repo_name }`) refuses a namespace-only source ("Required at source.repo_name"); the wildcard
  `repo_name: "*"` was refused back in apps/os #1683 too. The account-level `artifacts` source
  carries only repo.created/deleted/forked/imported, one subscription per account. wrangler 4.131
  has no `--namespace`/`--repo-name` flags for this source; the API does.
- Worker Previews: a preview reads bindings only from the `previews` block; a queue PRODUCER binding
  there works; a `consumers` entry is accepted and registers nothing — a queue's consumer is always
  a SCRIPT, i.e. the script's production deployment (`POST /queues/:id/consumers` takes
  `script_name`; a `preview_id` is ignored). A message sent by the preview into "its" queue was
  consumed by the parent deployment. A queue named only in `previews` is not provisioned (code
  11000): create it first, like the D1.

## The constraint from July

The apps/os implementation (one subscription per repo, reconciled synchronously at repo creation,
plus queue/subscription enumeration in deploy and ensure-resources) was quarantined because
concurrent project creation in preview marathons hit the account control plane: `429 Retry-After:
120` and `500`/`15000` across unrelated PRs. Its exit criteria still stand: creating many projects
concurrently must make zero account-level queue or subscription API calls, and the mechanism must
be bounded and deployment-global with telemetry. Per-repo subscriptions are the only Cloudflare
shape available, so that constraint decides the design.

## The choice

1. **Per-repo subscriptions, off the critical path.** The repo saga lands `repo/created` as now and
   ASKS for a subscription with a keyed fact (`repo/subscription-requested`); one deployment-global
   worker (a cron or an alarm on `/`) drains those requests with bounded concurrency and backoff,
   lands `repo/subscribed { subscriptionId }` / `subscribe-failed`, and deletes the subscription
   when the repo is deleted. Project creation never touches the control plane; the pushes of a repo
   whose subscription has not landed yet are missed until it does (the next facet commit still
   publishes). A queue per deployment (`<worker>-artifacts-events`, created in ensure-resources);
   the consumer maps `repoName` back with `repoPathOf`, ignores refs other than `main`, and appends
   `repo/pushed { path, ref, before, after, commits }` keyed `repo/pushed:<path>:<after>` on the
   repo's path and on `/`; the project processor follows it exactly like `commit-completed`. Needs
   an API token with event-subscription rights in `APP_CONFIG` (dev, preview, prd).
2. **Pushes go through us.** A git smart-HTTP door on the platform origin
   (`…/repos/config.git` on the project host, or `os.iterate2.com`), admitted like any project host
   visitor, that proxies `git-receive-pack` to Artifacts with the platform's own token and lands
   `repo/pushed` itself on success. Zero control-plane calls, works in every lane incl. local and
   previews, one door to secure; a push straight to the Artifacts remote stays unpublished by
   design (`createToken` then only hands out read tokens, or none).
3. **Unsupported.** Say so: the apex follows facet commits; an outside push is a read-only mirror
   until the next commit. Delete nothing (there is nothing to delete in os-next).

Previews, for option 1: the baseline `os-next-preview` worker is the one consumer of a shared queue
and forwards each event to the preview named by the event's namespace
(`os-next-preview-<slug>-repos` → `https://<slug>-os-next-preview….workers.dev`, a shared secret);
or each preview PULLS its queue over HTTP. Options 2 and 3 need nothing for previews.

## Done when

- The choice is written at the top of this file with the reason.
- For 1 or 2: a deployed-only e2e proves a push from outside the worker publishes the apex within
  seconds (the local worker cannot be a Cloudflare consumer; the workers lane fakes a batch), and
  a preview marathon shows no project-create tail from control-plane calls.
- `docs/project-creation.md` says what an outside push does.
