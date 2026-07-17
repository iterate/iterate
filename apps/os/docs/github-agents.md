# Userspace GitHub pull-request agents

GitHub pull-request agents are project-worker policy, not a platform
processor. The platform verifies and journals GitHub webhooks, stores a linked
repository fact, and exposes authenticated Octokit. The project's `worker.ts`
decides whether a webhook creates or wakes an agent and what that agent should
do.

```text
GitHub App webhook
  -> /integrations/github/<connection>       one verified, original fact
       |-> /repos/config                     default-branch push copy only
       `-> project worker processEvent
            -> /agents/repos/config/pr/<n>   userspace PR history + agent loop
```

There is no pull-request Durable Object, stream processor, path convention, or
review policy in the GitHub integration. The existing agent stream is the one
durable journal and execution loop for a pull request.

## The connection-stream fact

A signed, parseable delivery with both GitHub delivery headers and a claimed
installation is appended exactly once to `/integrations/github/<connection>`.
Its idempotency key is the GitHub delivery ID. The complete decoded JSON body
is preserved alongside a small normalized envelope:

```ts
{
  type: "events.iterate.com/github/webhook-received",
  payload: {
    appSlug: "iterate",
    installationId: "789",
    delivery: {
      id: "github-delivery-id",
      name: "issue_comment",
      action: "created",
    },
    associations: {
      repository: { id: 123456, nodeId: "R_...", fullName: "acme/widgets" },
      pullRequests: [
        { repositoryId: 123456, number: 42, basis: "subject" },
      ],
      actor: { id: 7, login: "octocat", type: "User" },
      contentAuthor: {
        id: 7,
        login: "octocat",
        type: "User",
        authorAssociation: "MEMBER",
      },
      mentionedUsers: ["iterate"],
      problems: [],
    },
    body: { /* the complete GitHub webhook payload */ },
  },
}
```

Associations are routing hints from a small runtime-checked parser. Octokit's
pinned generated webhook-name union compile-checks the recognized event names, but no
external payload is trusted as a TypeScript value. Subject events use their
pull request or pull-request-shaped issue; check events use GitHub's native
`pull_requests` array. Missing identities become `problems` entries instead of
guesses. `actor` is the webhook sender and `contentAuthor` is the author of the
comment or review; they are deliberately separate.

GitHub's numeric repository ID is stable across App installations. The
connection and installation identify the credential and source stream;
repository ID identifies the repository; owner/name are mutable Octokit
coordinates. Once the ID matches the configured link, userspace takes current
owner/name coordinates from the signed webhook association, so a rename does
not fork agent identity or keep review calls on stale display coordinates.

## Repo links and push import

Linking `/repos/config` records:

```ts
{
  connection: "install-789",
  installationId: "789",
  owner: "acme",
  repo: "widgets",
  repositoryId: 123456,
}
```

The link installs one generic connection-stream cross-post, filtered to
`push` deliveries for that repository ID. The repo processor accepts the copy
only when its provenance, subscription key, connection, installation,
repository ID, and default branch all agree with the current link. This lane
exists only for repo import. Pull-request routing consumes the original
connection event, never the repo copy.

Relinking removes the old subscription and installs the new one. A failed
same-connection relink restores the previous subscription before returning
the failure, so the existing import lane is not silently lost.

## The userspace router

The seeded [`worker.ts`](../config-repo-template/worker.ts) contains the whole
proof of concept. Its event hook performs a cheap PR-association check before
acquiring itx, then delegates to one directly unit-tested handler:

```ts
protected override async processEvent(event: StreamEvent): Promise<void> {
  switch (event.type) {
    case "events.iterate.com/github/webhook-received": {
      if (!hasPullRequestAssociations(event)) break;
      const itx = await this.env.ITX.get();
      try {
        await handleGithubPullRequestWebhook(itx, event);
      } finally {
        itx[Symbol.dispose]?.();
      }
      break;
    }
    default:
      break;
  }
}
```

The handler reads the current link for the configured internal repo and
accepts only an original event whose path, installation ID, and associated
repository ID exactly match that link. The project controls agent identity by
mirroring its own repo path:

```ts
// /repos/config + PR 42
"/agents/repos/config/pr/42";

