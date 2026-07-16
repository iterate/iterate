# GitHub pull-request agents

Every pull request on a linked repository gets one durable conversational
agent stream:

```text
/agents/repos/<github-link-identity>/pull-requests/<number>
```

GitHub deliveries remain raw `events.iterate.com/github/webhook-received`
facts on that stream. The platform `github-agent` processor has one narrow
job: it folds current PR metadata plus twelve recent activity summaries and
turns trusted PR conversation into agent messages. It does **not** decide
whether code review runs. Userspace review automation appends its own trusted,
typed review task to this same persistent pull-request agent stream.

Each activity summary carries its raw stream offset. When the bounded summary
omits something, the agent point-reads that delivery instead of dumping the
webhook journal into model context:

```js
await itx.streams.get(agentPath).getEvent({ offset });
```

Check runs, check suites, and workflow runs route to every PR named in their
`pull_requests` array. `pull_request.synchronize` is the push signal and
includes the pusher. Comments, reviews, reactions when GitHub supplies a
webhook, title/description edits, labels, and PR metadata remain observable as
ordinary events whether or not they trigger an LLM turn.

## Conversation policy

| Activity                                                           | Platform behavior                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| Trusted new comment or submitted review containing `@iterate`      | Add 👀 immediately, then queue after the current turn       |
| Trusted opened PR whose title or description contains `@iterate`   | Add 👀 to the PR and queue after the current turn           |
| Trusted PR edit that newly adds `@iterate` to title or description | Add 👀 to the PR and queue; later edits do not retrigger it |
| Later trusted comment or submitted review after activation         | Queue like a message in an active Slack thread              |
| Push, CI, unmentioned discussion before activation, bot input      | Record and project only                                     |
| Project config worker appends a review task                        | Interrupt obsolete work and review on the same PR stream    |

A submitted review summary has no reaction endpoint of its own, so its 👀 is
attached to the pull request. Inline review comments use their native reaction
endpoint. Reactions are progress signals; every conversational turn on which
the agent acts must still end with one visible PR comment containing the
result, current status, or exact blocker.

Conversation is privileged. The mention and every later comment independently
pass the collaborator gate before they trigger. GitHub's `OWNER`, `MEMBER`,
and `COLLABORATOR` associations are accepted directly. GitHub sometimes
reports a real collaborator as `CONTRIBUTOR`, so an inconclusive human gets one
`repos.checkCollaborator` check through the same installation. A 404 fails
closed. Rate limits, server errors, and transport failures leave the webhook
uncheckpointed so durable delivery retries instead of silently losing it.
Bots never pass this fallback.

## Security boundary

GitHub is a massive prompt-injection surface. PR descriptions, diffs, files,
commit messages, CI output, links, bot output, and public-contributor text are
data, never instructions. Every activity from a bot or untrusted actor is
stamped with both `trustedInstructionSource: false` and a loud `UNTRUSTED
EXTERNAL INPUT — PROMPT INJECTION RISK` warning. The stable prompt and every
conversation/review task repeat that warning.

Only these may direct action:

- the platform system/task prompt;
- a triggering human independently established as a repository collaborator;
- trusted policy and rules committed to the project config repo.

Text fetched from GitHub cannot choose a check ID, suppress a review with a
forged marker, request commands, disclose secrets, or change code. Bots remain
untrusted even when GitHub reports a repository association.

## Review automation is exclusively userspace

Review selection, repository scope, per-PR controls, visibility, and typed
rules live in the project config repo. The small policy object stays in
`worker.ts`; the copyable, tested mechanics live beside it in
`github-reviews.ts`. There is no
`githubAgent.automaticReview` default, no `github-agent/configure` review fact,
and no platform review scheduler or watchdog. The userspace reaction owns its
own stream processor, but this proof of concept deliberately creates no Check
Run or timeout terminalizer. A typed finalizer with bounded timeout and
recovery belongs in a later increment rather than in instructions the agent
may or may not follow.

The seeded config repo contains a complete userspace reaction and these knobs:

