# GitHub pull-request agents

Every pull request on a linked repo gets one durable agent stream:

```text
/agents/repos/<repo-slug>/pull-requests/<number>
```

GitHub deliveries remain raw `events.iterate.com/github/webhook-received`
facts on that stream. The `github-agent` processor folds a small current PR
projection and twelve recent activity summaries; it does not copy every
webhook into permanent LLM history. Each summary carries its raw stream
offset, so a turn can recover an omitted field without loading the journal:

```js
await itx.streams.get(agentPath).getEvent({ offset });
```

Check runs, check suites, and workflow runs are routed to every PR named in
their `pull_requests` array. `pull_request.synchronize` is the push signal and
includes the pusher. Comments, reviews, description changes, labels, and PR
metadata are projected from their ordinary GitHub webhooks.

## Turn policy

| Activity                                                     | Agent behavior                                |
| ------------------------------------------------------------ | --------------------------------------------- |
| New human comment, review, or PR body containing `@iterate`  | Queue after the current turn                  |
| Opened, ready, or synchronized reviewable head, when enabled | Interrupt work for the obsolete previous head |
| CI, unmentioned discussion, edits, labels, bot mentions      | Record only                                   |

Drafts stay quiet until `ready_for_review`. Automatic review inputs name the
immutable head SHA, require the agent to verify it is still current, and ask
for one COMMENT review. A hidden `<!-- iterate-review:<sha> -->` marker makes
retries idempotent.

## Configuration

One complete `events.iterate.com/github-agent/configure` fact owns project
policy. A later fact replaces it. There are no separate enable/disable events
and no scheduling knobs:

```ts
const defaults = await itx.agents.defaults.forPath(childPath, {
  githubAgent: {
    automaticReview: {
      enabled: true,
      instructions: `
- Public events need a schema example and reducer test.
- Changed behavior needs an integration test.
      `.trim(),
    },
  },
});
await itx.streams.get(childPath).append(...defaults.events);
```

Set `enabled: false` in the same shape to turn reviews off. An existing PR
agent can be reconfigured directly:

```js
await itx.agents.get("/agents/repos/config/pull-requests/42").configure({
  githubAgent: { automaticReview: { enabled: false } },
});
```

Two GitHub-native labels override the project default for one PR:

- `iterate:review` enables automatic review.
- `iterate:skip-review` disables it and wins if both labels are present.

Applying `iterate:review`, or removing `iterate:skip-review`, reviews the
current head if it has not already been requested. A human can always request
one review without changing persistent policy by commenting
`@iterate review now`. Label permissions are GitHub's normal repository
permissions; the agent maintains no second authorization or command state.

## GitHub and code tools

The GitHub capability is deliberately ordinary:

```js
const octokit = itx.integrations.github[connection].octokit;
const pr = await octokit.rest.pulls.get({ owner, repo, pull_number });
await octokit.rest.issues.createComment({ owner, repo, issue_number: pull_number, body });

const reviewThreads = await octokit.graphql(
  `query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) { nodes { isResolved } }
      }
    }
  }`,
  { owner, repo, number: pull_number },
);
```

`octokit` is the `Octokit` exported by the main `octokit` package; Iterate
supplies its GitHub App installation authentication and request transport.
Use `.rest.*` for routine endpoint calls and `.graphql(query, variables)` when
GraphQL's query shape or API coverage is useful. `.request(...)` is available
too. Pagination uses the serializable route-string form:

```js
await octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
  owner,
  repo,
  pull_number,
});
```

The connection's `__describe()` exposes the exact package type as:

```ts
export type GithubConnection = {
  octokit: import("octokit").Octokit;
};
```

Use the package types and [official Octokit documentation](https://github.com/octokit/octokit.js/).
Octokit's retry and throttling plugins are disabled, so it does not replay
5xx, 429, or 408 responses. The secret transport may refresh credentials and
repeat once after a 401. Inspect GitHub state before manually retrying an
ambiguous failed write.

RPC arguments must be serializable. For pagination, pass a route string and
params as above; endpoint-function overloads, map callbacks, and
`paginate.iterator()` cannot cross the boundary. The explicit `.octokit`
segment is mandatory; direct `.rest` or `.graphql` on the connection is
rejected.

For code work, the agent fetches the live PR, clones its head repository/ref
into a project sandbox, edits and tests normally, commits, and non-force
pushes the exact head branch. Sandboxes provide git, gh, and `GH_TOKEN`; the
turn prompt explicitly binds that token to the PR route's connection so
projects with several GitHub installations cannot select the wrong one.
`itx.repo` and `itx.workspace` are never PR write doors: both target the linked
project's default branch. If a fork is outside the GitHub App installation,
the agent reports the permission blocker instead of touching the base branch.