// /repos/team/service + PR 42
"/agents/repos/team/service/pr/42";
```

Only native `pull_request:opened` may create the agent. A draft opening creates
its durable history without requesting a review. Later deliveries reuse an
existing agent and cannot create one accidentally. Creation atomically adds:

- `github-pr/association`, pinning repo path, repository ID, and PR number;
- userspace-owned title/icon status (`PR #42`, GitHub icon); and
- the structural-review system prompt.

Every routed delivery rechecks the stored association. A collision or relink
appends `github/pull-request-routing-rejected` to the source stream instead of
mixing histories. A valid delivery is copied to the PR stream with explicit
cross-post provenance; it remains inert history until the worker also appends
a developer task.

## Structural reviews

Rules are ordinary typed policy in `worker.ts`. Record keys are the stable
identities used by suppressions, comments, idempotency, and future analytics:

```ts
const githubPullRequests = {
  policyVersion: "1",
  repoPath: "/repos/config",
  rules: {
    "typescript/explain-type-cast": {
      files: ["**/*.{ts,tsx,mts,cts}"],
      invariant:
        "Every type cast must have a nearby explanation of why it is safe and cannot reasonably be avoided.",
    },
  },
};
```

An open, non-draft `opened`, `ready_for_review`, or `synchronize` delivery
adds one review task keyed `github/review-task`. A new immutable head uses the
same key with `interrupt-current-request`, so the newest head supersedes an
unfinished older review. Its idempotency identity includes connection,
installation, repository ID, owner/name, policy version, head SHA, and the
source stream path/offset. The source occurrence suffix lets a later delivery
legitimately reconsider the same head while making redelivery of one event
idempotent.

The task requires the agent to:

- recheck live PR state and immutable head before publishing;
- paginate all changed files, fetch GitHub's reviewable diff, and fail visibly
  if every applicable added line cannot be covered;
- paginate reviews, inline comments, replies, and GraphQL review-thread
  resolution state;
- read applicable files from the PR head repository at that exact SHA, never
  from the default branch;
- apply only matching rule globs and honor source suppressions;
- publish exactly one consolidated `COMMENT` review with changed-line inline
  findings, or remain silent when clean; and
- perform no file, commit, branch, label, assignee, merge, settings, or project
  configuration mutations.

Suppressions are intentionally simple:

```ts
// iterate-lint-disable typescript/explain-type-cast -- generated SDK boundary
// iterate-lint-disable-next-line typescript/explain-type-cast -- checked above
```

The consolidated review contains a marker accepted only on a review authored
by the authenticated App bot:

```html
<!-- iterate-ai-lint:<repository-id>:policy:<version>:head:<sha> -->
```

That marker prevents duplicate non-clean publication for the same policy/head.
The persistent stream supplies prior tasks and outcomes; paginated GitHub
reviews, comments, native thread-resolution state, and trusted human
dispositions supply the external history.
The prompt keeps a resolved finding resolved unless relevant code changes.
Clean completion is deliberately not recorded in this spike, so another
qualifying delivery can reassess a clean head.

## Mentions

For an `@<app-slug>` comment/review mention, the normalized sender and content
author must be the same non-bot GitHub user, the mentioned login must match the
App that received this delivery, and the payload association must be `OWNER`,
`MEMBER`, or `COLLABORATOR`. The task then independently calls
`repos.checkCollaborator` through the pinned connection before following the
referenced request. GitHub content remains hostile data until that check.

The spike requires a fresh explicit App mention for each follow-up; it does not
yet fold an entire GitHub thread into a durable addressed-to-agent state
machine.

## Rollout and current limits

This is an intentionally breaking replacement for the removed platform
`github-agent` processor. It carries no historical compatibility path. Do not
deploy it over projects that still contain that processor's subscriptions or
old repo links without `repositoryId`; use the planned project/production
recreation, reseed the current config worker, and relink GitHub first. The
production smoke must verify the connection event associations and userspace
agent path after recreation.

The proof of concept also deliberately leaves these for later:

- no backfill for PRs opened before the userspace worker observed `opened`;
- prompt-mediated globs, suppressions, and finding validation;
- advisory `COMMENT` reviews only, with no Check Run or commit status;
- no typed finish/timeout fact, rule fan-out, PostHog telemetry, or blocking
  policy;
- no terminal event for a silent clean review. The GitHub marker deduplicates
  non-clean publication only; a typed finish capability is the likely next
  step if the experiment succeeds; and
- a repository intentionally linked into multiple Iterate projects can be
  reviewed once by each project/App.