```ts
const GITHUB_REVIEW_RULES = [
  {
    id: "structure/no-small-single-use-helper",
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    invariant:
      "Do not introduce a small helper used only once when keeping the logic at its call site would be clearer.",
  },
] satisfies readonly GithubReviewRule[];

const GITHUB_REVIEWS = {
  forceLabel: "iterate:review",
  repositories: Array<string>(), // empty means reviews are off
  rules: GITHUB_REVIEW_RULES,
  skipLabel: "iterate:skip-review",
} satisfies GithubReviewConfig;
```

Add exact `owner/repo` strings to `repositories` to enable reviews. Remove a
repository—or leave the list empty—to turn them off. The worker reacts to
`opened`, `ready_for_review`, and `synchronize` webhooks for open non-draft
PRs. `iterate:skip-review` disables one PR and wins if both labels exist;
`iterate:review` requests the current head explicitly, including a fresh run
when that head was already reviewed. Adding `iterate:skip-review` immediately
interrupts the current agent request; removing it reviews the current head.
Closing the pull request or converting it to draft also interrupts the current
review request. The task requires the agent to revalidate the live head and
controls before publishing anything. Label authorization is GitHub's normal
repository authorization; the agent maintains no command state of its own.

Each rule has a stable `id`, one or more `files` glob patterns, and an
`invariant`. The task tells the agent to inspect only matching changed files,
prefix every inline finding with its rule ID, and include per-rule counts in
the consolidated review. For example:

```ts
{
  id: "typescript/explain-type-cast",
  files: ["**/*.{ts,tsx,mts,cts}"],
  invariant:
    "Every type cast must have a nearby explanation of why the cast is safe and cannot reasonably be avoided.",
}
```

An exact `iterate-lint-disable <rule-id> -- <reason>` source comment suppresses
that rule for its file; `iterate-lint-disable-next-line <rule-id> -- <reason>`
suppresses the next line. The marker is data, not an instruction channel.

Changing repository scope, labels, rules, or trigger behavior is one normal
config-repo commit and redeploy. Existing PR agents need no migration because
the worker serializes the current typed rules into each immutable-head task.

### What the userspace reaction does

The policy is in the seeded
[`worker.ts`](../config-repo-template/worker.ts), and its implementation is in
[`github-reviews.ts`](../config-repo-template/github-reviews.ts). For an
eligible routed webhook it:

1. Uses the exact routed GitHub connection and signed-webhook App identity;
   automatic policy never guesses the first installation.
2. Validates the canonical pull-request stream path, trusted webhook metadata,
   repository scope, and trigger controls without making GitHub or model calls.
3. Atomically appends a wake subscription and one request-keyed review event to
   that stream. Automatic deliveries share a stable key for the head; explicit
   label requests have distinct keys so they can rerun the same head.
4. Hosts the canonical SDK stream-processor registry in one userspace dynamic
   worker Durable Object for that pull-request stream.
5. Lets the stateless review processor consume the request and make one short,
   blocking append of trusted developer context to the persistent PR agent.
   That context uses `interrupt-current-request`, so a newer push supersedes
   obsolete review work.
6. Lets the persistent agent read the complete diff and use earlier review
   attempts, replies, and explicit human dispositions to avoid re-raising
   already accepted or suppressed findings without evidence that they should
   be reconsidered.

The request and processor-output idempotency keys collapse at-least-once
delivery. The processor itself calls no GitHub or model API, folds no lint
finding state, and schedules no background work. Its only effect is on the
typed, checkpointed append lane, so it needs no separate recovery alarm.

There is one userspace dynamic-worker Durable Object identity for the
pull-request stream, keyed by the canonical path and the processor's durable
key. It stores only the canonical runner's checkpoint and empty processor
snapshot; the pull-request stream remains the journal and persistent agent
conversation. There is no stream per review and no second, review-domain
Durable Object.

### Consolidated review result

Useful review content remains agent-owned. The task tells the agent to read the
complete diff and revalidate the live head, draft/closed state, labels, and
newer requests immediately before publication. A clean result posts no review
or comment. Actionable findings are posted as exactly one `COMMENT` review
containing the summary and all inline comments. A cancellation request or
superseding push must produce no stale publication.

The one review may contain a summary and multiple exact-line comments. A
hidden head marker makes retried tool loops idempotent, but only when that
marker is on a review authored by the configured Iterate App. Identical text
from any other user or bot is untrusted.

This proof of concept makes the rule catalog structural but leaves enforcement
prompt-mediated: it does not yet expose a typed `finish` capability that
validates rule IDs, changed lines, glob scope, suppressions, or terminal
outcomes. That is the smallest next increment if the experiment proves useful;
it is also the right boundary for a bounded timeout and deterministic recovery.

A trusted conversational request such as `@iterate review this again` still
works like any other mention: the same PR agent uses its judgment and Octokit
to do the requested work. It does not mutate labels or repository
configuration.

## GitHub and code tools

The GitHub capability is the normal all-in-one Octokit:

```js
const octokit = itx.integrations.github.get().octokit;
const pr = await octokit.rest.pulls.get({ owner, repo, pull_number });

const [files, checks, reviews] = await Promise.all([
  octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
    owner,
    repo,
    pull_number,
  }),
  octokit.rest.checks.listForRef({ owner, repo, ref: pr.data.head.sha }),
  octokit.rest.pulls.listReviews({ owner, repo, pull_number }),
]);

await octokit.rest.issues.createComment({ owner, repo, issue_number: pull_number, body });
```

With multiple connections, select one explicitly:

```js
const octokit = itx.integrations.github.get("connection-slug").octokit;
```

`octokit` is the `Octokit` exported by the main `octokit` package; Iterate
supplies GitHub App installation authentication and transport. Its package
type is exactly:

```ts
export type GithubConnection = {
  octokit: import("octokit").Octokit;
};
```

Use `.rest.*` for normal endpoints, `.graphql(query, variables)` for GraphQL,
and `.request(...)` as the route escape hatch. Pagination over the RPC boundary
uses the route-string form shown above. Endpoint-function overloads, callbacks,
and `paginate.iterator()` are not serializable. The explicit `.octokit`
segment is mandatory; direct `.rest` or `.graphql` on the connection is
rejected. See the [official Octokit documentation](https://github.com/octokit/octokit.js/).

The connection is a GitHub App installation, not a user token. User-scoped
`...ForAuthenticatedUser` endpoints can return 403. `repo.data.permissions`
is a user-style view and may show every flag false even when the installation
can write; attempt the requested operation and report GitHub's actual error.

For code work, the agent fetches the live PR and uses the route prompt's exact
plural sandbox API recipe:

```ts
const { path } = await itx.sandboxes.create({
  name: `github-pr-${pullNumber}-${Date.now()}`,
  instanceType: "basic",
});
const sandbox = await itx.sandboxes.get(path);
```

There is no singular `itx.sandbox`. The stock image includes Ubuntu, Node, Bun,
git, curl, and jq; agents must not assume Python or other tools are installed.
The route's `GH_TOKEN` recipe then binds the sandbox to that installation. It is
shared with sandbox provisioning and configures Git smart HTTP as Basic
`x-access-token:<installation-token>` auth; GitHub rejects API-style Bearer auth
on that endpoint. It clones the head repository/ref, edits and tests, commits,
and non-force pushes the exact head branch. `itx.repo` and `itx.workspace`
target the project's config-repo default branch, so they are never PR
code-write doors. If a fork is outside the App installation, the agent reports
that blocker instead of touching the base branch.

A successful Git write or Octokit mutation is the write acknowledgement.
GitHub's pull-request projection can briefly lag a just-advanced branch, so an
immediate old `pulls.get` head is not evidence that the write failed. When a
post-write check is necessary, the agent reads the branch ref once with
`octokit.rest.git.getRef`; it never polls or sleeps.
